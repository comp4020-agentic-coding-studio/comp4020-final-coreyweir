// Workspace export through the page: a host in a room, WASIX bash typed
// into the terminal like a person would, the Export dialog, the download,
// and the zip read back outside the page. At 1280x800 and 390x844.
//
// Checks: the button is off until the workspace boots; what bash wrote
// (text, and a binary file whose sha256 bash printed in the terminal)
// comes out byte for byte; the dialog's defaults (transcripts ticked,
// dependencies not); node_modules left out and named in the summary; the
// dialog fits the phone's screen; a participant sees no Export button.
//
// Not told apart: Claude itself writing files (bash stands in); anything
// about a real model key; OPFS (the pod is memory-backed until it lands).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { unzipSync } from "fflate";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8095";
const sizes = [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }];
const dec = new TextDecoder();

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

async function terminalText(page) {
  return page.evaluate(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].map((row) => row.textContent).join("\n"));
}

try {
  for (const size of sizes) {
    const context = await browser.createBrowserContext();
    const host = await context.newPage();
    const pageErrors = [];
    host.on("pageerror", (error) => pageErrors.push(String(error)));
    await host.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    const downloads = mkdtempSync(path.join(os.tmpdir(), "riff-dl-"));
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, browserContextId: context.id });

    await host.goto(baseUrl, { waitUntil: "networkidle0" });
    await host.click(".entry-card > nav button:nth-child(2)");
    await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
    const inputs = await host.$$(".entry-card form input:not([type=radio])");
    await inputs[0].type("Export Host");
    await inputs[1].click({ clickCount: 3 });
    await inputs[1].type(`${baseUrl}/fake-anthropic`);
    await inputs[2].type("invalid-export-smoke-token");
    await host.click(".entry-card form .primary");
    await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
    await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000 });
    await host.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === "Room")?.click());

    const exportButton = async () => host.evaluateHandle(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Export"));
    const before = await exportButton();
    assert.equal(await before.evaluate((b) => b.disabled), true, `${size.name}: nothing to export before the workspace boots`);

    // Start Bash (second button): boots the pod and gives a prompt.
    await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Start Bash")?.click());
    await host.waitForFunction(() => /WASIX Bash ready/.test(document.querySelector(".terminal-heading")?.textContent ?? ""), { timeout: 180_000 });
    assert.equal(await (await exportButton()).evaluate((b) => b.disabled), false, `${size.name}: Export is on once it has booted`);

    const type = async (line) => { await host.click(".terminal-target .xterm"); await host.keyboard.type(line); await host.keyboard.press("Enter"); };
    await type("mkdir -p src/deep && echo 'hello from the ui smoke' > src/deep/hello.txt");
    await type("head -c 3000 /dev/urandom > random.bin && sha256sum random.bin");
    await type("mkdir -p node_modules/x && echo dep > node_modules/x/index.js && echo done-writing");
    await host.waitForFunction(() => /done-writing\s*\n?.*\$?/.test([...document.querySelectorAll(".terminal-target .xterm-rows > div")].map((r) => r.textContent).join("\n").split("echo done-writing").pop() ?? ""), { timeout: 60_000 });
    await host.waitForFunction(() => /\n\s*done-writing/.test([...document.querySelectorAll(".terminal-target .xterm-rows > div")].map((r) => r.textContent).join("\n")), { timeout: 60_000 });
    // On the phone the line wraps, so match with the whitespace gone.
    const sha = (await terminalText(host)).replace(/\s+/g, "").match(/([0-9a-f]{64})random\.bin/)?.[1];
    assert.ok(sha, `${size.name}: bash printed the file's hash`);

    // Open the dialog.
    await (await exportButton()).click();
    await host.waitForSelector(".ws-export");
    const boxes = await host.$$eval(".ws-export-option input", (els) => els.map((el) => el.checked));
    assert.deepEqual(boxes, [true, false], `${size.name}: transcripts ticked, dependencies not`);
    const fit = await host.$eval(".ws-export", (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight }; });
    assert.ok(fit.left >= 0 && fit.right <= fit.w && fit.top >= 0 && fit.bottom <= fit.h, `${size.name}: the dialog fits the screen ${JSON.stringify(fit)}`);
    await host.screenshot({ path: path.join(os.tmpdir(), `opencode/ws-export-${size.name}.png`) }).catch(() => {});

    await host.click(".ws-export-go");
    await host.waitForSelector(".ws-export-summary", { timeout: 60_000 });
    const summary = await host.$eval(".ws-export-summary", (el) => el.textContent);
    assert.match(summary, /riff-workspace-.*\.zip/, `${size.name}: the summary names the file`);
    assert.match(summary, /Left out: node_modules \(\d+ files?/, `${size.name}: it says node_modules was left out`);
    assert.match(summary, /Riff's own session files .* are never included/);
    await host.screenshot({ path: path.join(os.tmpdir(), `opencode/ws-export-${size.name}-done.png`) }).catch(() => {});

    // The download lands.
    let file = null;
    const deadline = Date.now() + 30_000;
    while (!file && Date.now() < deadline) {
      file = readdirSync(downloads).find((name) => name.endsWith(".zip")) ?? null;
      if (!file) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(file, `${size.name}: the zip was downloaded`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const files = unzipSync(new Uint8Array(readFileSync(path.join(downloads, file))));
    assert.equal(dec.decode(files["repo/src/deep/hello.txt"]), "hello from the ui smoke\n");
    assert.equal(createHash("sha256").update(files["repo/random.bin"]).digest("hex"), sha, `${size.name}: the binary file matches the hash bash printed`);
    assert.equal(Object.keys(files).some((n) => n.includes("node_modules") || n.includes(".wasix-session")), false);
    const manifest = JSON.parse(dec.decode(files["riff-workspace.json"]));
    assert.equal(manifest.includes.transcripts, true);
    assert.equal(manifest.includes.dependencies, false);

    // A participant sees no Export button.
    const guestContext = await browser.createBrowserContext();
    const guest = await guestContext.newPage();
    await guest.setViewport({ width: size.width, height: size.height });
    const code = await host.$eval(".room-name span", (el) => el.textContent.replace("Room ", ""));
    await guest.goto(`${baseUrl}/?room=${code.toLowerCase()}`, { waitUntil: "networkidle0" });
    await guest.waitForSelector(".entry-card form");
    await (await guest.$$(".entry-card form input"))[0].type("Export Guest");
    await guest.click(".entry-card form .primary");
    await guest.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
    await guest.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((b) => b.textContent === "Room")?.click());
    await guest.waitForSelector(".terminal-pane");
    assert.equal(await guest.$$eval(".terminal-controls button, .ws-export", (els) => els.length), 0, `${size.name}: a participant has no export`);

    assert.deepEqual(pageErrors, [], `${size.name}: no page errors`);
    console.log(`${size.name}: ok (${Object.keys(files).length} entries)`);
    await guestContext.close();
    await context.close();
  }
  console.log("workspace export ui smoke: ok");
} finally {
  await browser.close();
}
