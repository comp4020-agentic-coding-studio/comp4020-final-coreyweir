# 3. Room lifecycle and board retention

- Status: accepted; lifecycle, keeping and End room implemented 2026-10-18;
  pruning and the size cap decided and implemented 2026-10-18; local copies,
  export and import decided and implemented 2026-10-19 (amendments below)
- Date: 2026-10-12

## Context

A room is only fully alive while its host is there. Claude Code runs in the
host's browser, and so does the dev server behind the preview. When the host
leaves, both are gone. The whiteboard and the prompts are all that's left.
Today nothing marks that change: the room just goes quiet, and its board is
kept forever, on the server and in every visitor's browser.

Four things meet here:

- **The brief.** "The marker comes back the next day. Your machine stops when
  nobody is using it, so by then it has restarted, and what both people did
  has to still be there." It also leaves expiry to us: "What persists forever
  and what expires?"
- **Privacy.** A board can hold screenshots and notes people wouldn't want
  kept, and the people who drew on it aren't always the person deciding.
- **Fixed infrastructure.** One 1 GB volume (908 MB free) and 256 MB of RAM.
  We can't scale, so we can't promise to keep anything for a set time.
  Disk costs little. A board is kilobytes of text, plus about 0.3–1.3 MB per
  pasted image (ADR 0002). Memory is the tighter limit.
- **The copies in visitors' browsers.** `room.ts:80` keeps every room in
  every visitor's IndexedDB (`y-indexeddb`), stored under the room code, with
  no expiry. That's useful: it's long-term storage that costs the server
  nothing. The danger is that Yjs pushes a local copy back to the server when
  the visitor reconnects. A board the server let go would come back. And if
  a room code were ever reused, an old copy would merge into someone else's
  live room.

## Options

- **A. Always keep boards** (with pruning). Simplest, and passes the brief.
  But nobody chooses it, and people drawing on a board may not expect it to
  outlive the room.
- **B. Keep boards only if the host opts in.** Most private. But the default
  room vanishes, so the marker who comes back the next day finds nothing they
  did.
- **C. The host chooses when creating the room, with "keep" pre-selected.**
  Everyone who joins is told which it is.

## Decision

**C.** It's a choice the host makes when creating the room, with keeping as
the default. Everyone who joins can see that choice before they draw anything.

### Lifecycle

1. **Live:** the host is connected.
2. **Host away:** the host's connection has gone. Everyone sees a banner:
   *"The host has left. Claude and the preview have stopped; the whiteboard
   still works. This room ends in 4:32 unless they come back."* If the host
   returns within **5 minutes**, the room is live again.
3. **Ended:** the grace period ran out, or the host clicked "End room".
   Invites are deleted and the room leaves the live list. From then on the
   server accepts no more changes to the room. Only the host can revive it.
   What happens next depends on the host's choice:
   - **Kept:** the server keeps the board and serves it on read-only
     connections. The banner reads: *"This room has ended. The board is kept
     while space allows. Export it to keep your own copy."* It never
     promises a date.
   - **Not kept:** the server deletes its copy and refuses connections to
     the room. The banner reads: *"This room has ended. The server doesn't
     keep this board. You can still export your own copy."* It says "the
     server" because people's local copies (below) still exist.

"Host away" doesn't need to know *who* the host is, only that the host's
connection is gone. The relays already tell the host's connection apart,
using a capability token kept in the host's browser (`terminalRelay.mjs`).
What has to change is that the timer survives a restart. The room's state
and the time the host was last seen go into SQLite (ADR 0002). After a
restart, a host that doesn't reconnect counts as away from when the server
started.

Knowing who the host is still matters for the room list. "Rooms you hosted"
has to know whether *this* browser still holds that room's workspace in
OPFS. Minting the capability when the room is created, instead of letting
the first connection claim it, belongs to crit 10's permissions work.

The host can switch from keeping to not keeping at any time. They can't
switch the other way once someone else has joined, because those people drew
on the understanding that the server wouldn't keep the board.

### Pruning

Kept boards stay until storage needs the space. When volume use passes a
threshold, the boards opened longest ago are deleted first. Each room also
gets a size cap, which the server enforces, because one image-heavy room is
a memory risk on this machine. The UI never shows a retention date, because
we can't keep one.

### Local copies

- **Everyone keeps their copy**, host and visitors alike. That's how a board
  outlives the server's pruning without costing the server anything. The
  copies are visible and deletable: "Rooms you hosted" and "Boards you've
  been in". They're never silent, which matters on shared lab machines.
