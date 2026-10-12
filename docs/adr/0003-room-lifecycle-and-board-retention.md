# 3. Room lifecycle and board retention

- Status: accepted, not yet implemented (week 10, planning phase)
- Date: 2026-10-12

## Context

A room is only fully alive while its host is there. Claude Code runs in the
host's browser, and so does the dev server behind the preview. When the host
leaves, both are gone. The whiteboard and the prompts are all that's left.
Today nothing marks that change: the room just goes quiet, and its board is
kept forever, on the server and in every visitor's browser.

Three things meet here:

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

There's also a hidden copy. `room.ts:80` keeps every room in every visitor's
IndexedDB (`y-indexeddb`), with no expiry. When a visitor reconnects, Yjs
pushes that copy back to the server. A board the server deleted would come
back the next time anyone who had it opened the room.

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
   Invites are deleted and the room leaves the live list. What happens next
   depends on the host's choice:
   - **Kept:** the board stays on the server, read-only. The banner reads:
     *"This room has ended. The board is kept while space allows. Export
     it to keep your own copy."* It never promises a date.
   - **Not kept:** the server deletes the board and refuses connections to
     that room. Refusing matters: without it, a visitor's local copy would
     bring the board back. The banner reads: *"This room has ended and its
     board has been deleted."*

"Host away" doesn't need to know *who* the host is, only that the host's
connection is gone. The relays already tell the host's connection apart,
using a capability token kept in the host's browser (`terminalRelay.mjs`).
What has to change is that the timer survives a restart. The room's state
and the time the host was last seen go into SQLite (ADR 0002). After a
restart, a host that doesn't reconnect counts as away from when the server
started. Minting the capability when the room is created, instead of letting
the first connection claim it, belongs to crit 10's permissions work.

The host can switch from keeping to not keeping at any time. They can't
switch the other way once someone else has joined, because those people drew
on the understanding that the board would be deleted.

### Pruning

Kept boards stay until storage needs the space. When volume use passes a
threshold, the boards opened longest ago are deleted first. Each room also
gets a size cap, which the server enforces, because one image-heavy room is
a memory risk on this machine. The UI never shows a retention date, because
we can't keep one.

### Local copies, export and import

- **The host's copy** of each board they hosted stays in their browser, and
  they can delete it. If the host reopens the same room and the server has no
  board (pruned, or not kept), the host's copy restores it automatically.
  Restoring a room for the same people raises no new privacy question.
- **Visitors' copies** are cleared when a room ends. A kept board is served
  from the server, and a deleted one must stay deleted.
- **Export** is open to anyone in the room. It produces one file: the
  quickdraw snapshot (JSON, images included), the prompts, and the room's
  name and export date. A PNG of the board can be exported alongside it.
- **Import** into a new room is something the host chooses to do, never
  automatic. That covers handing a board to tomorrow's host. Everything in an
  imported file is treated as untrusted:
  - only known record types and fields are copied (nothing like `__proto__`
    gets through);
  - images must be `data:image/png`, `jpeg`, `webp` or `gif` (no SVG);
  - the same size cap as a live room applies.

  The checks on import are for convenience. The server's size cap is what
  actually enforces the limit.

## Consequences

- **The brief.** With the default left alone, a board is still there the next
  day. At this course's scale, pruning won't start within a day, but that's
  a claim about load, not a guarantee. A host who unticks "keep" opts their
  room out of the brief's persistence on purpose. The other people in that
  room are told before they draw.
- **Consistent with ADR 0001.** The board is what people chose to make. The
  terminal is whatever scrolled past. Keeping the first, but not the second,
  is the same line drawn from the other side.
- **Leaving no room behind.** A visitor's copy is wiped when the room ends.
  Anyone who wants a board keeps it by exporting.
- **What's new to build:** room records with state and when the host was
  last seen, a grace timer that survives restarts, refusing connections to
  ended rooms, pruning, a size cap, two banners, export, and import with
  checks.
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
  people who were in it. That's crit 10's permissions question.
- Importing a Claude session transcript. That's about the host's workspace,
  not the room, and it carries a risk the board doesn't: a transcript becomes
  Claude's own history, in a session with the host's GitHub token. It needs
  its own decision.
