import * as Y from "yjs";
import WebSocket, { type RawData } from "ws";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

// Riff from the outside: the HTTP API that creates and joins rooms, and
// headless sessions on a room's documents over the same /collaboration
// socket and Hocuspocus protocol the browser uses, minus the UI.
//
// The contract (ADR 0005 and ADR 0006):
// - POST /api/rooms {name} makes a room and its creator the host.
// - POST /api/rooms/join {code, name} makes a participant.
// - Either answers {room: {id, code}, member: {id, name, host, secret}}. A
//   guest's `secret` is their credential for that room only: the Hocuspocus
//   token, and `Authorization: Bearer` on the API.
// - A room's documents are `room/<id>/shared` (everyone writes) and
//   `room/<id>/control` (the host writes, participants read).
// - Every POST and every socket carries an Origin matching the app's own.
export type Member = {
  roomId: string;
  code: string;
  memberId: number;
  name: string;
  host: boolean;
  secret: string;
  // Goes in the preview's path: `/room-preview/<room id>/<key>/<generation>/`.
  // An iframe can't send the secret, so the key is what the relay checks.
  previewKey: string;
};

export type Part = "shared" | "control";

export const originOf = (baseUrl: string) => new URL(baseUrl).origin;
export const docName = (roomId: string, part: Part) => `room/${roomId}/${part}`;

export function uniqueName(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

type ApiInit = {
  method?: string;
  body?: unknown;
  secret?: string;
  // null sends no Origin at all; the default is the app's own origin
  origin?: string | null;
  cookie?: string;
};

export function api(baseUrl: string, path: string, init: ApiInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? originOf(baseUrl) : init.origin;
  if (origin) headers.origin = origin;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.secret) headers.authorization = `Bearer ${init.secret}`;
  if (init.cookie) headers.cookie = init.cookie;
  return fetch(new URL(path, baseUrl), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
  });
}

async function member(res: Response, what: string): Promise<Member> {
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`${what}: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return {
    roomId: body.room.id,
    code: body.room.code,
    memberId: body.member.id,
    name: body.member.name,
    host: body.member.host,
    secret: body.member.secret,
    previewKey: body.member.previewKey,
  };
}

export async function createRoom(baseUrl: string, name = uniqueName("host")): Promise<Member> {
  return member(await api(baseUrl, "/api/rooms", { body: { name } }), "creating a room");
}

export async function joinRoom(baseUrl: string, code: string, name = uniqueName("guest")): Promise<Member> {
  return member(await api(baseUrl, "/api/rooms/join", { body: { code, name } }), `joining ${code}`);
}

export function collaborationUrl(baseUrl: string) {
  const url = new URL("/collaboration", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

// A session on one document. `saved()` resolves once the server has
// acknowledged every local change so far. `refused()` resolves when the
// server answers an update with a failed sync status, which is how
// Hocuspocus turns away a write on a read-only connection. `shutOut`
// resolves if the server later refuses this session's credential (it
// reconnects and is turned away).
export type Session = {
  doc: Y.Doc;
  saved: () => Promise<void>;
  refused: () => Promise<void>;
  shutOut: Promise<string>;
  leave: () => void;
};

export class Refused extends Error {
  constructor(readonly reason: string) {
    super(`refused: ${reason}`);
  }
}

type OpenOptions = {
  token?: string;
  origin?: string | null;
  timeoutMs?: number;
};

// Opens a document by name. Rejects with Refused if the server turns the
// credential away before the first sync.
export function open(baseUrl: string, document: string, options: OpenOptions = {}): Promise<Session> {
  const doc = new Y.Doc();
  const origin = options.origin === undefined ? originOf(baseUrl) : options.origin;
  const refusals: Array<() => void> = [];
  const Socket = socketClass(origin, (bytes) => {
    const status = syncStatus(bytes);
    if (status && status.document === document && !status.applied) refusals.splice(0).forEach((f) => f());
  });
  let onAuthFailed: (reason: string) => void = () => {};
  const shutOut = new Promise<string>((resolve) => (onAuthFailed = resolve));
  const socket = new HocuspocusProviderWebsocket({
    url: collaborationUrl(baseUrl),
    WebSocketPolyfill: Socket,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: document,
    document: doc,
    token: options.token ?? null,
    onAuthenticationFailed: ({ reason }) => onAuthFailed(reason),
  });
  // a provider handed its socket doesn't attach to it by itself
  provider.attach();
  const leave = () => {
    provider.destroy();
    socket.destroy();
    doc.destroy();
  };
  const saved = () =>
    new Promise<void>((resolve, reject) => {
      if (!provider.hasUnsyncedChanges) return resolve();
      const timer = setTimeout(() => {
        provider.off("unsyncedChanges", onChange);
        reject(new Error(`server never acknowledged changes to ${document}`));
      }, 10_000);
      function onChange({ number }: { number: number }) {
        if (number > 0) return;
        clearTimeout(timer);
        provider.off("unsyncedChanges", onChange);
        resolve();
      }
      provider.on("unsyncedChanges", onChange);
    });
  const refused = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server never refused a write to ${document}`)), 10_000);
      refusals.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      leave();
      reject(new Error(`${document} never synced`));
    }, options.timeoutMs ?? 10_000);
    let synced = false;
    shutOut.then((reason) => {
      if (synced) return;
      clearTimeout(timer);
      leave();
      reject(new Refused(reason));
    });
    provider.on("synced", ({ state }: { state: boolean }) => {
      if (!state || synced) return;
      synced = true;
      clearTimeout(timer);
      resolve({ doc, saved, refused, shutOut, leave });
    });
  });
}

