// The production entry point. In development these relays are mounted as Vite
// middleware (see vite.config.ts), which only exists in dev mode — a built
// deployment has no Vite, so the same modules are mounted here on a plain
// node:http server. nginx terminates TLS and serves dist/; this process only
// handles the relays, the OAuth proxy, and the health endpoint.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createTerminalRelay } from "./terminalRelay.mjs";
import { createPreviewRelay } from "./previewRelay.mjs";
import { createGitHubDeviceProxy } from "./githubDeviceProxy.mjs";

const require = createRequire(import.meta.url);
const { setupWSConnection } = require("y-websocket/bin/utils");

// The same public client identity the development server falls back to, so a
// deployment without its own OAuth app behaves identically to local work.
const GITHUB_CLI_CLIENT_ID = "178c6fc778ccc68e1d6a";

const port = Number(process.env.PORT ?? 8093);
const host = process.env.HOST ?? "127.0.0.1";
// Health lives on its own listener rather than a path. The preview vhost
// proxies every path it receives, so a /healthz route on the main server
// would both shadow a preview's own /healthz and expose this process's state
// to whatever the facilitator's Claude happens to be serving.
const healthPort = Number(process.env.HEALTH_PORT ?? 8094);

const previewRelay = createPreviewRelay();
const terminalRelay = createTerminalRelay();
const collaboration = new WebSocketServer({ noServer: true });
const collaborationSockets = new Set();

const middlewares = [
  previewRelay.middleware,
  createGitHubDeviceProxy({ clientId: process.env.GITHUB_OAUTH_CLIENT_ID || GITHUB_CLI_CLIENT_ID }),
];

function countHosts(rooms) {
  let hosts = 0;
  for (const room of rooms.values()) if (room.host) hosts += 1;
  return hosts;
}

// Host metrics cannot answer "is anyone actually able to use this", so report
// the state that matters: whether each room still has a facilitator attached,
// and whether preview requests are piling up unanswered.
function health() {
  let pending = 0;
  for (const room of previewRelay.rooms.values()) pending += room.pending.size;
  let terminalClients = 0;
  for (const room of terminalRelay.rooms.values()) terminalClients += room.clients.size;
  return {
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    preview: { rooms: previewRelay.rooms.size, hosts: countHosts(previewRelay.rooms), pending },
    terminal: { rooms: terminalRelay.rooms.size, hosts: countHosts(terminalRelay.rooms), clients: terminalClients },
    collaboration: { sockets: collaborationSockets.size },
  };
}

function fail(response, error) {
  console.error("[riff] request failed", error);
  if (response.headersSent) return response.destroy();
  response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("Internal error");
}

function runMiddlewares(request, response) {
  let index = 0;
  const next = () => {
    const middleware = middlewares[index++];
    // nginx serves the built client, so anything still unmatched here is a
    // request for a route this process does not own.
    if (!middleware) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    try {
      const result = middleware(request, response, next);
      if (result && typeof result.catch === "function") result.catch((error) => fail(response, error));
    } catch (error) {
      fail(response, error);
    }
  };
  next();
}

const server = createServer(runMiddlewares);

const healthServer = createServer((request, response) => {
  if (new URL(request.url ?? "/", "http://localhost").pathname !== "/healthz") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Not found");
    return;
  }
  const body = JSON.stringify(health());
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
});

// A malformed percent-escape is a bad request, not a crash — decode before
// handing the name to a relay so an exception cannot tear down the upgrade.
function roomFrom(pathname, prefix) {
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  for (const [prefix, handle] of [
    ["/terminal/", (room) => terminalRelay.handleUpgrade(request, socket, head, room)],
    ["/preview-control/", (room) => previewRelay.handleUpgrade(request, socket, head, room)],
    ["/collaboration/", (room) => collaboration.handleUpgrade(request, socket, head, (websocket) => {
      collaborationSockets.add(websocket);
      websocket.on("close", () => collaborationSockets.delete(websocket));
      setupWSConnection(websocket, request, { docName: room, gc: true });
    })],
  ]) {
    if (!url.pathname.startsWith(prefix)) continue;
    const room = roomFrom(url.pathname, prefix);
    if (room === null) return socket.destroy();
    return handle(room);
  }
  socket.destroy();
});

// One wedged room must not drop the other four mid-session. A genuine crash
// still exits and lets systemd restart us; a stray rejection is not worth
// ending every live session over.
process.on("unhandledRejection", (reason) => console.error("[riff] unhandled rejection", reason));

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[riff] ${signal} received, stopping`);
  // Each relay's close() terminates its client sockets, which is what lets the
  // HTTP server's close callback fire at all.
  previewRelay.close();
  terminalRelay.close();
  for (const websocket of collaborationSockets) websocket.terminate();
  collaborationSockets.clear();
  collaboration.close();
  healthServer.close();
  server.close(() => process.exit(0));
  // systemd escalates to SIGKILL after TimeoutStopSec; exit first so a stuck
  // connection cannot hold the unit in "deactivating".
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(port, host, () => console.log(`[riff] listening on http://${host}:${port}`));
healthServer.listen(healthPort, host, () => console.log(`[riff] health on http://${host}:${healthPort}/healthz`));
