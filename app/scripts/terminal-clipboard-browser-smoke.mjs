import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

// OSC 52 from a program in the host's terminal (Claude Code copying a
// selection) reaches the host's clipboard; a query for the clipboard's
// contents gets no answer at all (not even an empty one, which bash would
// take as typed input); and the participants' mirror, which receives
// the same bytes, leaves the participant's clipboard alone and shows no junk.
//
// What this can't tell apart: Claude Code's own copy isn't driven here (a
// printf in WASIX bash sends the same sequence), and headless Chromium's
// clipboard with a granted permission stands in for a real one.

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
// Two browsers, not two contexts: contexts in one browser share its clipboard.
const launch = () => puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const browser = await launch();
const otherBrowser = await launch();
const base64 = (text) => Buffer.from(text).toString("base64");
const rowsText = (selector) => (page) => page.$eval(selector, (element) => [...element.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent.replace(/\u00a0/g, " ").trimEnd()).join("\n"));
// A row that is exactly `marker`: the command's output, not the command line.
const printed = (selector, marker) => (page) => page.waitForFunction(
  (selector, marker) => [...document.querySelectorAll(`${selector} .xterm-rows > div`)].some((row) => row.textContent.replace(/\u00a0/g, " ").trim() === marker),
  { timeout: 30_000, polling: 100 }, selector, marker,
);
const hostText = rowsText(".terminal-target:not(.readonly-terminal)");
const participantText = rowsText(".readonly-terminal");

async function openRoomTab(page) {
  await page.waitForSelector(".topbar nav button");
  await page.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room")?.click());
}

try {
  const pageErrors = [];
  const hostContext = await browser.createBrowserContext();
  await hostContext.overridePermissions(baseUrl, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  const host = await hostContext.newPage();
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.setViewport({ width: 1280, height: 900 });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const hostInputs = await host.$$(".entry-card form input:not([type=radio])");
  await hostInputs[0].type("Clipboard Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(`${baseUrl}/fake-anthropic`);
  await hostInputs[2].type("invalid-clipboard-smoke-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const room = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  await openRoomTab(host);
  await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((element) => element.textContent === "Start Bash")?.click());
  await host.waitForFunction(() => document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready"), { timeout: 120_000 }).catch(async (error) => {
    const state = await host.evaluate(() => ({ heading: document.querySelector(".terminal-heading")?.textContent, note: document.querySelector(".terminal-note")?.textContent }));
    throw new Error(`WASIX Bash did not become ready: ${JSON.stringify(state)}`, { cause: error });
  });

  const participantContext = await otherBrowser.createBrowserContext();
  await participantContext.overridePermissions(baseUrl, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => pageErrors.push(String(error)));
  await participant.setViewport({ width: 390, height: 844 });
  await participant.goto(`${baseUrl}/?room=${room.toLowerCase()}`, { waitUntil: "networkidle0" });
  await participant.waitForSelector(".entry-card form");
  await (await participant.$(".entry-card form input")).type("Clipboard Participant");
  await participant.click(".entry-card form .primary");
  await participant.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await openRoomTab(participant);
  await participant.waitForFunction(() => Number(document.querySelector(".readonly-terminal")?.dataset.sequence) > 0, { timeout: 30_000 });
  await participant.bringToFront();
  await participant.evaluate(() => navigator.clipboard.writeText("participant's own"));

  await host.bringToFront();
  await host.evaluate(() => navigator.clipboard.writeText("host secret"));
  await host.locator(".terminal-target textarea").click();

  // A query: an answer would arrive in bash's input as `ESC ] 52 ; c ; …`.
  // There must be none, so nothing of the host's clipboard reaches the guest.
  await host.keyboard.type("printf '\\033]52;c;?\\a'; echo query-done");
  await host.keyboard.press("Enter");
  await printed(".terminal-target", "query-done")(host);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const afterQuery = await hostText(host);
  assert.ok(!afterQuery.includes(base64("host secret")), "a query never answers with the host's clipboard");
  assert.ok(!afterQuery.split("\n").some((row) => !row.includes("printf") && row.includes("52;")), `a query gets no answer at all:\n${afterQuery}`);
  assert.equal(await host.evaluate(() => navigator.clipboard.readText()), "host secret");

  // A copy.
  await host.keyboard.type(`printf '\\033]52;c;${base64("copied by riff")}\\a'; echo copy-done`);
  await host.keyboard.press("Enter");
  await host.waitForFunction(() => navigator.clipboard.readText().then((text) => text === "copied by riff"), { timeout: 10_000, polling: 200 }).catch(async (error) => {
    const state = { clipboard: await host.evaluate(() => navigator.clipboard.readText()), rows: await hostText(host), focused: await host.evaluate(() => document.hasFocus()) };
    throw new Error(`The copy didn't reach the host's clipboard: ${JSON.stringify(state)}`, { cause: error });
  });

  await printed(".readonly-terminal", "copy-done")(participant);
  await participant.bringToFront();
  assert.equal(await participant.evaluate(() => navigator.clipboard.readText()), "participant's own", "the mirror leaves the participant's clipboard alone");
  const mirror = await participantText(participant);
  const outside = mirror.split("\n").filter((row) => !row.includes("printf")).join("\n");
  assert.ok(!/52;|copied by riff/.test(outside), `the mirror shows no trace of the sequence beyond the command line:\n${outside}`);

  await participantContext.close();
  await hostContext.close();
  assert.deepEqual(pageErrors, []);
  console.log("OSC 52 copied to the host's clipboard, a query got nothing, and the mirror left the participant's clipboard alone.");
} finally {
  await browser.close();
  await otherBrowser.close();
}
