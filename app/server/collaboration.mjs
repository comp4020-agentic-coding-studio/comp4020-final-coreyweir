// The room documents: Hocuspocus serves them over /collaboration/, and every
// update is committed to SQLite as a row when it arrives (docs/adr/0002).
// Shared by the production server (index.mjs) and the Vite dev server, so
// development exercises the same store.
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
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

function userIdFrom(origin) {
  if (origin && typeof origin === "object" && origin.source === "connection") {
    return origin.connection?.context?.userId ?? null;
  }
  return null;
}

export function createCollaboration({
  dbPath,
  compactMinBytes = DEFAULT_COMPACT_MIN_BYTES,
  log = (message) => console.log(`[riff] ${message}`),
} = {}) {
  if (!dbPath) throw new Error("createCollaboration needs a dbPath");
  const db = openDatabase(dbPath);

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
        statements.append.run(documentName, update, userIdFrom(origin), Date.now());
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
      websocket.on("message", (data) => client.handleMessage(new Uint8Array(data)));
      websocket.on("close", (code, reason) => client.handleClose({ code, reason: reason.toString() }));
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

  function close() {
    hocuspocus.closeConnections();
    for (const websocket of sockets.clients) websocket.terminate();
    sockets.close();
    db.close();
  }

  return { handleUpgrade, stats, close, hocuspocus };
}
