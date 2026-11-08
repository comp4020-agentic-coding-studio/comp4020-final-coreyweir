// Queue release (docs/adr/0004), with two clients: a participant stages
// prompts, the host queues them, and Send and auto each deliver every
// prompt to Claude exactly once, newlines intact.
//
// Judged from what reaches the model: a fake Anthropic API
// (fake-anthropic.mjs) records the prompt of every turn Claude Code makes,
// so a dropped prompt is a missing turn and a duplicate is a second one.
// The participant's page is checked for what the room sees: the queue
// emptying, Claude's state and the auto toggle, and no Send button.
//
// What it can't tell apart: a prompt that reached Claude but whose turn
// failed before the model call (the fake never sees it), and anything the
// fake's instant replies hide, such as a slow real model. Claude takes a
// prompt typed while it works as a follow-up with its own turn, so one
// prompt per turn is judged from the queue instead: the next prompt must
// still be queued while a slow turn runs. "slow" prompts keep Claude busy
// for a few seconds; one also checks a Send while Claude works.
//
//   RIFF_URL=http://127.0.0.1:8096 npm run test:queue-release-browser
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

const PROMPTS = {
  manual: "Sent by hand.\nIts second line\n\n  and an indented fourth.",
  autoFirst: "Auto, first (slow): sent as soon as auto went on.",
  autoSecond: "Auto, second:\nsent when the first turn ended.",
  autoLater: "Auto, later: queued while auto was on and Claude idle.",
  afterCommand: "After a slash command, once the host resumed auto.",
  rapidFirst: "Rapid, first:\nclicked in the same moment as the next.",
  rapidSecond: "Rapid, second: waits for Claude to take the first.",
  slow: "A slow one, so Claude is busy.",
  followUp: "A follow-up sent\nwhile Claude was busy.",
};

