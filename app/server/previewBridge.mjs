// The host's own preview, served from the host page's Nodepod instead of the
// relay (docs/adr/0011, "2b"). Three small files on the preview origin, under
// /__riff_preview__/, and nothing else of Riff's: a page that registers a
// service worker and hands it a MessagePort to the parent (Riff's page, which
// answers only its own preview frame), the worker, which forwards the frame's
// requests over that port, and a helper injected into pod HTML that carries
// WebSockets (Vite's hot reload) the same way. A browser that won't run the
// worker gets the relay, as before: Riff's page falls back on a timeout.
//
// The browser code is written as functions here and served as their source,
// so it is checked like the rest; nothing outside the function may be used.

export const BRIDGE_PREFIX = "/__riff_preview__/";

/* eslint-disable no-restricted-globals */

function hostPage(riffOrigin) {
  const report = (type, detail) => parent.postMessage({ type, detail }, riffOrigin);
  const next = new URLSearchParams(location.search).get("next") || "/";
  const start = async () => {
    if (!("serviceWorker" in navigator)) throw new Error("no service worker");
    await navigator.serviceWorker.register("/__riff_preview__/sw.js", { scope: "/" });
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) throw new Error("worker not active");
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker did not take the port")), 4000);
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "riff-port-ready") {
          clearTimeout(timer);
          resolve();
        }
      });
      navigator.serviceWorker.startMessages();
    });
    const channel = new MessageChannel();
    parent.postMessage({ type: "riff-preview-port" }, riffOrigin, [channel.port1]);
    worker.postMessage({ type: "riff-port" }, [channel.port2]);
    await ready;
    // Only a path on this origin: `next` comes from the worker's redirect.
    const target = new URL(next, location.origin);
    location.replace(target.origin === location.origin ? target.pathname + target.search + target.hash : "/");
  };
  start().catch((error) => report("riff-preview-fallback", String(error && error.message || error)));
}

