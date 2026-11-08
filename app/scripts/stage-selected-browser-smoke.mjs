// "Stage selected text" on the board (App.tsx, selectedText): it stages the
// words of exactly one shape that has some, and says why not otherwise.
//
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev npm run test:stage-selected-browser
//
// A host starts a room from a board file (a sticky note, a labelled
// rectangle, an arrow) without booting anything. Nothing selected: the
// button is disabled and says why. The note: enabled, and it stages the
// note's words. The rectangle: stages its label. Both (shift-click): disabled,
// "not 2 shapes". The arrow: disabled, it has no text. A participant who
// joins stages the note the same way. Every button in the bar fits it,
// none over another, at both sizes (SIZES=desktop or phone for one). The room is ended.
//
// Not told apart: a text box from a note (the same rule; a text box's
// height depends on fonts, so it's hard to click blind), and edits to a
// shape's text after it was selected (the click reads the text again).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = (process.env.RIFF_URL ?? "http://127.0.0.1:8094").replace(/\/$/, "");
const allSizes = [{ name: "desktop", width: 1920, height: 1080 }, { name: "phone", width: 390, height: 844 }];
const sizes = allSizes.filter((size) => !process.env.SIZES || process.env.SIZES.split(",").includes(size.name));
const work = path.join(os.tmpdir(), "opencode");
mkdirSync(work, { recursive: true });

