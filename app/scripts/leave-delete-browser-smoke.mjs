// Leaving and deleting a room (docs/adr/0003 and 0008), in browsers: a
// member leaves from the People panel and from their rooms list, and comes
// back by the code under the same name; the host deletes the room from the
// server through their row's Delete, a member's open page is told so, and
// the member's own copy stays. Guests only, so it runs against dev or live:
//   RIFF_URL=http://127.0.0.1:8099 W=390 H=844 SHOTS=dir npm run test:leave-delete-browser
// The server side is spec/rooms.test.ts and scripts/rooms.test.mjs.
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
  await inputs[2].type("invalid-leave-smoke-token");
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

// A row's action, in sight or in its More menu.
async function rowAction(tab, code, label) {
  await tab.waitForFunction((room) => [...document.querySelectorAll(".your-rooms li")].some((li) => li.textContent.includes(`Room ${room}`)), { timeout: 10_000, polling: 100 }, code);
  const clicked = await tab.evaluate((room, text) => {
    const li = [...document.querySelectorAll(".your-rooms li")].find((row) => row.textContent.includes(`Room ${room}`));
    const more = li.querySelector("details.row-more");
    if (more) more.open = true;
    const button = [...li.querySelectorAll(".actions button")].find((candidate) => candidate.textContent === text);
    button?.click();
    return Boolean(button);
  }, code, label);
  assert.ok(clicked, `no ${label} on room ${code}'s row`);
}

async function openPeople(tab) {
  if (!(await tab.$(".people-panel"))) await tab.click(".participants");
  await tab.waitForSelector(".people-panel");
}

try {
  const hostContext = await browser.createBrowserContext();
  const guestContext = await browser.createBrowserContext();

  const room = await host(hostContext, "Hana", true);
  let bo = await join(guestContext, room.code, "Bo");
  await stage(bo, "Bo's idea");
  await openPeople(room.tab);
  await room.tab.waitForFunction(() => [...document.querySelectorAll(".people-panel li")].some((li) => li.textContent.includes("Bo")), { timeout: 10_000, polling: 100 });

  // Leaving from the People panel: asked first, then the start page, and
  // the host's list of people no longer has them.
  await openPeople(bo);
  await bo.click(".leave-room > button");
  await waitText(bo, ".leave-room.asking", /To come back, you'd need the code or an invite/);
  await shot(bo, "leave-question");
  await Promise.all([bo.waitForNavigation({ waitUntil: "networkidle0" }), bo.click(".leave-room button.danger")]);
  assert.equal(new URL(bo.url()).search, "", "back on the start page");
  await room.tab.waitForFunction(() => ![...document.querySelectorAll(".people-panel li")].some((li) => li.textContent.includes("Bo")), { timeout: 10_000, polling: 100 });
  // the row is this browser's copy only now: no Enter, no Leave
  await waitText(bo, ".your-rooms li", new RegExp(`Room ${room.code}.*Not live`));
  console.log(`room ${room.code}: Bo left from the People panel, gone from the host's people, the copy kept`);

  // Back by the code, under the same name; then leaving from the row.
  await bo.close();
  bo = await join(guestContext, room.code, "Bo");
  await seesPrompt(bo, "Bo's idea");
  await bo.goto(baseUrl, { waitUntil: "networkidle0" });
  await rowAction(bo, room.code, "Leave room");
  await waitText(bo, ".your-rooms .asking", /To come back, you'd need the code or an invite/);
  await bo.click(".your-rooms .asking button.danger");
  await waitText(bo, ".your-rooms li", new RegExp(`Room ${room.code}.*Not live`));
  assert.equal(await bo.evaluate((id) => localStorage.getItem(`riff-member:${id}`), new URL(room.tab.url()).searchParams.get("id")), null, "the secret is forgotten");
  console.log("Bo came back by the code under the same name, then left from the row");

  // Bo joins once more and keeps the room open; the host deletes the room
  // from the server through the row's Delete.
  await bo.close();
  bo = await join(guestContext, room.code, "Bo");
  await room.tab.goto(baseUrl, { waitUntil: "networkidle0" });
  await rowAction(room.tab, room.code, "Delete");
  await room.tab.waitForSelector(".your-rooms .asking .also-server input");
  assert.equal(await room.tab.$(".your-rooms .asking .server-delete-note"), null, "this browser only, until asked");
  await room.tab.click(".your-rooms .asking .also-server input");
  await waitText(room.tab, ".your-rooms .asking .server-delete-note", /gone from the server for good.*Members keep any copy of the board their own browsers have/);
  await shot(room.tab, "delete-from-server-question");
  await room.tab.click(".your-rooms .asking button.danger");
  await room.tab.waitForFunction((code) => ![...document.querySelectorAll(".your-rooms li")].some((li) => li.textContent.includes(`Room ${code}`)), { timeout: 10_000, polling: 100 }, room.code);
  await waitText(bo, ".entry-card h2", /The host deleted this room/);
  await shot(bo, "deleted-member-page");
  // the member's own copy is still theirs
  await bo.goto(baseUrl, { waitUntil: "networkidle0" });
  await waitText(bo, ".your-rooms li", new RegExp(`Room ${room.code}.*Not live`));
  console.log(`room ${room.code} deleted by its host: the member was told, kept their copy, and the host's row is gone`);

  // The code leads nowhere now.
  const late = await page(await browser.createBrowserContext());
  await late.goto(`${baseUrl}/?room=${room.code.toLowerCase()}`, { waitUntil: "networkidle0" });
  await waitText(late, ".entry-card", /No live room.*no live room with that code/);
  assert.deepEqual(pageErrors, []);
  console.log(`Leaving and deleting in the browser passed at ${viewport.width}x${viewport.height}.`);
} finally {
  await browser.close();
}
