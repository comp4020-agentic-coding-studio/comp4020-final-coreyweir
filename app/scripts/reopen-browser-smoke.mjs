// Reopening an ended room (docs/adr/0003, "Reopening"), in browsers: the
// host ends a room, finds it in their rooms as ended with Reopen, reopens
// it and is back in as host with the board, and the room's participant can
// come back in. For a board the server didn't keep, the board comes back
// from the host's own browser copy, which a newcomer with no copy then sees
// from the server. Guests only, so it runs against dev or live:
//   RIFF_URL=http://127.0.0.1:8099 W=390 H=844 SHOTS=dir npm run test:reopen-browser
// The server side (only the host may reopen, the list) is spec/rooms.test.ts
// and scripts/rooms.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const viewport = { width: Number(process.env.W ?? 1920), height: Number(process.env.H ?? 1080), deviceScaleFactor: 1 };
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const pageErrors = [];

async function page(context) {
  const opened = await context.newPage();
  opened.on("pageerror", (error) => pageErrors.push(String(error)));
  await opened.setViewport(viewport);
  return opened;
}

async function shot(target, name) {
  if (shots) await target.screenshot({ path: `${shots}/${name}.png` });
}

const textOf = (target, selector) => target.$eval(selector, (element) => element.textContent.replace(/\s+/g, " ").trim());
const waitText = (target, selector, pattern, timeout = 10_000) => target.waitForFunction(
  (sel, source) => [...document.querySelectorAll(sel)].some((element) => new RegExp(source).test(element.textContent.replace(/\s+/g, " "))),
  { timeout, polling: 100 }, selector, pattern.source,
);

async function host(context, name, keep) {
  const tab = await page(context);
  await tab.goto(baseUrl, { waitUntil: "networkidle0" });
  await tab.click(".entry-card > nav button:nth-child(2)");
  // a fake endpoint of the smoke's own, not Riff's models
  await tab.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await tab.$$(".entry-card form input:not([type=radio])");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(name);
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].type("invalid-reopen-smoke-token");
  const checkbox = await tab.$(".entry-card form label.check input[type=checkbox]");
  if (!keep) await checkbox.click();
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const code = (await textOf(tab, ".room-name span")).replace("Room ", "");
  return { tab, code };
}

async function join(context, code, name) {
  const tab = await page(context);
  await tab.goto(`${baseUrl}/?room=${code.toLowerCase()}`, { waitUntil: "networkidle0" });
  await tab.waitForSelector(".entry-card form");
  const inputs = await tab.$$(".entry-card form input");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(name);
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await tab.waitForSelector(".new-prompt textarea");
  return tab;
}

async function stage(tab, text) {
  await tab.type(".new-prompt textarea", text);
  await tab.click(".new-prompt button");
  await seesPrompt(tab, text);
}

const seesPrompt = (tab, text, timeout = 10_000) =>
  tab.waitForFunction((value) => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === value), { timeout, polling: 100 }, text);

async function endRoom(tab) {
  if (!(await tab.$(".people-panel"))) await tab.click(".participants");
  await tab.waitForSelector(".people-panel");
  await tab.click(".end-room > button");
  await tab.waitForSelector(".end-room.asking", { timeout: 5_000 }).catch(async (error) => {
    await shot(tab, "end-room-failed");
    throw error;
  });
  await Promise.all([tab.waitForNavigation({ waitUntil: "networkidle0" }), tab.click(".end-room button.danger")]);
}

