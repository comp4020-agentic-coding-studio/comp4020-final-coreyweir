// Boards on this browser, export and import (docs/adr/0003, second
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
  const inputs = await tab.$$(".entry-card form input");
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
  await waitText(bo, ".local-boards li", new RegExp(`Room ${code}.*joined`));
  await shot(bo, "boards-list");
  await Promise.all([bo.waitForNavigation(), clickText(bo, ".local-boards li .actions button", /^Open$/)]);
  assert.match(bo.url(), /\?id=/, "a room you're still in opens as the room");
  await bo.waitForSelector(".new-prompt textarea");

  // The host ends the room. The guest's copy stays, opens without a server,
  // read-only, and exports the same board (no queue: that isn't copied).
  await openPeople(hana);
  await hana.click(".end-room > button");
  await Promise.all([hana.waitForNavigation({ waitUntil: "networkidle0" }), hana.click(".end-room button.danger")]);
  await waitText(bo, ".room-banner.ended", /has ended/);
  await shot(bo, "ended-banner-export");
  await bo.goto(baseUrl, { waitUntil: "networkidle0" });
  await waitText(bo, ".local-boards li", new RegExp(`Room ${code}`));
  await Promise.all([bo.waitForNavigation(), clickText(bo, ".local-boards li .actions button", /^Open$/)]);
  assert.match(bo.url(), /\?copy=room%2F/, "an ended room opens as this browser's copy");
  await waitText(bo, ".room-banner", /copy this browser kept of room/);
  await bo.waitForFunction(() => document.querySelectorAll(".prompt-card").length === 1 && !document.querySelector(".new-prompt"), { timeout: 10_000, polling: 100 });
  assert.deepEqual(await prompts(bo), ["staged idea"]);
  await shot(bo, "copy-view");
  await bo.click(".topbar .share");
  const fromCopy = await lastDownload(bo, 1);
  assert.equal(assetsOf(fromCopy.file)[0].src, image.src, "the copy's image is the room's, byte for byte");
  assert.deepEqual(fromCopy.file.queue, []);
  console.log("room ended: the copy opens read-only with no server and exports the same board");

  // Deleting the copy takes this browser's place in the room with it.
  await bo.goto(baseUrl, { waitUntil: "networkidle0" });
  await clickText(bo, ".local-boards li .actions button", /^Delete$/);
  await waitText(bo, ".local-boards .asking", /and its place in the room/);
  await shot(bo, "delete-confirm");
  await bo.click(".local-boards .asking button.danger");
  await bo.waitForFunction(() => !document.querySelector(".local-boards"), { timeout: 10_000, polling: 100 });
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
