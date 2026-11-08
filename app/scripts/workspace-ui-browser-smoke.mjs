// The host's workspace survives a reload, through the real UI, so it runs
// against the built app on live as well as dev (docs/adr/0010):
//
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev [W=390 H=844] npm run test:workspace-ui-browser
//
// A fresh browser profile hosts a room from the landing page (one room,
// board not kept, ended at the end), opens the Room view and starts Bash.
// Typed into the terminal: a file, a few bytes no text editor would keep
// (00 01 fe ff), a file in /tmp, and a git commit that is never pushed.
// It waits until OPFS has the commit (the branch's ref, read from the
// manifest and blob the page wrote, not a sleep), then reloads with no
// warning, as a crash or a stray reload would. Bash in the reloaded page
// must say it restored the workspace and show the commit, the bytes and
// the file, and not /tmp. Then a second tab opens the room: it asks before
// taking the workspace over, the first tab says it stopped saving, and a
// write the first tab makes afterwards isn't saved.
//
// workspace-browser-smoke.mjs covers more (node writes, renames, modes,
// 10,000 files, transcripts, clone at boot, deleting) but imports the
// controller from /src, so only on dev.
//
// DEBUG_FAIL=1 waits on a failure, then prints the screen again and what
// OPFS holds, and screenshots each tab (to SHOTS, or the temp directory).
//
// Can't tell apart: a save that only reached OPFS's in-memory cache from
// one on disk; a reload from a browser crash. It reads the terminal's
// screen (xterm's DOM rows), so a command whose output scrolls off the
// screen would read short.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const viewport = { width: Number(process.env.W ?? 1600), height: Number(process.env.H ?? 1000), deviceScaleFactor: 1 };
const shots = process.env.SHOTS;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const pageErrors = [];

async function page(context) {
  const opened = await context.newPage();
  opened.on("pageerror", (error) => pageErrors.push(String(error)));
  await opened.setViewport(viewport);
  return opened;
}

async function shot(tab, name) {
  if (shots) await tab.screenshot({ path: `${shots}/workspace-${name}-${viewport.width}.png` });
}

async function host(context) {
  const tab = await page(context);
  await tab.goto(baseUrl, { waitUntil: "networkidle0" });
  await tab.click(".entry-card > nav button:nth-child(2)");
  // Claude never starts here; an endpoint of its own keeps the form simple.
  await tab.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await tab.$$(".entry-card form input:not([type=radio])");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type("Wren");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].click({ clickCount: 3 });
  await inputs[2].type("invalid-workspace-smoke-token");
  // a board nobody needs afterwards: ending the room deletes it
  const keep = await tab.$(".entry-card form label.check input[type=checkbox]");
  if (await keep.evaluate((element) => element.checked)) await keep.click();
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000, polling: 100 });
  const roomId = new URL(tab.url()).searchParams.get("id");
  const code = await tab.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  return { tab, roomId, code };
}

// (phrases are matched on unwrap(): on a phone the terminal is 52 columns)
const unwrap = (text) => text.replace(/\n/g, "");
const screenText = (tab) => tab.$eval(".terminal-target .xterm-rows", (element) => element.innerText.replace(/\u00a0/g, " "));