- **Local copies are filed under a permanent room id**, unique forever and
  separate from the short code people type in. That way a reused code can
  never merge an old board into a new room.
- **A local copy never goes back to an ended room.** The server refuses
  changes, as above. The one exception is the host reviving their own room:
  if the host reopens it, the host's copy can restore it, which raises no new
  privacy question.

### Export and import

- **Export** is open to anyone in the room. It produces one file: the
  quickdraw snapshot (JSON, images included as they are), the prompts, and
  the room's name and export date. A PNG of the board can be exported
  alongside it. The file is the "no lock-in" answer, and it saves the
  prompts if the host disconnects.
- **Import** into a new room is something the host chooses to do, never
  automatic. That covers handing a board to tomorrow's host. Only known
  record types and fields are copied, so nothing like `__proto__` gets
  through.
- **Images are imported as they are, not re-encoded.** A board exported and
  imported at the end of each day would otherwise lose image quality every
  time, and screenshots would get steadily harder to read.
- **This adds no new risk.** The normal path doesn't check anything on the
  server either: anyone with the room code can write any Yjs update. The
  server's size cap and safe drawing in the client are the real defences,
  and they're needed regardless.
- **If time allows,** a basic check that each image is what it claims to be:
  it decodes, its bytes match its declared type (PNG, JPEG, WebP or GIF; no
  SVG), and it's within quickdraw's 2048px limit.

### Claude session transcripts

The host can also export and import Claude session transcripts. Both carry
warnings, because:

- an export can contain secrets from the host's session;
- an imported transcript becomes Claude's own history, in a session that
  skips permission prompts and works in the host's repo. So: import only
  from people you trust.

## Consequences

- **The brief.** With the default left alone, a board is still there the next
  day. At this course's scale, pruning won't start within a day, but that's
  a claim about load, not a guarantee. A host who unticks "keep" opts their
  room out of the brief's persistence on purpose. The other people in that
  room are told before they draw.
- **Consistent with ADR 0001.** The board is what people chose to make. The
  terminal is whatever scrolled past. Keeping the first, but not the second,
  is the same line drawn from the other side.
- **"Not kept" is a promise about the server, not about people.** Anyone in
  the room could export the board or screenshot it anyway. The wording
  says exactly that and no more.
- **What's new to build:**
  - room records with state, the host's last-seen time, and a permanent id
    beside the join code;
  - a grace timer that survives restarts;
  - read-only connections for kept ended rooms, refused ones for not-kept;
  - pruning and a per-room size cap;
  - local-copy lists;
  - two banners;
  - export, and import with checks.
- **Phone hosts.** Android suspends background tabs. A host who switches apps
  for more than 5 minutes ends their room. Test on the Pixel before settling
  on 5 minutes.

## The case for the options we didn't pick

**B (opt in).** "The default should be the private one: people shouldn't have
to know to untick a box." Our answer: everyone sees the choice before they
contribute, the host can turn keeping off at any time, and the brief makes
next-day persistence a requirement, not a feature.

**A (always keep).** "A choice nobody understands is worse than none." Our
answer: hosts run rooms for very different groups, and README's "not too
opinionated" says to make that a setting.

## Not decided here

- Who can view a kept, ended board: anyone with the room code, or only the
  people who were in it. That's crit 10's permissions question. (Settled in
  ADR 0006: the host and the room's members, read-only. The code stops
  resolving once a room ends.)

## Implementation (2026-10-18)

Built with ADR 0008's room states (`a0bee0f`, `ef1401f`): the state and the
host's last-seen time in SQLite, the grace timer, and after a restart live
rooms counting as away from then. This part adds keeping and ending.

- **Server** (`7928bac`, `d9a7766`). `rooms.keep` is set at creation
  (`POST /api/rooms {keep}`, default true) and changed with
  `POST /api/rooms/:id/keep`: host only, and `409 others_joined` when
  switching back to keeping after anyone else has ever been a member,
  removed members included. Ending (`POST /api/rooms/:id/end`, or the grace
  running out) deletes invites, then:
  - kept: every connection to the room's documents turns read-only,
    the host's too, so the host's still-open page can't write either;
  - not kept: the server tells each non-host socket in-band
    (`PermissionDenied`, reason `room-ended`) and hangs up, deletes the
    room's rows from `doc_updates`, and refuses the documents from then on.
  The terminal relay tells participants `room-ended` and hangs up. The log
  records `room.create board=kept|not_kept`, `room.keep`, `room.end
  reason=host|host_away board=kept|deleted invites_dropped=N`, and denials
  with the member's name.