try {
  const pageErrors = [];
  const host = await browser.newPage();
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.setViewport({ width: 1440, height: 900 });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const hostInputs = await host.$$(".entry-card form input:not([type=radio])");
  await hostInputs[0].type("Queue Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(fake.url);
  await hostInputs[2].type("fake-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const room = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  const openTab = (page, label) => page.evaluate((next) => {
    [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === next)?.click();
  }, label);

  // The participant joins from the link, at phone size.
  const participantContext = await browser.createBrowserContext();
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => pageErrors.push(String(error)));
  await participant.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await participant.goto(`${baseUrl}/?room=${room.toLowerCase()}`, { waitUntil: "networkidle0" });
  await participant.waitForSelector(".entry-card form");
  await (await participant.$$(".entry-card form input"))[0].type("Queue Participant");
  await participant.click(".entry-card form .primary");
  await participant.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });

  const stateOn = (page) => page.$eval(".claude-state", (element) => element.dataset.state).catch(() => null);
  const autoOn = (page) => page.$eval(".auto-release input", (element) => element.checked);
  const queuedTexts = (page) => page.$$eval(".queue-row p", (elements) => elements.map((element) => element.textContent));

  // Claude starts in the host's page, straight to its prompt: Riff accepts
  // the bypass-permissions dialog for the host (claudePod.ts settings).
  await openTab(host, "Room");
  await openTab(participant, "Room");
  // No Boot Claude to press: a new room boots Claude by itself (autoBoot.ts).
  await host.waitForSelector(".terminal-target .xterm", { timeout: 180_000 });
  const screen = () => host.$eval(".terminal-target .xterm-rows", (element) => element.textContent);
  await until(async () => (await stateOn(participant)) === "idle", "the participant to see Claude waiting", 180_000).catch(async (error) => {
    console.log({ host: await stateOn(host), participant: await stateOn(participant), screen: (await screen()).slice(-600) });
    throw error;
  });
  assert.doesNotMatch(await screen(), /Yes, I accept/, "no bypass-permissions dialog");

  // The participant stages every prompt; the host queues them in order.
  for (const text of [...Object.values(PROMPTS), "/cost"]) {
    await participant.evaluate((value) => {
      const textarea = document.querySelector(".new-prompt textarea");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
    await participant.click(".new-prompt button");
  }
  const queue = async (text) => {
    await until(() => host.evaluate((value) => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === value), text), `"${text}" staged on the host`, 10_000);
    await host.evaluate((value) => {
      [...document.querySelectorAll(".prompt-card")].find((card) => card.querySelector("textarea")?.value === value).querySelector("footer button").click();
    }, text);
    // With auto on and Claude idle it may go before the participant sees it queued.
    await until(async () => (await queuedTexts(participant)).includes(text) || fake.count(text) > 0, `"${text}" queued for the participant`, 10_000);
  };
  await queue(PROMPTS.manual);
  await queue(PROMPTS.autoFirst);
  await queue(PROMPTS.autoSecond);

  if (process.env.SCREENSHOTS) {
    await host.screenshot({ path: `${process.env.SCREENSHOTS}/queue-host.png` });
    await openTab(participant, "Room");
    await sleep(500);
    await participant.$eval(".queue", (element) => element.scrollIntoView());
    await participant.screenshot({ path: `${process.env.SCREENSHOTS}/queue-participant.png` });
  }
  // The participant can't send or toggle.
  assert.equal(await participant.$(".send-prompt"), null, "no Send for a participant");
  assert.equal(await participant.$eval(".auto-release input", (element) => element.disabled), true, "the toggle is the host's");

  // Manual is the default: nothing goes until the host presses Send.
  await sleep(1_500);
  assert.equal(fake.turns.length, 0, "nothing sent before Send");
  assert.equal(await autoOn(participant), false, "auto is off by default");
  await host.evaluate((value) => {
    [...document.querySelectorAll(".queue-row")].find((row) => row.querySelector("p").textContent === value).querySelector(".send-prompt").click();
  }, PROMPTS.manual);
  await until(() => fake.count(PROMPTS.manual) === 1, "the manual prompt to reach the model");
  await until(async () => !(await queuedTexts(participant)).includes(PROMPTS.manual), "the sent prompt to leave the participant's queue", 10_000);
  await until(async () => (await stateOn(host)) === "idle", "Claude idle after the manual turn");
  await sleep(1_500);
  assert.equal(fake.turns.length, 1, "Send sent one prompt, and auto (off) none");

  // Auto on while idle sends the next at once, then one per finished turn.
  await host.click(".auto-release input");
  await until(() => autoOn(participant), "the participant to see auto on", 10_000);
  // One prompt per turn: while the first works, the second stays queued.
  // Claude would take it as a follow-up and give it its own turn, so the
  // model's requests alone can't show a second prompt sent too early.
  await until(() => fake.count(PROMPTS.autoFirst) === 1, "the first auto prompt to reach the model");
  await until(async () => (await stateOn(participant)) === "working", "the participant to see Claude working", 10_000);
  assert.deepEqual(await queuedTexts(participant), [PROMPTS.autoSecond], "the second waits for the first turn to end");
  await sleep(1_000);
  assert.deepEqual(await queuedTexts(host), [PROMPTS.autoSecond], "still waiting a second later");
  await until(() => fake.count(PROMPTS.autoSecond) === 1, "both auto prompts to reach the model");
  await until(async () => (await queuedTexts(participant)).length === 0, "the participant's queue to empty", 10_000);
  assert.ok(fake.turns.findIndex((turn) => turn.blocks.includes(PROMPTS.autoFirst)) < fake.turns.findIndex((turn) => turn.blocks.includes(PROMPTS.autoSecond)), "in queue order");

  // With auto on and the queue empty, a newly queued prompt goes at once.
  await until(async () => (await stateOn(host)) === "idle", "Claude idle after the auto turns");
  await queue(PROMPTS.autoLater);
  await until(() => fake.count(PROMPTS.autoLater) === 1, "the later prompt to reach the model");

  // A slash command runs locally and fires no hook, so auto sends it and
  // then pauses rather than type the next prompt into whatever it left
  // open (/cost leaves a dialog). The host closes it and turns auto on
  // again, and the next prompt goes.
  await until(async () => (await stateOn(host)) === "idle", "Claude idle before the slash command");
  await queue("/cost");
  await until(async () => (await stateOn(participant)) === "paused", "the participant to see auto paused", 10_000);
  await queue(PROMPTS.afterCommand);
  await sleep(2_000);
  assert.deepEqual(await queuedTexts(host), [PROMPTS.afterCommand], "auto waits after a slash command");
  assert.equal(fake.count(PROMPTS.afterCommand), 0);
  await host.click(".terminal-target .xterm");
  await host.keyboard.press("Escape");
  await host.click(".auto-release input");
  await until(async () => !(await autoOn(host)), "auto off", 5_000);
  await host.click(".auto-release input");
  await until(() => fake.count(PROMPTS.afterCommand) === 1, "the prompt after the slash command to reach the model");

  // Auto off. Two Sends in the same moment: typed back to back, Claude
  // merges, duplicates or drops them (measured), so the second waits until
  // Claude has taken the first, and the host sends it then.
  await host.click(".auto-release input");
  await until(async () => !(await autoOn(participant)), "the participant to see auto off", 10_000);
  await until(async () => (await stateOn(host)) === "idle", "Claude idle before the rapid sends");
  await queue(PROMPTS.rapidFirst);
  await queue(PROMPTS.rapidSecond);
  await host.evaluate(() => {
    const buttons = [...document.querySelectorAll(".queue-row .send-prompt")];
    for (const button of buttons) button.click();
  });
  await until(() => fake.count(PROMPTS.rapidFirst) === 1, "the first rapid prompt to reach the model");
  assert.deepEqual(await queuedTexts(host), [PROMPTS.rapidSecond], "the second click didn't send");
  await until(() => host.$eval(".queue-row .send-prompt", (button) => !button.disabled), "Send enabled again", 10_000);
  await host.click(".queue-row .send-prompt");
  await until(() => fake.count(PROMPTS.rapidSecond) === 1, "the second rapid prompt to reach the model");
  await until(async () => (await stateOn(host)) === "idle", "Claude idle after the rapid sends");

  // A Send while Claude is busy goes in as a follow-up.
  await queue(PROMPTS.slow);
  await queue(PROMPTS.followUp);
  const sendFirst = () => host.evaluate(() => document.querySelector(".queue-row .send-prompt").click());
  await sendFirst();
  await until(async () => (await stateOn(participant)) === "working", "the participant to see Claude working", 10_000);
  await sendFirst();
  await until(() => fake.count(PROMPTS.followUp) === 1, "the follow-up to reach the model", 30_000);
  await until(async () => (await stateOn(participant)) === "idle", "Claude idle at the end", 15_000);

  // Every prompt exactly once, and nothing else asked of the model.
  await sleep(3_000);
  const counts = Object.fromEntries(Object.entries(PROMPTS).map(([key, text]) => [key, fake.count(text)]));
  console.log(JSON.stringify({ counts, turns: fake.turns.length }));
  for (const [key, count] of Object.entries(counts)) assert.equal(count, 1, `${key} reached the model ${count} times`);
  assert.equal(fake.turns.length, Object.keys(PROMPTS).length, "one turn per prompt");
  assert.deepEqual(await queuedTexts(participant), []);
  await participantContext.close();
  assert.deepEqual(pageErrors, []);
  console.log("Queue release smoke passed: Send and auto each delivered every prompt once, newlines intact.");
} finally {
  await browser.close();
  await fake.close();
}
