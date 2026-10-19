// The production entry point. In development these relays are mounted as Vite
// middleware (see vite.config.ts), which only exists in dev mode — a built
// deployment has no Vite, so the same modules are mounted here on a plain
// node:http server. nginx terminates TLS and serves dist/; this process only
// handles Riff's own routes (riff.mjs) and the health endpoint.
import { createServer } from "node:http";
import { createRiff } from "./riff.mjs";

const port = Number(process.env.PORT ?? 8093);
const host = process.env.HOST ?? "127.0.0.1";
// Health lives on its own listener rather than a path. The preview vhost
// proxies every path it receives, so a /healthz route on the main server
// would both shadow a preview's own /healthz and expose this process's state
// to whatever the facilitator's Claude happens to be serving.
const healthPort = Number(process.env.HEALTH_PORT ?? 8094);

// RIFF_DB is a SQLite file on the fly volume (deploy/start.sh). RIFF_ORIGIN
// is where browsers reach us (fly.toml); sign-in and the Origin checks are
// built from it, never from a request's Host header.
const riff = createRiff({
  dbPath: process.env.RIFF_DB ?? "riff.sqlite",
  origin: process.env.RIFF_ORIGIN,
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  sessionSecret: process.env.SESSION_SECRET,
  // Riff's own free models for hosts (docs/adr/0009); unset, hosts bring their own
  openrouterKey: process.env.OPENROUTER_API_KEY,
});

// Host metrics cannot answer "is anyone actually able to use this", so report
// the state that matters: whether each room still has a facilitator attached,
// and whether preview requests are piling up unanswered.
function health() {
  return {
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    ...riff.health(),
  };
}

// nginx serves the built client, so anything Riff doesn't answer is a
// request for a route this process does not own.
function runMiddlewares(request, response) {
  riff.middleware(request, response, () => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Not found");
  });
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

server.on("upgrade", (request, socket, head) => {
  if (!riff.handleUpgrade(request, socket, head)) socket.destroy();
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
  riff.close();
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
