import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SOCKET_BYTES = Math.ceil(MAX_RESPONSE_BYTES * 4 / 3) + 64 * 1024;
const STRIPPED_HEADERS = new Set([
  "authorization", "connection", "content-length", "cookie", "host", "proxy-authorization",
  "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-proto",
]);

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sameCapability(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function filteredHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!STRIPPED_HEADERS.has(lower) && value !== undefined) result[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

// A root-relative URL ("/main.ts"), optionally written against the preview
// server's own loopback origin. Protocol-relative "//host/x" URLs address a
// different origin entirely and must be left alone.
const ROOT_RELATIVE = String.raw`(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+)?\/(?!\/)`;

// Everything the relay understands is expressed as "capture what precedes the
// URL, then the URL's leading slash", so one replacer serves every pattern.
const HTML_ATTRIBUTE = new RegExp(String.raw`(\b(?:action|href|src)\s*=\s*["'])${ROOT_RELATIVE}`, "gi");
const INLINE_MODULE = /(<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>)([\s\S]*?)(<\/script\s*>)/gi;
const INLINE_STYLE = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
// `import "/x"`, `import("/x")` and `... from "/x"`. The lookbehind keeps
// `Array.from("/x")` and `import.meta` out of the match. `new URL("/x", ...)`
// is left to CSS_URL, which already matches `URL(` case-insensitively.
const MODULE_SPECIFIER = new RegExp(
  String.raw`(?<![.\w$])((?:(?:import|export)\s*\(?|from)\s*["'])${ROOT_RELATIVE}`,
  "g",
);
const SOURCE_MAP_COMMENT = new RegExp(String.raw`(\/\/[#@]\s*sourceMappingURL=)${ROOT_RELATIVE}`, "g");
// Also applied to JavaScript: a dev server serves an imported stylesheet as a
// module that carries the stylesheet's text, escaped quotes and all — so the
// quote may arrive as \" rather than ", and @import may carry no whitespace.
const CSS_URL = new RegExp(String.raw`(\burl\(\s*(?:\\?["'])?)${ROOT_RELATIVE}`, "gi");
const CSS_IMPORT = new RegExp(String.raw`(@import\s*(?:\\?["']))${ROOT_RELATIVE}`, "gi");

const HTML_TYPE = /^text\/html(?:\s*;|$)/i;
const JAVASCRIPT_TYPE = /^(?:text|application)\/(?:x-)?(?:java|ecma)script(?:\s*;|$)/i;
const CSS_TYPE = /^text\/css(?:\s*;|$)/i;

function under(relayPrefix) {
  // A function replacer, so a "$" inside an encoded room name cannot be read
  // as a replacement pattern.
  return (_match, lead) => `${lead}${relayPrefix}/`;
}

function rewriteStyles(css, relayPrefix) {
  return css.replace(CSS_URL, under(relayPrefix)).replace(CSS_IMPORT, under(relayPrefix));
}

// Root-relative URLs in a script are resolved against Riff's own origin: the
// injected <base> governs markup only, never module specifiers, so an
// unrewritten `import "/carousel.ts"` leaves the relay and 404s on Riff. The
// facilitator never sees this because their service worker claims those
// requests for the pod; a participant has no such worker (the preview iframe
// is sandboxed into an opaque origin, which no service worker controls), so
// the prefix has to survive in the bytes themselves.
function rewriteScript(script, relayPrefix) {
  return rewriteStyles(script, relayPrefix)
    .replace(MODULE_SPECIFIER, under(relayPrefix))
    .replace(SOURCE_MAP_COMMENT, under(relayPrefix));
}

function rewritePreviewHtml(body, relayPrefix) {
  let html = body.toString("utf8");
  html = html.replace(HTML_ATTRIBUTE, under(relayPrefix));
  html = html.replace(INLINE_MODULE, (_match, open, code, close) => `${open}${rewriteScript(code, relayPrefix)}${close}`);
  html = html.replace(INLINE_STYLE, (_match, open, css, close) => `${open}${rewriteStyles(css, relayPrefix)}${close}`);
  if (!/<base(?:\s|>)/i.test(html)) {
    const base = `<base href="${relayPrefix}/">`;
    html = /<head(?:\s[^>]*)?>/i.test(html)
      ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${base}`)
      : `${base}${html}`;
  }
  return Buffer.from(html);
}

function rewritePreviewBody(body, contentType, relayPrefix) {
  if (HTML_TYPE.test(contentType)) return rewritePreviewHtml(body, relayPrefix);
  if (JAVASCRIPT_TYPE.test(contentType)) return Buffer.from(rewriteScript(body.toString("utf8"), relayPrefix));
  if (CSS_TYPE.test(contentType)) return Buffer.from(rewriteStyles(body.toString("utf8"), relayPrefix));
  return body;
}

function fail(response, status, message) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
  });
  response.end(message);
}

export function createPreviewRelay() {
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_BYTES });
  const rooms = new Map();

  function roomFor(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { capability: null, host: null, generation: 0, pending: new Map() };
      rooms.set(name, room);
    }
    return room;
  }

  function rejectPending(room, status, message) {
    for (const pending of room.pending.values()) {
      clearTimeout(pending.timer);
      fail(pending.response, status, message);
    }
    room.pending.clear();
  }

  socketServer.on("connection", (socket, _request, roomName) => {
    const room = roomFor(roomName);
    socket.role = "unclaimed";

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", code: "invalid-json" });
        return;
      }

      if (message.type === "hello") {
        const valid = typeof message.capability === "string" && message.capability.length >= 48;
        if (valid && room.capability === null) {
          room.capability = message.capability;
        }
        if (valid && sameCapability(message.capability, room.capability) && (room.host === null || room.host === socket)) {
          room.host = socket;
          socket.role = "host";
          send(socket, { type: "host-accepted" });
        } else {
          send(socket, { type: "error", code: "host-rejected" });
        }
        return;
      }

      if (room.host !== socket || socket.role !== "host") {
        send(socket, { type: "error", code: "host-only" });
        return;
      }
      if (message.type === "preview-up") {
        const generation = Number(message.generation);
        if (Number.isSafeInteger(generation) && generation > room.generation) {
          rejectPending(room, 502, "Preview generation changed");
          room.generation = generation;
        }
        return;
      }
      if (message.type === "preview-down") {
        if (Number(message.generation) !== room.generation) return;
        room.generation = 0;
        rejectPending(room, 502, "Preview went offline");
        return;
      }
      if (message.type !== "response" || typeof message.requestId !== "string") return;

      const pending = room.pending.get(message.requestId);
      if (!pending || pending.generation !== room.generation) return;
      room.pending.delete(message.requestId);
      clearTimeout(pending.timer);

      let body;
      try {
        body = Buffer.from(String(message.body ?? ""), "base64");
      } catch {
        fail(pending.response, 502, "Invalid preview response");
        return;
      }
      if (body.byteLength > MAX_RESPONSE_BYTES) {
        fail(pending.response, 502, "Preview response too large");
        return;
      }
      const headers = filteredHeaders(message.headers && typeof message.headers === "object" ? message.headers : {});
      if (!headers["content-encoding"]) {
        body = rewritePreviewBody(body, headers["content-type"] ?? "", pending.relayPrefix);
      }
      headers["access-control-allow-origin"] = "*";
      headers["cache-control"] = "no-store";
      headers["cross-origin-embedder-policy"] = "require-corp";
      headers["cross-origin-resource-policy"] = "cross-origin";
      headers["referrer-policy"] = "no-referrer";
      headers["content-length"] = String(body.byteLength);
      const status = Number(message.status);
      pending.response.writeHead(Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502, headers);
      pending.response.end(pending.method === "HEAD" ? undefined : body);
    });

    socket.on("close", () => {
      if (room.host === socket) {
        room.host = null;
        room.generation = 0;
        rejectPending(room, 502, "Preview host disconnected");
      }
      if (!room.host && room.pending.size === 0) rooms.delete(roomName);
    });
  });

  function middleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/room-preview/")) return next();
    const parts = url.pathname.slice("/room-preview/".length).split("/");
    if (parts.length < 2) return fail(response, 404, "Preview not found");

    const [encodedRoom, generationText, ...pathParts] = parts;
    let roomName;
    try {
      roomName = decodeURIComponent(encodedRoom);
    } catch {
      return fail(response, 404, "Preview not found");
    }
    const room = rooms.get(roomName);
    const generation = Number(generationText);
    if (!room || !room.host || generation !== room.generation) {
      return fail(response, 404, "Preview not found");
    }

    if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
      response.writeHead(204, {
        "access-control-allow-headers": String(request.headers["access-control-request-headers"] ?? "content-type"),
        "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-origin": "*",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }

    const chunks = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) oversized = true;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      if (oversized) return fail(response, 413, "Preview request too large");
      if (!room.host || generation !== room.generation) return fail(response, 502, "Preview went offline");

      const requestId = randomUUID();
      const timer = setTimeout(() => {
        if (!room.pending.delete(requestId)) return;
        fail(response, 504, "Preview request timed out");
      }, REQUEST_TIMEOUT_MS);
      room.pending.set(requestId, {
        response,
        timer,
        generation,
        method: request.method,
        relayPrefix: `/room-preview/${encodedRoom}/${generation}`,
      });
      response.on("close", () => {
        const pending = room.pending.get(requestId);
        if (pending?.response === response) {
          clearTimeout(pending.timer);
          room.pending.delete(requestId);
        }
      });
      send(room.host, {
        type: "request",
        requestId,
        generation,
        method: request.method ?? "GET",
        path: `/${pathParts.join("/")}${url.search}`,
        headers: filteredHeaders(request.headers),
        body: Buffer.concat(chunks).toString("base64"),
      });
    });
  }

  return {
    rooms,
    middleware,
    handleUpgrade(request, socket, head, roomName) {
      socketServer.handleUpgrade(request, socket, head, (websocket) => {
        socketServer.emit("connection", websocket, request, roomName);
      });
    },
    close() {
      for (const room of rooms.values()) rejectPending(room, 502, "Preview relay closed");
      for (const client of socketServer.clients) client.terminate();
      rooms.clear();
      socketServer.close();
    },
  };
}
