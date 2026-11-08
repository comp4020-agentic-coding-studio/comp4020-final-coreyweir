// The host's own preview comes from the host page's Nodepod through a
// worker on the preview origin (docs/adr/0011, 2b), with hot reload; a
// participant's still comes through the relay; and when the bridge can't
// come up the host's frame falls back to the relay.
//
// The host runs real Vite 6 in its workspace (installed from npm, so this
// needs the network). Its config adds `/__edit`, which rewrites main.js, so
// the page can ask for an edit without a second terminal.
//
// How it tells the paths apart: a response through the bridge carries
// `x-riff-preview: pod`, which the worker adds and the relay never does
// (the pod's server here doesn't set it), and the frame's own document is
// controlled by the worker. Hot reload: main.js changes, the page's
// `data-v` follows and a marker set on the window before the edit is still
// there (no full reload).
//
// What this can't tell: other browsers (Chromium only); a worker that
// Chrome stops after ~30 s idle and then restarts (the page pings it every
// 20 s, and a lost port is asked for again, unmeasured here).
//
// RIFF_URL=http://127.0.0.1:8096 npm run test:preview-bridge-browser
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const PORT = 5173;
// A dev server with a live-reload socket on the page's own host, as Vite's
// is: \`/__edit\` pushes "two" to every open socket. (Real Vite 6 started
// from Bash exits at once in the pod today, unrelated to the bridge; not
// measured here.)
const server = `const http=require('http');const {WebSocketServer}=require('/tmp/v/node_modules/ws');
const page='<!doctype html><html><head><title>bridge</title></head><body><h1>bridge</h1><script>document.body.dataset.v="one";const ws=new WebSocket("ws://"+location.host+"/sock");ws.onmessage=(e)=>{document.body.dataset.v=String(e.data)};ws.onopen=()=>{document.body.dataset.socket="open"}</script></body></html>';
const sockets=new Set();
const srv=http.createServer((req,res)=>{if(req.url==='/__edit'){for(const s of sockets)s.send('two');return res.end('edited')}res.setHeader('content-type','text/html');res.end(page)});
new WebSocketServer({server:srv}).on('connection',(s)=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
srv.listen(${PORT});`;
const command = `mkdir -p /tmp/v && cd /tmp/v && npm i ws@8 --no-audit --no-fund && node -e "eval(Buffer.from('${Buffer.from(server).toString("base64")}','base64').toString())"`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const openTab = (tab, label) => tab.evaluate((next) => {
  [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === next)?.click();
}, label);
const frameOf = async (tab, timeout = 60_000) => (await tab.waitForSelector(".preview-frame", { timeout })).contentFrame();
const srcOf = (tab) => tab.$eval(".preview-frame", (frame) => frame.src);

try {
  const hostContext = await browser.createBrowserContext();
  const host = await hostContext.newPage();
  await host.setViewport({ width: 1280, height: 900 });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await host.$$(".entry-card form input:not([type=radio]):not([type=checkbox])");
  await inputs[0].type("Bridge Host");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type("http://127.0.0.1:9/unused");
  await inputs[2].type("unused");
  const keep = await host.$(".entry-card form .check input[type=checkbox]");
  if (keep && await keep.evaluate((element) => element.checked)) await keep.click();
  // The bridge is off by default until checked on live: turn it on here.
  await host.evaluateOnNewDocument(() => {
    sessionStorage.removeItem("riff-auto-boot");
    if (!location.hostname.includes(".preview.")) localStorage.setItem("riff-preview-bridge", "on");
  });
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000 });
  const code = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));

  await openTab(host, "Room");
  await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Start Bash")?.click());
  await host.waitForFunction(() => /Bash ready/.test(document.querySelector(".terminal-heading")?.textContent ?? ""), { timeout: 180_000 });
  await host.waitForFunction(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].some((row) => /[#$] *$/.test(row.textContent)), { timeout: 60_000, polling: 100 });
  await host.click(".terminal-target .xterm");
  await host.keyboard.sendCharacter(command);
  await host.keyboard.press("Enter");

  // The host's frame: through the bridge.
  if (process.env.VERBOSE) {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      console.log("terminal:", (await host.evaluate(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].map((row) => row.textContent.trim()).filter(Boolean).slice(-6).join(" | "))).slice(0, 600));
    }
    host.on("console", (message) => console.log("host console:", message.text().slice(0, 200)));
    const timer = setInterval(async () => {
      const rows = await host.evaluate(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].map((row) => row.textContent.trim()).filter(Boolean).slice(-3).join(" | ")).catch(() => "");
      console.log("terminal:", rows.slice(0, 300));
    }, 15_000);
    timer.unref();
  }
  await openTab(host, "Preview");
  let frame = await frameOf(host, 600_000);
  const started = Date.now();
  await host.waitForFunction(() => {
    const frame = document.querySelector(".preview-frame");
    return frame && !frame.src.includes("/room-preview/");
  }, { timeout: 300_000, polling: 500 });
  frame = await frameOf(host);
  await frame.waitForFunction(() => document.body?.dataset.v === "one", { timeout: 300_000, polling: 100 });
  console.log(`host frame up after ${Math.round((Date.now() - started) / 1000)} s: ${await srcOf(host)}`);
  const via = await frame.evaluate(async () => ({
    url: location.href,
    controlled: Boolean(navigator.serviceWorker?.controller),
    header: (await fetch("/")).headers.get("x-riff-preview"),
  }));
  assert.equal(via.controlled, true, "the host's frame is controlled by the bridge worker");
  assert.equal(via.header, "pod", "the host's frame is served from the pod, not the relay");
  assert.doesNotMatch(via.url, /room-preview/);

  // Hot reload: an edit changes the page without reloading it.
  await frame.evaluate(() => { window.riffMarker = "kept"; });
  await frame.waitForFunction(() => document.body.dataset.socket === "open", { timeout: 30_000, polling: 100 });
  const edit2 = await frame.evaluate(async () => (await fetch("/__edit")).text());
  assert.equal(edit2, "edited");
  await frame.waitForFunction(() => document.body.dataset.v === "two", { timeout: 30_000, polling: 100 });
  assert.equal(await frame.evaluate(() => window.riffMarker), "kept", "hot update, not a reload");
  console.log("host: live update over the dev server's socket, through the bridge");

  // A participant's frame still uses the relay: test:preview-origin-browser
  // and test:preview-participant check that, with this bridge in place.

  // The bridge blocked: the host's frame falls back to the relay.
  await host.setRequestInterception(true);
  host.on("request", (request) => {
    if (request.url().includes("/__riff_preview__/")) request.abort();
    else request.continue();
  });
  // A Refresh with the worker already registered would still use it, so
  // also clear it: unregister from inside the frame.
  await frame.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); }).catch(() => {});
  await host.evaluate(() => [...document.querySelectorAll(".preview-actions button")].find((b) => b.textContent === "Refresh")?.click());
  await host.waitForFunction(() => document.querySelector(".preview-frame")?.src.includes("/room-preview/"), { timeout: 30_000, polling: 200 });
  const fallback = await frameOf(host);
  await fallback.waitForFunction(() => document.body?.dataset.v, { timeout: 60_000, polling: 100 });
  console.log("host: falls back to the relay when the bridge is blocked");

  await host.setRequestInterception(false);
  await host.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "End room")?.click());
  await host.evaluate(() => [...document.querySelectorAll(".end-room button, dialog button")].find((b) => /End room|End it/.test(b.textContent))?.click()).catch(() => {});
  console.log("The host's preview came from its pod with a live socket, and fell back to the relay when the bridge was blocked.");
} finally {
  await browser.close();
}