// The Room view, and Bash in it. Returns what the terminal said first.
async function startBash(tab) {
  await tab.waitForSelector(".topbar nav button:nth-child(2)", { timeout: 20_000 });
  await tab.click(".topbar nav button:nth-child(2)");
  await tab.waitForSelector(".terminal-controls button", { timeout: 20_000 });
  const clicked = await tab.$$eval(".terminal-controls button", (buttons) => {
    const button = buttons.find((b) => b.textContent === "Start Bash");
    button?.click();
    return !!button;
  });
  assert.ok(clicked, "Start Bash");
  await tab.waitForFunction(
    () => document.querySelector(".terminal-heading span")?.textContent === "WASIX Bash ready",
    { timeout: 240_000, polling: 200 },
  );
  await tab.waitForFunction(() => /\$ $|# $/m.test(document.querySelector(".terminal-target .xterm-rows")?.innerText.replace(/\u00a0/g, " ").trimEnd() + " "), { timeout: 30_000, polling: 100 });
  return screenText(tab);
}

// Type a command into the host's terminal and read its output off the
// screen, between two markers the shell prints (the typed line holds
// $((n+0)), not n, so it can't match itself).
let sequence = 100;
// Typed at 20 ms a key. With no delay (TYPE_DELAY=0) the host's bash
// stops taking input part-way through a command in about half the runs,
// on dev and live, with or without the workspace: a terminal input bug of
// its own, not this smoke's subject.
const typeDelay = Number(process.env.TYPE_DELAY ?? 20);
async function run(tab, command) {
  const n = ++sequence;
  // xterm draws on animation frames, which a background tab doesn't get
  await tab.bringToFront();
  await tab.focus(".terminal-target .xterm-helper-textarea");
  await tab.keyboard.type(`printf '\\033[H\\033[2J'; echo @B$((${n}+0)); ${command}; echo @E$((${n}+0))`, { delay: typeDelay });
  await tab.keyboard.press("Enter");
  await tab.waitForFunction(
    (n) => document.querySelector(".terminal-target .xterm-rows")?.innerText.includes(`@E${n}`),
    { timeout: 60_000, polling: 100 }, n,
  );
  const text = await screenText(tab);
  return text.slice(text.indexOf(`@B${n}`) + `@B${n}`.length, text.indexOf(`@E${n}`)).trim();
}

// What OPFS holds for the room, read the way the next boot will: the
// newest manifest, and a file's bytes from its blob.
async function saved(tab, roomId, path) {
  return tab.evaluate(async (roomId, path) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("riff-workspaces").then((d) => d.getDirectoryHandle(roomId)).catch(() => null);
    if (!dir) return null;
    const read = async (slot) => {
      try { return JSON.parse(await (await (await dir.getFileHandle(`manifest-${slot}.json`)).getFile()).text()); } catch { return null; }
    };
    const manifests = (await Promise.all([read(0), read(1)])).filter(Boolean).sort((a, b) => b.seq - a.seq);
    const entry = manifests[0]?.entries[path];
    if (!entry || entry[0] !== "f") return null;
    const blobs = await dir.getDirectoryHandle("b");
    return (await (await (await blobs.getFileHandle(entry[4])).getFile()).text());
  }, roomId, path);
}

