# 6. Who may see and change what, and the log of who did

- Status: accepted, implemented 2026-10-12; amended 2026-10-18 (participants
  don't queue, see "Amendment" below)
- Date: 2026-10-12

## Context

With identity in place (ADR 0005), the server can decide what each person
may do instead of trusting the browser. Today every rule is in the UI: only
the facilitator sees the Queue and Send buttons (`canQueue` in `App.tsx`),
but any client can write any part of the room document. Crit 10 asks for
this decision to be written down with reasons, and for a server-side log of
who did what that outlives the crit.

Hocuspocus can make a connection read-only per document, set in
`onAuthenticate`. A read-only connection's updates are dropped and answered
with a failed sync status (`MessageReceiver` in `@hocuspocus/server` 4.7.0).
It can't permit some keys of a document and refuse others.

## Options

1. **Keep one document and check each update on the server.** Decode it,
   work out which keys it touches, and refuse forbidden ones.
2. **One document per permission boundary.** Each person can write a
   document or can't. Actions that cross a boundary go through the server.
3. **Leave rules in the UI and only log.** The log shows who broke a rule
   after the fact.

## Decision

**2.**

### Roles

- **Members.** `room_members(id, room_id, user_id NULL, secret_hash NULL,
  is_host, name, name_key, joined_at, last_seen, removed_at)`, `STRICT`.
  - `CHECK ((user_id IS NULL) <> (secret_hash IS NULL))`: a member is a
    GitHub user or a guest, never both.
  - The host is the member with `is_host = 1`. A partial unique index (`ON
    room_members(room_id) WHERE is_host`) allows at most one per room.
  - Creating a room inserts the room and its host member in one
    transaction, because the schema can't require a host.
  - `UNIQUE (room_id, name_key)` and `UNIQUE (room_id, user_id)`.
- **Rooms.** `rooms(id, code, keep, locked, state, host_last_seen,
  created_at, ended_at)`.
  - `id` is permanent and random, and names the documents.
  - `code` is the short join code. It can change; `id` never does.
- **The server resolves the role on every connection**, from the session
  cookie or the member secret: host, participant, or nobody. The browser no
  longer claims to be the host. `?host=1` and first-claim capabilities go.

### Who may change what

| What | Where | Host | Participant |
|---|---|---|---|
| Board | `room/<id>/shared` | write | write |
| Staged prompts: write, edit, delete | `room/<id>/shared` | write | write |
| Queue: add, order, Send, remove | `room/<id>/control` | write | read |
| Settings: auto release, keep the board | `room/<id>/control` | write | read |
| Preview state | `room/<id>/control` | write | read |
| Member list (names, GitHub logins, verified) | `room/<id>/control`, written by the server | read | read |
| Terminal: typing into Claude | terminal relay | yes | no (mirror only) |
| Remove a member, rotate the code, lock the room | API, server checks | yes | no |

- **Staged prompts are shared work.** Anyone in the room may edit or delete
  any draft, as in a shared doc. The log shows who did.
- **Staging is how a participant proposes; the host queueing is the
  approval.** Only the host moves a prompt into the queue, and only the queue
  reaches Claude.
- **The member list is written by the server.** So the "verified GitHub
  user" badge can't be faked by typing a name into awareness.
- **A participant who writes `control` anyway** (from the console, say) has
  the update dropped. The denial is logged. Their own copy keeps the forged
  change (Yjs never undoes a local edit), but the server and everyone else
  never see it.

### Who may see what

- **A live room:** its members. Anyone with the code can become a member
  unless the room is locked.
- **The terminal mirror and the preview:** members of the live room only.
  The mirror is never stored (ADR 0001).
- **A kept, ended board:** the host and its members, read-only. This
  settles the question ADR 0003 left open.
- **A not-kept, ended board:** nobody; the server refuses the connection
  (ADR 0003).
- **There is no public list of rooms.**

### Removing someone, and a leaked code

- **Remove.** The host can remove a member. The server sets `removed_at`,
  drops that member's sockets and refuses their credential from then on.
  The host can invite a removed GitHub user back.
- **Rotate the code.** A removed guest could rejoin with the code as a new
  guest. So the host can rotate it: the old code stops resolving, and
  members already in stay connected.
- **Lock the room.** No new joins by code. Members and invited GitHub users
  still get in.
- **A code leaked on a stream:** rotate, remove, lock, then share the new
  code privately.

### The log

- **The table:** `events(seq, at, room_id, member_id, action, detail_json)`.
  - `detail_json` is a flat object of scalars: ids, counts, bytes, setting
    names and values, denial reasons. Never content, because prompts and the
    board can hold secrets.
  - Rows are kept 90 days, swept hourly (ADR 0005).
- **Each event is also printed to stdout as logfmt,** so `flyctl logs` reads
  it directly:

  ```
  [audit] room=K7MQ2P member=3 github=coreyweir role=host action=queue.send prompt=3f2a
  [audit] room=K7MQ2P member=12 guest="Ada" role=participant action=denied what=control.write
  ```
- **Logged actions:**
  - sign-in and sign-out;
  - room create, join, leave and end;
  - queue add, send (host or auto, ADR 0004) and remove;
  - settings changes;
  - member remove, code rotate, lock and unlock;
  - host connect and refusals;
  - every denial.
  - Edits to `shared` are combined per connection and document, about every
    10 seconds (`action=board.edit updates=14 bytes=3100`).
- **Not the log:** `doc_updates.user_id` (ADR 0002). Compaction merges those
  rows, so it can't answer who did what last week.

## Consequences

- **Moving a prompt into the queue crosses documents.** The prompt leaves
  `shared` and appears in `control`. Only the host does it, from its own
  client, which can write both.
- **Two documents per room,** over one socket (a shared
  `HocuspocusProviderWebsocket`). The client's IndexedDB copy, export and
  import (ADR 0003) handle both.
- **Each room keeps one host socket.** A second one from the same host (a
  reload) replaces the first instead of being refused.
- **Specs before the code:**
  - a socket with no credential is refused;
  - a socket from another origin is refused;
  - a participant's write to `control` doesn't survive a reconnect;
  - the host's write does;
  - a removed member is refused;
  - an old code stops resolving after a rotate.
- **Rules for the board itself stay coarse.** Anyone in the room can erase
  anyone's drawing. Finer rules would mean option 1.

## The case for the options we didn't pick

**One document, checked per update.** "Permissions per key, no data model
change, and the queue can stay where it is." Our answer: deciding what a
Yjs update touches means decoding it against the document's state on the
server, for every update, in code we'd own alone. When it's wrong, it's
wrong silently. Read-only connections are Hocuspocus's own, tested
mechanism, and the boundary between `shared` and `control` is the same as
the boundary between "anyone" and "the host".

**Rules in the UI, plus a log.** "This is a room of colleagues. Nobody is
forging Yjs updates from the console; a log is enough to settle disputes."
Our answer: crit groups rotate, codes leak, and one person's forged Send
types into the host's Claude, which can push to the host's repo. A log
tells you afterwards. The server refusing it means it never happens.

## Implementation (2026-10-12)

`389ffff` (server), `4acb32b` (client), `f78b367` (removal behind fly's
proxy). `rooms.resolve()` turns a guest secret or the session cookie into a
role for every document, relay hello and API call; Hocuspocus marks the
control document read-only for anyone but the host; both relays take the
same credential, and a second host socket replaces the first. Where it
differs from the plan, or stops short:

- **The Queue button is the host's only.** Queueing copies the prompt's
  text into `control` and deletes it from `shared`. (The plan also had
  participants proposing to the queue; that was dropped, see "Amendment".)
- **The control document also carries the room's code and lock state**,
  written by the server beside the member list, so a rotated code reaches
  every member at once.
- **Removal is told, not only enforced.** fly's proxy held a browser's side
  of a socket the server had closed open for seconds (through nginx alone it
  closed at once). The server now sends each of the member's documents a
  Hocuspocus PermissionDenied before hanging up, and drops the connection
  500 ms after the close frame. Live, a removed browser is shut out in about
  20 ms instead of 3 s.
- **The preview's HTTP side is gated by a per-member key** (decided and
  built 18 Oct). `/room-preview/<room id>/…` is loaded by an iframe, which
  can't send a guest's secret. The room id alone wasn't enough protection:
  `GET /api/rooms/by-code/:code` gives it to anyone with the code, joined
  or not (even in a locked room), and a removed member keeps it. Options:
  - **A key in the path (chosen):** `/room-preview/<room id>/<key>/<generation>/…`,
    where the key is `<member id>.<MAC>`, an HMAC over the room and member
    from `SESSION_SECRET`. The create, join and `me` responses carry it.
    Every request checks the MAC, then the member like any other
    credential, so removal or the room ending turns it away from the next
    request. Nothing is stored. The relay already rewrites root-relative URLs
    under the prefix, so the page's own requests carry the key. A bad key
    is refused (403) before the relay even looks for a preview.
  - **A cookie scoped to the preview path:** tidier URLs, but the
    participant's iframe is sandboxed into an opaque origin, where cookies
    can't be relied on. Worth measuring if A ever chafes.
  - **Stop giving the room id to people who haven't joined:** simple, but a
    removed member still has it.

  Cost: the key sits in the URL. Relayed responses already send
  `Referrer-Policy: no-referrer`, but a Claude-written page can set its
  own policy. Since a key names its member and dies with their removal, a
  leaked one is traceable and revocable. This is a stop-gap: serving the
  preview from a separate origin (still open, with the host's unsandboxed
  preview) would change how the preview is reached anyway.
  Checked by `spec/permissions.test.ts` ("serves the preview only to
  members, by their own key"). Mutations that turn it red: removed members'
  keys still resolving, and skipping the MAC check. Also checked by
  `preview-participant-browser-smoke.mjs` on dev and live: a pod's dev
  server reaches a sandboxed participant iframe through the key, page,
  stylesheet, script and a module's import included.
- **What the log records so far:** room create and join, code rotate,
  lock and unlock, member removal, sign-in and sign-out, each member's
  connect and disconnect (first socket opened, last one closed), staged
  prompts and queued prompts added and deleted (by id, with who: anyone
  may delete a staged prompt, so the log has to say who did), edits to each
  document (one line per person, document and 10 s, `updates=N bytes=B`),
  and every refusal with its reason (cross-origin socket or API call, not a
  member, a document that isn't a room's, a read-only write, host-only
  actions, a participant claiming the terminal or the preview, a bad
  sign-in state; repeated refusals are combined the same way, `times=N`).
  Queueing a prompt shows as `queue.add` then `prompt.delete` with the same
  id. Lines name the room by its current code, even for a socket that
  connected before a rotation. Since 18 Oct, Load takes the prompt out of
  the queue and is logged as `queue.send`, removing it as `queue.delete`:
  Load names the prompt in the control document's `roomState.lastSent` in
  the same transaction as the delete. That is the host's own claim, since
  the terminal runs in the host's browser. Ending (ADR 0003) comes with
  that feature, and automatic release (ADR 0004) will log the same way.
- **Checked:** `spec/permissions.test.ts`, 14 checks against the live app,
  including the relays. Mutations that turn them red, one at a time:
  control writable by everyone, no Origin check, removed members still
  resolving, the relays treating anyone as host. The log was read in
  `flyctl logs` after a spec run and a two-browser run. Since 18 Oct,
  `npm run test:audit-log` (in `app/`) reads the `events` table back after a
  host and a guest stage, queue, send and remove prompts, which the spec/
  checks can't do against a deployed app.


## Amendment (2026-10-18): participants don't queue

The table had a row letting participants propose a prompt for the queue: a
stateless message the server checks and applies. It was never built, and it
won't be. All the server could check is that the sender is a member, so a
"proposal" would really be a participant queueing their own prompt. With
ADR 0004's automatic release, that means a participant's text is typed into
the host's Claude with nobody approving it, which is the thing making
`control` host-only was for. The host's browser holds the model key, the
GitHub token and the Claude session, so the host decides what reaches it.

The approval flow already exists: staging a prompt is the proposal, the
host's Queue is the approval, Send is the release. The log names both
people (`prompt.add` by the participant, `queue.add` by the host, same id).
A separate "proposed" list would duplicate the staged prompts.

The case against: the host becomes a bottleneck in a busy room. Our answer:
that's the cost of the host keeping control, and a host who trusts the room
can queue quickly; a setting that lets everyone queue could come later as
the host's explicit choice.
