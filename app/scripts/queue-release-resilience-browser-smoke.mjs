// Queue release (docs/adr/0004) when the host's page doesn't sit still:
//
// - the host's tab is in the background for a minute while auto runs;
// - Chrome freezes the tab mid-turn, then thaws it;
// - Claude exits (/exit) and the host starts it again;
// - the host reloads mid-turn, and boots Claude again.
//
// After each, auto must carry on by itself: every queued prompt reaches the
// model exactly once (judged from a fake Anthropic API, fake-anthropic.mjs),
// nothing is sent while Claude isn't running, and neither the host nor the
// room is left with a stale state or Send stuck "waiting for Claude".
//
// What it can't tell apart: a background tab here is a headless one behind
// another tab, and a frozen one is frozen through DevTools (as Chrome does
// on a phone or with energy saver), not a phone that has suspended the
// browser or killed the tab; a reload, not a crash. The reload check is
// probabilistic: before the fix, the room was left seeing "working" in
// about half the runs (Yjs keeps either of two concurrent writes).
//
//   RIFF_URL=http://127.0.0.1:8096 npm run test:queue-release-resilience-browser
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const HIDDEN_MS = Number(process.env.HIDDEN_MS ?? 60_000);
const FROZEN_MS = Number(process.env.FROZEN_MS ?? 45_000);
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

const PROMPTS = {
  hiddenFirst: "Hidden, first (slow): sent as the tab went to the background.",
  hiddenSecond: "Hidden, second:\nsent while the tab was in the background.",
  frozenFirst: "Frozen, first (slow): the tab is frozen during this turn.",
  frozenSecond: "Frozen, second:\nsent once the tab thawed.",
  whileOff: "Queued while Claude wasn't running.",
  reloadFirst: "Reload, first (slow): the host reloads during this turn.",
  reloadSecond: "Reload, second:\nsent once Claude is back.",
};

