// Send board to Claude (app/src/SendBoard.tsx, boardForClaude.ts) through
// the page, so it runs against the built live app as well as dev:
//
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev npm run test:send-board-browser
//
// A fresh profile hosts a room started from a board file (a note, a labelled
// rectangle, an arrow from one to the other, a freehand stroke and a
// 2048x1024 image: the same records a paste makes). Before the pod boots
// the button is there but disabled, saying why. With Bash started and
// auto-release on, Send writes /tmp/riff/board-1/ and opens the popup on
// the prompt, which is edited and staged: it's in Staging with the edited
// text, and the queue stays empty. In the pod, node (Nodepod, where
// Claude's own tools read) finds the note's text, the arrow's ends named,
// the stroke without its points; bash (WASIX) finds the image shrunk to
// 2000x1000 and, with the host's own endpoint, a PNG picture. Then one
// shape is selected: the label says so; Esc cancels, deleting board-2 and
// staging nothing; sent again and staged, board-2 holds the note alone.
// A participant who joins has no such button.
//
// MODELS=own (the host's endpoint: board.png written) or riff (Riff's free
// models: no board.png, and the popup says why); SIZES=desktop or phone.
// By default every pair, at 1920x1080 and 390x844. The rooms are ended.
//
// Not told apart: whether Claude reads the files well (no model runs here);
// a pasted image from an imported one (same records); the picture's
// contents (only that it's a PNG within 2000 px).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import puppeteer from "puppeteer-core";

const baseUrl = (process.env.RIFF_URL ?? "http://127.0.0.1:8094").replace(/\/$/, "");
const allSizes = [{ name: "desktop", width: 1920, height: 1080 }, { name: "phone", width: 390, height: 844 }];
const sizes = allSizes.filter((size) => !process.env.SIZES || process.env.SIZES.split(",").includes(size.name));
const models = (process.env.MODELS ?? "own,riff").split(",");
const TOKEN = "invalid-send-board-smoke-token";
const work = path.join(os.tmpdir(), "opencode");
mkdirSync(work, { recursive: true });

// ---- the board file ---------------------------------------------------------

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(x < width / 2 ? [49, 94, 251] : [240, 200, 60], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const NOTE_TEXT = "Sign up flow needs a skip button";
const LABEL = "Onboarding page";
const shape = (id, type, x, y, props, z) => ({ id, typeName: "shape", type, x, y, rot: 0, z, props });
const pts = [];
for (let index = 0; index < 600; index += 1) pts.push(index * 0.7, Math.sin(index / 25) * 40, 0.5);
const boardFile = {
  format: "riff-board",
  version: 1,
  exportedAt: new Date().toISOString(),
  room: { code: "SMOKE" },
  board: {
    document: {
      store: {
        // At the board's top-left, where the camera starts, so a click selects it.
        "shape:note": shape("shape:note", "note", 30, 110, { text: NOTE_TEXT, color: "yellow", size: "m", font: "draw", scale: 1 }, 1),
        "shape:page": shape("shape:page", "geo", 420, 110, { geo: "rectangle", w: 240, h: 160, label: LABEL, labelSize: "s", color: "black", size: "m", dash: "draw", fill: "none", font: "draw" }, 2),
        "shape:arrow": shape("shape:arrow", "arrow", 220, 190, { dx: 210, dy: 0, bend: 0, color: "black", size: "m", dash: "solid" }, 3),
        "shape:stroke": shape("shape:stroke", "draw", 40, 420, { pts, color: "blue", size: "m", dash: "draw", done: true }, 4),
        "asset:img": { id: "asset:img", typeName: "asset", src: `data:image/png;base64,${png(2048, 1024).toString("base64")}`, w: 2048, h: 1024 },
        "shape:img": shape("shape:img", "image", 700, 420, { w: 256, h: 128, assetId: "asset:img" }, 5),
      },
    },
  },
  prompts: [],
  queue: [],
};
const boardPath = path.join(work, "send-board-smoke.json");
writeFileSync(boardPath, JSON.stringify(boardFile));

// ---- the page -----------------------------------------------------------------

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const unwrap = (text) => text.replace(/\n/g, "");
const screenText = (tab) => tab.$eval(".terminal-target .xterm-rows", (element) => element.innerText.replace(/\u00a0/g, " "));
const view = (tab, name) => tab.evaluate((name) => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === name)?.click(), name);
const sendButton = (tab) => tab.$eval(".send-board-button", (b) => ({ text: b.textContent, disabled: b.disabled, title: b.title, rect: b.getBoundingClientRect().toJSON() }));

