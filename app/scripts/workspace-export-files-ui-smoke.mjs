// "Export files" on a room's row of the landing page, through the page, so
// it runs against the built live app as well as dev:
//
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev npm run test:workspace-export-files-ui
//
// A host makes a room (board not kept), types work into WASIX bash (a commit
// never pushed, an uncommitted change, a few bytes no editor keeps, a
// transcript, a node_modules) and exports it with the workspace's own Export
// dialog. Once OPFS holds that work (read from its manifest, not a sleep), a
// second tab opens the landing page: the room's row has "Export board" and
// "Export files", and Export files refuses while the room's tab holds the
// workspace (it never takes it over). The room's tab goes back to the
// landing page; Export files then downloads a zip with the same file list
// and the same bytes as the in-room Export, with defaults and with the
// boxes flipped. The room is ended at the end. At 1920x1080 and 390x844
// (SIZES=desktop or phone for one).
//
// Not told apart: whether OPFS held the bytes on disk or in the browser's
// cache; a workspace the size of a real project's (both zips are built in
// memory). riff-workspace.json differs between the two only in its time and
// in naming Riff's session folder, which only a running pod has.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { unzipSync } from "fflate";

const baseUrl = (process.env.RIFF_URL ?? "http://127.0.0.1:8094").replace(/\/$/, "");
const allSizes = [{ name: "desktop", width: 1920, height: 1080 }, { name: "phone", width: 390, height: 844 }];
const sizes = allSizes.filter((size) => !process.env.SIZES || process.env.SIZES.split(",").includes(size.name));
const TOKEN = "invalid-files-smoke-token-0123";
const shots = path.join(os.tmpdir(), "opencode");
mkdirSync(shots, { recursive: true });
const dec = new TextDecoder();

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const roomButton = (tab) => tab.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === "Room")?.click());

let sequence = 100;
async function run(tab, command) {
  const n = ++sequence;
  await tab.bringToFront();
  await tab.focus(".terminal-target .xterm-helper-textarea");
  await tab.keyboard.type(`printf '\\033[H\\033[2J'; echo @B$((${n}+0)); ${command}; echo @E$((${n}+0))`, { delay: Number(process.env.TYPE_DELAY ?? 5) });
  await tab.keyboard.press("Enter");
  await tab.waitForFunction((n) => document.querySelector(".terminal-target .xterm-rows")?.innerText.includes(`@E${n}`), { timeout: 60_000, polling: 100 }, n);
}

const manifestOf = (tab, roomId) => tab.evaluate(async (roomId) => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("riff-workspaces").then((d) => d.getDirectoryHandle(roomId)).catch(() => null);
  if (!dir) return null;
  const read = async (slot) => { try { return JSON.parse(await (await (await dir.getFileHandle(`manifest-${slot}.json`)).getFile()).text()); } catch { return null; } };
  return (await Promise.all([read(0), read(1)])).filter(Boolean).sort((a, b) => b.seq - a.seq)[0] ?? null;
}, roomId);

