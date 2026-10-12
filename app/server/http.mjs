// Small HTTP helpers shared by the rooms API and sign-in.

export function sendJson(response, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

export function sendText(response, status, text, headers = {}) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readJson(request) {
  if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
    throw new HttpError(415, "expected_json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function parseCookies(header) {
  const cookies = new Map();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (!name || cookies.has(name)) continue;
    cookies.set(name, part.slice(at + 1).trim());
  }
  return cookies;
}

export function cookie(name, value, { maxAge } = {}) {
  const parts = [`${name}=${value}`, "Path=/", "Secure", "HttpOnly", "SameSite=Lax"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

export const clearCookie = (name) => cookie(name, "", { maxAge: 0 });

// Browsers send cookies when a page on another site opens a WebSocket or
// posts a form to us. Requiring our own Origin on every socket and every
// state-changing request means only our pages can act with them.
export function sameOrigin(request, origin) {
  return request.headers.origin === origin;
}

// The client's address: fly's proxy sets Fly-Client-IP, which a client
// can't forge (unlike the first X-Forwarded-For entry).
export function clientAddress(request) {
  const fly = request.headers["fly-client-ip"];
  if (typeof fly === "string" && fly) return fly;
  return request.socket?.remoteAddress ?? "unknown";
}

// A fixed window per key: plenty for people, a wall for a script.
export function createRateLimit({ limit, windowMs }) {
  const windows = new Map();
  return function allow(key, now = Date.now()) {
    let entry = windows.get(key);
    if (!entry || now - entry.started >= windowMs) {
      if (windows.size > 10_000) {
        for (const [k, e] of windows) if (now - e.started >= windowMs) windows.delete(k);
      }
      entry = { started: now, count: 0 };
      windows.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= limit ? 0 : Math.ceil((entry.started + windowMs - now) / 1000);
  };
}