// The host's row for the room: says it ended, and offers Reopen first.
async function endedRow(tab, code, fate) {
  const row = `.your-rooms li`;
  await tab.waitForFunction((room) => [...document.querySelectorAll(".your-rooms li")].some((li) => li.textContent.includes(`Room ${room}`) && /Ended just now/.test(li.textContent)), { timeout: 10_000, polling: 100 }, code)
    .catch(async (error) => assert.fail(`no ended row for ${code}: ${error.message}; rows: ${JSON.stringify(await tab.$$eval(row, (rows) => rows.map((li) => li.textContent)))}`));
  const text = await tab.$$eval(row, (rows, room) => rows.find((li) => li.textContent.includes(`Room ${room}`)).textContent, code);
  assert.match(text, fate);
  const first = await tab.$$eval(row, (rows, room) => rows.find((li) => li.textContent.includes(`Room ${room}`)).querySelector(".actions > button")?.textContent, code);
  assert.equal(first, "Reopen", "Reopen is the row's first action");
  assert.doesNotMatch(text, /Enter/, "an ended room isn't entered");
}

async function reopen(tab, code) {
  const button = await tab.evaluateHandle((room) => [...document.querySelectorAll(".your-rooms li")].find((li) => li.textContent.includes(`Room ${room}`)).querySelector(".actions > button"), code);
  await Promise.all([tab.waitForNavigation({ waitUntil: "networkidle0" }), button.click()]);
  assert.match(tab.url(), /\?id=/);
  // in as host: the host's own controls are there
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000, polling: 100 });
  await tab.waitForSelector(".new-prompt textarea");
}

try {
  const hostContext = await browser.createBrowserContext();
  const guestContext = await browser.createBrowserContext();

  // A kept board.
  const kept = await host(hostContext, "Hana", true);
  const bo = await join(guestContext, kept.code, "Bo");
  await stage(bo, "kept prompt");
  await seesPrompt(kept.tab, "kept prompt");
  await endRoom(kept.tab);
  await waitText(bo, ".room-banner.ended", /has ended/);
  await endedRow(kept.tab, kept.code, /board kept on server/);
  await shot(kept.tab, "ended-row-kept");
  await reopen(kept.tab, kept.code);
  await seesPrompt(kept.tab, "kept prompt");
  // the participant's open page comes back to life without a reload
  await bo.waitForFunction(() => !document.querySelector(".room-banner.ended"), { timeout: 10_000, polling: 100 });
  await bo.waitForSelector(".new-prompt textarea", { timeout: 10_000 });
  await stage(bo, "after reopening");
  await seesPrompt(kept.tab, "after reopening");
  await shot(kept.tab, "reopened-kept");
  console.log(`kept room ${kept.code}: ended, reopened from the row, board back, participant writing again`);
  await bo.close();
  await kept.tab.close();

  // A board the server didn't keep: it comes back from the host's copy.
  const unkept = await host(hostContext, "Hana", false);
  await stage(unkept.tab, "from the host's copy");
  const cy = await join(guestContext, unkept.code, "Cy");
  await seesPrompt(cy, "from the host's copy");
  await cy.close();
  await endRoom(unkept.tab);
  await endedRow(unkept.tab, unkept.code, /board deleted on server/);
  await shot(unkept.tab, "ended-row-not-kept");
  await reopen(unkept.tab, unkept.code);
  await seesPrompt(unkept.tab, "from the host's copy");
  // Someone with no copy at all reads it from the server, so the host's
  // copy really went back to it (a third browser joins by the same code).
  const newcomerContext = await browser.createBrowserContext();
  const dee = await join(newcomerContext, unkept.code, "Dee");
  await seesPrompt(dee, "from the host's copy");
  // and the participant from before gets back in
  const cyBack = await page(guestContext);
  await cyBack.goto(`${baseUrl}/?room=${unkept.code.toLowerCase()}`, { waitUntil: "networkidle0" });
  await cyBack.waitForSelector(".new-prompt textarea", { timeout: 15_000 });
  await seesPrompt(cyBack, "from the host's copy");
  await shot(dee, "reopened-not-kept-newcomer");
  console.log(`unkept room ${unkept.code}: ended (board deleted), reopened, the host's copy restored it on the server`);

  assert.deepEqual(pageErrors, []);
  console.log(`Reopening in the browser passed at ${viewport.width}x${viewport.height}.`);
} finally {
  await browser.close();
}
