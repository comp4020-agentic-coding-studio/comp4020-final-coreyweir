// A server Claude starts with its Bash tool reaches the participant's
// preview, and Claude can check it with curl (docs/week-13 walkthrough: a
// backgrounded server died with the command that started it, and curl
// localhost never reached it, so the preview stayed "Not live").
//
// The model is fake (fake-anthropic.mjs): a prompt "bash: <cmd>" makes it
// call the Bash tool with that command, "bash&: <cmd>" as a background task,
// and it records what the tool answered. Everything after the model is real:
// Claude Code's Bash tool, the WASIX bash it runs in, the bridge to Nodepod,
// the preview relay and a participant in another browser context.
//
// 1. `node -e "...listen(8000)" &` in one Bash call; the call returns.
// 2. A second Bash call: `curl localhost:8000` answers with the page, so the
//    server outlived the command that started it, and localhost in the
//    session is the workspace's servers.
// 3. The participant's Preview shows the page.
// 4. The same through Claude's own background task (run_in_background).
// 5. curl on a port nothing listens on is refused, not sent to the machine.
// First: a command's stderr (`ls /nope`) reaches Claude, as it does natively
// where stdout and stderr share the file the Bash tool reads.
// With PYTHON=1 (downloads 115 MB once per profile): `python3 -m
// http.server` fails saying why and what to use instead.
//
// What it can't tell apart: a real model's choice of command (the fake one
// runs exactly what it's given), and anything about a phone-sized screen.
//
//   RIFF_URL=http://127.0.0.1:8094 npm run test:claude-serve-browser
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const fake = await startFakeAnthropic();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const server = (port, text) => `node -e "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<h1>${text}</h1>')}).listen(${port})"`;

try {
  const pageErrors = [];
  const host = await browser.newPage();
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.setViewport({ width: 1440, height: 900 });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const hostInputs = await host.$$(".entry-card form input:not([type=radio]):not([type=checkbox]):not([type=file])");
  await hostInputs[0].type("Serve Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(fake.url);
  await hostInputs[2].type("fake-token");
  const keep = await host.$$(".entry-card form label.check input[type=checkbox]");
  if (keep.length && await keep.at(-1).evaluate((box) => box.checked)) await keep.at(-1).click();
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const code = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", "").trim());
  await host.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room")?.click());

  // A new room boots Claude by itself (autoBoot.ts).
  await host.waitForSelector(".terminal-target .xterm", { timeout: 180_000 });
  const state = () => host.$eval(".claude-state", (element) => element.dataset.state).catch(() => null);
  await until(async () => (await state()) === "idle", "Claude waiting for a prompt", 180_000);

  // The participant, in another browser context, watching the Preview.
  const other = await browser.createBrowserContext();
  const guest = await other.newPage();
  guest.on("pageerror", (error) => pageErrors.push(String(error)));
  await guest.setViewport({ width: 1280, height: 900 });
  await guest.goto(`${baseUrl}/?room=${code}`, { waitUntil: "networkidle0" });
  await guest.waitForSelector(".entry-card form input");
  await guest.type(".entry-card form input", "Watcher");
  await guest.click(".entry-card form .primary");
  await guest.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 20_000, polling: 100 });
  await guest.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Preview")?.click());
  await guest.waitForSelector(".preview-heading .offline");

  // One prompt, one Bash call; what the tool answered.
  const run = async (prompt) => {
    const before = fake.turns.length;
    await host.bringToFront();
    await host.click(".terminal-target .xterm");
    await host.keyboard.type(prompt);
    await sleep(300);
    await host.keyboard.press("Enter");
    await until(() => fake.turns.slice(before).some((turn) => turn.toolResult), `the Bash call for "${prompt}"`, 120_000);
    await until(async () => (await state()) === "idle", "the turn to end", 60_000);
    return fake.turns.slice(before).filter((turn) => turn.toolResult).map((turn) => turn.toolText).join("\n");
  };
  const previewShows = async (text) => {
    await guest.bringToFront();
    const frame = await (await guest.waitForSelector("iframe.preview-frame", { timeout: 60_000 })).contentFrame();
    await frame.waitForFunction((text) => document.querySelector("h1")?.textContent === text, { timeout: 60_000, polling: 100 }, text);
  };

  // Error text reaches Claude: natively stderr shares the file Claude reads.
  const mixed = await run("bash: echo to-stderr >&2; echo to-stdout");
  assert.match(mixed, /to-stderr/, `stderr reaches Claude: ${mixed}`);
  assert.match(mixed, /to-stdout/, mixed);
  const failed = await run("bash: ls /nope");
  assert.match(failed, /nope.*No such file or directory/, `a failed command's error reaches Claude: ${failed}`);
  console.log(`stderr reaches Claude's Bash tool: ${JSON.stringify(failed)}`);

  const started = Date.now();
  const first = await run(`bash: ${server(8000, "Hello Riff")} &`);
  const startMs = Date.now() - started;
  console.log(`backgrounded server: the Bash call returned (${startMs} ms for the whole turn): ${JSON.stringify(first.slice(0, 120))}`);
  const checked = await run("bash: curl -sS localhost:8000/");
  assert.match(checked, /<h1>Hello Riff<\/h1>/, `curl from a later Bash call: ${checked}`);
  await previewShows("Hello Riff");
  console.log("the server outlived its command, curl localhost reached it, the participant's preview shows it");

  const background = await run(`bash&: ${server(8001, "Background task")}`);
  console.log(`background task: ${JSON.stringify(background.slice(0, 160))}`);
  await until(async () => /Background task/.test(await run("bash: curl -sS localhost:8001/")), "curl to reach the background task's server", 60_000);
  await previewShows("Background task");
  console.log("Claude's own background task: curl and the preview reach it");

  const refused = await run("bash: curl -sS localhost:8009/; echo status=$?");
  assert.match(refused, /status=7/, `curl on a port nothing listens on: ${refused}`);

  if (process.env.PYTHON === "1") {
    const python = await run("bash: python3 -m http.server 8002; echo status=$?");
    assert.match(python, /can't be reached/, python);
    assert.match(python, /node server\.js/, python);
    assert.doesNotMatch(python, /npx serve/, python);
    assert.match(python, /status=1/, python);
    console.log("python3 -m http.server says why it can't serve and what to use");
  }

  await other.close();
  await host.bringToFront();
  await host.click(".participants");
  await host.waitForSelector(".end-room > button");
  await host.click(".end-room > button");
  await host.click(".end-room button.danger");
  assert.deepEqual(pageErrors, []);
  console.log("Claude-served preview smoke passed.");
} finally {
  await browser.close();
  await fake.close();
}
