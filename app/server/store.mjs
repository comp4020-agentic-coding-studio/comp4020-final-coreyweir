// Everything the server knows about people and rooms, in the same SQLite
// file as the room documents (docs/adr/0002, 0005, 0006). One connection,
// opened by collaboration.mjs's openDatabase and shared.
import { createHash, randomBytes } from "node:crypto";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function migrate(db) {
  // SQLite leaves foreign keys off unless each connection asks.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY,
      github_id   INTEGER NOT NULL UNIQUE,
      login       TEXT    NOT NULL,
      avatar_url  TEXT,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions (expires_at);

    CREATE TABLE IF NOT EXISTS rooms (
      id              TEXT    PRIMARY KEY,
      code            TEXT    NOT NULL UNIQUE,
      keep            INTEGER NOT NULL DEFAULT 1,
      locked          INTEGER NOT NULL DEFAULT 0,
      state           TEXT    NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'away', 'ended')),
      host_last_seen  INTEGER,
      created_at      INTEGER NOT NULL,
      ended_at        INTEGER
    ) STRICT;

    -- A member is a GitHub user or a guest with a room-scoped secret, never
    -- both. Removed members keep their row (and their name), so the log
    -- can always say who someone was.
    CREATE TABLE IF NOT EXISTS room_members (
      id           INTEGER PRIMARY KEY,
      room_id      TEXT    NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
      user_id      INTEGER REFERENCES users (id),
      secret_hash  TEXT    UNIQUE,
      is_host      INTEGER NOT NULL DEFAULT 0,
      name         TEXT    NOT NULL,
      name_key     TEXT    NOT NULL,
      joined_at    INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL,
      removed_at   INTEGER,
      CHECK ((user_id IS NULL) <> (secret_hash IS NULL)),
      UNIQUE (room_id, name_key),
      UNIQUE (room_id, user_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_host_per_room ON room_members (room_id) WHERE is_host;

    -- The who-did-what log. No foreign keys: it outlives the rooms and
    -- members it names. detail_json is flat scalars, never content.
    CREATE TABLE IF NOT EXISTS events (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      room_id      TEXT,
      member_id    INTEGER,
      user_id      INTEGER,
      action       TEXT    NOT NULL,
      detail_json  TEXT    NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS events_by_room ON events (room_id, seq);
    CREATE INDEX IF NOT EXISTS events_by_at ON events (at);
  `);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

// Join codes: short, read aloud and typed on phones, so no 0/O or 1/I.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function newCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  // 256 is a multiple of 32, so the modulo has no bias.
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export function normaliseCode(input) {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return code.length > 0 && code.length <= 16 ? code : null;
}

const MAX_NAME_LENGTH = 40;

// A display name, and the key two names collide on: NFKC (so look-alike
// compatibility characters fold together), trimmed, case-insensitive.
export function normaliseName(input) {
  if (typeof input !== "string") return null;
  const name = input.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length === 0 || [...name].length > MAX_NAME_LENGTH) return null;
  if (/\p{Cc}|\p{Cf}/u.test(name)) return null;
  return { name, key: name.toLowerCase() };
}

export function createStore(db) {
  migrate(db);
  const q = (sql) => db.prepare(sql);
  const s = {
    roomById: q("SELECT * FROM rooms WHERE id = ?"),
    roomByCode: q("SELECT * FROM rooms WHERE code = ? AND state <> 'ended'"),
    insertRoom: q("INSERT INTO rooms (id, code, created_at, host_last_seen) VALUES (?, ?, ?, ?)"),
    setCode: q("UPDATE rooms SET code = ? WHERE id = ?"),
    setLocked: q("UPDATE rooms SET locked = ? WHERE id = ?"),
    insertMember: q(`INSERT INTO room_members (room_id, user_id, secret_hash, is_host, name, name_key, joined_at, last_seen)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    memberById: q("SELECT * FROM room_members WHERE id = ?"),
    memberBySecret: q("SELECT * FROM room_members WHERE secret_hash = ?"),
    memberByUser: q("SELECT * FROM room_members WHERE room_id = ? AND user_id = ?"),
    memberByNameKey: q("SELECT id FROM room_members WHERE room_id = ? AND name_key = ?"),
    removeMember: q("UPDATE room_members SET removed_at = ? WHERE id = ? AND removed_at IS NULL"),
    touchMember: q("UPDATE room_members SET last_seen = ? WHERE id = ?"),
    members: q(`SELECT m.id, m.name, m.is_host, m.removed_at, u.login FROM room_members m
                LEFT JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.id`),
    userById: q("SELECT * FROM users WHERE id = ?"),
    upsertUser: q(`INSERT INTO users (github_id, login, avatar_url, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url,
                   last_seen = excluded.last_seen RETURNING *`),
    insertSession: q("INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)"),
    sessionByHash: q("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?"),
    touchSession: q("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?"),
    deleteSession: q("DELETE FROM sessions WHERE token_hash = ?"),
    sweepSessions: q("DELETE FROM sessions WHERE expires_at <= ?"),
    insertEvent: q("INSERT INTO events (at, room_id, member_id, user_id, action, detail_json) VALUES (?, ?, ?, ?, ?, ?)"),
    sweepEvents: q("DELETE FROM events WHERE at < ?"),
  };

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // A code no live room is using. Collisions are rare at a billion codes,
  // so a few tries is plenty.
  function freshCode() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = newCode();
      if (!s.roomByCode.get(code)) return code;
    }
    throw new Error("could not find a free room code");
  }

  return {
    db,
    statements: s,
    transaction,

    // The room and its host, in one transaction: the schema can't say every
    // room has a host, so creation is the only way a room comes to exist.
    createRoom({ name, userId, now = Date.now() }) {
      return transaction(() => {
        const id = randomToken(16);
        const code = freshCode();
        s.insertRoom.run(id, code, now, now);
        const secret = userId ? null : randomToken();
        const { lastInsertRowid } = s.insertMember.run(
          id, userId ?? null, secret ? hashToken(secret) : null, 1, name.name, name.key, now, now,
        );
        return { room: s.roomById.get(id), member: s.memberById.get(Number(lastInsertRowid)), secret };
      });
    },

    addMember({ roomId, name, userId, now = Date.now() }) {
      const secret = userId ? null : randomToken();
      const { lastInsertRowid } = s.insertMember.run(
        roomId, userId ?? null, secret ? hashToken(secret) : null, 0, name.name, name.key, now, now,
      );
      return { member: s.memberById.get(Number(lastInsertRowid)), secret };
    },

    rotateCode(roomId) {
      return transaction(() => {
        const code = freshCode();
        s.setCode.run(code, roomId);
        return code;
      });
    },

    sweep(now = Date.now(), { eventsMaxAgeMs = 90 * DAY_MS } = {}) {
      const sessions = s.sweepSessions.run(now).changes;
      const events = s.sweepEvents.run(now - eventsMaxAgeMs).changes;
      return { sessions, events };
    },
  };
}
