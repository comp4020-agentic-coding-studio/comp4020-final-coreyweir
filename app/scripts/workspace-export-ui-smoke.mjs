// Workspace export through the page, so it runs against the built live app
// as well as dev (the browser smoke imports source files and can't).
//
// A host makes a room (board not kept, so ending it deletes the board), starts
// WASIX bash and types what a person would: a nested directory, a name with
// a space and unicode, an empty file, a binary file whose sha256 bash prints,
// a git repository with a token pasted into its remote and an unpushed commit,
// the token in a note, a transcript where Claude Code keeps them, and a
// node_modules. The Export dialog downloads the zip; it is read back here,
// outside the page, and compared byte for byte (the binary file against the
// hash bash printed), and `python3 -m zipfile -t` accepts it.
//
// Then the page reloads with no warning: the host's pod opens the room's saved
// workspace from OPFS (docs/adr/0010; the smoke waits for OPFS to hold the
// files' sizes, not a sleep), the terminal says it restored it, and a second
// export has the same content. A participant has no Export button. The room
// is ended at the end. At 1280x800 and 390x844 (SIZES=desktop or phone for one).
//
// Not told apart: Claude itself writing files (bash stands in); a real model
// key (the token here is made up, typed into the host form); a real crash from
// a reload; whether OPFS held the bytes on disk or in the browser's cache.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { unzipSync } from "fflate";

const baseUrl = (process.env.RIFF_URL ?? "http://127.0.0.1:8095").replace(/\/$/, "");
const allSizes = [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }];
const sizes = allSizes.filter((size) => !process.env.SIZES || process.env.SIZES.split(",").includes(size.name));
const TOKEN = "invalid-export-smoke-token-0123";
const dec = new TextDecoder();
const shots = path.join(os.tmpdir(), "opencode");
mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

