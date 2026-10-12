# 2. Room state in SQLite, as an append-only update log

- Status: accepted, not yet implemented (week 10, planning phase)
- Date: 2026-10-12

## Context

Each room's shared state (whiteboard, staged prompts, queue) is a Yjs
document. Today `y-websocket` serves it and `y-leveldb` persists it to the fly
volume (`YPERSISTENCE=/data/yjs`). Three things push us to change that:

- **Crit 10 and the identity work need relational data.** Users (GitHub and
  guest), rooms and who owns them, members, invites and an audit log of who
  did what. That data is relational and has to live beside the documents it
  describes. Ending a room should remove its document, members and invites in
  one transaction.
- **We're moving the Yjs server to Hocuspocus** for its per-connection
  authentication, read-only connections and per-change hooks that carry the
  connection's identity. Its persistence is pluggable, so the store is a free
  choice at this point.
- **The current store is a stale native dependency.** `y-leveldb` 0.1.2 pulls
  in `level@6` and `leveldown@5.6.0`, a compiled C++ addon. npm marks both
  `leveldown` and `levelup` deprecated ("superseded by classic-level").

Two facts constrain how documents are written:

- **Documents are large.** Pasted images are stored in the document as data
  URLs. Quickdraw keeps images up to 2048px and 600 KB as they are, and
  re-encodes anything larger as a 2048px JPEG at quality 0.85
  (`@quickdrawjs/core` `readImage`). `boardSync.ts` copies those asset records
  into `boardRecords` like any shape, so one screenshot adds roughly
  0.3–1.3 MB of base64.
- **The machine is small.** One shared-cpu-1x with 256 MB and one volume
  (`fly.toml`). The likeliest crash is running out of memory, and image-heavy
  rooms cause it. A persistence scheme has to hold up through exactly that
  crash, not just a clean shutdown.

## Options

1. **Keep LevelDB for documents and add SQLite for everything else.** Least
   change. But there are two stores to back up, export and keep consistent:
   ending a room can't be one transaction. And the deprecated native addon
   stays.
2. **SQLite, storing the full document on a debounce.** Hocuspocus's
   `extension-database` default writes the whole encoded state after edits
   settle, by default 2s after the last change and at most every 10s. It also
   stores on the last disconnect and on SIGTERM. That's about 20 lines. But a
   hard crash loses up to ~10s of edits, and every store rewrites the whole
   document, images included, every few seconds while anyone is active.
3. **SQLite, as an append-only log of updates** (y-leveldb's own model).
   Every incoming update is committed as a row when it arrives. Loading a
   document merges the latest snapshot with the rows after it. Compaction
   folds the rows into a new snapshot inside one transaction. About 60 lines.

## Decision

Option 3, on `node:sqlite` (built into Node, so no native dependency), in WAL
mode on `/data`.

- Updates are written from Hocuspocus's per-change hook (`onChange`), one row
  each: `(doc, seq, update, user_id, at)`.
- Compaction is triggered by **bytes**, not by update count. y-leveldb
  compacts every 500 updates (`PREFERRED_TRIM_SIZE`), and on an image-heavy
  board each compaction rewrites megabytes. A byte threshold ties how often we
  rewrite to the cost of rewriting.
- `user_id` stays on each update row until compaction. It's a raw trail, not
  the audit log, which crit 10 gets as its own table with readable events.
- Images stay inline for now. Document sizes get logged so the next decision
  is made from measurements.

## Consequences

- **What we gain:** almost nothing is lost if the process crashes, because
  each update is committed when it arrives. Each edit writes only its update;
  the whole document is written only at compaction. Rooms, members, invites,
  documents and the audit log share one transaction boundary and one file, so
  backup and export copy one thing. The deprecated addon goes.
- **What it costs:**
  - We own about 60 lines of persistence code, including compaction, instead
    of using an extension. Compaction has to be atomic and has to be tested.
    The check is to kill the process mid-session and confirm the document
    reloads intact.
  - `node:sqlite` is unflagged in our Node 24 but still marked experimental
    there. It only reaches "release candidate" in Node 25.7.
  - Existing rooms in `/data/yjs` aren't migrated. Rooms are short-lived, so
    the cut-over drops them.
  - Images still inflate documents and memory. Inline storage is a known
    risk, tracked by the size logging above, not solved here.
- **Durability beyond the volume:** Fly snapshots volumes daily and keeps
  them 5 days by default. That covers losing the volume. It doesn't cover the
  edits since the last snapshot. Litestream to object storage would, but it
  needs a bucket outside the course setup, so it's out of scope.
- **To check during implementation:** on Hocuspocus `main`, `onChange`
  carries `update: Uint8Array` and the connection's `context`
  (`packages/server/src/types.ts`). Confirm that against the version we pin.
  If it differs, the update log hooks in through the document's own `update`
  event, with the origin mapped to the connection.

## Related decisions, still open

- **What persists and for how long.** Today the whiteboard persists
  indefinitely. Whether people can return to an ended room depends on that,
  and the UI would have to make clear that the board is all that's left.
- **Room list.** Only live rooms you can join, plus rooms you hosted whose
  workspace is still in local OPFS. Never a public directory.
- **Invites.** An invite to a GitHub user lives only as long as the room. It's
  pruned when the room ends, so nobody signs up to a backlog of dead rooms.
  This needs "ended" defined: the host ends it, or the host has been absent
  past a grace period long enough to cover a reload.