async function host(tab, model) {
  await tab.goto(baseUrl, { waitUntil: "networkidle0" });
  await tab.click(".entry-card > nav button:nth-child(2)");
  await tab.waitForSelector(".model-choice", { timeout: 10_000 });
  await tab.click(`.model-choice label:nth-of-type(${model === "riff" ? 1 : 2}) input`);
  const inputs = await tab.$$(".entry-card form input:not([type=radio]):not([type=checkbox]):not([type=file])");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type("Board host");
  if (model === "own") {
    await inputs[1].click({ clickCount: 3 });
    await inputs[1].type(`${baseUrl}/fake-anthropic`);
    await inputs[2].click({ clickCount: 3 });
    await inputs[2].type(TOKEN);
  }
  await (await tab.$(".import-board input[type=file]")).uploadFile(boardPath);
  await tab.waitForSelector(".import-board .import-summary", { timeout: 20_000 });
  const summary = await tab.$eval(".import-board .import-summary", (element) => element.textContent);
  assert.match(summary, /5 things on the board, 1 image/, `the board file is read whole: ${summary}`);
  const keep = await tab.$$(".entry-card form label.check input[type=checkbox]").then((boxes) => boxes.at(-1));
  if (await keep.evaluate((element) => element.checked)) await keep.click();
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 60_000 });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 20_000, polling: 100 });
}