- **Reviving.** The host opening an ended room (its documents or
  `GET /api/rooms/:id/me`) revives it, as decided. For a not-kept room the
  server starts empty; the host's own browser copy (IndexedDB) then syncs
  back into it, the exception "Local copies" allows. That last step is by
  design but **not measured in a browser** yet.
- **Client** (`8066106`). The host form has "Keep the board after the room
  ends", ticked by default. A share link's join form says what happens to
  the board before anyone joins, and inside the room the top bar (desktop)
  and the People panel say it. The People panel gives the host the switch
  and "End room", which asks first and says what happens to the board. The
  host's page then leaves for the start page at once (`?ended=CODE`),
  because its reconnecting would revive the room.
- **Wording that changed from the Decision.** The away banner says *"The
  host isn't connected, so there's no Claude or preview for now. The
  whiteboard still works. If they don't come back, the room ends in 4:32."*:
  "isn't connected", because the server only knows the connection went. The
  ended banners don't mention export until export exists. A not-kept ended
  room is a closed page, not a banner, because the server refuses it.
- **Read-only, in the page.** In a kept ended room the whiteboard is
  quickdraw's `readonly` (no toolbar), staging has no form and its cards
  are read-only. The server refuses writes anyway; this is so the page
  doesn't offer what would be refused. A participant's terminal stops
  reconnecting on `room-ended` and starts again if the host revives the
  room.

Checked:

- `spec/rooms.test.ts` (live): keeping and its 409, a not-kept board deleted
  and its guest let go, the host's open socket refused after ending, the
  room's state and `endsAt` inside the room, the terminal relay's
  `room-ended`. It can't tell an in-band notice from a refused reconnect
  (a mutation that skipped telling members stayed green).
- `npm run test:rooms`: the grace period ending a kept and a not-kept room,
  rows deleted only for the latter, the log, and the relay's denial naming
  the member.
- `npm run test:lifecycle-browser`, dev and live, 1920×1080 and 390×844:
  the form's default, the join form's notice, the away banner's countdown
  and its clearing when the host returns, End room's confirmation, the kept
  board read-only after a reload, the keep switch refused after a join, and
  the not-kept room closed after a reload. The five-minute grace is too long
  to wait for in a browser; `test:rooms` shortens it.

