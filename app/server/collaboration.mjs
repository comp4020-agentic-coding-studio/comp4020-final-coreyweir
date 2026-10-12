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

// y-protocols sync message type for an incremental update.
const MESSAGE_YJS_UPDATE = 2;

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
  log = (message) => console.log(`[riff] ${message}`),
} = {}) {
  if (!givenDb && !dbPath) throw new Error("createCollaboration needs a db or a dbPath");
  const db = givenDb ?? openDatabase(dbPath);
  // socketId → websocket, and member id → socket ids, so removing someone
  // can close what they already have open.
  const socketsById = new Map();
  const socketsByMember = new Map();
  const memberBySocket = new Map();
  const documentsBySocket = new Map();

  const statements = {
    rows: db.prepare("SELECT data FROM doc_updates WHERE doc = ? ORDER BY seq"),
    append: db.prepare("INSERT INTO doc_updates (doc, data, user_id, at) VALUES (?, ?, ?, ?)"),
    lastSeq: db.prepare("SELECT MAX(seq) AS seq FROM doc_updates WHERE doc = ?"),
    snapshot: db.prepare("INSERT INTO doc_updates (doc, data, at, snapshot) VALUES (?, ?, ?, 1)"),
    dropUpTo: db.prepare("DELETE FROM doc_updates WHERE doc = ? AND seq <= ?"),
  };

  // Per loaded document: bytes of the last snapshot and of rows since it.
  const loaded = new Map();

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
        ids.add(payload.socketId);
        memberBySocket.set(payload.socketId, memberId);
        let documents = documentsBySocket.get(payload.socketId);
        if (!documents) documentsBySocket.set(payload.socketId, (documents = new Set()));
        documents.add(payload.documentName);
      }
      return context;
    },

    // Hocuspocus drops a read-only connection's update and answers it with
    // a failed sync status; this only reports that it happened.
    async beforeSync({ connection, type, documentName, context }) {
      if (connection?.readOnly && type === MESSAGE_YJS_UPDATE) onRefusedWrite(context?.who, documentName);
    },
  });

  const sockets = new WebSocketServer({ noServer: true });

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
        memberBySocket.delete(client.socketId);
        documentsBySocket.delete(client.socketId);
        const ids = socketsByMember.get(memberId);
        ids?.delete(client.socketId);
        if (ids?.size === 0) socketsByMember.delete(memberId);
        client.handleClose({ code, reason: reason.toString() });
      });
      websocket.on("error", (error) => console.error("[riff] collaboration socket error", error));
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
    socketsByMember.delete(memberId);
    let closed = 0;
    for (const id of ids) {
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

  function close() {
    hocuspocus.closeConnections();
    for (const websocket of sockets.clients) websocket.terminate();
    sockets.close();
    if (!givenDb) db.close();
  }

  return { handleUpgrade, stats, close, disconnectMember, change, hocuspocus, db };
}
