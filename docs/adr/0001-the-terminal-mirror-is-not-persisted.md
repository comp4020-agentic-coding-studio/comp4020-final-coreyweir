# 1. The terminal mirror is not persisted

- Status: accepted (crit 9, week 10)
- Date: 2026-10-12

## Context

Only the host's browser runs Claude Code. Everyone else in the room watches a
read-only mirror of the host's terminal, relayed by the server
(`app/server/terminalRelay.mjs`). When several people share a room, someone
always arrives late, reloads or drops off the wifi. So the question is: what
does the server keep of the terminal, and for how long?

How the mirror works today:

- The host streams output as it happens (`data` events, batched every 16ms).
  Every 3 seconds, if the screen has changed, it also sends a **snapshot**:
  the whole xterm screen plus scrollback, serialised and capped at 512 KB
  (`TerminalPane.tsx`, `claudePod.ts` `snapshot()`).
- The server keeps the latest snapshot, plus up to 1 MB of output since that
  snapshot. Someone who joins late gets both, so they see the current
  terminal, not a blank one.
- All of this lives only in server memory. It's dropped when the last person
  leaves the room, and on a restart or redeploy. Nothing reaches the disk.

The rest of the room's shared state does persist on the server: whiteboard,
staged prompts and queue. The README counts information durability as part of
good. So keeping the terminal off the disk is a deliberate exception, and it
needs a reason.

What a terminal shows: everything Claude Code prints, which includes diffs
and file contents from the host's repo (and the host can connect GitHub with
access to private repos), plus the output of any command Claude runs. A
`cat .env` or a command that echoes a token puts a secret on screen. Claude
does that kind of thing unprompted.

## Options

1. **Memory only, while the room is live** (today's behaviour).
2. **Persist the transcript server-side for as long as the room lasts.** Write
   snapshots or the output stream to the database, and delete them when the
   room ends.
3. **Persist the transcript server-side indefinitely**, alongside the
   whiteboard and prompts, so an ended room can be reopened with its full
   history.

## Decision

Option 1. The server relays the terminal and keeps just enough in memory for
latecomers to catch up. It never writes terminal output to disk.

The line is between **seeing** and **keeping**. Everyone in the room already
sees the terminal live: that's the point of the room, and the host is told so
("Terminal output is shared with everyone in this room"). What this decision
rules out is the server *keeping* a copy after the moment has passed. Once
stored, a secret that flashed on screen for a second can be read by anyone
who later gets into the room. Today that's anyone with the room code, because
the terminal relay doesn't authenticate participants. A stored copy also sits
in Fly's daily volume snapshots, which are kept for 5 days, so deleting it
doesn't make it go away.

The durable record of what happened lives elsewhere, and is safer:

- **What was asked:** the prompts, which persist in the room document, and
  (from crit 10) a server-side log of who sent and released what.
- **What changed:** the host's commits, pushed to the host's own repo.
- **The session itself:** Claude Code's own session files, in the host's
  filesystem. Once the workspace persists to the host's OPFS (planned), a
  host who comes back can resume from their own device. The session stays
  with the person whose session it was.

## Consequences

- **Latecomers and reloads are covered while the room is live.** The
  snapshot plus the output since it gives them the current screen and
  scrollback. Anything older than the 512 KB snapshot is gone, which for a
  terminal is acceptable.
- **An ended room has no terminal history.** Coming back the next day shows
  the board and prompts, not the terminal. If the host is still running, the
  mirror is live again. If the host left, the host's own device has the
  session (after OPFS). The UI should say this, not show an empty terminal
  that looks broken.
- **A redeploy wipes the server's copy.** The host's browser still has the
  terminal and reconnects within ~1.2s. Its next snapshot repopulates the
  relay. **Known gap:** the host skips a snapshot identical to the last one
  it sent, so until the screen next changes, a latecomer sees nothing. The
  fix is to forget the last snapshot when the relay accepts the host again.
  It's small but needs a client rebuild, so it's queued behind the build fix.
- **This limits keeping, not seeing.** Today the host's model token and
  GitHub token are in the guest's environment (`claudePod.ts`: `ANTHROPIC_*`,
  `GITHUB_TOKEN`, `GH_TOKEN`). If Claude runs `env`, both go out live to
  everyone in the room. The fix is planned, and it worked in `nodepod_poc`:
  a proxy for the model API and the GitHub API, so neither token enters the
  guest. The guest gets a placeholder, and the real credential is added
  outside the guest, beyond anything Claude or bash can read. With that in
  place, the two worst secrets can't reach the terminal at all.
- **A tradeoff against the README.** "Information durability" doesn't cover
  the terminal, and CLAUDE.md now says so, so the rule against server-memory
  state doesn't get "fixed" by a future agent.

## The case for the option we didn't pick

The strongest argument for persisting (option 2 or 3) is the person who
missed the session. They come back to an ended room and want to know *why*
Claude did what it did. The prompts say what was asked and the commits say
what changed, but the reasoning in between was only ever on the terminal.

Our answer: that reasoning belongs to the host's Claude session, which the
host keeps. If the room wants a record, the host can export or share the
session deliberately. The server shouldn't keep a copy of everything that
scrolled past by default. If people keep asking for the history, the next
step is an **explicit, host-initiated** save to the room. It wouldn't be on
by default.