const NOTE = "Sign up flow needs a skip button";
const LABEL = "Login page";
const shape = (id, type, x, y, props, z) => ({ id, typeName: "shape", type, x, y, rot: 0, z, props });
const boardPath = path.join(work, "stage-selected-smoke.json");
// At the board's top-left, where the camera starts, so clicks land on them.
writeFileSync(boardPath, JSON.stringify({
  format: "riff-board", version: 1, exportedAt: new Date().toISOString(), room: { code: "SMOKE" }, prompts: [], queue: [],
  board: { document: { store: {
    "shape:note": shape("shape:note", "note", 30, 110, { text: NOTE, color: "yellow", size: "m", font: "draw", scale: 1 }, 1),
    "shape:geo": shape("shape:geo", "geo", 30, 380, { geo: "rectangle", w: 200, h: 120, label: LABEL, labelSize: "s", color: "black", size: "m", dash: "draw", fill: "none", font: "draw" }, 2),
    "shape:arrow": shape("shape:arrow", "arrow", 250, 600, { dx: 100, dy: 0, bend: 0, color: "black", size: "m", dash: "solid" }, 3),
  } } },
}));
const AT = { note: [130, 210], geo: [130, 440], arrow: [300, 600], empty: [330, 300] };

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const button = (tab) => tab.$eval(".stage-selected", (b) => ({ text: b.textContent, disabled: b.disabled, title: b.title, rect: b.getBoundingClientRect().toJSON() }));
// Every button in the board's bar on screen, none over another (the host's
// Send board one at its longest, with one shape selected).
async function barFits(tab, say, width) {
  const boxes = await tab.$$eval(".board-actions button", (buttons) => buttons.filter((b) => b.offsetParent).map((b) => ({ text: b.textContent, ...b.getBoundingClientRect().toJSON() })));
  for (const box of boxes) assert.ok(box.left >= 0 && box.right <= width, say(`"${box.text}" fits the bar: ${JSON.stringify(boxes)}`));
  const overlap = boxes.some((a, i) => boxes.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
  assert.equal(overlap, false, say(`the bar's buttons don't overlap: ${JSON.stringify(boxes)}`));
}
const staged = (tab) => tab.$$eval(".staging .prompt-card textarea", (areas) => areas.map((area) => area.value));

async function click(tab, where, shift = false) {
  const canvas = await tab.$eval(".quickdraw-surface", (element) => element.getBoundingClientRect().toJSON());
  if (shift) await tab.keyboard.down("Shift");
  await tab.mouse.click(canvas.left + AT[where][0], canvas.top + AT[where][1]);
  if (shift) await tab.keyboard.up("Shift");
}

async function expectButton(tab, say, enabled, why) {
  await tab.waitForFunction((enabled) => document.querySelector(".stage-selected")?.disabled === !enabled, { timeout: 5000, polling: 100 }, enabled)
    .catch(async () => {
      await tab.screenshot({ path: path.join(work, "stage-selected-fail.png") });
      throw new Error(say(`expected ${enabled ? "enabled" : "disabled"}: ${JSON.stringify(await button(tab))}`));
    });
  const state = await button(tab);
  assert.equal(state.text, "Stage selected text", say("the label"));
  if (why) assert.match(state.title, why, say(`says why: ${state.title}`));
}

async function stageAndCheck(tab, say, want) {
  const before = (await staged(tab)).length;
  await tab.click(".stage-selected");
  await tab.waitForFunction((count) => document.querySelectorAll(".staging .prompt-card").length === count + 1, { timeout: 10_000, polling: 100 }, before);
  assert.ok((await staged(tab)).includes(want), say(`staged "${want}": ${JSON.stringify(await staged(tab))}`));
}

const pageErrors = [];
try {
  for (const size of sizes) {
    const say = (message) => `${size.name}: ${message}`;
    const context = await browser.createBrowserContext();
    const tab = await context.newPage();
    tab.on("pageerror", (error) => pageErrors.push(String(error)));
    await tab.evaluateOnNewDocument(() => sessionStorage.removeItem("riff-auto-boot"));
    await tab.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    await tab.goto(baseUrl, { waitUntil: "networkidle0" });
    await tab.click(".entry-card > nav button:nth-child(2)");
    await tab.waitForSelector(".model-choice", { timeout: 10_000 });
    await tab.click(".model-choice label:nth-of-type(2) input");
    const inputs = await tab.$$(".entry-card form input:not([type=radio]):not([type=checkbox]):not([type=file])");
    await inputs[0].click({ clickCount: 3 });
    await inputs[0].type("Stager");
    await inputs[1].click({ clickCount: 3 });
    await inputs[1].type(`${baseUrl}/fake-anthropic`);
    await inputs[2].click({ clickCount: 3 });
    await inputs[2].type("invalid-stage-selected-token");
    await (await tab.$(".import-board input[type=file]")).uploadFile(boardPath);
    await tab.waitForSelector(".import-board .import-summary", { timeout: 20_000 });
    const keep = await tab.$$(".entry-card form label.check input[type=checkbox]").then((boxes) => boxes.at(-1));
    if (await keep.evaluate((element) => element.checked)) await keep.click();
    await tab.click(".entry-card form .primary");
    await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 60_000, polling: 100 });
    await tab.waitForSelector(".qd-dock button[data-name=select]");
    await tab.click(".qd-dock button[data-name=select]");

    await expectButton(tab, say, false, /Select one sticky note, text box or labelled shape/);

    await click(tab, "note");
    await expectButton(tab, say, true);
    await stageAndCheck(tab, say, NOTE);
    await click(tab, "geo");
    await expectButton(tab, say, true);
    await stageAndCheck(tab, say, LABEL);
    await click(tab, "note", true);
    await expectButton(tab, say, false, /not 2 shapes/);
    await click(tab, "empty");
    await click(tab, "arrow");
    await expectButton(tab, say, false, /has no text/);
    await barFits(tab, say, size.width);
    await tab.screenshot({ path: path.join(work, `stage-selected-${size.name}.png`) });

    // A participant, the same way.
    const code = await tab.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
    const other = await browser.createBrowserContext();
    const guest = await other.newPage();
    guest.on("pageerror", (error) => pageErrors.push(String(error)));
    await guest.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    await guest.goto(`${baseUrl}/?room=${code}`, { waitUntil: "networkidle0" });
    await guest.waitForSelector(".entry-card form input");
    await guest.type(".entry-card form input", "Guest");
    await guest.click(".entry-card form .primary");
    await guest.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 20_000, polling: 100 });
    await guest.waitForSelector(".qd-dock button[data-name=select]");
    await guest.click(".qd-dock button[data-name=select]");
    await expectButton(guest, (m) => say(`guest: ${m}`), false);
    await click(guest, "note");
    await expectButton(guest, (m) => say(`guest: ${m}`), true);
    await barFits(guest, (m) => say(`guest: ${m}`), size.width);
    await stageAndCheck(guest, (m) => say(`guest: ${m}`), NOTE);
    await other.close();

    await tab.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === "Room")?.click());
    await tab.click(".participants");
    await tab.waitForSelector(".end-room > button");
    await tab.click(".end-room > button");
    await tab.click(".end-room button.danger");
    await context.close();
    console.log(say("ok"));
  }
  assert.deepEqual(pageErrors, [], "no page errors");
  console.log("stage-selected smoke passed");
} finally {
  await browser.close();
}
