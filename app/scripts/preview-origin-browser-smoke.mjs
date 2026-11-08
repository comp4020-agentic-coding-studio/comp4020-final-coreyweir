// A hostile preview, in Riff's real room UI (docs/adr/0011). The host starts
// a dev server in its workspace whose page tries everything a page Claude
// wrote could try against the people looking at it: read the host page and
// its stored tokens, use Riff's cookie, open Riff's sockets. Host and
// participant both load it, at phone and desktop sizes, and both must get:
//
// - the page on the room's own preview origin, never Riff's
// - nothing of Riff's from inside it (parent, storage, cookie, API, sockets)
// - a page that works: stylesheet, module import, its own localStorage
//   (kept across a reload), a form POST to the dev server
//
// and the host's own Nodepod worker must refuse to serve a pod page as a
// document on Riff's origin.
//
// What this can't tell apart: whether Riff's session cookie would ride along
// on the preview's credentialed fetch. The smoke's host is a guest (no
// GitHub session), and the browser hides the answer behind CORS either way.
// The server refusing the preview's Origin (spec/preview-origin.test.ts) and
// the cookie's SameSite=Lax on a different site cover that.
//
// RIFF_URL=http://127.0.0.1:8096 npm run test:preview-origin-browser
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const riff = new URL(baseUrl).origin;
const PORT = 4471;

const page = `<!doctype html><html><head><link rel="stylesheet" href="/s.css"></head><body><h1>Hostile preview</h1><form id="f" method="post" action="/echo"><input name="hello" value="world"></form><script type="module" src="/m.js"></script></body></html>`;
const probe = `import { dep } from "/dep.js";
const RIFF = ${JSON.stringify(riff)};
const r = { origin: location.origin, cookie: document.cookie, dep };
const t = (name, f) => { try { r[name] = f(); } catch (e) { r[name] = "blocked:" + e.name; } };
t("parentDocument", () => typeof parent.document.title);
t("parentStorage", () => parent.localStorage.getItem("riff-host-config"));
t("parentFetch", () => typeof parent.fetch);
t("topHref", () => top.location.href);
t("storedBefore", () => localStorage.getItem("riff-preview-probe"));
t("storage", () => { localStorage.setItem("riff-preview-probe", "kept"); return localStorage.getItem("riff-preview-probe"); });
r.styled = getComputedStyle(document.body).getPropertyValue("--probe").trim();
for (const [name, path, init] of [["unwrap", "/api/github/token/unwrap", { method: "POST", credentials: "include" }], ["me", "/api/me", { credentials: "include" }]]) {
  try { const res = await fetch(RIFF + path, init); r[name] = "read:" + res.status + ":" + (await res.text()).slice(0, 80); }
  catch (e) { r[name] = "blocked:" + e.name; }
}
r.socket = await new Promise((done) => {
  const ws = new WebSocket(RIFF.replace(/^http/, "ws") + "/collaboration");
  ws.onopen = () => { done("open"); ws.close(); };
  ws.onerror = () => done("refused");
  setTimeout(() => done("timeout"), 5000);
});
document.body.dataset.result = JSON.stringify(r);
`;
const server = `const http=require('http');
const files={'/s.css':['text/css','body{--probe:styled}'],'/dep.js':['text/javascript','export const dep="loaded";'],'/m.js':['text/javascript',${JSON.stringify(probe)}]};
http.createServer((req,res)=>{
  if(req.method==='POST'&&req.url==='/echo'){let b='';req.on('data',(c)=>b+=c);req.on('end',()=>{res.setHeader('content-type','text/html');res.end('<p id="posted">'+b+'</p><a id="back" href="/">Back</a>')});return}
  const f=files[req.url];res.setHeader('content-type',f?f[0]:'text/html');res.end(f?f[1]:${JSON.stringify(page)});
}).listen(${PORT});`;
const command = `node -e "eval(Buffer.from('${Buffer.from(server).toString("base64")}','base64').toString())"`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1 };
const DESKTOP = { width: 1920, height: 1080, deviceScaleFactor: 1 };
const openTab = (tab, label) => tab.evaluate((next) => {
  [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === next)?.click();
}, label);