async function startBash(tab) {
  await view(tab, "Room");
  await tab.waitForSelector(".terminal-controls button", { timeout: 20_000 });
  await tab.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Start Bash")?.click());
  await tab.waitForFunction(() => document.querySelector(".terminal-heading span")?.textContent === "WASIX Bash ready", { timeout: 240_000, polling: 200 });
  await tab.waitForFunction(() => /\$ $|# $/m.test(document.querySelector(".terminal-target .xterm-rows")?.innerText.replace(/\u00a0/g, " ").trimEnd() + " "), { timeout: 30_000, polling: 100 });
}

let sequence = 100;
async function run(tab, command) {
  const n = ++sequence;
  await tab.bringToFront();
  await tab.focus(".terminal-target .xterm-helper-textarea");
  await tab.keyboard.type(`printf '\\033[H\\033[2J'; echo @B$((${n}+0)); ${command}; echo @E$((${n}+0))`, { delay: Number(process.env.TYPE_DELAY ?? 5) });
  await tab.keyboard.press("Enter");
  await tab.waitForFunction((n) => document.querySelector(".terminal-target .xterm-rows")?.innerText.includes(`@E${n}`), { timeout: 60_000, polling: 100 }, n);
  const text = await screenText(tab);
  return unwrap(text.slice(text.indexOf(`@B${n}`) + `@B${n}`.length, text.indexOf(`@E${n}`))).trim();
}

// board.json as Nodepod's node reads it (where Claude's own tools read), summed up on one line.
const SUMMARY = "const d=JSON.parse(require('fs').readFileSync(process.argv[process.argv.length-1],'utf8'));"
  + "const by=(t)=>d.shapes.filter((s)=>s.type===t);const a=by('arrow')[0]||{};const name=(id)=>{const s=d.shapes.find((x)=>x.id===id);return s?(s.text||s.label):'-'};"
  + "console.log('SUM'+JSON.stringify({format:d.format,scope:d.scope,n:d.shapes.length,note:by('note').map((s)=>s.text),from:name(a.from),to:name(a.to),free:by('freehand').map((s)=>Object.keys(s).sort().join()),img:by('image').map((s)=>s.file),pic:d.picture&&d.picture.file})+'END')";
async function summary(tab, dir) {
  const out = await run(tab, `node -e "${SUMMARY}" ${dir}/board.json`);
  const match = /SUM(.*)END/.exec(out.replace(/\s+/g, " "));
  assert.ok(match, `node read ${dir}/board.json: ${out}`);
  return JSON.parse(match[1]);
}

async function endRoom(tab) {
  await view(tab, "Room");
  await tab.click(".participants");
  await tab.waitForSelector(".end-room > button");
  await tab.click(".end-room > button");
  await tab.click(".end-room button.danger");
  await tab.waitForFunction(() => new URL(location.href).searchParams.has("ended") || !location.search.includes("id="), { timeout: 20_000 });
}

const stagedTexts = (tab) => tab.$$eval(".staging .prompt-card textarea", (areas) => areas.map((area) => area.value));

const pageErrors = [];
try {
  for (const size of sizes) for (const model of models) {
    const say = (message) => `${size.name}/${model}: ${message}`;
    const context = await browser.createBrowserContext();
    const tab = await context.newPage();
    tab.on("pageerror", (error) => pageErrors.push(String(error)));
    await tab.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    await host(tab, model);

    // Before the pod: there, disabled, and why.
    let button = await sendButton(tab);
    assert.equal(button.text, "Send board to Claude", say("the label"));
    assert.equal(button.disabled, true, say("disabled before the pod boots"));
    assert.match(button.title, /Boot Claude/, say(`says why: ${button.title}`));
    assert.ok(button.rect.right <= size.width && button.rect.width > 0, say(`the button is on screen: ${JSON.stringify(button.rect)}`));

    await startBash(tab);
    await view(tab, "Room");
    await tab.click(".auto-release input");
    await tab.waitForFunction(() => document.querySelector(".auto-release input")?.checked, { timeout: 5000, polling: 100 });
    await view(tab, "Board");
    await tab.waitForFunction(() => !document.querySelector(".send-board-button")?.disabled, { timeout: 10_000, polling: 100 });
    await tab.click(".send-board-button");
    await tab.waitForSelector("dialog.send-board[open]", { timeout: 30_000 });

    // The popup: on the prompt, saying what was written.
    const dialog = await tab.$eval("dialog.send-board", (element) => ({
      text: element.textContent,
      value: element.querySelector("textarea").value,
      focused: document.activeElement === element.querySelector("textarea"),
      notice: element.querySelector(".send-board-notice")?.textContent ?? null,
      rect: element.getBoundingClientRect().toJSON(),
    }));
    assert.ok(dialog.focused, say("the prompt has focus"));
    assert.ok(dialog.rect.left >= 0 && dialog.rect.right <= size.width && dialog.rect.bottom <= size.height, say(`the popup fits: ${JSON.stringify(dialog.rect)}`));
    const picture = model === "own";
    assert.equal(dialog.value, `The board from our room is in /tmp/riff/board-1/ (board.json describes every shape; ${picture ? "board.png is a picture of it; " : ""}image-1.png is the pasted image${picture ? "" : ", which the model in use can't look at"}).\n\n`, say("the prompt's opening"));
    if (picture) assert.equal(dialog.notice, null, say("no notice with a model that reads images"));
    else assert.match(dialog.notice ?? "", /free models read text only, so there's no picture/, say(`the notice: ${dialog.notice}`));
    assert.match(dialog.text, new RegExp(`board\\.json, image-1\\.png${picture ? ", board\\.png" : ""}\\.`), say(`it lists the files: ${dialog.text}`));

    // Edit, Stage: in Staging as edited, and nothing goes to the queue.
    // (The popup is modal, so the pod is read after it closes.)
    await tab.focus("dialog.send-board textarea");
    await tab.keyboard.type("Build the onboarding page with a skip button.");
    const before = (await stagedTexts(tab)).length;
    await tab.click(".send-board-go");
    await tab.waitForFunction(() => !document.querySelector("dialog.send-board"), { timeout: 5000, polling: 100 });
    await tab.waitForFunction((count) => document.querySelectorAll(".staging .prompt-card").length === count + 1, { timeout: 10_000, polling: 100 }, before);
    const staged = await stagedTexts(tab);
    assert.ok(staged.includes(`${dialog.value}Build the onboarding page with a skip button.`), say(`staged as edited: ${JSON.stringify(staged)}`));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await view(tab, "Room");
    assert.equal(await tab.$$eval(".queue-list .queue-row", (rows) => rows.length), 0, say("nothing queued, with auto-release on"));

    // In the pod.
    const files = await run(tab, "ls /tmp/riff/board-1");
    assert.equal(files.split(/\s+/).sort().join(" "), (picture ? "board.json board.png image-1.png" : "board.json image-1.png"), say(`the files: ${files}`));
    const described = await summary(tab, "/tmp/riff/board-1");
    assert.deepEqual(described, {
      format: "riff-board-for-claude-1", scope: "the whole board, 5 shapes", n: 5, note: [NOTE_TEXT],
      from: NOTE_TEXT, to: LABEL, free: ["color,h,id,type,w,x,y"], img: ["image-1.png"], ...(picture ? { pic: "board.png" } : {}),
    }, say("board.json"));
    // IHDR's width and height: the 2048x1024 image shrunk within Claude's 2000.
    assert.equal(await run(tab, "od -An -tx1 -j16 -N8 /tmp/riff/board-1/image-1.png"), "00 00 07 d0 00 00 03 e8", say("image-1.png is 2000x1000"));
    if (picture) {
      const header = await run(tab, "od -An -tx1 -N8 /tmp/riff/board-1/board.png; od -An -tx1 -j16 -N8 /tmp/riff/board-1/board.png");
      const bytes = header.replace(/\s+/g, " ").trim().split(" ").map((hex) => parseInt(hex, 16));
      assert.deepEqual(bytes.slice(0, 8), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], say(`board.png is a PNG: ${header}`));
      const width = ((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0;
      const height = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
      assert.ok(width <= 2000 && height <= 2000 && width > 1000, say(`board.png within 2000 px: ${width}x${height}`));
    }

    // One shape selected: the label says so. Esc cancels, deleting its
    // files and staging nothing; sent again and staged, it's there alone.
    await view(tab, "Board");
    await tab.waitForSelector(".quickdraw-surface canvas");
    const canvas = await tab.$eval(".quickdraw-surface", (element) => element.getBoundingClientRect().toJSON());
    // quickdraw starts on the pen: take the select tool first.
    await tab.click(".qd-dock button[data-name=select]");
    await tab.mouse.click(canvas.left + 60, canvas.top + 140);
    await tab.waitForFunction(() => document.querySelector(".send-board-button")?.textContent === "Send selected shape to Claude", { timeout: 5000, polling: 100 })
      .catch(async (error) => {
        await tab.screenshot({ path: path.join(work, `send-board-${size.name}-${model}-select.png`) });
        throw new Error(say(`selecting the note: ${(await sendButton(tab)).text} (${error.message})`));
      });
    await tab.click(".send-board-button");
    await tab.waitForSelector("dialog.send-board[open]", { timeout: 30_000 });
    const selectedValue = await tab.$eval("dialog.send-board textarea", (area) => area.value);
    assert.match(selectedValue, /^The shapes we selected on our room's board are in \/tmp\/riff\/board-2\/ \(board\.json describes every shape/, say(selectedValue));
    await tab.screenshot({ path: path.join(work, `send-board-${size.name}-${model}.png`) });
    await tab.keyboard.press("Escape");
    await tab.waitForFunction(() => !document.querySelector("dialog.send-board"), { timeout: 5000, polling: 100 });
    assert.equal((await stagedTexts(tab)).length, before + 1, say("Cancel staged nothing"));
    await view(tab, "Room");
    assert.equal(await run(tab, "ls /tmp/riff"), "board-1", say("Cancel deleted board-2 and kept board-1"));
    await view(tab, "Board");
    await tab.waitForFunction(() => document.querySelector(".send-board-button")?.textContent === "Send selected shape to Claude", { timeout: 5000, polling: 100 });
    await tab.click(".send-board-button");
    await tab.waitForSelector("dialog.send-board[open]", { timeout: 30_000 });
    await tab.click(".send-board-go");
    await tab.waitForFunction((count) => document.querySelectorAll(".staging .prompt-card").length === count + 2, { timeout: 10_000, polling: 100 }, before);
    await view(tab, "Room");
    const selection = await summary(tab, "/tmp/riff/board-2");
    assert.equal(selection.scope, "1 selected of the board's 5 shapes", say("board-2 is the selection"));
    assert.deepEqual(selection.note, [NOTE_TEXT], say("board-2 holds the note"));
    assert.equal(selection.n, 1, say("board-2 holds the note alone"));
    assert.equal(await tab.$$eval(".queue-list .queue-row", (rows) => rows.length), 0, say("still nothing queued"));

    // A participant's board has no such button.
    if (size === sizes[0] && model === models[0]) {
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
      await guest.waitForSelector(".board-actions .board-buttons button");
      assert.equal(await guest.$(".send-board-button"), null, say("a participant has no Send board button"));
      await other.close();
    }

    await endRoom(tab);
    await context.close();
    console.log(say("ok"));
  }
  assert.deepEqual(pageErrors, [], "no page errors");
  console.log("send-board smoke passed");
} finally {
  await browser.close();
}