export const openPart = (baseUrl: string, who: Member, part: Part) =>
  open(baseUrl, docName(who.roomId, part), { token: who.secret });

// What happens at the HTTP upgrade itself, before Hocuspocus: the status the
// server answered with, or 101 if it accepted the socket.
export function upgradeStatus(baseUrl: string, origin: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(collaborationUrl(baseUrl), origin ? { origin } : {});
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("the server never answered the upgrade"));
    }, 5_000);
    ws.on("close", () => clearTimeout(timer));
    ws.on("upgrade", () => {
      ws.terminate();
      resolve(101);
    });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("error", reject);
  });
}

// The terminal mirror and the preview relay: open `/terminal/<room>` or
// `/preview-control/<room>`, say hello, and report what the server said back
// (message types and error codes, then `closed:<code>` if it hung up).
export function relayHello(
  baseUrl: string,
  relay: "terminal" | "preview-control",
  roomId: string,
  hello: Record<string, unknown>,
  listenMs = 1_000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const url = `${collaborationUrl(baseUrl).replace(/\/collaboration$/, "")}/${relay}/${encodeURIComponent(roomId)}`;
    const ws = new WebSocket(url, { origin: originOf(baseUrl) });
    const heard: string[] = [];
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("message", (raw: RawData) => {
      const message = JSON.parse(toBytes(raw).length ? new TextDecoder().decode(toBytes(raw)) : "{}");
      heard.push(message.code ? `${message.type}:${message.code}` : message.type);
    });
    ws.on("close", (code) => heard.push(`closed:${code}`));
    ws.on("error", reject);
    setTimeout(() => {
      ws.terminate();
      resolve(heard);
    }, listenMs);
  });
}

// Play the host's side of the preview: claim the relay with the host's
// secret, announce a preview, and answer every request with `page`. The
// relay rewrites root-relative links in it under the requester's prefix.
export type PreviewHost = { generation: number; requests: string[]; close(): void };

export function servePreview(baseUrl: string, host: Member, page: string): Promise<PreviewHost> {
  return new Promise((resolve, reject) => {
    const url = `${collaborationUrl(baseUrl).replace(/\/collaboration$/, "")}/preview-control/${encodeURIComponent(host.roomId)}`;
    const ws = new WebSocket(url, { origin: originOf(baseUrl) });
    const generation = Date.now();
    const requests: string[] = [];
    const timer = setTimeout(() => reject(new Error("preview relay never accepted the host")), 10_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: host.secret })));
    ws.on("message", (raw: RawData) => {
      const message = JSON.parse(new TextDecoder().decode(toBytes(raw)));
      if (message.type === "host-accepted") {
        ws.send(JSON.stringify({ type: "preview-up", generation }));
        clearTimeout(timer);
        resolve({ generation, requests, close: () => ws.close() });
      } else if (message.type === "request") {
        requests.push(message.path);
        ws.send(JSON.stringify({
          type: "response",
          requestId: message.requestId,
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: Buffer.from(page).toString("base64"),
        }));
      } else if (message.type === "error") {
        clearTimeout(timer);
        reject(new Error(`preview relay: ${message.code}`));
      }
    });
    ws.on("error", reject);
  });
}

// The `ws` client with a fixed Origin header (a browser always sends one;
// node's built-in WebSocket can't), and a tap on what the server sends.
function socketClass(origin: string | null, tap: (bytes: Uint8Array) => void) {
  return class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, origin ? { origin } : {});
      this.on("message", (data: RawData) => tap(toBytes(data)));
    }
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
}

// A Hocuspocus message is varString(document) varUint(type) payload; type 8
// is SyncStatus, whose payload is varUint(1 applied, 0 refused).
function syncStatus(bytes: Uint8Array): { document: string; applied: boolean } | null {
  let pos = 0;
  const varUint = () => {
    let value = 0;
    for (let shift = 0; pos < bytes.length; shift += 7) {
      const byte = bytes[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return -1;
  };
  const length = varUint();
  if (length < 0 || pos + length > bytes.length) return null;
  const document = new TextDecoder().decode(bytes.subarray(pos, pos + length));
  pos += length;
  if (varUint() !== 8) return null;
  return { document, applied: varUint() === 1 };
}

// Resolves with how long it took (ms) for `check` to become true on `doc`,
// driven by the document's own update events rather than polling.
export function timeUntil(doc: Y.Doc, check: () => boolean, timeoutMs: number): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    if (check()) return resolve(0);
    const timer = setTimeout(() => {
      doc.off("update", onUpdate);
      reject(new Error(`condition not met within ${timeoutMs}ms`));
    }, timeoutMs);
    function onUpdate() {
      if (!check()) return;
      clearTimeout(timer);
      doc.off("update", onUpdate);
      resolve(performance.now() - started);
    }
    doc.on("update", onUpdate);
  });
}