try {
  const errors = [];
  const hostContext = await browser.createBrowserContext();
  const host = await hostContext.newPage();
  host.on("pageerror", (error) => errors.push(`host: ${error}`));
  await host.setViewport(DESKTOP);
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await host.$$(".entry-card form input:not([type=radio]):not([type=checkbox])");
  await inputs[0].type("Preview Host");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type("http://127.0.0.1:9/unused");
  await inputs[2].type("host-token-to-steal");
  // Not kept: ending the room deletes its board.
  const keep = await host.$(".entry-card form .check input[type=checkbox]");
  if (keep && await keep.evaluate((element) => element.checked)) await keep.click();
  // Bash first: keep the new room from booting Claude by itself (autoBoot.ts).
  await host.evaluateOnNewDocument(() => sessionStorage.removeItem("riff-auto-boot"));
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000 });
  const code = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  // There is something to steal.
  assert.match(await host.evaluate(() => localStorage.getItem("riff-host-config") ?? ""), /host-token-to-steal/);

  const participantContext = await browser.createBrowserContext();
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => errors.push(`participant: ${error}`));
  await participant.setViewport(PHONE);
  await participant.goto(`${baseUrl}/?room=${code.toLowerCase()}`, { waitUntil: "networkidle0" });
  await participant.waitForSelector(".entry-card form");
  await (await participant.$$(".entry-card form input"))[0].type("Preview Participant");
  await participant.click(".entry-card form .primary");
  await participant.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });

  // The dev server, started from the host's shell like anyone would.
  await openTab(host, "Room");
  await host.evaluate(() => [...document.querySelectorAll(".terminal-controls button")].find((b) => b.textContent === "Start Bash")?.click());
  await host.waitForFunction(() => /Bash ready/.test(document.querySelector(".terminal-heading")?.textContent ?? ""), { timeout: 180_000 });
  await host.waitForFunction(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")].some((row) => /[#$] *$/.test(row.textContent)), { timeout: 60_000, polling: 100 });
  await host.click(".terminal-target .xterm");
  await host.keyboard.sendCharacter(command);
  await host.keyboard.press("Enter");

  // The host's Nodepod worker serves a pod's pages to navigations under
  // /__virtual__/ and /__preview__/ on Riff's origin; Riff's worker refuses
  // them first, so none can be framed (or opened) there.
  for (const path of [`/__virtual__/1/${PORT}/`, `/__preview__/1/${PORT}/`]) {
    const text = await host.evaluate(async (src) => {
      const frame = document.createElement("iframe");
      frame.src = src;
      document.body.append(frame);
      await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
      const body = frame.contentDocument?.body?.textContent ?? "";
      frame.remove();
      return body;
    }, path);
    assert.match(text, /Previews open on their own origin/, `Riff's origin served ${path}`);
  }

  async function check(tab, who, { reloaded }) {
    await openTab(tab, "Preview");
    const handle = await tab.waitForSelector(".preview-frame", { timeout: 60_000 });
    if (reloaded) {
      await tab.evaluate(() => [...document.querySelectorAll(".preview-actions button")].find((b) => b.textContent === "Refresh")?.click());
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const element = await tab.waitForSelector(".preview-frame");
    const src = await element.evaluate((frame) => frame.src);
    const sandbox = await element.evaluate((frame) => frame.getAttribute("sandbox"));
    const previewOrigin = new URL(src).origin;
    assert.notEqual(previewOrigin, riff, `${who}: the preview is on Riff's origin`);
    assert.match(new URL(src).hostname, /^[a-z2-7]+\.preview\./, `${who}: ${src}`);
    assert.deepEqual(sandbox.split(" ").sort(), ["allow-forms", "allow-modals", "allow-same-origin", "allow-scripts"], `${who}: sandbox`);
    assert.equal(await tab.evaluate(() => crossOriginIsolated), true, `${who}: Riff's page stays isolated`);
    // Riff's own origin never serves the relay path (the host's frame may
    // start at the pod bridge's page instead, docs/adr/0011 2b), nor the
    // bridge's worker.
    const relayPath = src.includes("/room-preview/") ? new URL(src).pathname : "/room-preview/x/y/1/";
    const onRiff = await tab.evaluate(async (path) => (await fetch(path)).status, relayPath);
    assert.equal(onRiff, 404, `${who}: Riff's origin served the preview`);
    const bridgeOnRiff = await tab.evaluate(async () => (await fetch("/__riff_preview__/sw.js")).text());
    assert.doesNotMatch(bridgeOnRiff, /riff-port/, `${who}: Riff's origin served the bridge's worker`);

    const frame = await element.contentFrame();
    assert(frame, `${who}: no frame`);
    // Poll on a timer: Chrome can starve animation frames in an out-of-process iframe.
    await frame.waitForFunction(() => document.body?.dataset.result, { timeout: 60_000, polling: 100 });
    const result = JSON.parse(await frame.evaluate(() => document.body.dataset.result));
    assert.deepEqual(result, {
      origin: previewOrigin,
      cookie: "",
      dep: "loaded",
      parentDocument: "blocked:SecurityError",
      parentStorage: "blocked:SecurityError",
      parentFetch: "blocked:SecurityError",
      topHref: "blocked:SecurityError",
      storedBefore: reloaded ? "kept" : null,
      storage: "kept",
      styled: "styled",
      unwrap: "blocked:TypeError",
      me: "blocked:TypeError",
      socket: "refused",
    }, `${who}: what the preview could do`);

    // A form POST reaches the dev server, inside the frame.
    await frame.evaluate(() => document.getElementById("f").submit());
    await tab.waitForFunction(() => document.querySelector(".preview-frame") !== null, { polling: 100 });
    const after = await (await tab.$(".preview-frame")).contentFrame();
    await after.waitForSelector("#posted", { timeout: 30_000, polling: 100 });
    assert.equal(await after.$eval("#posted", (element) => element.textContent), "hello=world", `${who}: form POST`);
    // and a real click on a link in it, as a person would
    await after.click("#back");
    await after.waitForSelector("#f", { timeout: 30_000, polling: 100 });
    return previewOrigin;
  }

  const hostOrigin = await check(host, "host at 1920x1080", { reloaded: false });
  const participantOrigin = await check(participant, "participant at 390x844", { reloaded: false });
  assert.equal(participantOrigin, hostOrigin, "one origin per room, for every member");

  await host.setViewport(PHONE);
  await participant.setViewport(DESKTOP);
  await check(host, "host at 390x844", { reloaded: true });
  await check(participant, "participant at 1920x1080", { reloaded: true });

  assert.deepEqual(errors, []);
  // End the room so its board is deleted.
  await host.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "End room")?.click());
  await host.evaluate(() => [...document.querySelectorAll(".end-room button, dialog button")].find((b) => /End room|End it/.test(b.textContent))?.click()).catch(() => {});
  console.log("A hostile preview on its own origin reached nothing of Riff's, and still worked, for host and participant at both sizes.");
} finally {
  await browser.close();
}
