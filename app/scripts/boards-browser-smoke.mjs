// Your rooms and the boards this browser keeps, export and import (docs/adr/0003, second
// amendment), in two browsers: a guest exports a room with an image, a
// staged prompt and a queued one; after the room ends the guest's browser
// still lists its copy, opens it read-only with no server and exports it
// again; deleting the copy takes this browser's place in the room with it;
// the host starts a new room from the file, and what arrives in it (seen
// by a guest, so it went through the server) is the same board, images
// byte for byte, with the queued prompt staged. A board too big for a room
// is refused before any room exists. Guests only, so it runs against dev
// or live:
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev W=390 H=844 SHOTS=dir npm run test:boards-browser
// What the file may contain is checked in scripts/board-file.test.mjs.
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
  // Catch downloads in the page: the export is a blob link that is clicked.
  await opened.evaluateOnNewDocument(() => {
    window.__downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith("blob:")) {
        const name = this.download;
        window.__downloads.push(fetch(this.href).then((response) => response.text()).then((text) => ({ name, text })));
        return;
      }
      return click.call(this);
    };
  });
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
const clickText = (target, selector, pattern) => target.evaluate((sel, source) => {
  const found = [...document.querySelectorAll(sel)].find((element) => new RegExp(source).test(element.textContent));
  if (!found) throw new Error(`nothing matching ${sel} ${source}`);
  found.click();
}, selector, pattern.source);

async function lastDownload(tab, count) {
  await tab.waitForFunction((n) => window.__downloads.length >= n, { timeout: 10_000, polling: 100 }, count);
  const { name, text } = await tab.evaluate((n) => window.__downloads[n - 1], count);
  return { name, file: JSON.parse(text) };
}

async function hostForm(tab, name) {
  await tab.goto(baseUrl, { waitUntil: "networkidle0" });
  await tab.click(".entry-card > nav button:nth-child(2)");
  // Riff's own models are the default when the server has a key; this
  // smoke runs Claude against a fake endpoint of its own.
  await tab.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await tab.$$(".entry-card form input:not([type=radio])");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(name);
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].click({ clickCount: 3 });
  await inputs[2].type("invalid-boards-smoke-token");
}

async function createRoom(tab) {
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  return (await textOf(tab, ".room-name span")).replace("Room ", "");
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
  await tab.waitForFunction((value) => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === value), { timeout: 10_000, polling: 100 }, text);
}

// A read-only board still moves: a drag pans it, ctrl and the wheel zoom
// it (lookOnly.ts puts the camera on the board as data-camera).
async function looksAround(tab, scope) {
  const surface = `${scope} [data-camera]`;
  await tab.waitForSelector(surface);
  const camera = () => tab.$eval(surface, (element) => element.dataset.camera.split(",").map(Number));
  const box = await (await tab.$(surface)).boundingBox();
  const [x, y, z] = await camera();
  await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await tab.mouse.down();
  await tab.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 60, { steps: 6 });
  await tab.mouse.up();
  const [x2, y2] = await camera();
  assert.ok(Math.abs(x2 - x) > 20 || Math.abs(y2 - y) > 20, `a drag pans the board (${x},${y} -> ${x2},${y2})`);
  await tab.keyboard.down("Control");
  await tab.mouse.wheel({ deltaY: -200 });
  await tab.keyboard.up("Control");
  await tab.waitForFunction((sel, before) => Number(document.querySelector(sel).dataset.camera.split(",")[2]) !== before, { timeout: 2000, polling: 50 }, surface, (await camera())[2]).catch(() => {});
  const [, , z2] = await camera();
  assert.notEqual(z2, z, "ctrl and the wheel zoom it");
  // and nothing on it moved: the hand tool, never select
  assert.equal(await tab.$eval(surface, (element) => element.style.cursor || getComputedStyle(element).cursor), "grab");
}

const prompts = (tab) => tab.$$eval(".prompt-card textarea", (elements) => elements.map((element) => element.value));

async function pasteImage(tab, side) {
  await tab.evaluate(async (size) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    const pixels = context.createImageData(size, size);
    for (let offset = 0; offset < pixels.data.length; offset += 65536) crypto.getRandomValues(pixels.data.subarray(offset, offset + 65536));
    for (let index = 3; index < pixels.data.length; index += 4) pixels.data[index] = 255;
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "screenshot.png", { type: "image/png" }));
    document.querySelector(".quickdraw-surface canvas").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, side);
}