try {
  const pageErrors = [];
  const context = browser.defaultBrowserContext();
  const host = await browser.newPage();
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  if (process.env.VERBOSE) host.on("console", (message) => console.log("[host]", message.text().slice(0, 200)));
  await host.setViewport({ width: 1440, height: 900 });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const hostInputs = await host.$$(".entry-card form input:not([type=radio])");
  await hostInputs[0].type("Resilient Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(fake.url);
  await hostInputs[2].type("fake-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const room = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  const openRoom = (page) => page.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room")?.click());

  const participantContext = await browser.createBrowserContext();
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => pageErrors.push(String(error)));
  await participant.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await participant.goto(`${baseUrl}/?room=${room.toLowerCase()}`, { waitUntil: "networkidle0" });
  await (await participant.$$(".entry-card form input"))[0].type("Watching Participant");
  await participant.click(".entry-card form .primary");
  await participant.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await openRoom(participant);

  const stateOn = (page) => page.$eval(".claude-state", (element) => element.dataset.state).catch(() => null);
  const autoOn = (page) => page.$eval(".auto-release input", (element) => element.checked);
  const queuedTexts = (page) => page.$$eval(".queue-row p", (elements) => elements.map((element) => element.textContent));
  const screen = () => host.$eval(".terminal-target .xterm-rows", (element) => element.textContent).catch(() => "");
  const sendTitles = () => host.$$eval(".send-prompt", (elements) => elements.map((element) => element.title));

  // Clicks go through the page: once Chrome has frozen and thawed the tab,
  // puppeteer's own clicks fail with "Target closed" (its utility world
  // isn't recreated), though the page is fine.
  const focusTerminal = () => host.evaluate(() => document.querySelector(".terminal-target .xterm-helper-textarea").focus());
  // Boot or start Claude, past the bypass-permissions dialog if it shows.
  async function startClaude(what) {
    await openRoom(host);
    await host.waitForSelector(".terminal-controls button:not([disabled])", { timeout: 60_000 });
    await host.evaluate(() => document.querySelector(".terminal-controls button").click());
    await until(async () => (await screen()).includes("Yes, I accept") || (await stateOn(host)) === "idle", `${what}: Claude's prompt or its dialog`, 180_000).catch(async (error) => {
      if (process.env.SCREENSHOTS) await host.screenshot({ path: `${process.env.SCREENSHOTS}/resilience-${what.replace(/\W+/g, "-")}.png` });
      console.log({ visibility: await host.evaluate(() => document.visibilityState), xterms: await host.$$eval(".xterm", (elements) => elements.map((element) => `${element.closest(".terminal-target")?.className} ${element.clientWidth}x${element.clientHeight}`)), state: await stateOn(host), heading: await host.$eval(".terminal-heading", (element) => element.textContent).catch(() => null), note: await host.$eval(".terminal-note", (element) => element.textContent).catch(() => null), screen: (await screen()).slice(-800) });
      throw error;
    });
    if ((await stateOn(host)) !== "idle") {
      await focusTerminal();
      await host.keyboard.press("ArrowDown");
      await sleep(300);
      await host.keyboard.press("Enter");
    }
    await until(async () => (await stateOn(participant)) === "idle", `${what}: the room to see Claude waiting`, 60_000);
  }
  // The host stages a prompt and queues it.
  async function queue(text) {
    await host.evaluate((value) => {
      const textarea = document.querySelector(".new-prompt textarea");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
    await host.evaluate(() => document.querySelector(".new-prompt button").click());
    await until(() => host.evaluate((value) => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === value), text), `"${text}" staged`, 10_000);
    await host.evaluate((value) => {
      [...document.querySelectorAll(".prompt-card")].find((card) => card.querySelector("textarea")?.value === value).querySelector("footer button").click();
    }, text);
  }

  await startClaude("first start");
  await host.click(".auto-release input");
  await until(() => autoOn(participant), "the room to see auto on", 10_000);

  // 1. The host's tab goes to the background with two prompts queued.
  await queue(PROMPTS.hiddenFirst);
  await queue(PROMPTS.hiddenSecond);
  const other = await context.newPage();
  await other.goto(`${baseUrl}/readme/`).catch(() => {});
  await other.bringToFront();
  const hiddenAt = Date.now();
  assert.equal(await host.evaluate(() => document.visibilityState), "hidden", "the host's tab is in the background");
  await until(() => fake.count(PROMPTS.hiddenSecond) === 1, "the second prompt to go while the tab is hidden", HIDDEN_MS + 30_000);
  const sentHiddenAfter = Date.now() - hiddenAt;
  await sleep(Math.max(0, HIDDEN_MS - (Date.now() - hiddenAt)));
  assert.equal(await host.evaluate(() => document.visibilityState), "hidden", "still in the background");
  await until(async () => (await stateOn(participant)) === "idle", "the room to see Claude waiting, from the hidden host", 10_000);
  await host.bringToFront();
  await other.close();
  assert.deepEqual(await queuedTexts(participant), []);
  console.log(`background: the second prompt went ${sentHiddenAfter} ms after the tab was hidden`);

  // 1b. Chrome freezes the tab (as it does to background tabs on a phone,
  // or with energy saver) during a turn, then thaws it.
  await until(async () => (await stateOn(host)) === "idle", "Claude idle before the freeze");
  await queue(PROMPTS.frozenFirst);
  await queue(PROMPTS.frozenSecond);
  await until(() => fake.count(PROMPTS.frozenFirst) === 1, "the first prompt to reach the model before the freeze");
  const cdp = await host.createCDPSession();
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await sleep(FROZEN_MS);
  const sentWhileFrozen = fake.count(PROMPTS.frozenSecond);
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  // The tab comes back to the front, as a thaw does when the host returns.
  const nudge = await context.newPage();
  await host.bringToFront();
  await nudge.close();
  assert.equal(await host.evaluate(() => document.visibilityState), "visible");
  await until(() => fake.count(PROMPTS.frozenSecond) === 1, "the second prompt to go after the thaw", 60_000);
  await until(async () => (await stateOn(participant)) === "idle", "the room to see Claude waiting after the thaw", 30_000);
  console.log(`frozen ${FROZEN_MS} ms: the second prompt ${sentWhileFrozen ? "went while frozen" : "went after the thaw"}`);

  await cdp.detach();
  // 2. Claude exits; a prompt queued meanwhile waits, then goes once it's back.
  await focusTerminal();
  await host.keyboard.type("/exit");
  await sleep(300);
  await host.keyboard.press("Enter");
  await until(async () => (await stateOn(participant)) === "off", "the room to see Claude not running", 20_000);
  await queue(PROMPTS.whileOff);
  await until(async () => (await queuedTexts(participant)).includes(PROMPTS.whileOff), "the prompt queued", 10_000);
  await sleep(2_000);
  assert.equal(fake.count(PROMPTS.whileOff), 0, "nothing sent while Claude isn't running");
  assert.deepEqual(await sendTitles(), ["Start Claude first"]);
  await startClaude("restart after /exit");
  await until(() => fake.count(PROMPTS.whileOff) === 1, "the waiting prompt to go once Claude is back");

  // 3. The host reloads mid-turn.
  await until(async () => (await stateOn(host)) === "idle", "Claude idle before the reload");
  await queue(PROMPTS.reloadFirst);
  await queue(PROMPTS.reloadSecond);
  await until(() => fake.count(PROMPTS.reloadFirst) === 1, "the first prompt to reach the model");
  await until(async () => (await stateOn(participant)) === "working", "the room to see Claude working");
  await host.reload({ waitUntil: "networkidle0" });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 20_000 });
  await openRoom(host);
  await until(async () => (await stateOn(participant)) === "off", "the room to see Claude not running after the reload", 10_000).catch(async (error) => {
    console.log({ participant: await stateOn(participant), host: await stateOn(host), hostQueue: await queuedTexts(host), heading: await host.$eval(".terminal-heading", (element) => element.textContent).catch(() => null) });
    throw error;
  });
  assert.deepEqual(await queuedTexts(host), [PROMPTS.reloadSecond], "the second prompt still queued");
  assert.equal(await autoOn(host), true, "auto survives the reload");
  assert.deepEqual(await sendTitles(), ["Start Claude first"], "Send isn't stuck waiting for the old page's prompt");
  await startClaude("boot after the reload");
  await until(() => fake.count(PROMPTS.reloadSecond) === 1, "the second prompt to go once Claude is back");
  await until(async () => (await stateOn(participant)) === "idle", "Claude idle at the end", 15_000);

  // Every prompt exactly once, nothing else asked of the model.
  await sleep(3_000);
  const counts = Object.fromEntries(Object.entries(PROMPTS).map(([key, text]) => [key, fake.count(text)]));
  console.log(JSON.stringify({ counts, turns: fake.turns.length }));
  for (const [key, count] of Object.entries(counts)) assert.equal(count, 1, `${key} reached the model ${count} times`);
  assert.equal(fake.turns.length, Object.keys(PROMPTS).length, "one turn per prompt");
  assert.deepEqual(await queuedTexts(participant), []);
  await participantContext.close();
  assert.deepEqual(pageErrors, []);
  console.log("Queue release resilience smoke passed: auto carried on through a background tab, a frozen one, /exit and a reload, every prompt once.");
} finally {
  await browser.close();
  await fake.close();
}