async function waitSaved(tab, roomId, path, content, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const now = await saved(tab, roomId, path);
    if (now !== null && now.trim() === content.trim()) return;
    if (Date.now() > deadline) assert.fail(`${path} never reached OPFS as ${JSON.stringify(content)} (has ${JSON.stringify(now)})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function endRoom(tab, code) {
  if (!(await tab.$(".people-panel"))) await tab.click(".participants");
  await tab.waitForSelector(".people-panel");
  await tab.click(".end-room > button");
  await tab.waitForSelector(".end-room.asking");
  await Promise.all([tab.waitForNavigation({ waitUntil: "networkidle0" }), tab.click(".end-room button.danger")]);
  // The host knows they ended it: no notice in the card.
  assert.equal(await tab.$(".ended-note"), null, "no ended notice for the host who ended it");
  assert.doesNotMatch(await tab.$eval(".entry-card", (element) => element.textContent), /has ended/);
  assert.equal(new URL(tab.url()).searchParams.has("ended"), false, "the URL forgets it");
  // (Its row is checked in the lifecycle smoke: here the host's first tab is
  // still in the room, so the server may list it again.)
}

// A fresh profile: nothing in OPFS to start with, and nothing left after.
const context = await browser.createBrowserContext();
let room = null;
try {
  room = await host(context);
  const { tab, roomId, code } = room;
  console.log(`hosting room ${code} at ${viewport.width}x${viewport.height}`);
  const first = await startBash(tab);
  assert.match(unwrap(first), /Saved in this browser: everything under \/work and \/home\/user/, "the terminal says what is saved");
  assert.doesNotMatch(unwrap(first), /Restored this room's workspace/, "a new room has nothing to restore");

  // ---- work that was never pushed ----
  await run(tab, "cd /work/repo && git init -q && git config user.email wren@example.com && git config user.name Wren");
  await run(tab, "echo 'never pushed' > notes.txt && printf '\\000\\001\\376\\377' > bytes.bin && echo scratch > /tmp/scratch");
  const committed = await run(tab, "git add notes.txt bytes.bin && git commit -q -m 'unpushed work' && git log --oneline");
  assert.match(committed, /unpushed work/);
  const head = (await run(tab, "cat .git/HEAD")).replace(/^ref: /, "").trim();
  const hash = await run(tab, `cat .git/${head}`);
  assert.match(hash, /^[0-9a-f]{40}$/, `${head} holds the commit`);
  const bytesBefore = await run(tab, "od -An -tx1 bytes.bin");
  assert.match(bytesBefore, /00 01 fe ff/);
  await shot(tab, "before-reload");
  const started = Date.now();
  await waitSaved(tab, roomId, `/work/repo/.git/${head}`, hash);
  await waitSaved(tab, roomId, "/work/repo/notes.txt", "never pushed");
  console.log(`the commit reached OPFS ${Date.now() - started} ms after it was made`);

  // ---- an unannounced reload ----
  await tab.reload({ waitUntil: "networkidle0" });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000, polling: 100 });
  const reopened = await startBash(tab);
  assert.match(unwrap(reopened), /Restored this room's workspace from this browser/);
  const log = await run(tab, "cd /work/repo && git log --oneline");
  const bytesAfter = await run(tab, "od -An -tx1 bytes.bin");
  const notes = await run(tab, "cat notes.txt");
  const scratch = await run(tab, "ls /tmp/scratch 2>&1");
  // Riff's session files live in /opt/riff, so git sees only the host's work.
  const status = await run(tab, "git status --short; echo clean");
  await shot(tab, "after-reload");
  console.log("after reload", JSON.stringify({ log, bytesAfter, notes, scratch, status }));
  assert.match(log, /unpushed work/, "the unpushed commit is back");
  assert.equal(log.split(" ")[0], hash.slice(0, 7), "the same commit");
  assert.equal(bytesAfter, bytesBefore, "the bytes are the same");
  assert.equal(notes, "never pushed");
  assert.match(unwrap(scratch), /No such file|cannot access/, "/tmp isn't saved");
  assert.equal(status, "clean", "the files match the commit");

  // ---- a second tab ----
  const second = await page(context);
  const asked = [];
  second.on("dialog", (dialog) => {
    asked.push(dialog.message());
    void dialog.accept();
  });
  await second.goto(tab.url(), { waitUntil: "networkidle0" });
  await second.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000, polling: 100 });
  await startBash(second);
  console.log("second tab asked", JSON.stringify(asked));
  assert.equal(asked.length, 1, "the second tab asks before taking the workspace over");
  assert.match(asked[0], /open in another tab/);
  await tab.bringToFront();
  await tab.waitForFunction(
    () => document.querySelector(".terminal-target .xterm-rows")?.innerText.replace(/\n/g, "").includes("no longer saved"),
    { timeout: 15_000, polling: 100 },
  );
  await shot(tab, "taken-over");
  assert.match(await run(second, "cd /work/repo && git log --oneline"), /unpushed work/, "the second tab has the work");
  await run(tab, "echo late > /work/repo/late.txt");
  await run(second, "echo second > /work/repo/second.txt");
  await waitSaved(second, roomId, "/work/repo/second.txt", "second");
  assert.equal(await saved(second, roomId, "/work/repo/late.txt"), null, "the first tab no longer saves");

  await endRoom(second, code);
  room = null;
  assert.deepEqual(pageErrors, []);
  console.log(`workspace UI smoke passed at ${viewport.width}x${viewport.height}`);
} catch (error) {
  console.error("failed:", error);
  for (const [index, open] of context.pages ? (await context.pages()).entries() : []) {
    console.error(`tab ${index} terminal:\n${await screenText(open).catch(() => "(none)")}`);
    if (process.env.DEBUG_FAIL) {
      await open.bringToFront();
      await new Promise((r) => setTimeout(r, 5000));
      console.error(`tab ${index} 5 s later:\n${await screenText(open).catch(() => "(none)")}`);
      console.error("in OPFS:", await open.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const out = [];
        for await (const [name, dir] of (await root.getDirectoryHandle("riff-workspaces")).entries()) {
          for (const slot of [0, 1]) {
            try { out.push([name, slot, Object.keys(JSON.parse(await (await (await dir.getFileHandle(`manifest-${slot}.json`)).getFile()).text()).entries).filter((p) => p.startsWith("/work/repo/") && !p.includes(".git/") && !p.includes(".wasix"))]); } catch {}
          }
        }
        return JSON.stringify(out);
      }).catch((e) => String(e)));
      await open.screenshot({ path: `${shots ?? tmpdir()}/workspace-failed-tab-${index}.png` });
    }
  }
  process.exitCode = 1;
} finally {
  // a failed run still ends its room, so the board isn't kept
  if (room) await endRoom(room.tab, room.code).catch((error) => console.error("couldn't end the room:", error.message));
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
