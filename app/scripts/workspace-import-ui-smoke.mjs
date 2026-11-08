// Workspace import through the page (docs/adr/0003, workspace import), so it
// runs against the built live app as well as dev:
//
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev npm run test:workspace-import-ui
//
// One browser profile hosts a room, types work into WASIX bash (a commit
// never pushed, then an uncommitted change to it and an untracked file, a
// few bytes no editor keeps, a transcript where Claude Code keeps them, a
// node_modules) and exports it with the Export dialog. The room is ended.
//
// A second, fresh profile (so nothing comes from the first one's OPFS)
// picks a zip that isn't an export (refused, with why), then the export, on
// the host form. With a Git repository filled in, the form says it will be
// ignored; it says node_modules was left out, and the transcripts box is
// unticked until ticked here. The new room's workspace is in OPFS before
// anything boots. Bash then shows the unpushed commit, the uncommitted
// change and untracked file (git status), the bytes, the transcript, and
// says it was imported, what to reinstall and that it didn't clone. After a
// reload with no warning it is all still there. Both rooms are ended (boards
// not kept). At 1920x1080 and 390x844 (SIZES=desktop or phone for one).
//
// Not told apart: Claude itself writing a transcript (bash stands in); a
// workspace the size of a real project's (the zip is built and read in
// memory); whether OPFS held the bytes on disk or in the browser's cache.
// Nodepod's git keeps contents as text, so a committed binary file isn't
// exact in its store (ADR 0003); the working tree is, and that's what the
// bytes check reads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { strToU8, zipSync } from "fflate";

const baseUrl = (process.env.RIFF_URL ?? "http://127.0.0.1:8094").replace(/\/$/, "");
const allSizes = [{ name: "desktop", width: 1920, height: 1080 }, { name: "phone", width: 390, height: 844 }];
const sizes = allSizes.filter((size) => !process.env.SIZES || process.env.SIZES.split(",").includes(size.name));
const TOKEN = "invalid-import-smoke-token-0123";
const REPO = "https://github.com/octocat/Hello-World";
const shots = path.join(os.tmpdir(), "opencode");
mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const unwrap = (text) => text.replace(/\n/g, "");
const screenText = (tab) => tab.$eval(".terminal-target .xterm-rows", (element) => element.innerText.replace(/\u00a0/g, " "));
const roomButton = (tab) => tab.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === "Room")?.click());

async function hostForm(tab, name, repo = "") {
  await tab.goto(baseUrl, { waitUntil: "networkidle0" });
  await tab.click(".entry-card > nav button:nth-child(2)");
  await tab.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await tab.$$(".entry-card form input:not([type=radio]):not([type=checkbox]):not([type=file])");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(name);
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].click({ clickCount: 3 });
  await inputs[2].type(TOKEN);
  if (repo) await inputs[3].type(repo);
  const keep = await tab.$$(".entry-card form label.check input[type=checkbox]").then((boxes) => boxes.at(-1));
  if (await keep.evaluate((element) => element.checked)) await keep.click();
}

async function createRoom(tab) {
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 60_000 });
  // a repository but no GitHub: the room asks first
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected" || [...document.querySelectorAll("button")].some((b) => b.textContent === "Continue without GitHub"), { timeout: 20_000, polling: 100 });
  await tab.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Continue without GitHub")?.click());
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 20_000, polling: 100 });
  return {
    roomId: new URL(tab.url()).searchParams.get("id"),
    code: await tab.$eval(".room-name span", (element) => element.textContent.replace("Room ", "")),
  };
}

async function startBash(tab) {
  await roomButton(tab);
  await tab.waitForSelector(".terminal-controls button", { timeout: 20_000 });
  await tab.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Start Bash")?.click());
  await tab.waitForFunction(() => document.querySelector(".terminal-heading span")?.textContent === "WASIX Bash ready", { timeout: 240_000, polling: 200 });
  await tab.waitForFunction(() => /\$ $|# $/m.test(document.querySelector(".terminal-target .xterm-rows")?.innerText.replace(/\u00a0/g, " ").trimEnd() + " "), { timeout: 30_000, polling: 100 });
  return unwrap(await screenText(tab));
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
  return text.slice(text.indexOf(`@B${n}`) + `@B${n}`.length, text.indexOf(`@E${n}`)).trim();
}

// The room's newest OPFS manifest, as the next boot reads it.
const manifestOf = (tab, roomId) => tab.evaluate(async (roomId) => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("riff-workspaces").then((d) => d.getDirectoryHandle(roomId)).catch(() => null);
  if (!dir) return null;
  const read = async (slot) => { try { return JSON.parse(await (await (await dir.getFileHandle(`manifest-${slot}.json`)).getFile()).text()); } catch { return null; } };
  return (await Promise.all([read(0), read(1)])).filter(Boolean).sort((a, b) => b.seq - a.seq)[0] ?? null;
}, roomId);

