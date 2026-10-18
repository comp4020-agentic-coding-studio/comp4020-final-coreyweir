// A room's size limit as the people in it see it (docs/adr/0003,
// amendment), in two browsers: an image that fits reaches the room; one
// that doesn't is turned away on the page that pasted it, with a message,
// and the room stays writable; when a write does cross the limit the room
// turns read-only for everyone, the host included, and stays so after a
// reload. Guests only, so it runs against dev or live:
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev W=390 H=844 SHOTS=dir npm run test:limits-browser
// A node client with the host's secret fills the room, standing in for a
// board of screenshots. The server's refusal itself is checked in
// spec/limits.test.ts and scripts/rooms.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import puppeteer from "puppeteer-core";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const viewport = { width: Number(process.env.W ?? 1920), height: Number(process.env.H ?? 1080), deviceScaleFactor: 1 };
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const MB = 1024 * 1024;
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

async function host(context, name) {
  const tab = await page(context);
  await tab.goto(baseUrl, { waitUntil: "networkidle0" });
  await tab.click(".entry-card > nav button:nth-child(2)");
  const inputs = await tab.$$(".entry-card form input");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(name);
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].type("invalid-limits-smoke-token");
  // Not kept, so ending the room afterwards deletes what this filled it with.
  await tab.click(".entry-card form label.check input");
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const code = (await textOf(tab, ".room-name span")).replace("Room ", "");
  const roomId = new URL(tab.url()).searchParams.get("id");
  const secret = await tab.evaluate((id) => localStorage.getItem(`riff-member:${id}`), roomId);
  return { tab, code, roomId, secret };
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

// Pastes a PNG of random pixels (so it doesn't compress) onto the board,
// the way a screenshot arrives.
async function pasteImage(tab, side) {
  return tab.evaluate(async (size) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    const pixels = context.createImageData(size, size);
    crypto.getRandomValues(pixels.data.subarray(0, Math.min(pixels.data.length, 65536)));
    for (let offset = 65536; offset < pixels.data.length; offset += 65536) crypto.getRandomValues(pixels.data.subarray(offset, offset + 65536));
    for (let index = 3; index < pixels.data.length; index += 4) pixels.data[index] = 255;
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "screenshot.png", { type: "image/png" }));
    document.querySelector(".quickdraw-surface canvas").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    return blob.size;
  }, side);
}

function socketClass(origin) {
  return class extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { origin } });
    }
  };
}

// The room's shared document from node, as the host.
async function openShared(roomId, secret) {
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: `${baseUrl.replace(/^http/, "ws")}/collaboration`, WebSocketPolyfill: socketClass(baseUrl) });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: `room/${roomId}/shared`, document: doc, token: secret });
  provider.attach();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the shared document never synced")), 10_000);
    provider.on("synced", ({ state }) => state && (clearTimeout(timer), resolve()));
  });
  const saved = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("write never acknowledged")), 30_000);
    const check = () => provider.unsyncedChanges === 0 && (clearTimeout(timer), provider.off("unsyncedChanges", check), resolve());
    provider.on("unsyncedChanges", check);
    check();
  });
  const images = () => [...doc.getMap("boardRecords").values()].filter((record) => record.typeName === "asset").length;
  return { doc, saved, images, close: () => { provider.destroy(); socket.destroy(); } };
}

async function me(roomId, secret) {
  const response = await fetch(`${baseUrl}/api/rooms/${roomId}/me`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(response.status, 200);
  return (await response.json()).room;
}

let filler;
let hana;
try {
  const hostContext = await browser.createBrowserContext();
  const guestContext = await browser.createBrowserContext();
  hana = await host(hostContext, "Hana");
  const bo = await join(guestContext, hana.code, "Bo");
  filler = await openShared(hana.roomId, hana.secret);
  const room = await me(hana.roomId, hana.secret);
  assert.equal(room.limitBytes, 4 * MB);
  assert.equal(room.full, false);

  // A prompt in the host's queue, to see the queue stop with the board.
  await bo.type(".new-prompt textarea", "queued before the board filled");
  await bo.click(".new-prompt button");
  await hana.tab.waitForSelector(".prompt-card footer button:not([disabled])", { timeout: 10_000 });
  await hana.tab.click(".prompt-card footer button");
  await hana.tab.waitForSelector(".queue-row .load-prompt");

  // A small image fits.
  const small = await pasteImage(bo, 48);
  await filler.saved();
  await waitFor(() => filler.images() === 1, "the small image reaching the room");
  console.log(`a ${small}-byte image reached the room`);

  // Fill the room to about 3 MB, then paste something that wouldn't fit.
  const assets = filler.doc.getMap("assets");
  for (let index = 0; index < 6; index += 1) assets.set(`filler-${index}`, randomBytes(384 * 1024).toString("base64"));
  await filler.saved();
  // The page can only judge by what has reached it, so wait until it has
  // the filling (it shows in the People panel) before pasting.
  await bo.click(".participants");
  await waitText(bo, ".people-panel .board-size", /It holds 3(\.\d+)? MB of the 4 MB/);
  await shot(bo, "room-size");
  await bo.click(".people-panel .section-title button");
  const big = await pasteImage(bo, 520);
  await waitText(bo, ".board-notice", /doesn't fit: this room holds 4 MB and has about [\d.]+ MB left/);
  await shot(bo, "image-refused");
  console.log(`a ${big}-byte image was turned away: "${await textOf(bo, ".board-notice")}"`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(filler.images(), 1, "the refused image never reached the room");
  assert.equal((await me(hana.roomId, hana.secret)).full, false, "turning an image away keeps the room writable");
  assert.equal(await bo.$(".room-banner.full"), null);
  await bo.type(".new-prompt textarea", "still writable");
  await bo.click(".new-prompt button");
  await hana.tab.waitForFunction(() => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === "still writable"), { timeout: 10_000, polling: 100 });

  // A write that crosses the limit turns the room read-only for everyone.
  assets.set("too-much", randomBytes(MB).toString("base64"));
  await waitFor(async () => (await me(hana.roomId, hana.secret)).full, "the room turning full");
  for (const [who, tab] of [["host", hana.tab], ["guest", bo]]) {
    await waitText(tab, ".room-banner.full", /This board is full \(4 MB\)/);
    assert.match(await textOf(tab, ".board-actions"), /This board is full/);
    assert.equal(await tab.$(".new-prompt"), null, `${who}: no new prompts`);
    assert.equal(await tab.$eval(".prompt-card textarea", (element) => element.readOnly), true, `${who}: prompts read-only`);
  }
  assert.equal(await hana.tab.$(".load-prompt"), null, "the host's queue stops too");
  await shot(hana.tab, "full-host");
  await shot(bo, "full-guest");
  await bo.reload({ waitUntil: "networkidle0" });
  await waitText(bo, ".room-banner.full", /This board is full/);
  console.log(`room ${hana.code} full: read-only for host and guest, still after a reload`);

  assert.deepEqual(pageErrors, []);
  console.log(`A room's size limit in the browser passed at ${viewport.width}x${viewport.height}.`);
} finally {
  filler?.close();
  if (hana) {
    // End it: a room that isn't kept takes what filled it with it.
    await fetch(`${baseUrl}/api/rooms/${hana.roomId}/end`, { method: "POST", headers: { authorization: `Bearer ${hana.secret}`, origin: baseUrl } }).catch(() => {});
  }
  await browser.close();
}

async function waitFor(check, what, timeout = 10_000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
