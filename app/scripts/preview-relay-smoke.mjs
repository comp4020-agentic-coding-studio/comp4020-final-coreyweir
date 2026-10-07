import assert from "node:assert/strict";
import { createServer } from "node:http";
import WebSocket from "ws";
import { createPreviewRelay } from "../server/previewRelay.mjs";

const relay = createPreviewRelay();
const server = createServer((request, response) => {
  relay.middleware(request, response, () => {
    response.writeHead(404);
    response.end("Not found");
  });
});
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/preview-control/")) return socket.destroy();
  relay.handleUpgrade(request, socket, head, decodeURIComponent(url.pathname.slice("/preview-control/".length)));
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));

const { port } = server.address();
const room = "riff-preview-test";
const hostCapability = "host-capability-that-is-at-least-forty-eight-characters-long";
const host = new WebSocket(`ws://127.0.0.1:${port}/preview-control/${room}`);
const messages = [];

function waitFor(check, message, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 10);
  });
}

// A dev server emits root-relative URLs for everything it rewrites, in markup
// and in the modules and stylesheets it serves.
const previewFiles = {
  "/index.html": ["text/html; charset=utf-8", '<a href="http://localhost:4319/next.html">Next</a><script type="module">import "/inline.ts";</script><style>body{background:url(/pattern.png)}</style>'],
  "/main.ts": ["text/javascript", [
    'import "/node_modules/@fontsource/fraunces/latin-500.css";',
    'import {mountCarousel} from "/carousel.ts";',
    'export {theme} from"/theme.ts";',
    'const later = () => import("/late.ts");',
    'const logo = new URL("/logo.svg", import.meta.url);',
    'const untouched = [Array.from("/not-a-module"), import.meta.url, "https://cdn.example.com/x.js"];',
    'import "//cdn.example.com/y.js";',
    "//# sourceMappingURL=/main.ts.map",
  ].join("\n")],
  "/fonts.css.js": ["text/javascript", 'const __vite__css = "@import\\"/reset.css\\";@font-face{src:url(\\"/files/a.woff2\\")}"'],
  "/styles.css": ["text/css", '@import "/reset.css";body{background:url(/img/bg.png)}'],
};

host.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  messages.push(message);
  if (message.type !== "request") return;
  const requestBody = Buffer.from(message.body, "base64");
  const binary = message.path === "/asset.bin";
  const file = previewFiles[message.path];
  const body = binary
    ? Buffer.from([0, 1, 2, 255])
    : file
      ? Buffer.from(file[1])
      : Buffer.from(`${message.method} ${message.path} ${requestBody}`);
  host.send(JSON.stringify({
    type: "response",
    requestId: message.requestId,
    status: binary ? 201 : 200,
    headers: { "content-type": binary ? "application/octet-stream" : file ? file[0] : "text/plain; charset=utf-8", "set-cookie": "blocked=yes" },
    body: body.toString("base64"),
  }));
});

try {
  await new Promise((resolve) => host.once("open", resolve));
  host.send(JSON.stringify({ type: "hello", capability: hostCapability }));
  await waitFor(() => messages.some((message) => message.type === "host-accepted"), "Preview host was not accepted");
  host.send(JSON.stringify({ type: "preview-up", generation: 7 }));

  const base = `http://127.0.0.1:${port}/room-preview/${room}/7`;
  const textResponse = await fetch(`${base}/hello?name=riff`);
  assert.equal(textResponse.status, 200);
  assert.equal(await textResponse.text(), "GET /hello?name=riff ");
  assert.equal(textResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(textResponse.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(textResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(textResponse.headers.get("set-cookie"), null);

  const postResponse = await fetch(`${base}/echo`, { method: "POST", body: "payload", headers: { "content-type": "text/plain" } });
  assert.equal(await postResponse.text(), "POST /echo payload");

  const binaryResponse = await fetch(`${base}/asset.bin`);
  assert.equal(binaryResponse.status, 201);
  assert.deepEqual(new Uint8Array(await binaryResponse.arrayBuffer()), new Uint8Array([0, 1, 2, 255]));

  const prefix = `/room-preview/${room}/7`;
  const html = await (await fetch(`${base}/index.html`)).text();
  assert.match(html, new RegExp(`href="${prefix}/next\\.html"`));
  assert.match(html, new RegExp(`<base href="${prefix}/">`));
  assert.match(html, new RegExp(`import "${prefix}/inline\\.ts"`));
  assert.match(html, new RegExp(`url\\(${prefix}/pattern\\.png\\)`));

  // Root-relative URLs inside a module resolve against Riff's origin, not the
  // injected <base>, so the relay prefix has to be written into the bytes.
  const script = await (await fetch(`${base}/main.ts`)).text();
  assert.equal(script, [
    `import "${prefix}/node_modules/@fontsource/fraunces/latin-500.css";`,
    `import {mountCarousel} from "${prefix}/carousel.ts";`,
    `export {theme} from"${prefix}/theme.ts";`,
    `const later = () => import("${prefix}/late.ts");`,
    `const logo = new URL("${prefix}/logo.svg", import.meta.url);`,
    'const untouched = [Array.from("/not-a-module"), import.meta.url, "https://cdn.example.com/x.js"];',
    'import "//cdn.example.com/y.js";',
    `//# sourceMappingURL=${prefix}/main.ts.map`,
  ].join("\n"));

  const styleModule = await (await fetch(`${base}/fonts.css.js`)).text();
  assert.equal(styleModule, `const __vite__css = "@import\\"${prefix}/reset.css\\";@font-face{src:url(\\"${prefix}/files/a.woff2\\")}"`);

  const stylesheet = await (await fetch(`${base}/styles.css`)).text();
  assert.equal(stylesheet, `@import "${prefix}/reset.css";body{background:url(${prefix}/img/bg.png)}`);

  assert.equal((await fetch(`http://127.0.0.1:${port}/room-preview/${room}/6/`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/room-preview/other-room/7/`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/room-preview/%FF/7/`)).status, 404);

  host.send(JSON.stringify({ type: "preview-down", generation: 6 }));
  host.send(JSON.stringify({ type: "hello", capability: hostCapability }));
  await waitFor(() => messages.filter((message) => message.type === "host-accepted").length === 2, "Stale Preview down was not processed");
  assert.equal(relay.rooms.get(room)?.generation, 7);
  assert.equal((await fetch(`${base}/hello`)).status, 200);

  host.send(JSON.stringify({ type: "preview-down", generation: 7 }));
  await waitFor(() => relay.rooms.get(room)?.generation === 0, "Preview did not go offline");
  assert.equal((await fetch(`${base}/hello`)).status, 404);
  console.log("Room-scoped Preview HTTP relay and room isolation passed.");
} finally {
  host.terminate();
  relay.close();
  await new Promise((resolve) => server.close(resolve));
}