function serviceWorker() {
  const STRIP = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie",
    "cross-origin-embedder-policy", "cross-origin-resource-policy", "cross-origin-opener-policy"]);
  let port = null;
  let nextId = 1;
  const pending = new Map();
  let waiting = [];

  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type !== "riff-port" || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = (message) => {
      const reply = message.data || {};
      const resolve = pending.get(reply.id);
      if (resolve) {
        pending.delete(reply.id);
        resolve(reply);
      }
    };
    const woken = waiting;
    waiting = [];
    woken.forEach((wake) => wake());
    if (event.source) event.source.postMessage({ type: "riff-port-ready" });
  });

  const text = (status, body) => new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
    },
  });

  async function portFor(clientId) {
    if (port) return port;
    const client = clientId ? await self.clients.get(clientId) : null;
    if (!client) return null;
    client.postMessage({ type: "riff-need-port" });
    await new Promise((resolve) => {
      waiting.push(resolve);
      setTimeout(resolve, 5000);
    });
    return port;
  }

  async function decoded(body, encoding) {
    if (!encoding || encoding === "identity") return body;
    if (!["gzip", "deflate"].includes(encoding)) return body;
    const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream(encoding));
    return new Response(stream).arrayBuffer();
  }

  async function answer(event, url) {
    const request = event.request;
    if (request.mode !== "navigate" && event.clientId) {
      // A participant's relay page in this same browser keeps the relay.
      const client = await self.clients.get(event.clientId);
      if (client && new URL(client.url).pathname.startsWith("/room-preview/")) return fetch(request);
    }
    const target = request.mode === "navigate" ? port : await portFor(event.clientId);
    if (!target) {
      if (request.mode === "navigate") {
        return Response.redirect(`/__riff_preview__/host.html?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
      }
      return text(503, "The preview lost its connection to the host. Refresh.");
    }
    const body = ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer();
    const headers = {};
    request.headers.forEach((value, name) => { headers[name] = value; });
    const id = nextId++;
    const reply = await new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) resolve({ status: 504, headers: {}, body: new TextEncoder().encode("The preview did not answer.") });
      }, 15000);
      target.postMessage({ type: "request", id, method: request.method, path: url.pathname + url.search, headers, body }, body ? [body] : []);
    });
    const out = new Headers();
    let encoding = "";
    for (const [name, value] of Object.entries(reply.headers || {})) {
      const lower = name.toLowerCase();
      if (lower === "content-encoding") encoding = String(value).trim().toLowerCase();
      if (STRIP.has(lower)) continue;
      try { out.set(lower, Array.isArray(value) ? value.join(", ") : String(value)); } catch { /* not a header a worker may set */ }
    }
    out.set("cross-origin-embedder-policy", "require-corp");
    out.set("cross-origin-resource-policy", "cross-origin");
    out.set("x-riff-preview", "pod");
    let payload = reply.body ? await decoded(reply.body, encoding) : null;
    if (payload && /text\/html/i.test(out.get("content-type") || "")) {
      const html = new TextDecoder().decode(payload);
      const tag = '<script src="/__riff_preview__/helper.js"></script>';
      const head = html.match(/<head[^>]*>/i);
      payload = head ? html.replace(head[0], head[0] + tag) : tag + html;
    }
    const status = reply.status || 502;
    const empty = [101, 204, 205, 304].includes(status) || request.method === "HEAD";
    return new Response(empty ? null : payload, { status: status < 200 || status > 599 ? 502 : status, headers: out });
  }

  self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/__riff_preview__/") || url.pathname.startsWith("/room-preview/")) return;
    event.respondWith(answer(event, url).catch((error) => text(502, String(error && error.message || error))));
  });
}

function helper(riffOrigin) {
  const connect = () => {
    const channel = new MessageChannel();
    parent.postMessage({ type: "riff-preview-port" }, riffOrigin, [channel.port1]);
    return channel.port2;
  };
  const container = navigator.serviceWorker;
  if (container) {
    container.addEventListener("message", (event) => {
      if (event.data && event.data.type === "riff-need-port" && container.controller) {
        container.controller.postMessage({ type: "riff-port" }, [connect()]);
      }
    });
    container.startMessages();
    // A message from a page it controls keeps the worker (and its port) alive.
    setInterval(() => { if (container.controller) container.controller.postMessage({ type: "ping" }); }, 20000);
  }

  // WebSockets to the dev server (Vite's hot reload, an app's own socket)
  // travel to Riff's page and on into Nodepod, as they do on Nodepod's own
  // preview. Anything else is a real socket.
  const Native = window.WebSocket;
  const sockets = new Map();
  let socketPort = null;
  let count = 0;
  const bridge = () => {
    if (socketPort) return socketPort;
    socketPort = connect();
    socketPort.onmessage = (event) => {
      const data = event.data || {};
      const socket = sockets.get(data.uid);
      if (socket) socket._receive(data);
    };
    return socketPort;
  };
  const local = (url) => url.host === location.host || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(url.hostname);

  class BridgedSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = url.href;
      this.readyState = 0;
      this.protocol = "";
      this.extensions = "";
      this.bufferedAmount = 0;
      this.binaryType = "blob";
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._uid = `riff-${Date.now()}-${count += 1}`;
      sockets.set(this._uid, this);
      bridge().postMessage({
        kind: "ws-connect", uid: this._uid, path: url.pathname + url.search,
        protocols: Array.isArray(protocols) ? protocols.join(",") : (protocols || ""),
      });
      this._timer = setTimeout(() => { if (this.readyState === 0) this._receive({ kind: "ws-error" }); }, 5000);
    }
    _fire(event) {
      const handler = this[`on${event.type}`];
      if (typeof handler === "function") handler.call(this, event);
      this.dispatchEvent(event);
    }
    _receive(data) {
      if (data.kind === "ws-open") {
        clearTimeout(this._timer);
        this.readyState = 1;
        this._fire(new Event("open"));
      } else if (data.kind === "ws-message") {
        let value = data.data;
        if (data.type === "binary") {
          const bytes = new Uint8Array(data.data);
          value = this.binaryType === "arraybuffer" ? bytes.buffer : new Blob([bytes]);
        }
        this._fire(new MessageEvent("message", { data: value }));
      } else if (data.kind === "ws-closed" || data.kind === "ws-error") {
        clearTimeout(this._timer);
        const was = this.readyState;
        this.readyState = 3;
        sockets.delete(this._uid);
        if (data.kind === "ws-error" && was < 2) this._fire(new Event("error"));
        if (was < 3) this._fire(new CloseEvent("close", { code: data.code || (data.kind === "ws-error" ? 1006 : 1000), reason: "", wasClean: data.kind !== "ws-error" }));
      }
    }
    send(data) {
      if (this.readyState !== 1) throw new DOMException("WebSocket is not open", "InvalidStateError");
      if (typeof data === "string") return bridge().postMessage({ kind: "ws-send", uid: this._uid, data, type: "text" });
      const send = (buffer) => bridge().postMessage({ kind: "ws-send", uid: this._uid, data: Array.from(new Uint8Array(buffer)), type: "binary" });
      if (data instanceof Blob) data.arrayBuffer().then(send);
      else send(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    }
    close(code, reason) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      bridge().postMessage({ kind: "ws-close", uid: this._uid, code: code || 1000, reason: reason || "" });
      setTimeout(() => this._receive({ kind: "ws-closed", code: code || 1000 }), 0);
    }
  }
  for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    BridgedSocket[name] = value;
    BridgedSocket.prototype[name] = value;
  }
  function RiffWebSocket(url, protocols) {
    const parsed = new URL(url, location.href);
    if (!local(parsed)) return new Native(url, protocols);
    return new BridgedSocket(parsed, protocols);
  }
  Object.assign(RiffWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  RiffWebSocket.prototype = BridgedSocket.prototype;
  window.WebSocket = RiffWebSocket;
}

/* eslint-enable no-restricted-globals */

const call = (fn, ...args) => `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")});\n`;

/** Answers the bridge's three files on a preview host; false for anything
 * else, which then goes to the relay. */
export function createPreviewBridge({ riffOrigin }) {
  const files = {
    "host.html": {
      type: "text/html; charset=utf-8",
      body: `<!doctype html><meta charset="utf-8"><title>Preview</title><script>${call(hostPage, riffOrigin)}</script>`,
    },
    "sw.js": { type: "text/javascript; charset=utf-8", body: call(serviceWorker), extra: { "service-worker-allowed": "/" } },
    "helper.js": { type: "text/javascript; charset=utf-8", body: call(helper, riffOrigin) },
  };
  return function servePreviewBridge(request, response, pathname) {
    if (!pathname.startsWith(BRIDGE_PREFIX)) return false;
    const file = files[pathname.slice(BRIDGE_PREFIX.length)];
    if (!file || !["GET", "HEAD"].includes(request.method ?? "GET")) return false;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": file.type,
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
      ...file.extra,
    });
    response.end(request.method === "HEAD" ? undefined : file.body);
    return true;
  };
}