Not built: pruning and the size cap (their numbers aren't decided), local
copy lists, export and import.

## Amendment (2026-10-18): pruning and the size cap

The Decision above left the numbers open. We proposed a 16 MB cap per room
as a hypothesis, to be measured before settling. It failed: on the live
machine (256 MB, of which the kernel leaves 212 MB; node idles at 70 MB),
writing a 16 MB board got node killed for running out of memory after about
10 MB. The client reconnected and the server, loading the same board back
from SQLite, was killed again, and again, until the grace period ended the
room. (It was a not-kept test room, so ending it deleted the board.) Peak
memory of node, after a fresh restart, for one board written in 1 MB images
and loaded back:

| Board | Peak |
| --- | --- |
| 2 MB | 110 MB |
| 4 MB | 127 MB |
| 8 MB | 132 MB |
| 16 MB | killed |

Growth isn't linear (garbage collection decides), and several big rooms
open at once weren't measured. The finding is that board size is a way
for any member to take the server down, today, not only a storage question.

### Decided

- **A room holds at most 4 MB** (its two documents' stored bytes, after
  compaction). That's several screenshots, not dozens.
- **The cap is hard, and a full room is read-only for everyone**, the host
  included. The update that would take a room past 4 MB is refused, and the
  room is marked full (`rooms.full_at`, so it stays full after a restart).
  Refusing just that one update isn't an option: the sender's copy would
  then hold something the server doesn't, and their later changes would
  build on it. Members see "This board is full. Export it and start a new
  room." Staged prompts live in the same document, so they stop too; the
  host's terminal doesn't.
- **One websocket message is at most 8 MB** (it was `ws`'s default,
  100 MB). Bigger closes the socket.
- **The client refuses an image that wouldn't fit** before it reaches the
  board, and says why. The server's refusal is the backstop, not the
  experience: a client whose change was refused keeps resending it on
  every reconnect.
- **Pruning** runs at startup and hourly. The disk counts as used by what
  the filesystem reports used, less the free pages inside SQLite's file
  (deleting rows frees pages for reuse; the file doesn't shrink). Above 70%
  of the volume, ended kept rooms are pruned, least recently opened first,
  until below 60%. Live and away rooms are never pruned. Opening a room
  (any member's socket) sets `rooms.last_opened`.
- **A pruned room** loses its stored board and pending invites; its row,
  members and log stay, marked `pruned_at`. From then on it behaves like an
  ended room whose board wasn't kept: members are told "The server deleted
  this board to make space", and a host who comes back revives it from
  their own copy.

### Next: images out of the board document

Option C, chosen to follow, and to be built with export, which has to
package images anyway: the browser uploads each image once, the server
stores it on the volume, and the board holds a reference. Server memory per
room is then strokes and text, and the cap becomes a disk limit. Until then,
4 MB is the price of keeping images inline (ADR 0002).

### The case for the options we didn't pick

**A bigger machine** (512 MB, an 8 MB cap): costs more each month and only
moves the limit; the next person who pastes enough images finds it again.
**Images out of the document straight away**: the right end state, but a
bigger change than closing the crash, which can't wait.

### Implementation of the amendment (2026-10-18)

Spec first (`3e54ceb`, fixed in `b3df0f2`), then the server (`f512b5a`) and
the client (`7d27daa`).

- **Counting.** The server counts a room's stored bytes per document: the
  snapshot plus updates since, in memory while a document is loaded, from
  SQLite otherwise. Before accepting a sync or update message for a room's
  document (Hocuspocus's `beforeSync`, which it awaits before checking the
  connection is read-only), it adds the message's size. Over the limit, it
  compacts the room's open documents first, so edits since undone don't
  count, and only then refuses. Refusing marks the connection read-only for
  that message, sets `rooms.full_at`, logs `room.full` with both sizes, and
  turns every connection to the room read-only.
- **One rule for read-only.** `riff.mjs` decides every connection's access
  with one function: full, ended, or a participant on the control document.
  Ending, reviving and filling a room all reapply it to open connections.
- **Pruning** follows the decision. A pruned room's members are turned away
  with the reason `board-pruned`; its log line is `room.prune` with the
  bytes freed.
- **The page.** Its check counts both documents as it has them
  (`Y.encodeStateAsUpdate`), which is about what the server stores. A
  pasted or dropped image that would cross the limit is taken back off the
  board and out of the undo history, and the page says how big it was and
  how much room is left. The People panel shows how much the room holds.
- **Deviations.** The banner says "This board is full (4 MB), so nothing
  more can be added to it, the prompts or the queue. Claude and the
  terminal still work. To keep going together, start a new room." It
  doesn't say "Export it" because export isn't built; it will when it is.
  A full room's control document is read-only for the host too, so the
  queue stops (Load and remove are hidden: Load would leave the prompt
  queued for everyone else), and so does the preview's live flag: a host
  who starts a dev server after the room filled has a working preview
  relay, but participants aren't told it's live. That follows from "read-only
  for everyone"; we accepted it rather than carve out the control document.
- **Checked.** `spec/limits.test.ts` (live): accepted writes stay under 4 MB,
  the write that crosses is refused, the room is full for host and guest,
  control writes stop, a 9 MB message closes with 1009 and stores nothing.
  `npm run test:rooms`: undone edits don't count, full survives a restart,
  pruning order, a pruned room refused then revived by its host.
  `npm run test:limits-browser` (dev and live, both viewports): an image
  that fits reaches the room; one that doesn't is turned away with the
  message and the room stays writable; a crossing write turns both pages
  read-only, still after a reload. On live, node peaked at 127 MB while
  that smoke filled rooms to the limit (`/proc` `VmHWM`), the same as the
  4 MB measurement above.
- **Not checked.** The page's check only knows what has reached it: an
  image pasted before someone else's large change arrives can still cross
  the limit, and the server then fills the room (the smoke waits for the
  People panel's count for this reason). Pruning has only run against a
  stand-in for the disk; the volume is at 7%.

## Amendment (2026-10-19): local copies, export and import

The Decision above settled what local copies, export and import are for.
Building them raised five questions, settled on 19 October.

What was already there: every browser that opens a room keeps that room's
shared document (the board and the staged prompts) in IndexedDB, filed
under the permanent room id (`app/src/room.ts`). Nothing listed those
copies, nothing deleted them, and nothing recorded which room they were. So
on a shared lab machine they were silent, which the Decision rules out. The
queue lives in the control document, which isn't copied.

### Decided

- **One list, not two.** The landing page already has "Your rooms" (live
  rooms, ADR 0008). Local copies go in a single "Boards on this browser"
  list below it, each marked hosted or joined, with Open, Export and
  Delete. That replaces "Rooms you hosted" and "Boards you've been in".
  The list also shows copies made before this list existed, found by their
  IndexedDB name, so none stays silent.
- **This browser records each room when it opens it:** the id, the code,
  whether it hosted, the host's name, and when it first and last opened it.
  That's what the list shows; the copy itself is unchanged.
- **Open** goes into the room if it's in "Your rooms". Otherwise (ended,
  pruned, or this browser is no longer a member) it shows the copy
  read-only, from IndexedDB alone, with no connection to the server, and
  says it's this browser's copy and when it was last opened.
- **Delete removes the copy and this browser's membership** of the room:
  nothing of the room is left on the machine. A live room can be joined
  again by its code; a member who joined with a GitHub account stays a
  member through the account.
- **Signing out offers to delete** the copies too ("Also delete the N
  boards on this browser?"). Guests have no sign-out, so the list has
  "Delete all".
- **Export** is one JSON file, `riff-<code>-<date>.json`: a format name and
  version, the export date, the room code, the board (quickdraw's records,
  images as they are), the staged prompts, and the queue as everyone in the
  room sees it. Participants can already read the queue, so including it
  shows nothing new. Exporting from the list (a copy, not the room) has no
  queue to include. The code is there as the room's name; a code only
  joins a live, unlocked room, and the host can rotate it.
- **Import is only into a new room**, an optional file in the host form.
  Nothing overwrites or adds to a board people are already in. The file is
  checked before the room is created: it must fit in a room (4 MB), and
  only known record types and fields are copied (quickdraw's shapes and
  image assets, and prompt author and text). The queue comes in as staged
  prompts, so nothing is sent before the new host queues it. Images are
  copied byte for byte.
- **The full banner** says "Export it" from now on.

### The case for the options we didn't pick

**Two lists** match the Decision's wording, but with "Your rooms" above
they'd make three lists of rooms on one page, and most rooms would be in
two of them. **Deleting only the copy** would leave a room secret behind,
and the copy would quietly come back the next time the room was opened.
**Leaving copies at sign-out** keeps them for whoever uses the machine next;
**always deleting** would surprise someone on their own laptop. **Import
into a live room** is handy for a host who forgot to import at the start,
but it would put a file's contents in front of people mid-session without
them choosing it. **Leaving the queue out** would lose the prompts the host
had already approved.

## Implementation of the second amendment (2026-10-19)

Built in `4e17a8f` (the board file) and `65ba779` (the client). No server
change: everything here happens in the browser, and the server's 4 MB cap
stays the backstop.

- **The file** (`app/src/boardFile.ts`): format `riff-board`, version 1.
  Reading one back copies only quickdraw's shape types and their known
  props, and image assets that are PNG, JPEG, WebP or GIF data URLs whose
  first bytes match the type, at most 2048px a side. The browser then
  decodes each image and drops any that won't open. Anything left out is
  counted and named before the room is created ("Left out: 1 image that
  isn't PNG, JPEG, WebP or GIF"), so the "if time allows" image checks
  were built too. A file over 8 MB, or a board over 4 MB less 64 KB, is
  refused at the form.
- **Starting a room from a file** creates the room, writes the board and
  prompts into this browser's copy of it, reads the copy back to check it,
  then opens the room, which syncs the copy to the server. The server
  doesn't read the file: it trusts the content as much as it trusts
  anyone drawing, and counts it against the cap like any other write.
- **The list** (`app/src/copies.ts`): this browser notes each room it opens
  in localStorage (`riff-boards`); the list is every note whose IndexedDB
  copy still exists, plus copies with no note, found by name. "Delete all"
  shows for anyone with two or more copies, not only guests: a signed-in
  person on a shared machine needs it as much.
- **A copy deleted while its room is open in another tab** closes that
  tab's IndexedDB connection (`versionchange`). Without it the tab's next
  edit threw `InvalidStateError`; the room carries on through the server.
- **Wording:** sign-out asks "This browser has a copy of 1 board you've
  been in. Delete it too?"; the ended and full banners and the People
  panel offer "Export".

**Checked:** `npm run test:board-file` (round trip, hostile fields,
image rules; two mutations turn it red); `npm run test:boards-browser` on
dev and live at both sizes (export, Open into the room, the read-only copy
after the room ends, Delete leaving nothing, a too-big file refused, an
SVG left out, a guest in the new room exporting the same images byte for
byte and the same shape ids); `npm run test:rooms-browser` (sign-out
deleting copies, and the other tab carrying on).

**Not built:** the workspace export (it waits for the OPFS workspace) and
transcripts. **Not checked:** a browser other than Chrome.
