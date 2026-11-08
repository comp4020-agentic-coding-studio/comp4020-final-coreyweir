// An image pasted or dropped on the host's terminal reaches the model
// (imagePaste.ts): judged from a fake Anthropic API (fake-anthropic.mjs),
// which records each turn's image blocks and a PNG's size.
//
// - A 3000x1500 screenshot is pasted: Claude only attaches images up to
//   2000 px a side, so it must arrive shrunk to 2000x1000.
// - A 320x160 image is dropped: it arrives as it was.
// - A paste with text and an image (a spreadsheet's cells) stays a text paste.
// Each turn must carry exactly the images pasted for it, once.
//
// What it can't tell apart: a real clipboard from a synthetic paste event
// (Chrome builds the event here, so the OS clipboard and permission prompts
// aren't involved), and what a real model makes of the image. Riff's free
// model refusing images is checked by test:image-paste, not here.
//
//   RIFF_URL=http://127.0.0.1:8096 npm run test:image-paste-browser
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

try {
  const pageErrors = [];
  const host = await browser.newPage();
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.setViewport({ width: 1440, height: 900 });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const hostInputs = await host.$$(".entry-card form input:not([type=radio])");
  await hostInputs[0].type("Image Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(fake.url);
  await hostInputs[2].type("fake-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  await host.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room")?.click());

  await host.locator(".terminal-controls button").click();
  await host.waitForSelector(".terminal-target .xterm", { timeout: 180_000 });
  const screen = () => host.$eval(".terminal-target .xterm-rows", (element) => element.textContent);
  await until(async () => (await screen()).includes("Yes, I accept"), "the bypass-permissions dialog", 180_000);
  await host.click(".terminal-target .xterm");
  await host.keyboard.press("ArrowDown");
  await sleep(300);
  await host.keyboard.press("Enter");
  const state = () => host.$eval(".claude-state", (element) => element.dataset.state).catch(() => null);
  await until(async () => (await state()) === "idle", "Claude waiting for a prompt", 60_000);

  // A PNG of the given size, made in the page, put on a DataTransfer and
  // fired at the terminal as a paste or a drop.
  const give = (kind, width, height, text) => host.evaluate(async (kind, width, height, text) => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#315efb";
    context.fillRect(0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const data = new DataTransfer();
    if (text) data.setData("text/plain", text);
    data.items.add(new File([blob], `board-${width}.png`, { type: "image/png" }));
    if (kind === "paste") {
      document.querySelector(".terminal-target .xterm-helper-textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    } else {
      const target = document.querySelector(".terminal-target .xterm-screen");
      target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  }, kind, width, height, text);
  const images = () => (screen().then((text) => text.match(/\[Image #\d+\]/g)?.length ?? 0));
  const ask = async (words) => {
    await host.click(".terminal-target .xterm");
    await host.keyboard.type(words);
    await sleep(300);
    await host.keyboard.press("Enter");
    await until(() => fake.count(words) === 1 || fake.turns.some((turn) => turn.blocks.some((block) => block.includes(words))), `"${words}" to reach the model`);
    await until(async () => (await state()) === "idle", "the turn to end");
    return fake.turns.filter((turn) => turn.blocks.some((block) => block.includes(words)));
  };
  const note = () => host.$eval(".terminal-note strong", (element) => element.textContent).catch(() => "");

  // A screenshot bigger than Claude takes: shrunk on the way in.
  await give("paste", 3000, 1500);
  await until(async () => (await images()) === 1, "Claude to take the pasted image");
  assert.equal(await note(), "Image scaled to 2000×1000 so Claude can read it.");
  const big = await ask(" what is in this screenshot?");
  assert.equal(big.length, 1, "one turn for the screenshot");
  assert.deepEqual(big[0].images, ["image/png 2000x1000"]);

  // A small image dropped on the terminal: as it was.
  await give("drop", 320, 160);
  await until(async () => (await images()) >= 1 && (await screen()).includes("[Image #2]"), "Claude to take the dropped image");
  const small = await ask(" and this one?");
  assert.equal(small.length, 1, "one turn for the dropped image");
  assert.deepEqual(small[0].images, ["image/png 320x160"]);

  // Text with a picture of it is a text paste.
  await give("paste", 200, 100, "cells as text");
  await until(async () => (await screen()).includes("cells as text"), "the text paste");
  const cells = await ask(" were pasted");
  assert.equal(cells.length, 1);
  assert.ok(cells[0].blocks.some((block) => block.includes("cells as text were pasted")), JSON.stringify(cells[0].blocks));
  assert.deepEqual(cells[0].images, []);

  console.log(JSON.stringify(fake.turns.map((turn) => ({ images: turn.images, text: turn.blocks.filter((block) => !block.startsWith("<")).join("|").slice(0, 80) }))));
  assert.equal(fake.turns.length, 3, "one turn per prompt, nothing else asked of the model");
  assert.deepEqual(pageErrors, []);
  console.log("Image paste smoke passed: a pasted screenshot arrived shrunk to 2000 px, a dropped image as it was, text with an image as text.");
} finally {
  await browser.close();
  await fake.close();
}
