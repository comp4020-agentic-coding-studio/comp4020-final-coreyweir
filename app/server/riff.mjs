// Riff's server, assembled: the room documents, rooms and members, sign-in,
// the who-did-what log and the two relays, behind one HTTP middleware and
// one upgrade handler. The production entry point (index.mjs) and the Vite
// dev server (vite.config.ts) both mount this, so they can't drift apart.
import { createCollaboration, openDatabase } from "./collaboration.mjs";
import { createStore } from "./store.mjs";
import { createAudit } from "./audit.mjs";
import { createAuth } from "./auth.mjs";
import { createRooms } from "./rooms.mjs";
import { createTerminalRelay } from "./terminalRelay.mjs";
import { createPreviewRelay } from "./previewRelay.mjs";
import { randomBytes } from "node:crypto";
import { HttpError, sameOrigin, sendJson } from "./http.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DOCUMENT = /^room\/([\w-]{8,64})\/(shared|control)$/;

export function createRiff({
  dbPath,
  origin,
  githubClientId,
  githubClientSecret,
  sessionSecret,
  log = (message) => console.log(`[riff] ${message}`),
}) {
  if (!origin) throw new Error("createRiff needs RIFF_ORIGIN: the origin browsers reach this server at");
  const db = openDatabase(dbPath);
  const store = createStore(db);
  const audit = createAudit({ store });
  const auth = createAuth({ store, audit, origin, clientId: githubClientId, clientSecret: githubClientSecret, sessionSecret });

  let collaboration;
  const rooms = createRooms({
    store,
    auth,
    audit,
    origin,
    // Production and CI always set SESSION_SECRET. Without it, preview keys
    // last as long as the process, which is as long as any preview does.
    previewSecret: sessionSecret || randomBytes(32).toString("hex"),
    onRoomChanged: (roomId) => publishRoom(roomId),
    onRemoved: (roomId, memberId) => {
      collaboration.disconnectMember(memberId);
      terminalRelay.disconnectMember(roomId, memberId);
      previewRelay.disconnectMember(roomId, memberId);
    },
  });

  // Who a document belongs to and what this credential may do with it.
  // Anything that isn't `room/<id>/shared|control` doesn't exist.
  function authorize({ documentName, token, requestHeaders }) {
    const match = DOCUMENT.exec(documentName);
    const who = match && rooms.resolve(match[1], { token, cookie: requestHeaders.get("cookie") ?? undefined });
    if (!who) {
      audit.tally(null, "denied", { what: "document", reason: match ? "not_a_member" : "no_such_document" });
      throw Object.assign(new Error("not a member"), { reason: "not-a-member" });
    }
    const part = match[2];
    return { context: { who }, readOnly: part === "control" && who.role !== "host" };
  }

  collaboration = createCollaboration({
    db,
    authorize,
    log,
    onEdit: (who, documentName, bytes) => audit.tally(who, `${documentName.split("/").pop()}.edit`, {}, bytes),
    onRefusedWrite: (who, documentName) =>
      audit.tally(who, "denied", { what: `${documentName.split("/").pop()}.write`, reason: "read_only" }),
    onDocumentLoaded: watchDocument,
    onPresence: (who, action) => audit.record(who, action),
  });

  // Edits are only tallied, but adding and removing a staged prompt or a
  // queued one is logged one by one, with who did it: anyone may delete a
  // staged prompt (ADR 0006) because the log shows who did. Ids only, never
  // the text. The server's own writes (the member list) have no member.
  function watchDocument(documentName, document, whoOf) {
    const part = DOCUMENT.exec(documentName)?.[2];
    const watch = (map, subject) =>
      map.observe((event) => {
        const who = whoOf(event.transaction.origin);
        if (!who) return;
        for (const [id, change] of event.changes.keys) {
          if (change.action === "add") audit.record(who, `${subject}.add`, { id });
          if (change.action === "delete") audit.record(who, `${subject}.delete`, { id });
        }
      });
    if (part === "shared") watch(document.getMap("prompts"), "prompt");
    if (part === "control") watch(document.getMap("queue"), "queue");
  }

  // The relays' hello carries the same credential as the documents: a
  // guest's secret as `token`, or the session cookie on the upgrade.
  const relayAuthorize = (roomId, hello, request) =>
    rooms.resolve(roomId, {
      token: typeof hello.token === "string" && hello.token ? hello.token : undefined,
      cookie: request.headers.cookie,
    });
  const relayRefused = (roomId, what, who) =>
    audit.record(who ?? { roomId }, "denied", { what, reason: who ? "host_only" : "not_a_member" });
  const terminalRelay = createTerminalRelay({ authorize: relayAuthorize, onRefused: relayRefused });
  const previewRelay = createPreviewRelay({
    authorize: relayAuthorize,
    onRefused: relayRefused,
    // A page load is dozens of requests, so refusals are tallied.
    authorizeView: (roomId, key) => {
      const who = rooms.resolvePreview(roomId, key);
      if (!who) audit.tally({ roomId }, "denied", { what: "preview.view", reason: "bad_preview_key" });
      return who;
    },
  });

  // The room's code, lock and member list live in the control document,
  // written only here, so names and the GitHub badge can't be forged from a
  // browser and everyone sees a rotated code or a removal at once.
  function publishRoom(roomId) {
    const { room, members } = rooms.summary(roomId);
    collaboration
      .change(`room/${roomId}/control`, (document) => {
        const info = document.getMap("room");
        const list = document.getMap("members");
        document.transact(() => {
          if (info.get("code") !== room.code) info.set("code", room.code);
          if (info.get("locked") !== room.locked) info.set("locked", room.locked);
          for (const member of members) {
            const current = list.get(String(member.id));
            if (JSON.stringify(current) !== JSON.stringify(member)) list.set(String(member.id), member);
          }
        });
      })
      .catch((error) => console.error("[riff] publishing room state failed", error));
  }


  function fail(response, error) {
    if (error instanceof HttpError) {
      if (response.headersSent) return response.destroy();
      return sendJson(response, error.status, { error: error.code }, error.extra.headers ?? {});
    }
    console.error("[riff] request failed", error);
    if (response.headersSent) return response.destroy();
    sendJson(response, 500, { error: "internal" });
  }

  // Connect-style: answers what it owns, passes the rest to `next`.
  function middleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const run = async () => {
      if (await auth.handle(request, response, url)) return;
      if (await rooms.handle(request, response, url)) return;
      previewRelay.middleware(request, response, next);
    };
    run().catch((error) => fail(response, error));
  }

  function refuseUpgrade(socket, status, text) {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  // A malformed percent-escape is a bad request, not a crash.
  function roomFrom(pathname, prefix) {
    try {
      return decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return null;
    }
  }

  // Returns false for a path this server doesn't own (Vite's HMR socket).
  function handleUpgrade(request, socket, head) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const ours = path === "/collaboration" || path.startsWith("/collaboration/") || path.startsWith("/terminal/") || path.startsWith("/preview-control/");
    if (!ours) return false;
    // Browsers send cookies on a WebSocket opened by any site; only our own
    // pages may open one.
    if (!sameOrigin(request, origin)) {
      audit.tally(null, "denied", { what: "socket", reason: "cross_origin" });
      refuseUpgrade(socket, 403, "Forbidden");
      return true;
    }
    if (path === "/collaboration" || path.startsWith("/collaboration/")) {
      collaboration.handleUpgrade(request, socket, head);
      return true;
    }
    for (const [prefix, relay] of [["/terminal/", terminalRelay], ["/preview-control/", previewRelay]]) {
      if (!path.startsWith(prefix)) continue;
      const room = roomFrom(path, prefix);
      if (!room) refuseUpgrade(socket, 400, "Bad Request");
      else relay.handleUpgrade(request, socket, head, room);
      return true;
    }
    return false;
  }

  function sweep() {
    try {
      const swept = store.sweep();
      if (swept.sessions || swept.events) log(`swept ${swept.sessions} expired sessions, ${swept.events} old events`);
    } catch (error) {
      console.error("[riff] sweep failed", error);
    }
  }
  sweep();
  const sweeper = setInterval(sweep, HOUR_MS);
  sweeper.unref();

  function health() {
    let pending = 0;
    for (const room of previewRelay.rooms.values()) pending += room.pending.size;
    let terminalClients = 0;
    let terminalHosts = 0;
    for (const room of terminalRelay.rooms.values()) {
      terminalClients += room.clients.size;
      if (room.host) terminalHosts += 1;
    }
    let previewHosts = 0;
    for (const room of previewRelay.rooms.values()) if (room.host) previewHosts += 1;
    return {
      preview: { rooms: previewRelay.rooms.size, hosts: previewHosts, pending },
      terminal: { rooms: terminalRelay.rooms.size, hosts: terminalHosts, clients: terminalClients },
      collaboration: collaboration.stats(),
    };
  }

  function close() {
    clearInterval(sweeper);
    audit.close();
    previewRelay.close();
    terminalRelay.close();
    collaboration.close();
    db.close();
  }

  return { middleware, handleUpgrade, health, close };
}
