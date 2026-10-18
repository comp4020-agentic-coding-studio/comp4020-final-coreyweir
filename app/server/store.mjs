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
      ended_at        INTEGER,
      -- ADR 0003's amendment: a full room stays read-only; pruning picks
      -- the ended boards opened longest ago, and a pruned board is gone.
      full_at         INTEGER,
      last_opened     INTEGER,
      pruned_at       INTEGER
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

    -- An invite names a GitHub account by its numeric id, which a rename
    -- doesn't change (docs/adr/0008). The account may not use Riff yet, so
    -- it's not a users row. Invites go when the room ends.
    CREATE TABLE IF NOT EXISTS invites (
      room_id     TEXT    NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
      github_id   INTEGER NOT NULL,
      login       TEXT    NOT NULL,
      invited_by  INTEGER NOT NULL REFERENCES room_members (id),
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (room_id, github_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS invites_by_account ON invites (github_id);

    -- Someone's own list of colleagues: private, one-way, kept until they
    -- remove it. Also by GitHub id, since you can add someone by username.
    CREATE TABLE IF NOT EXISTS colleagues (
      user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      github_id   INTEGER NOT NULL,
      login       TEXT    NOT NULL,
      avatar_url  TEXT,
      added_at    INTEGER NOT NULL,
      PRIMARY KEY (user_id, github_id)
    ) STRICT;
  `);
  // Columns added after the table first shipped. CREATE TABLE IF NOT EXISTS
  // leaves an existing table as it was, so the live database gets them here.
  const columns = new Set(db.prepare("PRAGMA table_info(rooms)").all().map((column) => column.name));
  for (const column of ["full_at", "last_opened", "pruned_at"]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE rooms ADD COLUMN ${column} INTEGER`);
  }
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
    // A new room is "away" until its host's first socket arrives.
    insertRoom: q("INSERT INTO rooms (id, code, created_at, host_last_seen, state, keep) VALUES (?, ?, ?, ?, 'away', ?)"),
    hostArrived: q("UPDATE rooms SET state = 'live', host_last_seen = ?, ended_at = NULL WHERE id = ? AND state <> 'ended'"),
    hostLeft: q("UPDATE rooms SET state = 'away', host_last_seen = ? WHERE id = ? AND state = 'live'"),
    endRoom: q("UPDATE rooms SET state = 'ended', ended_at = ? WHERE id = ? AND state <> 'ended'"),
    // A pruned board comes back from the host's own copy.
    reviveRoom: q("UPDATE rooms SET state = 'away', host_last_seen = ?, ended_at = NULL, pruned_at = NULL WHERE id = ? AND state = 'ended'"),
    markFull: q("UPDATE rooms SET full_at = ? WHERE id = ? AND full_at IS NULL"),
    touchOpened: q("UPDATE rooms SET last_opened = ? WHERE id = ?"),
    // Ended boards the server still keeps, opened longest ago first.
    prunable: q(`SELECT id, code FROM rooms WHERE state = 'ended' AND keep = 1 AND pruned_at IS NULL
                 ORDER BY COALESCE(last_opened, ended_at, created_at), created_at`),
    // The board is gone, so it isn't full any more either.
    markPruned: q("UPDATE rooms SET pruned_at = ?, full_at = NULL WHERE id = ? AND pruned_at IS NULL"),
    overdueRooms: q("SELECT id FROM rooms WHERE state = 'away' AND host_last_seen < ?"),
    // After a restart nobody is connected, so a live room's host is away
    // from that moment and gets the whole grace period to come back.
    liveToAway: q("UPDATE rooms SET state = 'away', host_last_seen = ? WHERE state = 'live'"),
    hostOf: q("SELECT * FROM room_members WHERE room_id = ? AND is_host"),
    // The rooms a signed-in user is in, newest first.
    roomsOfUser: q(`SELECT r.*, m.id AS member_id, m.is_host FROM room_members m JOIN rooms r ON r.id = m.room_id
                    WHERE m.user_id = ? AND m.removed_at IS NULL AND r.state <> 'ended' ORDER BY r.created_at DESC`),
    insertInvite: q(`INSERT INTO invites (room_id, github_id, login, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (room_id, github_id) DO UPDATE SET login = excluded.login`),
    invite: q("SELECT * FROM invites WHERE room_id = ? AND github_id = ?"),
    deleteInvite: q("DELETE FROM invites WHERE room_id = ? AND github_id = ?"),
    deleteRoomInvites: q("DELETE FROM invites WHERE room_id = ?"),
    invitesOfRoom: q("SELECT github_id, login, created_at FROM invites WHERE room_id = ? ORDER BY created_at"),
    invitesFor: q(`SELECT i.room_id, i.created_at, r.code, inviter.name AS invited_by FROM invites i
                   JOIN rooms r ON r.id = i.room_id JOIN room_members inviter ON inviter.id = i.invited_by
                   WHERE i.github_id = ? AND r.state <> 'ended' ORDER BY i.created_at DESC`),
    userByGithubId: q("SELECT * FROM users WHERE github_id = ?"),
    restoreMember: q("UPDATE room_members SET removed_at = NULL WHERE id = ?"),
    colleagues: q("SELECT github_id, login, avatar_url, added_at FROM colleagues WHERE user_id = ? ORDER BY login COLLATE NOCASE"),
    insertColleague: q(`INSERT INTO colleagues (user_id, github_id, login, avatar_url, added_at) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT (user_id, github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url`),
    deleteColleague: q("DELETE FROM colleagues WHERE user_id = ? AND github_id = ?"),
    // GitHub users who were in a room with this one, most recent first.
    recentlyWorkedWith: q(`SELECT u.github_id, u.login, u.avatar_url, MAX(r.created_at) AS last_room_at
                           FROM room_members me
                           JOIN room_members them ON them.room_id = me.room_id AND them.user_id IS NOT NULL
                                AND them.user_id <> me.user_id AND them.removed_at IS NULL
                           JOIN users u ON u.id = them.user_id
                           JOIN rooms r ON r.id = me.room_id
                           WHERE me.user_id = ? AND me.removed_at IS NULL
                           GROUP BY u.id ORDER BY last_room_at DESC LIMIT 30`),
    setCode: q("UPDATE rooms SET code = ? WHERE id = ?"),
    setLocked: q("UPDATE rooms SET locked = ? WHERE id = ?"),
    setKeep: q("UPDATE rooms SET keep = ? WHERE id = ?"),
    // everyone who ever joined besides the host, removed or not
    othersEver: q("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND is_host = 0"),
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
    createRoom({ name, userId, keep = true, now = Date.now() }) {
      return transaction(() => {
        const id = randomToken(16);
        const code = freshCode();
        s.insertRoom.run(id, code, now, now, keep ? 1 : 0);
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