async function download(downloads, start) {
  await start();
  let name = null;
  for (const deadline = Date.now() + 60_000; !name && Date.now() < deadline;) {
    name = readdirSync(downloads).find((file) => file.endsWith(".zip")) ?? null;
    if (!name) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(name, "a zip downloaded");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const bytes = new Uint8Array(readFileSync(path.join(downloads, name)));
  unlinkSync(path.join(downloads, name));
  return unzipSync(bytes);
}

// Through the dialog: Download zip, then Close.
async function viaDialog(tab, downloads, { flip = false } = {}) {
  await tab.waitForSelector(".ws-export");
  if (flip) {
    await tab.click(".ws-export-option:nth-of-type(1) input");
    await tab.click(".ws-export-option:nth-of-type(2) input");
  }
  const files = await download(downloads, () => tab.click(".ws-export-go"));
  await tab.waitForSelector(".ws-export-summary", { timeout: 60_000 });
  await tab.click(".ws-export-actions button:last-child");
  await tab.waitForFunction(() => !document.querySelector(".ws-export"));
  return files;
}

function same(say, row, room) {
  const names = (files) => Object.keys(files).sort();
  assert.deepEqual(names(row), names(room), say("the same file list"));
  for (const name of names(room)) {
    if (name === "riff-workspace.json") continue;
    assert.deepEqual(Buffer.from(row[name]), Buffer.from(room[name]), say(`${name}: the same bytes`));
  }
  const [a, b] = [row, room].map((files) => JSON.parse(dec.decode(files["riff-workspace.json"])));
  assert.deepEqual(a.history, b.history, say("the same commit list"));
  assert.equal(a.files, b.files);
}

const pageErrors = [];
try {
  for (const size of sizes) {
    const say = (message) => `${size.name}: ${message}`;
    const downloads = mkdtempSync(path.join(os.tmpdir(), "riff-files-"));
    const context = await browser.createBrowserContext();
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, browserContextId: context.id });
    const open = async () => {
      const tab = await context.newPage();
      tab.on("pageerror", (error) => pageErrors.push(String(error)));
      await tab.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
      return tab;
    };

    // ---- host, work, in-room Export
    const host = await open();
    await host.goto(baseUrl, { waitUntil: "networkidle0" });
    await host.click(".entry-card > nav button:nth-child(2)");
    await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
    const inputs = await host.$$(".entry-card form input:not([type=radio]):not([type=checkbox]):not([type=file])");
    await inputs[0].type("Files Host");
    await inputs[1].click({ clickCount: 3 });
    await inputs[1].type(`${baseUrl}/fake-anthropic`);
    await inputs[2].type(TOKEN);
    const keep = await host.$$(".entry-card form label.check input[type=checkbox]").then((boxes) => boxes.at(-1));
    if (await keep.evaluate((element) => element.checked)) await keep.click();
    await host.click(".entry-card form .primary");
    await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 30_000 });
    await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 20_000, polling: 100 });
    const roomId = new URL(host.url()).searchParams.get("id");
    const code = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
    await roomButton(host);
    await host.waitForSelector(".terminal-controls button", { timeout: 20_000 });
    await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Start Bash")?.click());
    await host.waitForFunction(() => document.querySelector(".terminal-heading span")?.textContent === "WASIX Bash ready", { timeout: 240_000, polling: 200 });
    await host.waitForFunction(() => /\$ $|# $/m.test(document.querySelector(".terminal-target .xterm-rows")?.innerText.replace(/\u00a0/g, " ").trimEnd() + " "), { timeout: 30_000, polling: 100 });
    await run(host, "git init -q && git config user.email host@example.com && git config user.name Host");
    await run(host, "echo committed > notes.txt && printf '\\000\\001\\376\\377' > bytes.bin && git add notes.txt bytes.bin && git commit -q -m 'never pushed'");
    await run(host, "echo changed >> notes.txt && mkdir -p node_modules/x && echo dep > node_modules/x/index.js");
    await run(host, "mkdir -p ~/.claude/projects/-work-repo && echo 'a transcript line' > ~/.claude/projects/-work-repo/smoke.jsonl");
    await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Export")?.click());
    const roomDefault = await viaDialog(host, downloads);
    await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Export")?.click());
    const roomFlipped = await viaDialog(host, downloads, { flip: true });
    assert.ok(roomDefault["repo/notes.txt"] && roomDefault["claude/projects/-work-repo/smoke.jsonl"], say("the in-room export has the work"));

    // OPFS holds what the in-room export read
    const want = Object.fromEntries(Object.entries(roomFlipped).filter(([name]) => name.startsWith("repo/") && !name.endsWith("/")).map(([name, data]) => [`/work/repo/${name.slice(5)}`, data.length]));
    for (const deadline = Date.now() + 60_000; ;) {
      const manifest = await manifestOf(host, roomId);
      if (manifest && Object.entries(want).every(([p, length]) => manifest.entries[p]?.[3] === length)) break;
      if (Date.now() > deadline) throw new Error(say(`OPFS never held ${JSON.stringify(want)}`));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // ---- the landing page in another tab: the row's buttons
    const landing = await open();
    await landing.goto(baseUrl, { waitUntil: "networkidle0" });
    const row = async () => {
      await landing.waitForFunction((code) => [...document.querySelectorAll(".your-rooms li")].some((li) => li.textContent.includes(code) && li.textContent.includes("Export files")), { timeout: 20_000, polling: 100 }, code);
      return landing.evaluateHandle((code) => [...document.querySelectorAll(".your-rooms li")].find((li) => li.textContent.includes(code)), code);
    };
    const buttons = await (await row()).evaluate((li) => [...li.querySelectorAll(".actions button")].map((b) => b.textContent));
    assert.ok(buttons.includes("Export board") && buttons.includes("Export files"), say(`the row has both exports: ${buttons}`));
    const clickFiles = async () => (await row()).evaluate((li) => [...li.querySelectorAll(".actions button")].find((b) => b.textContent === "Export files").click());

    // while the room's tab holds the workspace: refused, and that tab keeps saving
    await clickFiles();
    await landing.waitForSelector(".ws-export");
    await landing.click(".ws-export-go");
    await landing.waitForFunction(() => /open in another tab/.test(document.querySelector(".ws-export .form-error")?.textContent ?? ""), { timeout: 20_000, polling: 100 });
    assert.equal(readdirSync(downloads).filter((file) => file.endsWith(".zip")).length, 0, say("nothing downloaded while the room's tab has it"));
    await landing.click(".ws-export-actions button:last-child");
    await run(host, "echo still saving > later.txt");
    for (const deadline = Date.now() + 30_000; ;) {
      if ((await manifestOf(host, roomId))?.entries["/work/repo/later.txt"]) break;
      if (Date.now() > deadline) throw new Error(say("the room's tab stopped saving"));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await run(host, "rm later.txt");
    for (const deadline = Date.now() + 30_000; ;) {
      if (!(await manifestOf(host, roomId))?.entries["/work/repo/later.txt"]) break;
      if (Date.now() > deadline) throw new Error(say("the room's tab never saved the removal"));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // ---- the room's tab leaves; the row's export now runs
    await host.goto(baseUrl, { waitUntil: "networkidle0" });
    await host.close();
    await landing.bringToFront();
    await clickFiles();
    const rowDefault = await viaDialog(landing, downloads);
    same((m) => say(`defaults: ${m}`), rowDefault, roomDefault);
    await landing.screenshot({ path: path.join(shots, `ws-files-row-${size.name}.png`) }).catch(() => {});
    await clickFiles();
    const rowFlipped = await viaDialog(landing, downloads, { flip: true });
    same((m) => say(`transcripts out, dependencies in: ${m}`), rowFlipped, roomFlipped);
    assert.ok(rowFlipped["repo/node_modules/x/index.js"] && !rowFlipped["claude/projects/-work-repo/smoke.jsonl"], say("the boxes did what they say"));

    // ---- end the room
    await landing.goto(`${baseUrl}/?id=${roomId}`, { waitUntil: "networkidle0" });
    await landing.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 20_000, polling: 100 });
    await landing.click(".participants");
    await landing.waitForSelector(".end-room > button");
    await landing.click(".end-room > button");
    await landing.click(".end-room button.danger");
    await landing.waitForFunction(() => !location.search.includes("id="), { timeout: 20_000 });
    await context.close();
    console.log(`${size.name}: ok (room ${code}, ${Object.keys(rowDefault).length} and ${Object.keys(rowFlipped).length} entries)`);
  }
  assert.deepEqual(pageErrors, [], "no page errors");
  console.log("workspace export files ui smoke: ok");
} finally {
  await browser.close();
}
