// What the room's lifecycle looks like to the people in it (docs/adr/0003),
// in two browsers: the host chooses whether the board is kept, a joiner is
// told before drawing, the host leaving shows a countdown and coming back
// clears it, and ending the room leaves a kept board read-only and a
// not-kept one closed. Guests only, so it runs against dev or live:
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev W=390 H=844 SHOTS=dir npm run test:lifecycle-browser
// The server side (deleting rows, refusing writes, the grace period) is
// checked in spec/rooms.test.ts and scripts/rooms.test.mjs; the five-minute
// grace itself is too long to wait for here.
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
  const inputs = await tab.$$(".entry-card form input");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(name);
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].type("invalid-lifecycle-smoke-token");
  const checkbox = await tab.$(".entry-card form label.check input");
  assert.equal(await checkbox.evaluate((element) => element.checked), true, "keeping the board is the default");
  if (!keep) await checkbox.click();
  await shot(tab, `host-form-${keep ? "kept" : "not-kept"}`);
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const code = (await textOf(tab, ".room-name span")).replace("Room ", "");
  return { tab, code, url: tab.url() };
}

async function join(context, code, name, fate) {
  const tab = await page(context);
  await tab.goto(`${baseUrl}/?room=${code.toLowerCase()}`, { waitUntil: "networkidle0" });
  await tab.waitForSelector(".entry-card form");
  // Told what happens to the board before going in.
  assert.match(await textOf(tab, ".entry-card form .board-fate"), fate);
  await shot(tab, `join-${code}`);
  const inputs = await tab.$$(".entry-card form input");
  // The browser remembers the last name it used; replace it.
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
  await tab.waitForFunction((value) => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === value), { timeout: 10_000 }, text);
}

async function openPeople(tab) {
  if (!(await tab.$(".people-panel"))) await tab.click(".participants");
  await tab.waitForSelector(".people-panel");
}

async function endRoom(tab, code) {
  await openPeople(tab);
  await tab.click(".end-room > button");
  await tab.waitForSelector(".end-room.asking");
  await shot(tab, `end-confirm-${code}`);
  await Promise.all([tab.waitForNavigation({ waitUntil: "networkidle0" }), tab.click(".end-room button.danger")]);
  assert.match(await textOf(tab, ".ended-note"), new RegExp(`Room ${code} has ended`));
}

try {
  const hostContext = await browser.createBrowserContext();
  const guestContext = await browser.createBrowserContext();

  // A kept board: the host goes away and comes back, then ends the room.
  const kept = await host(hostContext, "Hana", true);
  const bo = await join(guestContext, kept.code, "Bo", /keeps this board after the room ends/);
  await stage(bo, "kept prompt");
  if (viewport.width > 780) assert.match(await textOf(bo, ".room-name"), /board kept/);
  await openPeople(bo);
  assert.match(await textOf(bo, ".people-panel .board-fate"), /keeps this board/);
  assert.equal(await bo.$(".people-panel .board-fate button"), null, "only the host changes it");
  assert.equal(await bo.$(".end-room"), null, "only the host ends the room");
  await bo.click(".people-panel .section-title button");

  await kept.tab.close();
  await waitText(bo, ".room-banner.away", /room ends in [0-4]:\d\d/);
  await shot(bo, "host-away");
  console.log(`kept room ${kept.code}: host left, guest sees "${await textOf(bo, ".room-banner")}"`);
  const back = await page(hostContext);
  await back.goto(kept.url, { waitUntil: "networkidle0" });
  await bo.waitForFunction(() => !document.querySelector(".room-banner"), { timeout: 10_000, polling: 100 });
  console.log("host came back: banner gone");

  await endRoom(back, kept.code);
  await waitText(bo, ".room-banner.ended", /has ended\. The server keeps this board/);
  await bo.waitForFunction(() => !document.querySelector(".new-prompt"), { timeout: 5_000, polling: 100 });
  assert.equal(await bo.$eval(".prompt-card textarea", (element) => element.readOnly && element.value), "kept prompt");
  assert.match(await textOf(bo, ".board-actions"), /you can look, but not change anything/);
  await shot(bo, "ended-kept");
  // Reloading still shows the board, read-only.
  await bo.reload({ waitUntil: "networkidle0" });
  await waitText(bo, ".room-banner.ended", /keeps this board/);
  await bo.waitForFunction(() => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === "kept prompt" && element.readOnly), { timeout: 10_000, polling: 100 });
  console.log("kept room ended: guest's board read-only, still there after a reload");
  await bo.close();
  await back.close();

  // A board the server doesn't keep, and a host who tries to change that
  // after someone joined.
  const unkept = await host(hostContext, "Hana", false);
  if (viewport.width > 780) assert.match(await textOf(unkept.tab, ".room-name"), /board not kept/);
  const cy = await join(guestContext, unkept.code, "Cy", /deletes this board when the room ends/);
  await stage(cy, "gone soon");
  await openPeople(unkept.tab);
  assert.match(await textOf(unkept.tab, ".people-panel .board-fate"), /deletes this board/);
  await unkept.tab.click(".people-panel .board-fate button");
  await waitText(unkept.tab, ".people-panel .form-error", /can't start keeping the board now/);
  await shot(unkept.tab, "keep-refused");
  await endRoom(unkept.tab, unkept.code);
  await waitText(cy, ".entry-card h2", /This room has ended/);
  assert.match(await textOf(cy, ".entry-card"), /doesn't keep this board/);
  await shot(cy, "ended-not-kept");
  await cy.reload({ waitUntil: "networkidle0" });
  await waitText(cy, ".entry-card h2", /This room has ended/);
  console.log("unkept room ended: keep refused after a join, guest let go, still closed after a reload");

  assert.deepEqual(pageErrors, []);
  console.log(`Room lifecycle in the browser passed at ${viewport.width}x${viewport.height}.`);
} finally {
  await browser.close();
}
