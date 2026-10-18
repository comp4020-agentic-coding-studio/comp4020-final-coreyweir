// The room documents: Hocuspocus serves them over /collaboration, and every
// update is committed to SQLite as a row when it arrives (docs/adr/0002).
// Who may open and write which document is decided by `authorize`
// (docs/adr/0006, wired up in riff.mjs). Shared by the production server and
// the Vite dev server, so development exercises the same store.
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import { hangUp } from "./sockets.mjs";
import * as Y from "yjs";

// Compact once the rows since the last snapshot outweigh the snapshot itself
// (and at least this much). Rewrites then cost a constant factor of what was
// written, however image-heavy the board: a count threshold like y-leveldb's
// 500 updates rewrites megabytes for a handful of pasted screenshots.
const DEFAULT_COMPACT_MIN_BYTES = 1024 * 1024;
// A single update this big is almost certainly a pasted image; log it so the
// "images inline" decision gets revisited from measurements.
const LARGE_UPDATE_BYTES = 100 * 1024;
// One websocket message, whatever it carries (docs/adr/0003, amendment).
// ws closes the socket with 1009 past it; its default is 100 MB, which one
// message could use to run the server out of memory.
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const PARTS = ["shared", "control"];
const ROOM_DOCUMENT = /^room\/([\w-]{8,64})\/(shared|control)$/;
const roomDocuments = (roomId) => PARTS.map((part) => `room/${roomId}/${part}`);

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  // WAL with synchronous=NORMAL: a commit survives the process being killed
  // (the likeliest crash here is running out of memory). A power loss on the
  // host can drop the last commits; fly's daily volume snapshots are the
  // backstop for losing more than that.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS doc_updates (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      doc      TEXT    NOT NULL,
      data     BLOB    NOT NULL,
      user_id  TEXT,
      at       INTEGER NOT NULL,
      snapshot INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS doc_updates_by_doc ON doc_updates (doc, seq);
  `);
  return db;
}

function contextFrom(origin) {
  if (origin && typeof origin === "object" && origin.source === "connection") {
    return origin.connection?.context ?? null;
  }
  return null;
}

// y-protocols sync message types that carry content: the answer to the
// server's state vector, and an incremental update.
const MESSAGE_YJS_SYNC_STEP_2 = 1;
const MESSAGE_YJS_UPDATE = 2;
// An update that changes nothing still encodes as two bytes.
const EMPTY_UPDATE_BYTES = 2;

// Hocuspocus's wire format: varString(document) varUint(type) payload. An
// Auth message (2) of kind PermissionDenied (1) with a reason is what the
// provider gets when onAuthenticate refuses; it fires authenticationFailed.
function varUint(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return bytes;
}

function varString(text) {
  const utf8 = new TextEncoder().encode(text);
  return [...varUint(utf8.length), ...utf8];
}

const permissionDenied = (documentName, reason) =>
  new Uint8Array([...varString(documentName), ...varUint(2), ...varUint(1), ...varString(reason)]);

// Without an `authorize`, every document is open to everyone (the
// collaboration-store test runs that way). With one, it is called for each
// document a socket asks for, and returns { context, readOnly } or throws.
export function createCollaboration({
  dbPath,
  db: givenDb,
  compactMinBytes = DEFAULT_COMPACT_MIN_BYTES,
  authorize,
  onEdit = () => {},
  onRefusedWrite = () => {},
  // (documentName, document, whoOf): after stored rows are applied, so
  // observers see only live changes. whoOf(transaction.origin) gives the
  // member who sent a change, or null for the server's own writes.
  onDocumentLoaded = () => {},
  // (who, "connect" | "disconnect"): a member's first socket opened, or
  // their last one closed.
  onPresence = () => {},
  // A room's two documents together may store this much (null: no limit).
  // The write that would cross it is refused, and onFull(roomId, who,
  // { storedBytes, refusedBytes }) decides what happens to the room.
  limitBytes = null,
  onFull = () => {},
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  // (who): a socket sent a message over maxMessageBytes and was closed
  onOversized = () => {},
  log = (message) => console.log(`[riff] ${message}`),
} = {}) {
  if (!givenDb && !dbPath) throw new Error("createCollaboration needs a db or a dbPath");
  const db = givenDb ?? openDatabase(dbPath);
  // socketId → websocket, and member id → socket ids, so removing someone
  // can close what they already have open.
  const socketsById = new Map();
  const socketsByMember = new Map();
  const memberBySocket = new Map();
  const whoBySocket = new Map();
  const documentsBySocket = new Map();

  const statements = {
    rows: db.prepare("SELECT data FROM doc_updates WHERE doc = ? ORDER BY seq"),
    append: db.prepare("INSERT INTO doc_updates (doc, data, user_id, at) VALUES (?, ?, ?, ?)"),
    lastSeq: db.prepare("SELECT MAX(seq) AS seq FROM doc_updates WHERE doc = ?"),
    snapshot: db.prepare("INSERT INTO doc_updates (doc, data, at, snapshot) VALUES (?, ?, ?, 1)"),
    dropUpTo: db.prepare("DELETE FROM doc_updates WHERE doc = ? AND seq <= ?"),
    dropAll: db.prepare("DELETE FROM doc_updates WHERE doc = ?"),
    storedBytes: db.prepare("SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM doc_updates WHERE doc = ?"),
  };

  // Per loaded document: bytes of the last snapshot and of rows since it.
  const loaded = new Map();

  // What a document has in SQLite now: kept up to date in memory while it's
  // loaded, read from the table otherwise.
  function storedBytes(name) {
    const entry = loaded.get(name);
    if (entry) return entry.snapshotBytes + entry.pendingBytes;
    return Number(statements.storedBytes.get(name).bytes);
  }

  // Compact each of a room's loaded documents that has rows since its
  // snapshot, now rather than at the next threshold.
  function compactRoom(roomId) {
    for (const name of roomDocuments(roomId)) {
      const entry = loaded.get(name);
      const document = hocuspocus.documents.get(name);
      if (!entry || !document || entry.pendingBytes === 0) continue;
      const before = entry.pendingBytes;
      const bytes = compact(name, document);
      if (bytes === undefined) continue;
      log(`doc ${name} compacted near the room's limit: ${before} bytes of updates folded, snapshot ${bytes} bytes`);
      Object.assign(entry, { snapshotBytes: bytes, pendingBytes: 0 });
    }
  }

  const roomBytes = (roomId) => roomDocuments(roomId).reduce((sum, name) => sum + storedBytes(name), 0);

  // Fold every row up to now into one snapshot row, atomically. Anything
  // appended after `lastSeq` stays; an update that lands in both the
  // snapshot and a later row is harmless, because applying a Yjs update twice
  // is a no-op.
  function compact(name, document) {
    const state = Y.encodeStateAsUpdate(document);
    db.exec("BEGIN IMMEDIATE");
    try {
      const { seq } = statements.lastSeq.get(name);
      if (seq === null) {
        db.exec("ROLLBACK");
        return;
      }
      statements.dropUpTo.run(name, seq);
      statements.snapshot.run(name, state, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return state.byteLength;
  }

  function maybeCompact(name, document) {
    const entry = loaded.get(name);
    if (!entry || entry.compacting) return;
    if (entry.pendingBytes < Math.max(compactMinBytes, entry.snapshotBytes)) return;
    entry.compacting = true;
    // After the current message, not inside Yjs's update event.
    setImmediate(() => {
      entry.compacting = false;
      if (loaded.get(name) !== entry) return;
      try {
        const before = entry.pendingBytes;
        const bytes = compact(name, document);
        if (bytes === undefined) return;
        log(`doc ${name} compacted: ${before} bytes of updates folded, snapshot ${bytes} bytes`);
        entry.snapshotBytes = bytes;
        entry.pendingBytes = 0;
      } catch (error) {
        console.error(`[riff] compacting ${name} failed`, error);
      }
    });
  }

  const hocuspocus = new Hocuspocus({
    name: "riff",
    quiet: true,

    async onLoadDocument({ documentName, document }) {
      const rows = statements.rows.all(documentName);
      if (rows.length > 0) {
        const stored = rows.reduce((sum, row) => sum + row.data.byteLength, 0);
        Y.applyUpdate(document, Y.mergeUpdates(rows.map((row) => row.data)));
        const snapshotBytes = rows.length > 1 ? compact(documentName, document) : stored;
        log(`doc ${documentName} loaded: ${rows.length} rows, ${stored} bytes stored, ${snapshotBytes} bytes as one snapshot`);
        loaded.set(documentName, { snapshotBytes, pendingBytes: 0, compacting: false });
      } else {
        loaded.set(documentName, { snapshotBytes: 0, pendingBytes: 0, compacting: false });
      }

      // Registered after the stored rows are applied, so loading writes
      // nothing back. Yjs fires this synchronously inside the apply, and
      // Hocuspocus acknowledges a change to the client only after the apply
      // returns: the server never acks an update it hasn't committed.
      // (Hocuspocus's own onChange hook runs a microtask later, after the ack.)
      document.on("update", (update, origin) => {
        const context = contextFrom(origin);
        const memberId = context?.who?.memberId;
        statements.append.run(documentName, update, memberId === undefined ? null : String(memberId), Date.now());
        if (context?.who) onEdit(context.who, documentName, update.byteLength);
        const entry = loaded.get(documentName);
        if (!entry) return;
        entry.pendingBytes += update.byteLength;
        if (update.byteLength >= LARGE_UPDATE_BYTES) {
          log(`doc ${documentName} large update: ${update.byteLength} bytes`);
        }
        maybeCompact(documentName, document);
      });
      onDocumentLoaded(documentName, document, (origin) => contextFrom(origin)?.who ?? null);
    },

    async beforeUnloadDocument({ documentName, document }) {
      // Hocuspocus (4.7.0) unloads a document twice after a server write: at
      // once, and again from a timer, which goes by name. If a newer copy
      // loaded in between, that second unload would take the newer copy out
      // of the map, and whoever is attached to it would stop receiving the
      // server's writes. Throwing makes Hocuspocus keep what it has; it logs the
      // message, so it reads as what happened.
      if (hocuspocus.documents.get(documentName) !== document) throw new Error(`${documentName}: skipped unloading a copy that was already unloaded`);
    },

    async afterUnloadDocument({ documentName }) {
      loaded.delete(documentName);
    },

    async onAuthenticate(payload) {
      if (!authorize) return {};
      const { context, readOnly } = authorize(payload);
      payload.connectionConfig.readOnly = Boolean(readOnly);
      const memberId = context?.who?.memberId;
      if (memberId !== undefined) {
        let ids = socketsByMember.get(memberId);
        if (!ids) socketsByMember.set(memberId, (ids = new Set()));
        if (ids.size === 0) onPresence(context.who, "connect");
        ids.add(payload.socketId);
        memberBySocket.set(payload.socketId, memberId);
        whoBySocket.set(payload.socketId, context.who);
        let documents = documentsBySocket.get(payload.socketId);
        if (!documents) documentsBySocket.set(payload.socketId, (documents = new Set()));
        documents.add(payload.documentName);
      }
      return context;
    },

    // Hocuspocus drops a read-only connection's update and answers it with
    // a failed sync status. It awaits this hook before looking at
    // `readOnly`, so turning the connection read-only here refuses the very
    // message that would take its room past the limit.
    async beforeSync({ connection, type, documentName, context, payload }) {
      if (!connection) return;
      if (connection.readOnly) {
        if (type === MESSAGE_YJS_UPDATE) onRefusedWrite(context?.who, documentName);
        return;
      }
      if (limitBytes === null || (type !== MESSAGE_YJS_UPDATE && type !== MESSAGE_YJS_SYNC_STEP_2)) return;
      const roomId = ROOM_DOCUMENT.exec(documentName)?.[1];
      if (!roomId || !payload || payload.byteLength <= EMPTY_UPDATE_BYTES) return;
      // The limit is on what the room stores once compacted (ADR 0003):
      // rows since the last snapshot can hold edits that were since undone.
      let stored = roomBytes(roomId);
      if (stored + payload.byteLength > limitBytes) {
        compactRoom(roomId);
        stored = roomBytes(roomId);
      }
      if (stored + payload.byteLength <= limitBytes) return;
      connection.readOnly = true;
      log(`room ${roomId} is full: ${stored} bytes stored, refused ${payload.byteLength} more to ${documentName}`);
      onFull(roomId, context?.who ?? null, { storedBytes: stored, refusedBytes: payload.byteLength });
    },
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });

  function toFetchRequest(request) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    return new Request(new URL(request.url ?? "/", "http://localhost"), { headers });
  }

  // Hocuspocus 4 takes a socket-like object and a Fetch Request, and leaves
  // feeding it messages and closes to the integration.
  function handleUpgrade(request, socket, head) {
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      const client = hocuspocus.handleConnection(websocket, toFetchRequest(request));
      socketsById.set(client.socketId, websocket);
      websocket.on("message", (data) => client.handleMessage(new Uint8Array(data)));
      websocket.on("close", (code, reason) => {
        socketsById.delete(client.socketId);
        const memberId = memberBySocket.get(client.socketId);
        const who = whoBySocket.get(client.socketId);
        memberBySocket.delete(client.socketId);
        whoBySocket.delete(client.socketId);
        documentsBySocket.delete(client.socketId);
        const ids = socketsByMember.get(memberId);
        ids?.delete(client.socketId);
        if (ids?.size === 0) {
          socketsByMember.delete(memberId);
          // Shutting down isn't anyone leaving: a restart treats live rooms
          // as away anyway, and the database may already be closed.
          if (who && !closing) onPresence(who, "disconnect");
        }
        client.handleClose({ code, reason: reason.toString() });
      });
      websocket.on("error", (error) => {
        // ws has already closed the socket with 1009; nothing of the
        // message reached a document.
        if (error?.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
          log(`collaboration socket closed: a message over ${maxMessageBytes} bytes`);
          onOversized(whoBySocket.get(client.socketId) ?? null);
          return;
        }
        console.error("[riff] collaboration socket error", error);
      });
    });
  }

  function databaseBytes() {
    let bytes = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        bytes += statSync(dbPath + suffix).size;
      } catch {
        // no WAL file yet
      }
    }
    return bytes;
  }

  function stats() {
    return {
      documents: hocuspocus.getDocumentsCount(),
      connections: hocuspocus.getConnectionsCount(),
      databaseBytes: databaseBytes(),
    };
  }

  // Tell every socket a member has open that each of its documents is now
  // refused, then close it; if their provider reconnects, `authorize`
  // refuses it again. The message matters: fly's proxy can hold the
  // browser's side of a closed socket open for seconds.
  function disconnectMember(memberId) {
    const ids = socketsByMember.get(memberId);
    if (!ids) return 0;
    // The bookkeeping is left to each socket's close handler, which also
    // logs the member's disconnect when the last one goes.
    let closed = 0;
    for (const id of [...ids]) {
      const websocket = socketsById.get(id);
      if (!websocket) continue;
      for (const documentName of documentsBySocket.get(id) ?? []) {
        websocket.send(permissionDenied(documentName, "removed"));
      }
      hangUp(websocket, 4403, "removed");
      closed += 1;
    }
    return closed;
  }

  // What open connections to a room may do changed (it ended, came back or
  // filled up). Hocuspocus checks a connection's `readOnly` on every
  // message, so nobody has to reconnect. readOnlyFor(who, part) decides.
  function setAccess(roomId, readOnlyFor) {
    for (const name of roomDocuments(roomId)) {
      const document = hocuspocus.documents.get(name);
      if (!document) continue;
      const part = name.split("/").pop();
      for (const connection of document.getConnections()) {
        const who = connection.context?.who;
        if (who) connection.readOnly = Boolean(readOnlyFor(who, part));
      }
    }
  }

  // A board the server deleted (not kept, or pruned) while the host still
  // had it open. Revived, the host's copy is the board again (ADR 0003):
  // store it whole, or later rows would build on content that isn't stored.
  // (The reviving connection isn't attached yet, so this is an older one.)
  function storeOpenCopy(roomId) {
    for (const name of roomDocuments(roomId)) {
      const document = hocuspocus.documents.get(name);
      if (!document) continue;
      const hostHasItOpen = document.getConnections().some((connection) => connection.context?.who?.role === "host");
      if (!hostHasItOpen || statements.lastSeq.get(name).seq !== null || Y.encodeStateVector(document).byteLength <= 1) continue;
      const state = Y.encodeStateAsUpdate(document);
      statements.snapshot.run(name, state, Date.now());
      const entry = loaded.get(name);
      if (entry) Object.assign(entry, { snapshotBytes: state.byteLength, pendingBytes: 0 });
      log(`doc ${name} stored again from the open copy`);
    }
  }

  // A room's board is no longer stored: it ended and the server doesn't keep
  // it, or it was pruned to make space (ADR 0003). Its members are told why
  // and let go, and its stored rows are deleted. The host's sockets stay,
  // read-only: a host that reconnects revives the room, and their page is
  // leaving anyway.
  function forgetRoom(roomId, reason = "room-ended") {
    setAccess(roomId, () => true);
    const names = roomDocuments(roomId);
    let closed = 0;
    for (const [socketId, documents] of documentsBySocket) {
      if (whoBySocket.get(socketId)?.role === "host") continue;
      const mine = names.filter((name) => documents.has(name));
      const websocket = socketsById.get(socketId);
      if (mine.length === 0 || !websocket) continue;
      for (const name of mine) websocket.send(permissionDenied(name, reason));
      hangUp(websocket, 4410, reason);
      closed += 1;
    }
    let rows = 0;
    for (const name of names) {
      rows += Number(statements.dropAll.run(name).changes);
      const entry = loaded.get(name);
      if (entry) Object.assign(entry, { snapshotBytes: 0, pendingBytes: 0 });
    }
    log(`room ${roomId} board deleted (${reason}): ${rows} stored rows, ${closed} sockets let go`);
    return { rows, closed };
  }

  // A change made by the server itself (the member list), stored like any
  // other update.
  async function change(documentName, transaction) {
    const connection = await hocuspocus.openDirectConnection(documentName, { server: true });
    try {
      await connection.transact(transaction);
    } finally {
      await connection.disconnect();
    }
  }

  let closing = false;
  function close() {
    closing = true;
    hocuspocus.closeConnections();
    for (const websocket of sockets.clients) websocket.terminate();
    sockets.close();
    if (!givenDb) db.close();
  }

  return {
    handleUpgrade,
    stats,
    close,
    disconnectMember,
    setAccess,
    storeOpenCopy,
    forgetRoom,
    roomBytes,
    change,
    hocuspocus,
    db,
  };
}