async function diagnose(page, name) {
  await page.screenshot({ path: path.join(shots, `ws-export-fail-${name}.png`) }).catch(() => {});
  const text = await page.evaluate(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].map((r) => r.textContent).join("\n").slice(-600)).catch(() => "");
  console.log(`--- terminal tail (${name}):\n${text}\n---`);
  const focus = await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`).catch(() => "?");
  await page.keyboard.type("Q").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await page.evaluate(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].map((r) => r.textContent).filter((t) => t.trim()).slice(-2).join(" | ")).catch(() => "");
  console.log(`focus: ${focus}; after typing Q: ${after}`);
}
const rows = (page) => page.evaluate(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].map((row) => row.textContent).join("\n"));
const stockTool = (file) => {
  const result = spawnSync("python3", ["-m", "zipfile", "-t", file], { encoding: "utf8" });
  assert.equal(result.status, 0, `a stock tool reads the zip: ${result.stdout}${result.stderr}`);
};

try {
  for (const size of sizes) {
    const say = (m) => `${size.name}: ${m}`;
    const context = await browser.createBrowserContext();
    const host = await context.newPage();
    const pageErrors = [];
    host.on("pageerror", (error) => pageErrors.push(String(error)));
    await host.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    const downloads = mkdtempSync(path.join(os.tmpdir(), "riff-dl-"));
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, browserContextId: context.id });

    // ---- host a room
    await host.goto(baseUrl, { waitUntil: "networkidle0" });
    await host.click(".entry-card > nav button:nth-child(2)");
    await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
    const inputs = await host.$$(".entry-card form input:not([type=radio]):not([type=checkbox])");
    await inputs[0].type("Export Host");
    await inputs[1].click({ clickCount: 3 });
    await inputs[1].type(`${baseUrl}/fake-anthropic`);
    await inputs[2].type(TOKEN);
    // Not kept: ending the room deletes its board from the server.
    const keep = await host.$(".entry-card form .check input[type=checkbox]");
    if (keep && await keep.evaluate((el) => el.checked)) await keep.click();
    // Bash first: keep the new room from booting Claude by itself (autoBoot.ts).
    await host.evaluateOnNewDocument(() => sessionStorage.removeItem("riff-auto-boot"));
    await host.click(".entry-card form .primary");
    await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
    await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000 });
    const roomId = await host.evaluate(() => new URL(location.href).searchParams.get("id"));
    const code = await host.$eval(".room-name span", (el) => el.textContent.replace("Room ", ""));
    await host.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === "Room")?.click());

    const exportButton = () => host.evaluateHandle(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Export"));
    assert.equal(await (await exportButton()).evaluate((b) => b.disabled), true, say("nothing to export before the workspace boots"));

    const startBash = async () => {
      await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Start Bash")?.click());
      await host.waitForFunction(() => /Bash ready/.test(document.querySelector(".terminal-heading")?.textContent ?? ""), { timeout: 180_000 });
    };
    // While it boots there's a controller but no files yet: still off.
    await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Start Bash")?.click());
    // The controller reports from inside its boot, so by then it exists.
    await host.waitForFunction(() => /Loading Claude runtime|Downloading/.test(document.querySelector(".terminal-heading")?.textContent ?? ""), { timeout: 30_000, polling: 50 });
    assert.equal(await (await exportButton()).evaluate((b) => b.disabled), true, say("nothing to export while the workspace boots"));
    await startBash();
    assert.equal(await (await exportButton()).evaluate((b) => b.disabled), false, say("Export is on once it has booted"));

    // Type a line, then wait for its sentinel. The sentinel is computed, so the
    // echoed command line never contains the text it waits for.
    let n = 0;
    const run = async (line) => {
      try { await runLine(line); } catch (error) { await diagnose(host, `${size.name}-${n}`); throw error; }
    };
    const runLine = async (line) => {
      const tag = `DONE-${1000 + ++n}`;
      // The first keys after "ready" can beat the first prompt. Later lines follow
      // the previous one's sentinel. (On the phone a long line scrolls sideways and
      // the redraw can put output after the prompt, so no stricter match than this.)
      if (n === 1) await host.waitForFunction(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].some((r) => r.textContent.includes("riff:/work/repo$")), { timeout: 60_000, polling: 100 });
      await host.click(".terminal-target .xterm");
      await host.keyboard.type(`${line}; echo DONE-$((${n} + 1000))`, { delay: 8 });
      await host.keyboard.press("Enter");
      await host.waitForFunction((tag) => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].some((r) => r.textContent.includes(tag)), { timeout: 60_000, polling: 100 }, tag);
    };
    await run("mkdir -p 'src/deep er' && echo nested > 'src/deep er/nü.txt'");
    await run(": > empty.txt");
    await run("head -c 3000 /dev/urandom > random.bin && sha256sum random.bin");
    // Read it now: on a phone's short screen the commands after it scroll
    // it away. A long line wraps there, so match with the whitespace gone.
    const sha = (await rows(host)).replace(/\s+/g, "").match(/([0-9a-f]{64})random\.bin/)?.[1];
    assert.ok(sha, say("bash printed the file's hash"));
    await run("mkdir -p node_modules/x && echo dep > node_modules/x/index.js");
    await run("git init -q && git config user.email host@example.com && git config user.name Host");
    await run(`git remote add origin https://x-access-token:${TOKEN}@github.com/o/r.git`);
    await run("git add src empty.txt random.bin && git commit -m 'unpushed work'");
    await run(`echo "my token: ${TOKEN}" > notes.txt`);
    await run(`mkdir -p ~/.claude/projects/-work-repo && echo "tool printed ${TOKEN}" > ~/.claude/projects/-work-repo/smoke.jsonl`);

    // Sizes, so we can wait until OPFS holds exactly those. Two are known here;
    // the git store's is bash's to say. (No $(...) in these lines: a command
    // substitution forks a subshell, which stalled bash now and then.)
    await run("wc -c .git/objects/store.json");
    const storeSize = Number((await rows(host)).split("\n").map((r) => /^\s*(\d+)\s+\.git\/objects\/store\.json/.exec(r)?.[1]).filter(Boolean).at(-1));
    assert.ok(storeSize > 0, say("bash printed the store's size"));
    const want = {
      "/work/repo/notes.txt": `my token: ${TOKEN}\n`.length,
      "/work/repo/.git/objects/store.json": storeSize,
      "/home/user/.claude/projects/-work-repo/smoke.jsonl": `tool printed ${TOKEN}\n`.length,
      "/work/repo/random.bin": 3000,
    };

    // ---- export, with the dialog
    let exportCount = 0;
    async function exportViaDialog({ transcripts = true, dependencies = false } = {}) {
      await (await exportButton()).click();
      await host.waitForSelector(".ws-export");
      const [t, d] = await host.$$eval(".ws-export-option input", (els) => els.map((el) => el.checked));
      assert.deepEqual([t, d], [true, false], say("transcripts ticked, dependencies not, by default"));
      if (!transcripts) await host.click(".ws-export-option:nth-of-type(1) input");
      if (dependencies) await host.click(".ws-export-option:nth-of-type(2) input");
      const fit = await host.$eval(".ws-export", (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight }; });
      assert.ok(fit.left >= 0 && fit.right <= fit.w && fit.top >= 0 && fit.bottom <= fit.h, say(`the dialog fits the screen ${JSON.stringify(fit)}`));
      await host.click(".ws-export-go");
      await host.waitForSelector(".ws-export-summary", { timeout: 60_000 });
      const summary = await host.$eval(".ws-export-summary", (el) => el.textContent);
      let file = null;
      const deadline = Date.now() + 30_000;
      while (!file && Date.now() < deadline) {
        file = readdirSync(downloads).find((name) => name.endsWith(".zip")) ?? null;
        if (!file) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(file, say("the zip was downloaded"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Two exports in a day share a name, so move each download out of the way.
      const zipPath = path.join(downloads, `export-${++exportCount}.zip.keep`);
      copyFileSync(path.join(downloads, file), zipPath);
      unlinkSync(path.join(downloads, file));
      const bytes = new Uint8Array(readFileSync(zipPath));
      await host.screenshot({ path: path.join(shots, `ws-export-${size.name}.png`) }).catch(() => {});
      await host.click(".ws-export-actions button:last-child");
      await host.waitForFunction(() => !document.querySelector(".ws-export"));
      return { zipPath, files: unzipSync(bytes), summary };
    }

    // What the zip must and mustn't hold.
    function check(label, { zipPath, files, summary }, { transcripts = true, dependencies = false } = {}) {
      stockTool(zipPath);
      const m = (what) => say(`${label}: ${what}`);
      assert.match(summary, /riff-workspace-.*\.zip/, m("the summary names the file"));
      assert.match(dec.decode(files["repo/src/deep er/nü.txt"] ?? new Uint8Array()), /^nested\n$/, m("a nested dir and a unicode name with a space"));
      assert.ok(files["repo/empty.txt"] && files["repo/empty.txt"].length === 0, m("an empty file"));
      assert.equal(createHash("sha256").update(files["repo/random.bin"] ?? new Uint8Array()).digest("hex"), sha, m("the binary file matches the hash bash printed"));
      assert.equal(files["repo/random.bin"].length, 3000);
      assert.ok(/unpushed work/.test(dec.decode(files["repo/.git/objects/store.json"])), m("the unpushed commit travels"));
      const config = dec.decode(files["repo/.git/config"]);
      assert.match(config, /url = https:\/\/github\.com\/o\/r\.git/, m("the remote stays, without its token"));
      assert.match(config, /host@example\.com/);
      assert.match(dec.decode(files["repo/notes.txt"]), /^my token: \*+\n$/, m("a real token pasted into a file is overwritten"));
      for (const [name, data] of Object.entries(files)) {
        assert.equal(Buffer.from(data).toString("latin1").includes(TOKEN), false, m(`no real token in ${name}`));
      }
      const names = Object.keys(files);
      assert.equal(names.some((n) => n.includes(".wasix-session")), false, m("Riff's session folder stays out"));
      assert.equal(names.some((n) => n.includes("node_modules")), dependencies, m(dependencies ? "node_modules included when ticked" : "node_modules left out by default"));
      assert.equal(names.includes("claude/projects/-work-repo/smoke.jsonl"), transcripts, m(transcripts ? "the transcript is in" : "the transcript is out when unticked"));
      if (transcripts) {
        const text = dec.decode(files["claude/projects/-work-repo/smoke.jsonl"]);
        assert.match(text, /^tool printed \*+\n$/, m("a token a tool printed into a transcript is overwritten"));
      }
      const manifest = JSON.parse(dec.decode(files["riff-workspace.json"]));
      const commit = manifest.history?.commits.find((c) => c.message === "unpushed work");
      assert.ok(commit && commit.unpushed === true, m("the manifest lists the commit as unpushed"));
      assert.equal(manifest.left.some((e) => e.reason === "session"), false, m("the session folder is outside the workspace, so nothing to leave out"));
      assert.equal(manifest.left.some((e) => e.reason === "dependencies"), !dependencies);
      if (!dependencies) assert.match(summary, /Left out: node_modules \(\d+ files?/, m("the summary says node_modules was left out"));
      if (dependencies) assert.equal(dec.decode(files["repo/node_modules/x/index.js"]), "dep\n");
      return manifest;
    }

    const first = await exportViaDialog();
    check("before reload", first);
    const noTranscripts = await exportViaDialog({ transcripts: false, dependencies: true });
    check("before reload, transcripts unticked and dependencies ticked", noTranscripts, { transcripts: false, dependencies: true });

    // ---- reload with no warning: the workspace comes back from OPFS
    await host.evaluate(async ({ room, want }) => {
      const root = await navigator.storage.getDirectory();
      const deadline = Date.now() + 120_000;
      for (;;) {
        const dir = await root.getDirectoryHandle("riff-workspaces").then((d) => d.getDirectoryHandle(room)).catch(() => null);
        const read = async (slot) => { try { return JSON.parse(await (await (await dir.getFileHandle(`manifest-${slot}.json`)).getFile()).text()); } catch { return null; } };
        const [a, b] = dir ? await Promise.all([read(0), read(1)]) : [null, null];
        const manifest = !a ? b : !b ? a : a.seq >= b.seq ? a : b;
        if (manifest && Object.entries(want).every(([p, size]) => manifest.entries[p]?.[3] === size)) return;
        if (Date.now() > deadline) throw new Error(`OPFS never held ${JSON.stringify(want)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }, { room: roomId, want });
    await host.reload({ waitUntil: "networkidle0" });
    await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 30_000 });
    await host.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === "Room")?.click());
    assert.equal(await (await exportButton()).evaluate((b) => b.disabled), true, say("after a reload the workspace needs booting again"));
    await startBash();
    assert.match(await rows(host), /Restored this room's workspace from this browser/, say("the terminal says it restored the workspace"));
    const second = await exportViaDialog();
    check("after reload", second);
    for (const name of ["repo/src/deep er/nü.txt", "repo/empty.txt", "repo/random.bin", "repo/notes.txt", "repo/.git/objects/store.json", "claude/projects/-work-repo/smoke.jsonl"]) {
      assert.deepEqual(Buffer.from(second.files[name]), Buffer.from(first.files[name]), say(`${name} is the same bytes after a reload`));
    }

    // ---- a participant has no Export button
    const guestContext = await browser.createBrowserContext();
    const guest = await guestContext.newPage();
    await guest.setViewport({ width: size.width, height: size.height });
    await guest.goto(`${baseUrl}/?room=${code.toLowerCase()}`, { waitUntil: "networkidle0" });
    await guest.waitForSelector(".entry-card form");
    await (await guest.$$(".entry-card form input"))[0].type("Export Guest");
    await guest.click(".entry-card form .primary");
    await guest.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
    await guest.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === "Room")?.click());
    await guest.waitForSelector(".terminal-pane");
    assert.equal(await guest.$$eval(".terminal-controls button:not(.mirror-mode), .ws-export", (els) => els.length), 0, say("a participant has no export"));
    await guestContext.close();

    // ---- end the room, so a live run leaves nothing behind
    await host.click(".participants");
    await host.waitForSelector(".end-room button");
    await host.click(".end-room button");
    await host.click(".end-room .danger");
    await host.waitForFunction(() => new URL(location.href).searchParams.has("ended") || !location.search.includes("id="), { timeout: 20_000 });

    assert.deepEqual(pageErrors, [], say("no page errors"));
    console.log(`${size.name}: ok (room ${code}, ${Object.keys(first.files).length} then ${Object.keys(second.files).length} entries)`);
    await context.close();
  }
  console.log("workspace export ui smoke: ok");
} finally {
  await browser.close();
}