async function openPeople(tab) {
  if (!(await tab.$(".people-panel"))) await tab.click(".participants");
  await tab.waitForSelector(".people-panel");
}

// Put a file in the host form's import input, as choosing one would.
async function chooseFile(tab, text, name = "board.json") {
  await tab.evaluate((content, fileName) => {
    const input = document.querySelector(".import-board input[type=file]");
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], fileName, { type: "application/json" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, text, name);
}

const assetsOf = (file) => Object.values(file.board.document.store).filter((record) => record.typeName === "asset");
const shapesOf = (file) => Object.values(file.board.document.store).filter((record) => record.typeName === "shape");

try {
  const hostContext = await browser.createBrowserContext();
  const guestContext = await browser.createBrowserContext();

  // A room with an image, a staged prompt and a queued one.
  const hana = await page(hostContext);
  await hostForm(hana, "Hana");
  const code = await createRoom(hana);
  const bo = await join(guestContext, code, "Bo");
  await pasteImage(bo, 64);
  await stage(bo, "staged idea");
  await stage(bo, "queued idea");
  // On a phone staging is below the board: the board's bar takes you down
  // to it, with the count. Beside the board on a wide screen: no button.
  await bo.evaluate(() => { document.querySelector(".workspace")?.scrollTo(0, 0); scrollTo(0, 0); });
  const toStaging = await bo.$(".board-actions .to-staging");
  const toStagingShown = await toStaging.evaluate((element) => element.checkVisibility());
  if (viewport.width <= 780) {
    assert.ok(toStagingShown, "a phone has a way down to staging");
    assert.match(await toStaging.evaluate((element) => element.textContent), /Add prompt\s*2/);
    assert.ok(await bo.$eval(".staging", (element) => element.getBoundingClientRect().top >= innerHeight), "staging starts out of view");
    await toStaging.click();
    await bo.waitForFunction(() => {
      const box = document.querySelector(".new-prompt textarea").getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && document.activeElement?.matches(".new-prompt textarea");
    }, { timeout: 5_000, polling: 100 }).catch(async (error) => {
      console.error(await bo.evaluate(() => ({ top: document.querySelector(".new-prompt textarea").getBoundingClientRect().top, active: document.activeElement?.outerHTML.slice(0, 80), ws: document.querySelector(".workspace").scrollTop, doc: document.scrollingElement.scrollTop })));
      throw error;
    });
    await shot(bo, "to-staging");
    console.log("phone: Add prompt takes you down to staging, ready to type");
  } else assert.equal(toStagingShown, false, "staging is beside the board, no button");
  await hana.waitForFunction(() => document.querySelectorAll(".prompt-card").length === 2, { timeout: 10_000, polling: 100 });
  await hana.evaluate(() => [...document.querySelectorAll(".prompt-card")].find((card) => card.querySelector("textarea").value === "queued idea").querySelector("footer button").click());
  await bo.waitForFunction(() => [...document.querySelectorAll(".queue-row p")].some((element) => element.textContent.includes("queued idea")), { timeout: 10_000, polling: 100 });

  // Anyone exports, from the People panel.
  await openPeople(bo);
  await shot(bo, "people-export");
  await bo.click(".people-panel .export-board button");
  const exported = await lastDownload(bo, 1);
  assert.match(exported.name, new RegExp(`^riff-${code}-\\d{4}-\\d\\d-\\d\\d\\.json$`));
  assert.equal(exported.file.format, "riff-board");
  assert.equal(exported.file.room.code, code);
  assert.deepEqual(exported.file.prompts.map((prompt) => prompt.text), ["staged idea"]);
  assert.deepEqual(exported.file.queue.map((prompt) => [prompt.author, prompt.text]), [["Bo", "queued idea"]]);
  const [image] = assetsOf(exported.file);
  assert.match(image.src, /^data:image\/png;base64,/);
  assert.equal(shapesOf(exported.file).filter((shape) => shape.type === "image").length, 1);
  console.log(`exported ${exported.name}: ${shapesOf(exported.file).length} shape, 1 image, 1 staged and 1 queued prompt`);

  // The guest's start page lists the board, and Open goes to the live room.
  await bo.goto(baseUrl, { waitUntil: "networkidle0" });
  await waitText(bo, ".your-rooms li", new RegExp(`Room ${code}.*Hana is hosting.*copy on this browser`));
  await shot(bo, "boards-list");
  // One line of buttons whatever the width: Enter, and the rest under More.
  const shown = () => bo.$$eval(".your-rooms li .actions button, .your-rooms li summary", (elements) => elements.filter((element) => element.checkVisibility()).map((element) => element.textContent));
  assert.deepEqual(await shown(), ["Enter", "More"]);
  await bo.click(".your-rooms li summary");
  assert.deepEqual(await shown(), ["Enter", "More", "Open", "Export board", "Leave room", "Delete"]);
  await shot(bo, "row-more");
  await bo.keyboard.press("Escape");
  assert.deepEqual(await shown(), ["Enter", "More"], "Escape closes the menu");
  await Promise.all([bo.waitForNavigation(), clickText(bo, ".your-rooms li .actions button", /^Enter$/)]);
  assert.match(bo.url(), /\?id=/, "a room you're still in enters the room");
  await bo.waitForSelector(".new-prompt textarea");

  // The host ends the room. The guest's copy stays, opens without a server,
  // read-only, and exports the same board (no queue: that isn't copied).
  await openPeople(hana);
  await hana.click(".end-room > button");
  await Promise.all([hana.waitForNavigation({ waitUntil: "networkidle0" }), hana.click(".end-room button.danger")]);
  await waitText(bo, ".room-banner.ended", /has ended/);
  await shot(bo, "ended-banner-export");
  await bo.goto(baseUrl, { waitUntil: "networkidle0" });
  await waitText(bo, ".your-rooms li", new RegExp(`Room ${code}.*Not live`));
  assert.equal(await bo.$$eval(".your-rooms li .actions button", (buttons) => buttons.some((button) => button.textContent === "Enter")), false, "an ended room can't be entered");
  if (viewport.width > 780) {
    // A wide screen opens the copy beside the forms, then as its own page.
    await clickText(bo, ".your-rooms li .actions button", /^Open$/);
    await waitText(bo, ".board-peek header", new RegExp(`Room ${code}.*from this browser's copy`));
    await bo.waitForSelector(".board-peek .quickdraw-surface");
    assert.ok(await bo.$(".entry-card > nav"), "the forms stay beside the board");
    assert.equal(await bo.$(".board-peek .enter"), null, "no Enter for an ended room");
    await shot(bo, "board-peek");
    await looksAround(bo, ".board-peek");
    await Promise.all([bo.waitForNavigation(), bo.click(".board-peek .full-page")]);
  } else {
    await Promise.all([bo.waitForNavigation(), clickText(bo, ".your-rooms li .actions button", /^Open$/)]);
  }
  assert.match(bo.url(), /\?copy=room%2F/, "an ended room opens as this browser's copy");
  await waitText(bo, ".copy-bar", new RegExp(`Copy of room ${code}.*copy this browser kept`));
  assert.ok(await bo.$(".site-bar .account"), "the copy's page has the start page's header");
  await shot(bo, "copy-view");
  await looksAround(bo, ".copy-board");
  // The prompts open on request, beside the board (in its place on a phone).
  assert.equal(await bo.$(".prompt-card"), null, "the prompts don't cover the board");
  await waitText(bo, ".copy-bar .prompts-toggle", /Prompts\s*1/);
  await bo.click(".copy-bar .prompts-toggle");
  await bo.waitForFunction(() => document.querySelectorAll(".prompt-card").length === 1 && !document.querySelector(".new-prompt"), { timeout: 10_000, polling: 100 });
  assert.deepEqual(await prompts(bo), ["staged idea"]);
  await shot(bo, "copy-view-prompts");
  await bo.click(".copy-bar .copy-export");
  const fromCopy = await lastDownload(bo, 1);
  assert.equal(assetsOf(fromCopy.file)[0].src, image.src, "the copy's image is the room's, byte for byte");
  assert.deepEqual(fromCopy.file.queue, []);
  console.log("room ended: the copy opens read-only with no server and exports the same board");

  // Deleting the copy takes this browser's place in the room with it.
  await bo.goto(baseUrl, { waitUntil: "networkidle0" });
  await clickText(bo, ".your-rooms li .actions button", /^Delete$/);
  await waitText(bo, ".your-rooms .asking", /forget that you're in this room\. If the host reopens it/);
  await shot(bo, "delete-confirm");
  await bo.click(".your-rooms .asking button.danger");
  await bo.waitForFunction(() => !document.querySelector(".your-rooms"), { timeout: 10_000, polling: 100 });
  const left = await bo.evaluate(async () => ({
    secrets: Object.keys(localStorage).filter((key) => key.startsWith("riff-member:")).length,
    databases: (await indexedDB.databases()).filter((database) => database.name.startsWith("room/")).length,
  }));
  assert.deepEqual(left, { secrets: 0, databases: 0 });
  console.log("deleted: no copy, no membership left in this browser");

  // A board too big for a room is refused before any room is made.
  await hostForm(hana, "Hana");
  const tooBig = await hana.evaluate(async (file) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1000;
    const context = canvas.getContext("2d");
    const pixels = context.createImageData(1000, 1000);
    for (let offset = 0; offset < pixels.data.length; offset += 65536) crypto.getRandomValues(pixels.data.subarray(offset, offset + 65536));
    for (let index = 3; index < pixels.data.length; index += 4) pixels.data[index] = 255;
    context.putImageData(pixels, 0, 0);
    const big = structuredClone(file);
    const asset = Object.values(big.board.document.store).find((record) => record.typeName === "asset");
    Object.assign(asset, { src: canvas.toDataURL("image/png"), w: 1000, h: 1000 });
    return JSON.stringify(big);
  }, exported.file);
  await chooseFile(hana, tooBig);
  await waitText(hana, ".import-board .form-error", /That board holds [45](\.\d)? MB; a room holds 4 MB/);
  await shot(hana, "import-too-big");
  console.log(`too big: "${await textOf(hana, ".import-board .form-error")}"`);

  // Start a new room from the exported file, plus an SVG the file shouldn't
  // be able to bring in.
  const withSvg = structuredClone(exported.file);
  withSvg.board.document.store["asset:svg"] = { id: "asset:svg", typeName: "asset", src: `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")}`, w: 10, h: 10 };
  withSvg.board.document.store["shape:svg"] = { id: "shape:svg", typeName: "shape", type: "image", x: 0, y: 0, rot: 0, z: 9, props: { w: 10, h: 10, assetId: "asset:svg" } };
  await chooseFile(hana, JSON.stringify(withSvg));
  await waitText(hana, ".import-summary", new RegExp(`From room ${code}.*1 thing on the board, 1 image, 2 prompts.*Left out: 1 image that isn't PNG, JPEG, WebP or GIF`));
  await shot(hana, "import-summary");
  console.log(`import: "${await textOf(hana, ".import-summary")}"`);
  const newCode = await createRoom(hana);
  assert.notEqual(newCode, code);
  await hana.waitForFunction(() => document.querySelectorAll(".prompt-card").length === 2, { timeout: 10_000, polling: 100 });
  assert.deepEqual(await prompts(hana), ["staged idea", "queued idea"], "the queued prompt comes in staged, after the staged one");

  // A guest in the new room gets it from the server and exports it.
  const cy = await join(guestContext, newCode, "Cy");
  await cy.waitForFunction(() => document.querySelectorAll(".prompt-card").length === 2, { timeout: 10_000, polling: 100 });
  await openPeople(cy);
  await cy.click(".people-panel .export-board button");
  const again = await lastDownload(cy, 1);
  assert.equal(again.file.room.code, newCode);
  assert.deepEqual(assetsOf(again.file).map((asset) => asset.src), [image.src], "same image, byte for byte; the SVG stayed out");
  assert.deepEqual(shapesOf(again.file).map((shape) => shape.id).sort(), shapesOf(exported.file).map((shape) => shape.id).sort());
  assert.deepEqual(again.file.prompts.map((prompt) => prompt.text), ["staged idea", "queued idea"]);
  await shot(cy, "imported-room");
  console.log(`new room ${newCode} from the file: a guest sees the same board through the server`);

  // Clean up: end the new room.
  await openPeople(hana);
  await hana.click(".end-room > button");
  await Promise.all([hana.waitForNavigation({ waitUntil: "networkidle0" }), hana.click(".end-room button.danger")]);

  assert.deepEqual(pageErrors, []);
  console.log(`boards browser smoke passed at ${viewport.width}x${viewport.height}`);
} finally {
  await browser.close();
}
