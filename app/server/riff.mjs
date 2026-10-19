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
import { createGithubLookup } from "./github.mjs";
import { createColleagues } from "./colleagues.mjs";
import { createWatch } from "./watch.mjs";
import { createModels } from "./models.mjs";
import { randomBytes } from "node:crypto";
import { statfsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { HttpError, sameOrigin, sendJson } from "./http.mjs";

const HOUR_MS = 60 * 60 * 1000;
const STATE_CHECK_MS = 30 * 1000;
const DOCUMENT = /^room\/([\w-]{8,64})\/(shared|control)$/;
// docs/adr/0003, amendment of 18 October: a 16 MB board ran the 256 MB
// machine out of memory, 4 MB per room didn't. Pruning starts above 70% of
// the volume and stops below 60%.
const ROOM_LIMIT_BYTES = 4 * 1024 * 1024;
const PRUNE_ABOVE = 0.7;
const PRUNE_UNTIL = 0.6;

// The volume the database is on, counting the database's free pages as
// free: SQLite reuses them, but never gives them back to the filesystem.
function volumeUsage(db, dbPath) {
  const volume = statfsSync(dirname(resolvePath(dbPath)));
  const { freelist_count: freePages } = db.prepare("PRAGMA freelist_count").get();
  const { page_size: pageSize } = db.prepare("PRAGMA page_size").get();
  const total = volume.blocks * volume.bsize;
  return { total, used: (volume.blocks - volume.bfree) * volume.bsize - freePages * pageSize };
}

export function createRiff({
  dbPath,
  origin,
  githubClientId,
  githubClientSecret,
  sessionSecret,
  // Riff's OpenRouter key (docs/adr/0009); the upstream and fetch are seams
  // for the in-process test's stand-in OpenRouter
  openrouterKey,
  modelUpstream,
  modelFetch,
  log = (message) => console.log(`[riff] ${message}`),
  // seams for the in-process tests: a stand-in GitHub, and a short grace
  githubLookup = createGithubLookup({ clientId: githubClientId, clientSecret: githubClientSecret }),
  hostGraceMs,
  stateCheckMs = STATE_CHECK_MS,
  roomLimitBytes = ROOM_LIMIT_BYTES,
  diskUsage,
}) {
  if (!origin) throw new Error("createRiff needs RIFF_ORIGIN: the origin browsers reach this server at");
  const db = openDatabase(dbPath);
  const store = createStore(db);
  const audit = createAudit({ store });
  const auth = createAuth({ store, audit, origin, clientId: githubClientId, clientSecret: githubClientSecret, sessionSecret });
  const usage = diskUsage ?? (() => volumeUsage(db, dbPath));

  // What a member may write in each document of a room. The host writes
  // both documents, participants only the shared one; once a room has
  // ended or filled up, nobody writes (ADR 0006, ADR 0003).
  const readOnly = (room, who, part) => room.full || room.state === "ended" || (who.role !== "host" && part === "control");
  const accessOf = (roomId) => {
    const row = store.statements.roomById.get(roomId);
    const room = { full: row.full_at !== null, state: row.state };
    return (who, part) => readOnly(room, who, part);
  };

  let collaboration;
  let watch;
  const rooms = createRooms({
    store,
    auth,
    audit,
    origin,
    githubLookup,
    hostGraceMs,
    limitBytes: roomLimitBytes,
    log,
    onListsChanged: () => watch?.changed(),
    onEnded: (roomId, { keep }) => {
      if (keep) collaboration.setAccess(roomId, accessOf(roomId));
      else collaboration.forgetRoom(roomId);
      terminalRelay.endRoom(roomId);
    },
    onRevived: (roomId) => {
      collaboration.setAccess(roomId, accessOf(roomId));
      collaboration.storeOpenCopy(roomId);
    },
    onFull: (roomId) => collaboration.setAccess(roomId, accessOf(roomId)),
    // Production and CI always set SESSION_SECRET. Without it, preview keys
    // last as long as the process, which is as long as any preview does.
    previewSecret: sessionSecret || randomBytes(32).toString("hex"),
    models: Boolean(openrouterKey),
    onRoomChanged: (roomId) => {
      publishRoom(roomId);
      watch?.changed();
    },
    onRemoved: (roomId, memberId) => {
      collaboration.disconnectMember(memberId);
      terminalRelay.disconnectMember(roomId, memberId);
      previewRelay.disconnectMember(roomId, memberId);
    },
  });

  watch = createWatch({ rooms, auth, log });
  const colleagues = createColleagues({ store, auth, audit, origin, githubLookup });
  const models = createModels({ apiKey: openrouterKey, upstream: modelUpstream, rooms, audit, origin, fetch: modelFetch });

  // Who a document belongs to and what this credential may do with it.
  // Anything that isn't `room/<id>/shared|control` doesn't exist. In an
  // ended room members may still read a board the server kept, and are
  // turned away from one it didn't keep or pruned (ADR 0003); the host
  // opening it revives it. Opening a room counts for pruning, which goes by
  // the boards opened longest ago.
  function authorize({ documentName, token, requestHeaders }) {
    const match = DOCUMENT.exec(documentName);
    const who = match && rooms.resolve(match[1], { token, cookie: requestHeaders.get("cookie") ?? undefined });
    if (!who) {
      audit.tally(null, "denied", { what: "document", reason: match ? "not_a_member" : "no_such_document" });
      throw Object.assign(new Error("not a member"), { reason: "not-a-member" });
    }
    if (who.state === "ended" && (!who.keep || who.pruned) && who.role !== "host") {
      const reason = who.keep ? "board-pruned" : "room-ended";
      audit.tally(who, "denied", { what: "document", reason: reason.replace(/-/g, "_") });
      throw Object.assign(new Error(reason), { reason });
    }
    store.statements.touchOpened.run(Date.now(), who.roomId);
    return { context: { who }, readOnly: readOnly(who, who, match[2]) };
  }

  collaboration = createCollaboration({
    db,
    authorize,
    log,
    onEdit: (who, documentName, bytes) => audit.tally(who, `${documentName.split("/").pop()}.edit`, {}, bytes),
    onRefusedWrite: (who, documentName) =>
      audit.tally(who, "denied", { what: `${documentName.split("/").pop()}.write`, reason: "read_only" }),
    onDocumentLoaded: watchDocument,
    limitBytes: roomLimitBytes,
    onOversized: (who) => audit.record(who, "denied", { what: "message", reason: "too_big" }),
    onFull: (roomId, who, { storedBytes, refusedBytes }) =>
      rooms.markFull(roomId, who, { stored_bytes: storedBytes, refused_bytes: refusedBytes }),
    onPresence: (who, action) => {
      audit.record(who, action);
      rooms.presence(who, action);
    },
  });

  // Edits are only tallied, but adding and removing a staged prompt or a
  // queued one is logged one by one, with who did it: anyone may delete a
  // staged prompt (ADR 0006) because the log shows who did. Ids only, never
  // the text. The server's own writes (the member list) have no member.
  // A queued prompt leaves the queue two ways: the host loads it into the
  // terminal, or removes it. Loading names the prompt in `roomState.lastSent`
  // in the same transaction as the delete, so the log can tell them apart.
  // That is the host's own claim: the terminal runs in the host's browser,
  // and the server never sees what was typed into it.
  function watchDocument(documentName, document, whoOf) {
    const part = DOCUMENT.exec(documentName)?.[2];
    const sentNow = (id) => document.getMap("roomState").get("lastSent") === id;
    const watch = (map, subject, deleted = () => `${subject}.delete`) =>
      map.observe((event) => {
        const who = whoOf(event.transaction.origin);
        if (!who) return;
        for (const [id, change] of event.changes.keys) {
          if (change.action === "add") audit.record(who, `${subject}.add`, { id });
          if (change.action === "delete") audit.record(who, deleted(id), { id });
        }
      });
    if (part === "shared") watch(document.getMap("prompts"), "prompt");
    if (part === "control") watch(document.getMap("queue"), "queue", (id) => (sentNow(id) ? "queue.send" : "queue.delete"));
  }

  // The relays' hello carries the same credential as the documents: a
  // guest's secret as `token`, or the session cookie on the upgrade.
  // An ended room has no host, so nothing to relay to its members.
  const relayAuthorize = (roomId, hello, request) => {
    const who = rooms.resolve(roomId, {
      token: typeof hello.token === "string" && hello.token ? hello.token : undefined,
      cookie: request.headers.cookie,
    });
    if (who && who.state === "ended" && who.role !== "host") return { refused: "room-ended", who };
    return who;
  };
  const relayRefused = (roomId, what, who, code) => {
    const member = who?.memberId ? who : null;
    const reason = code ?? who?.refused ?? (member ? "host_only" : "not_a_member");
    audit.record(member ?? { roomId }, "denied", { what, reason: reason.replace(/-/g, "_") });
  };
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

  // The room's code, lock, state and member list live in the control document,
  // written only here, so names and the GitHub badge can't be forged from a
  // browser and everyone sees a rotated code or a removal at once.
  // A board the server no longer keeps (or pruned) isn't written to again,
  // or this would store it afresh.
  function publishRoom(roomId) {
    const { room, members } = rooms.summary(roomId);
    if (room.state === "ended" && (!room.keep || room.pruned)) return;
    collaboration
      .change(`room/${roomId}/control`, (document) => {
        const info = document.getMap("room");
        const list = document.getMap("members");
        document.transact(() => {
          if (info.get("code") !== room.code) info.set("code", room.code);
          if (info.get("locked") !== room.locked) info.set("locked", room.locked);
          if (info.get("keep") !== room.keep) info.set("keep", room.keep);
          if (info.get("state") !== room.state) info.set("state", room.state);
          if (info.get("endsAt") !== room.endsAt) info.set("endsAt", room.endsAt);
          if (info.get("full") !== room.full) info.set("full", room.full);
          if (info.get("limitBytes") !== room.limitBytes) info.set("limitBytes", room.limitBytes);
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
      if (await colleagues.handle(request, response, url)) return;
      if (await models.handle(request, response, url)) return;
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
    const ours =
      path === "/collaboration" ||
      path.startsWith("/collaboration/") ||
      path === "/api/rooms/watch" ||
      path.startsWith("/terminal/") ||
      path.startsWith("/preview-control/");
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
    if (path === "/api/rooms/watch") {
      watch.handleUpgrade(request, socket, head);
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

  // Above 70% of the volume, delete ended boards the server kept, opened
  // longest ago first, until below 60% (ADR 0003's amendment). Live and
  // away rooms are never pruned. Freed pages stay in the file as free
  // pages, which volumeUsage counts as free.
  function prune() {
    const { total, used } = usage();
    if (used <= PRUNE_ABOVE * total) return 0;
    let remaining = used;
    let pruned = 0;
    let freed = 0;
    for (const { id } of store.statements.prunable.all()) {
      if (remaining < PRUNE_UNTIL * total) break;
      const bytes = collaboration.roomBytes(id);
      if (!rooms.markPruned(id, { freed_bytes: bytes })) continue;
      collaboration.forgetRoom(id, "board-pruned");
      remaining -= bytes;
      freed += bytes;
      pruned += 1;
    }
    const percent = (value) => Math.round((value / total) * 100);
    log(`volume ${percent(used)}% used: pruned ${pruned} ended boards, ${freed} bytes, now about ${percent(remaining)}%`);
    return pruned;
  }

  function sweep() {
    try {
      const swept = store.sweep();
      if (swept.sessions || swept.events) log(`swept ${swept.sessions} expired sessions, ${swept.events} old events`);
      prune();
    } catch (error) {
      console.error("[riff] sweep failed", error);
    }
  }
  sweep();
  const sweeper = setInterval(sweep, HOUR_MS);
  sweeper.unref();

  // Rooms whose host has been away past the grace period end (ADR 0008).
  function checkStates() {
    try {
      const ended = rooms.endOverdue();
      if (ended) log(`${ended} rooms ended: their hosts didn't come back`);
    } catch (error) {
      console.error("[riff] ending overdue rooms failed", error);
    }
  }
  checkStates();
  const stateChecker = setInterval(checkStates, stateCheckMs);
  stateChecker.unref();

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
      watchers: watch.count(),
      models: models.available,
    };
  }

  function close() {
    clearInterval(sweeper);
    clearInterval(stateChecker);
    watch.close();
    audit.close();
    previewRelay.close();
    terminalRelay.close();
    collaboration.close();
    db.close();
  }

  return { middleware, handleUpgrade, health, close, prune };
}