async function waitSaved(tab, roomId, want) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const manifest = await manifestOf(tab, roomId);
    if (manifest && Object.entries(want).every(([p, size]) => manifest.entries[p]?.[3] === size)) return manifest;
    if (Date.now() > deadline) throw new Error(`OPFS never held ${JSON.stringify(want)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function endRoom(tab) {
  await roomButton(tab);
  await tab.click(".participants");
  await tab.waitForSelector(".end-room > button");
  await tab.click(".end-room > button");
  await tab.click(".end-room button.danger");
  await tab.waitForFunction(() => new URL(location.href).searchParams.has("ended") || !location.search.includes("id="), { timeout: 20_000 });
}

// What bash must show of the workspace, wherever it came from.
async function checkWork(tab, say) {
  const log = unwrap(await run(tab, "git log --oneline"));
  assert.match(log, /never pushed/, say("the unpushed commit is in the history"));
  const status = unwrap(await run(tab, "git status"));
  assert.match(status, /modified:\s*notes\.txt/, say(`the uncommitted change shows in git status: ${status}`));
  assert.match(status, /untracked\.txt/, say("the untracked file shows in git status"));
  assert.match(unwrap(await run(tab, "cat notes.txt")), /committed\s*then changed/, say("the uncommitted change's content"));
  assert.match(unwrap(await run(tab, "od -An -tx1 bytes.bin")), /00 01 fe ff/, say("the bytes"));
  assert.match(unwrap(await run(tab, "cat ~/.claude/projects/-work-repo/smoke.jsonl")), /a transcript line/, say("the transcript"));
  assert.match(unwrap(await run(tab, "ls node_modules 2>&1")), /No such file/, say("node_modules wasn't exported, so isn't there"));
}

const pageErrors = [];
try {
  for (const size of sizes) {
    const say = (message) => `${size.name}: ${message}`;
    const downloads = mkdtempSync(path.join(os.tmpdir(), "riff-import-"));

    // ---- one profile: work, then Export
    const first = await browser.createBrowserContext();
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, browserContextId: first.id });
    const a = await first.newPage();
    a.on("pageerror", (error) => pageErrors.push(String(error)));
    await a.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    await hostForm(a, "Exporter");
    const roomA = await createRoom(a);
    await startBash(a);
    await run(a, "git init -q && git config user.email host@example.com && git config user.name Host");
    await run(a, "echo committed > notes.txt && printf '\\000\\001\\376\\377' > bytes.bin && git add notes.txt bytes.bin && git commit -q -m 'never pushed'");
    await run(a, "echo then changed >> notes.txt && echo new > untracked.txt");
    await run(a, "mkdir -p node_modules/x && echo dep > node_modules/x/index.js");
    await run(a, "mkdir -p ~/.claude/projects/-work-repo && echo 'a transcript line' > ~/.claude/projects/-work-repo/smoke.jsonl");
    await checkWork(a, (m) => say(`exporting room: ${m}`)).catch((error) => {
      if (!/node_modules/.test(error.message)) throw error;
    });
    await a.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Export")?.click());
    await a.waitForSelector(".ws-export");
    await a.click(".ws-export-go");
    await a.waitForSelector(".ws-export-summary", { timeout: 60_000 });
    let zipName = null;
    for (const deadline = Date.now() + 30_000; !zipName && Date.now() < deadline;) {
      zipName = readdirSync(downloads).find((name) => name.endsWith(".zip")) ?? null;
      if (!zipName) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(zipName, say("the export downloaded"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const zipPath = path.join(downloads, zipName);
    assert.ok(readFileSync(zipPath).length > 0);
    await a.click(".ws-export-actions button:last-child");
    await endRoom(a);
    await first.close();

    // ---- a fresh profile imports it on the host form
    const second = await browser.createBrowserContext();
    const b = await second.newPage();
    b.on("pageerror", (error) => pageErrors.push(String(error)));
    await b.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    await hostForm(b, "Importer", REPO);
    const picker = await b.$(".import-workspace input[type=file]");
    const notAnExport = path.join(downloads, "not-an-export.zip");
    writeFileSync(notAnExport, zipSync({ "src/a.txt": strToU8("a") }));
    await picker.uploadFile(notAnExport);
    await b.waitForFunction(() => document.querySelector(".import-workspace .form-error")?.textContent.includes("isn't a Riff workspace export"), { timeout: 10_000, polling: 100 });
    await picker.uploadFile(zipPath);
    await b.waitForSelector(".import-workspace .import-summary", { timeout: 20_000 });
    const form = await b.$eval(".import-workspace", (element) => element.textContent);
    assert.match(form, /\d+ files \(\d+ KB\)/, say(`the form counts the files: ${form}`));
    assert.match(form, /1 commit \(1 not pushed\)/, say("the form says one commit isn't pushed"));
    assert.match(form, /left out \/work\/repo\/node_modules \(1 file\)/, say("the form says node_modules was left out"));
    assert.match(form, /Git repository above is ignored/, say("the form says the repository is ignored"));
    const transcripts = await b.$(".import-workspace label.check input[type=checkbox]");
    assert.equal(await transcripts.evaluate((element) => element.checked), false, say("transcripts unticked by default"));
    await transcripts.click();
    const fit = await b.$eval(".import-workspace", (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, w: innerWidth }; });
    assert.ok(fit.left >= 0 && fit.right <= fit.w, say(`the import fits the screen ${JSON.stringify(fit)}`));
    await b.screenshot({ path: path.join(shots, `ws-import-form-${size.name}.png`), fullPage: true }).catch(() => {});
    const roomB = await createRoom(b);
    const seeded = await manifestOf(b, roomB.roomId);
    assert.ok(seeded?.imported, say("the new room's workspace is in OPFS, marked imported, before anything boots"));
    assert.ok(seeded.entries["/home/user/.claude/projects/-work-repo/smoke.jsonl"], say("with the transcript, as ticked"));
    assert.equal(Object.keys(seeded.entries).some((p) => p.includes(".wasix-session")), false);

    // whitespace dropped: on a phone the notes wrap at words
    const boot = (await startBash(b)).replace(/\s+/g, "");
    assert.match(boot, /Thisworkspacewasimportedfromanexport\(/, say("the terminal says it was imported"));
    assert.match(boot, /leftout\/work\/repo\/node_modules\(1file\)\.Reinstall/, say("and what to reinstall"));
    assert.match(boot, /Notcloned:theexportbroughtitsownrepository/, say("and that it didn't clone"));
    await checkWork(b, (m) => say(`imported: ${m}`));
    await b.screenshot({ path: path.join(shots, `ws-import-room-${size.name}.png`) }).catch(() => {});

    // ---- reload with no warning: it is still there
    await run(b, "echo after import > later.txt");
    await waitSaved(b, roomB.roomId, { "/work/repo/later.txt": "after import\n".length });
    await b.reload({ waitUntil: "networkidle0" });
    await b.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected" || [...document.querySelectorAll("button")].some((x) => x.textContent === "Continue without GitHub"), { timeout: 30_000, polling: 100 });
    await b.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent === "Continue without GitHub")?.click());
    await b.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 30_000, polling: 100 });
    const again = (await startBash(b)).replace(/\s+/g, "");
    assert.match(again, /Restoredthisroom'sworkspacefromthisbrowser/, say("after the reload it's restored from OPFS"));
    assert.doesNotMatch(again, /Cloning/, say("and not cloned over"));
    await checkWork(b, (m) => say(`after reload: ${m}`));
    assert.match(unwrap(await run(b, "cat later.txt")), /after import/, say("work done after the import too"));
    await endRoom(b);
    await second.close();
    console.log(`${size.name}: ok (exported from ${roomA.code}, imported into ${roomB.code})`);
  }
  assert.deepEqual(pageErrors, [], "no page errors");
  console.log("workspace import ui smoke: ok");
} finally {
  await browser.close();
}
