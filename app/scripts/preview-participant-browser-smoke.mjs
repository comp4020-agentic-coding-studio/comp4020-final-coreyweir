import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const previewPort = 4318;
const room = `riff-preview-${Date.now().toString(36)}`;
const hostCapability = "browser-host-capability-that-is-at-least-forty-eight-characters";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const host = await browser.newPage();
  const errors = [];
  host.on("pageerror", (error) => errors.push(String(error)));
  await host.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  await host.evaluate(async ({ roomName, hostKey }) => {
    const fromBase64 = (value) => {
      const binary = atob(value);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    };
    const toBase64 = (bytes) => {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
      }
      return btoa(binary);
    };
    const { ClaudePodController } = await import("/src/claudePod.ts");
    let generation = 0;
    let live = false;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/preview-control/${roomName}`);
    const sendState = () => socket.send(JSON.stringify(live
      ? { type: "preview-up", generation }
      : { type: "preview-down", generation }));
    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {}, (url) => {
      live = Boolean(url);
      if (live) generation += 1;
      if (socket.readyState === WebSocket.OPEN) sendState();
    });
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "hello",
      capability: hostKey,
    })));
    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "host-accepted") {
        sendState();
        return;
      }
      if (message.type !== "request") return;
      const response = await controller.requestPreview({
        method: message.method,
        path: message.path,
        headers: message.headers,
        body: message.body ? fromBase64(message.body) : null,
      });
      socket.send(JSON.stringify({
        type: "response",
        requestId: message.requestId,
        status: response.status,
        headers: response.headers,
        body: toBase64(response.body),
      }));
    });
    await controller.boot();
    window.__previewController = controller;
    window.__previewSocket = socket;
    window.__previewGeneration = () => generation;
    window.__previewLive = () => live;
  }, { roomName: room, hostKey: hostCapability });

  await host.evaluate(async (port) => {
    const script = "document.body.dataset.script='executed';try{parent.localStorage.getItem('riff-host-config');document.body.dataset.isolation='failed'}catch{document.body.dataset.isolation='safe'}";
    // A module whose own import is root-relative, exactly as a dev server
    // rewrites bare and relative specifiers. It resolves against the embedding
    // origin, not the relay base, so it only reaches the pod if the relay
    // rewrote the specifier under the room prefix.
    const entry = 'import "/module-dep.js";document.body.dataset.entry="loaded"';
    const dependency = 'document.body.dataset.dependency="loaded"';
    const page = (title, link) => `<link rel="stylesheet" href="/styles.css"><h1>${title}</h1>${link}<script src="/@vite/client"></script><script type="module" src="/module-entry.js"></script>`;
    const index = page("Participant preview", '<a id="next" href="./next.html">Next</a>');
    const next = page("Participant next page", '<a id="home" href="./index.html">Home</a>');
    const source = `const http=require('http');const js={'/@vite/client':${JSON.stringify(script)},'/module-entry.js':${JSON.stringify(entry)},'/module-dep.js':${JSON.stringify(dependency)}};http.createServer((req,res)=>{if(js[req.url]!==undefined){res.setHeader('content-type','text/javascript');return res.end(js[req.url])}if(req.url==='/styles.css'){res.setHeader('content-type','text/css');return res.end('body{--preview-styled:yes}')}res.setHeader('content-type','text/html');res.end(req.url==='/next.html'?${JSON.stringify(next)}:${JSON.stringify(index)})}).listen(${port})`;
    window.__previewProcess = await window.__previewController.pod.spawn("node", ["-e", source]);
  }, previewPort);
  await host.waitForFunction(() => window.__previewGeneration() === 1, { timeout: 30_000 });

  const participantContext = await browser.createBrowserContext();
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => errors.push(String(error)));
  await participant.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  const relayUrl = `${baseUrl}/room-preview/${room}/1/`;
  await participant.evaluate((url) => {
    const iframe = document.createElement("iframe");
    iframe.className = "participant-preview";
    iframe.sandbox.add("allow-scripts");
    iframe.src = url;
    document.body.append(iframe);
  }, relayUrl);
  const iframe = await participant.waitForSelector(".participant-preview");
  const frame = await iframe.contentFrame();
  assert(frame);
  await frame.waitForSelector("h1", { timeout: 30_000 });
  await frame.waitForFunction(() => document.body.dataset.script === "executed", { timeout: 30_000 });
  await frame.waitForFunction(() => document.body.dataset.dependency === "loaded", { timeout: 30_000 });
  assert.equal(await frame.evaluate(() => document.body.dataset.entry), "loaded");
  assert.equal(await frame.$eval("h1", (element) => element.textContent), "Participant preview");
  assert.equal(await frame.evaluate(() => document.body.dataset.isolation), "safe");
  assert.equal(await frame.evaluate(() => getComputedStyle(document.body).getPropertyValue("--preview-styled")), "yes");
  await frame.click("#next");
  await frame.waitForSelector("#home");
  assert.equal(await frame.$eval("h1", (element) => element.textContent), "Participant next page");
  assert.equal(await frame.evaluate(() => getComputedStyle(document.body).getPropertyValue("--preview-styled")), "yes");
  await frame.click("#home");
  await frame.waitForSelector("#next");
  assert.equal(await frame.$eval("h1", (element) => element.textContent), "Participant preview");

  await host.evaluate(() => window.__previewProcess.kill());
  await host.waitForFunction(() => window.__previewLive() === false, { timeout: 30_000 });
  assert.equal(await participant.evaluate((url) => fetch(url).then((response) => response.status), relayUrl), 404);

  await host.evaluate(async () => {
    await window.__previewController.dispose();
    window.__previewSocket.close();
  });
  await participantContext.close();
  assert.deepEqual(errors, []);
  console.log("Separate participant browser rendered a sandboxed relayed Nodepod preview.");
} finally {
  await browser.close();
}
