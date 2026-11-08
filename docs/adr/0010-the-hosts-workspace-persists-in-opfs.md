# 10. The host's workspace persists in this browser (OPFS), and the repository is cloned at boot

- Status: accepted
- Date: 2026-11-08

## Context

README, Resilience: "The filesystem Claude works in must be persisted
locally, not just in memory, so that a browser crash/accidental
reload/etc. don't result in unpushed changes being lost." Today it is only
in memory. The pod's filesystem is Nodepod's `MemoryVolume`; once the
WASIX session starts, the volume moves into the shared store
(`riff-sharedfs`: one filesystem laid out in a shared `WebAssembly.Memory`)
that bash, git, Claude's tools and Nodepod's workers all address. A reload
drops it: the repository, uncommitted edits, commits not yet pushed,
installed packages, and Claude's own transcripts.

The host form also asks for a "Git repository" and never uses it to
clone (PLAN P2). Claude has to be told to clone, every session.

What is already there:

- Nodepod's OPFS support is a cache of installed packages
  (`nodepod-package-packs-v1`), not the workspace.
- The shared store keeps a ring of every mutation, built for any number
  of readers, each at its own position, none of which can block a writer
  (`riff-sharedfs/src/events.rs`). Nodepod's volume reads it and reports
  each change, whoever made it, through `volume.onGlobalChange(path,
  event)`. Before the store is attached, the same call reports the
  JavaScript volume's own changes, including the workers' writes synced
  back.
- Nodepod's `git clone` is its own (GitHub's REST API, one request per
  file) and needs a token. It runs in the pod, so the push token reaches
  it as a placeholder and `riff-sw.js` swaps it in (ADR 0007), as for
  pushing.

## Options

**Where the copy is made.**

1. **Inside the Rust store**, writing to OPFS as part of each write. Not
   possible as it stands: the browser's main thread writes to the store,
   and synchronous OPFS access (`createSyncAccessHandle`) exists only in
   workers. The store's lock is also only sound because critical sections
   touch memory and nothing else (`lock.rs`); I/O inside one could stall
   the main thread, which spins for the lock.
2. **Behind the store, from its change ring**: restore into the volume at
   boot, then follow the ring and write each changed file to OPFS shortly
   after, without the writer waiting. This is still the filesystem layer
   (every writer is seen, whatever runtime it is in), needs no fork
   change, and loses at most the last moment of changes in a crash.
3. Nodepod's `snapshot()` of the whole tree into one file, on a timer.
   Every save rewrites everything.

**What is persisted.** The repository only; the repository and Claude's
transcripts; or everything the host and Claude work in.

**Keyed by what.** The repository (one workspace per repo); or the room.

**A second tab** with the same workspace: refuse; take it over; or an
unsaved scratch workspace.

## Decision

- **Option 2.** `app/src/workspace.ts` keeps one OPFS directory per
  workspace: each file's bytes in its own OPFS file, and a manifest (path,
  kind, mode, size, mtime, symlink target) written last. A manifest is
  replaced in one step (`createWritable` commits on close), so what's on
  disk is always some complete save: a crash mid-save leaves the previous
  one, never half of a `git commit`. Writes are not waited on.
- **Saved: everything under `/work` and `/home/user`**, including `.git`,
  `node_modules` and Claude's transcripts (`/resume` works after a
  reload). **Not saved:** what the boot writes fresh every time, because
  a stale copy could fight an upgrade: the Claude bundle (`/opt/claude`),
  Riff's `.wasix-session` (bash's tools), Claude's settings and
  `.claude.json`; and everything outside those two directories (`/tmp`,
  Nodepod's caches). The UI says what is saved and what isn't, so a
  script left in `/tmp` isn't a surprise.
- **Keyed by the room's permanent id.** Nobody expects a new room on the
  same repository to bring back an old filesystem. A room revived later
  on the same browser gets its workspace back.
- **Boot:** a workspace that exists is restored and **not** re-cloned or
  pulled (that would overwrite unpushed work). One that doesn't, for a
  room with a repository and a push token, is cloned into `/work/repo`
  before Claude starts, with the clone's output in the terminal, so the
  room sees it. Without a token there's no clone (Nodepod's git needs
  one) and the terminal says so. Since 8 Nov a clone only goes into an
  empty `/work/repo`: a workspace imported from an export (ADR 0003,
  "Import") brings its own repository, and the room's is left alone.
- **A second tab** of the same room (the host duplicating the tab) asks
  before taking the workspace over, through a Web Lock per room. The
  first tab stops saving and says so. A reload never asks: the old page's
  lock goes with it. The server already lets the newest host socket take
  over the room; this is the same rule for the workspace.
- **Listed and deleted** with the room's row in "Boards on this browser":
  a "Files" marker with how many, their size and when they were last
  saved, and "Delete files" (the list calls the workspace the host's
  files, and says what is and isn't saved). The row's Delete removes the
  workspace too, since Delete leaves nothing of the room on the machine
  (ADR 0003), and signing out offers to delete both. A workspace whose
  board copy the browser cleared gets a row of its own, so none is kept
  silently. The planned signed-in page shows the
  same marker on each room. Export is the workspace zip (P2, built
  alongside); since 8 Nov the row has "Export files" beside "Export
  board", which zips the saved workspace without booting it (ADR 0003,
  "Export files from the landing page").
- Only the host's browser has a workspace. Nothing about it reaches the
  server, the room, or other members.

## Consequences

- A reload or crash loses at most the last moment of changes, not the
  session. Unpushed commits survive.
- The boot rewrites what isn't saved, as today. Files a session left
  outside `/work` and `/home/user` are gone after a reload.
- A workspace holds the repository's code, and possibly a private
  repository's, in this browser profile until it's deleted. On a shared
  machine that's the same exposure as the board copies, and has the same
  answer: the list, Delete, and the offer at sign-out.
- Restoring reads the whole workspace into memory, as the pod holds it
  anyway. `node_modules` is most of the files; the cost of saving and
  restoring it is measured below.

## Checks

- A browser smoke: boot, write a file and commit it, reload, boot, and
  read both back from bash and git; a second tab is asked; Delete leaves
  nothing in OPFS.
- Nothing is server-visible, so no `spec/` check.
