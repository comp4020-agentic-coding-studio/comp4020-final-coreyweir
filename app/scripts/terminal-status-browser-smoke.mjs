// The Workspace header says what the terminal is doing, in plain words,
// after Claude's first Bash command. That command boots the shared Bash
// session in the background, and its "Starting WASIX session" report used
// to take over the header (grey dot) for the rest of the session. A fake
// model (fake-anthropic.mjs) answers a prompt containing "tool" with a Bash
// call, so this runs without a real API:
//   RIFF_URL=http://127.0.0.1:8093 npm run test:terminal-status-browser
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
async function until(check, what, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

try {
  const pageErrors = [];
  const reports = [];
  const host = await browser.newPage();
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  // Background reports go to the console (TerminalPane.tsx).
  host.on("console", (message) => reports.push(message.text()));
  await host.setViewport({ width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 900), deviceScaleFactor: 1 });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await host.$$(".entry-card form input:not([type=radio])");
  await inputs[0].type("Status Host");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(fake.url);
  await inputs[2].type("fake-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room")?.click());

  const state = () => host.$eval(".claude-state", (element) => element.dataset.state).catch(() => null);
  const screen = () => host.$eval(".terminal-target .xterm-rows", (element) => element.textContent).catch(() => "");
  const heading = () => host.$eval(".terminal-heading > div > span", (element) => ({ text: element.textContent, live: element.className === "live-dot" }));

  // A new room boots Claude by itself (autoBoot.ts); past the
  // bypass-permissions dialog if it shows.
  await until(async () => (await screen()).includes("Yes, I accept") || (await state()) === "idle", "Claude's prompt or its dialog", 240_000);
  if ((await state()) !== "idle") {
    await host.evaluate(() => document.querySelector(".terminal-target .xterm-helper-textarea").focus());
    await host.keyboard.press("ArrowDown");
    await sleep(300);
    await host.keyboard.press("Enter");
    await until(async () => (await state()) === "idle", "Claude waiting", 60_000);
  }
  assert.deepEqual(await heading(), { text: "Claude running", live: true });

  // A prompt that makes Claude run Bash, staged, queued and sent.
  const prompt = "Use a tool, then say done.";
  await host.evaluate((value) => {
    const textarea = document.querySelector(".new-prompt textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, prompt);
  await host.evaluate(() => document.querySelector(".new-prompt button").click());
  await until(() => host.evaluate((value) => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === value), prompt), "the prompt staged", 10_000);
  await host.evaluate((value) => [...document.querySelectorAll(".prompt-card")].find((card) => card.querySelector("textarea")?.value === value).querySelector("footer button").click(), prompt);
  await host.waitForSelector(".send-prompt:not([disabled])", { timeout: 10_000 });
  await host.evaluate(() => document.querySelector(".send-prompt").click());

  // Claude ran the command (the model got its result back) and finished.
  await until(() => fake.turns.some((turn) => turn.toolResult), "Claude to run Bash and send the result", 120_000);
  await until(async () => (await state()) === "idle", "Claude to finish the turn", 60_000);
  const after = await heading();
  assert.deepEqual(after, { text: "Claude running", live: true }, `the header after Claude's Bash: ${JSON.stringify(after)}`);
  // The test means something only if the background session did boot.
  assert.ok(reports.includes("Starting WASIX session"), `no background Bash session boot reported: ${JSON.stringify(reports.filter((text) => /WASIX|\[bash\]/.test(text)).slice(0, 5))}`);
  assert.doesNotMatch(await host.$eval(".terminal-heading", (element) => element.textContent), /WASIX/);
  assert.deepEqual(pageErrors, []);
  console.log("after Claude's first Bash command the header still says Claude running, live, and never WASIX");
} finally {
  await browser.close();
  await fake.close();
}
