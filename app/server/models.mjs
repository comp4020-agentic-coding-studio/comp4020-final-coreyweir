// Riff's own free models (docs/adr/0009): the host's Claude calls
// `/api/model/v1/...` with the host's model key, and this forwards the call
// to OpenRouter with Riff's key, which never leaves the server. Only the
// model API is forwarded, and only for a room's host while the room lasts.
// Which models, and how much they may cost, is OpenRouter's to limit: the
// key is set up there for free models and no spending at all.
import { Readable } from "node:stream";
import { HttpError, sendJson } from "./http.mjs";

const ROUTES = new Map([
  ["/api/model/v1/models", "GET"],
  ["/api/model/v1/messages", "POST"],
  ["/api/model/v1/messages/count_tokens", "POST"],
]);

// What Claude sends that OpenRouter needs, and what comes back that Claude
// uses (the rate limit headers explain a 429).
const REQUEST_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];
const RESPONSE_HEADERS = ["content-type", "retry-after", "request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];

export function createModels({ apiKey, upstream = "https://openrouter.ai/api", rooms, audit, origin, fetch = globalThis.fetch }) {
  const available = Boolean(apiKey);

  function keyOf(request) {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
    return match ? match[1] : undefined;
  }

  // Who may use the models: the host of a room that hasn't ended. A key we
  // didn't make is 401; a real key whose member isn't (or no longer is) the
  // host of a live room is 403.
  function hostOf(request) {
    const who = rooms.resolveModel(keyOf(request));
    if (!who) {
      audit.tally(null, "denied", { what: "model", reason: keyOf(request) ? "bad_model_key" : "no_credential" });
      throw new HttpError(401, "not_a_host");
    }
    if (who.role !== "host" || who.state === "ended") {
      const reason = who.role !== "host" ? "host_only" : "room_ended";
      audit.tally(who, "denied", { what: "model", reason });
      throw new HttpError(403, reason);
    }
    return who;
  }

  async function forward(request, response, url, who) {
    const headers = { authorization: `Bearer ${apiKey}`, "http-referer": origin, "x-title": "Riff" };
    for (const name of REQUEST_HEADERS) if (request.headers[name]) headers[name] = request.headers[name];
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(`${upstream}${url.pathname.slice("/api/model".length)}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : Readable.toWeb(request),
        duplex: "half",
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      audit.tally(who, "model.request", { status: 502 });
      throw new HttpError(502, "model_unreachable");
    }
    const out = { "cache-control": "no-store", "x-accel-buffering": "no" };
    for (const name of RESPONSE_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) out[name] = value;
    }
    response.writeHead(upstreamResponse.status, out);
    let bytes = 0;
    let logged = false;
    // Once per request, whether the reply finished or the host went away.
    const done = () => {
      if (logged) return;
      logged = true;
      audit.tally(who, "model.request", { status: upstreamResponse.status }, bytes);
    };
    if (!upstreamResponse.body) {
      response.end();
      return done();
    }
    // Streamed as it arrives: Claude shows a reply while it's written.
    const body = Readable.fromWeb(upstreamResponse.body);
    body.on("data", (chunk) => (bytes += chunk.length));
    body.on("error", () => response.destroy());
    body.on("end", done);
    body.on("close", done);
    response.on("close", () => body.destroy());
    body.pipe(response);
  }

  async function handle(request, response, url) {
    const path = url.pathname;
    if (path === "/api/model") {
      if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
      sendJson(response, 200, { available });
      return true;
    }
    if (!path.startsWith("/api/model/")) return false;
    if (ROUTES.get(path) !== request.method) throw new HttpError(404, "not_found");
    if (!available) throw new HttpError(503, "models_unavailable");
    const who = hostOf(request);
    await forward(request, response, url, who);
    return true;
  }

  return { available, handle };
}
