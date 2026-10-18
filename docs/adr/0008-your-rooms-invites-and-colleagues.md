# 8. Your rooms, invites by GitHub username, and colleagues

- Status: accepted, implemented 2026-10-18 (see Implementation)
- Date: 2026-10-18

## Context

Getting into a room means typing a six-character code someone reads out.
At the crits people struggled with that, and the groups rotate every week,
on laptops, so a QR code doesn't help. Once you're in a room there is also
no way back to it except the link you happened to keep.

ADR 0006 rules out a public list of rooms: a room is for the people in it.
So the way in has to be personal: the rooms you're already in, and rooms
someone has invited you to. Inviting needs a durable identity, which only
GitHub sign-in gives (ADR 0005); guests exist only inside a room.

A list of "your rooms" also needs to know which rooms are still going. The
columns for that exist (`rooms.state`, `host_last_seen`), but nothing sets
them, so today every room ever made counts as live.

## Options

- Where the list comes from: a public directory; or only rooms you're in or
  invited to.
- Who may invite: the host; or any member.
- What an invite names: the GitHub login as typed; or the account's numeric
  id, looked up on GitHub.
- How the list stays current: fetch on load and poll; server-sent events; a
  websocket; a per-user Yjs document.
- Colleagues: derived from shared rooms only; or derived suggestions plus a
  list you keep on purpose.

## Decision

### The list

The landing page gets a "Your rooms" card:

- **Signed in:** pending invites first ("Bo invited you to K7MQ2P", Join or
  Decline), then the live rooms your GitHub user is a member of. The server
  knows both, so the list is the same on every device.
- **Guest:** the rooms this browser holds a member secret for
  (`riff-member:<id>`). The page sends its secrets, the server answers for
  each. It lives in one browser because a guest has no account.
- Each room shows whether the host is there ("host away for 3 min").
- Never a room you aren't in or invited to.

### Room state, the server half of ADR 0003

To make "live" mean something, this ADR builds the part of ADR 0003's
lifecycle that the list needs:

- The host's first connection makes the room **live**; their last one
  leaving makes it **away**, with `host_last_seen` set.
- A room away for more than **5 minutes** becomes **ended**. A timer checks
  every 30 seconds. The state and time are in SQLite, so the timer survives
  a restart; at startup, rooms marked live become away from that moment,
  since nobody is connected yet.
- When a room ends, its invites are deleted and members' open connections
  become read-only. Members can still open it read-only; joining by code is
  refused.
- The host opening an ended room revives it.

Left to the lifecycle item: the banners, End room, deleting not-kept boards,
and pruning.

### Invites

- **Only the host invites**, like rotate, lock and remove. An invite gets
  past a lock, so a participant who could invite could undo the host's lock.
  A guest host may invite; only the invited person needs GitHub.
- The host types a username. The server looks it up with
  `GET /users/:login`, authenticated with the app's client id and secret
  (measured: 5000 requests an hour, against 60 without), and stores the
  invite against the account's **numeric id**. A renamed account keeps its
  invites, and whoever takes the old name doesn't get them.
- Whether a GitHub account exists is public, so a typo gets "No GitHub user
  called adaa". Whether someone uses *Riff* is not, so success always reads
  "Invited @ada. They'll see it when they sign in", member or not.
- Accepting joins under your saved name, or your login if there is none,
  and asks for another if it's taken. It works in a locked room. An invite
  goes when it's used, declined, cancelled by the host, or the room ends.
- The host sees pending invites in the People panel and can cancel them.

### Colleagues

Two lists, both only for signed-in users:

- **Recently worked together:** GitHub users who were members of a room
  with you, derived from `room_members`. It fades as old rooms are pruned
  (ADR 0003).
- **Colleagues:** people you add from that list, or by username, and keep
  until you remove them.
  - It's yours alone: adding someone doesn't tell them, and they don't see
    your list. There's nothing to accept, so there's no request to ignore.
  - Both lists are suggestions in the invite box. They grant nothing: an
    invite is still needed to get into a room.

### Live updates

The list is real time, over a websocket at `/api/rooms/watch`. The page
opens it from the landing page (and the People panel, for the host's
pending invites); a guest sends its secrets as the first message. The server
sends the whole list on connect and again whenever something in it changes:
an invite made, cancelled or used, someone joining, the host arriving or
leaving, a room ending. Lists are a few hundred bytes, so a full list beats
working out diffs.

### Log

`invite.add`, `invite.cancel`, `invite.accept`, `invite.decline` with the
invited account's id, `room.away`, `room.end`, `room.revive`.
`colleague.add` and `colleague.remove` are logged too, as user events with
no room (like sign-in): the user and the colleague's login and id. Like
every event they go after 90 days; the list itself doesn't.

## Consequences

- Getting into a room no longer needs the code for anyone signed in and
  invited, or anyone who has been in the room before on that browser.
- A room's state now changes on its own. A host whose tab is suspended for
  over 5 minutes (a phone in a pocket) ends their room; they revive it by
  opening it again. Whether 5 minutes suits phones is still open (PLAN).
- Until the lifecycle item lands, an ended room has no banner. Members just
  find it read-only.
- One more long-lived socket per landing page. The server keeps a map from
  user and member to open watchers; nothing about it is persisted.
- Colleague lists are personal data kept with no end date. They go in a
  user's export when that exists (the no-lock-in rule), and are deleted
  with the account.
- The signed-in paths can't be checked from `spec/`, which can't sign in
  with GitHub. An in-process test (`app/scripts`) inserts a user and session
  directly, as `test:audit-log` does.

## Implementation (2026-10-18)

- Server (`a0bee0f`, `ef1401f`): tables `invites` (room, GitHub id, login,
  inviter) and `colleagues` (user, GitHub id, login) in
  `app/server/store.mjs`; room state and invites in `app/server/rooms.mjs`;
  the GitHub lookup in `app/server/github.mjs`; colleagues in
  `app/server/colleagues.mjs`; the watch socket in `app/server/watch.mjs`
  (session from the cookie, secrets in the hello, the full list again on any
  change, debounced 50 ms). A room starts **away** and turns live when the
  host's first socket arrives. Ending flips the open non-host connections to
  read-only in place, and the terminal relay refuses participants with
  `room-ended`. The room's state and the time an away room ends also go into
  the control document, for the lifecycle item's banners.
- Client (`79a008f`): "Your rooms" on the landing page, invites with Join
  and Decline (and a name prompt when the name is taken), a Colleagues
  panel behind the account line, and an invite box in the host's People
  panel with colleagues and recent co-workers as suggestions and the
  pending invites below it.
- A Hocuspocus 4.7.0 bug turned up on the way (`7e6023e`). A server write
  (a direct connection) unloads the document twice: once at once, once on a
  timer. The timer checks the document by name, so if a client opened a
  fresh copy in between, the timer dropped that copy, and the client stayed
  attached to a document no later server write reached. The host's People
  panel froze while the browser said "connected". `beforeUnloadDocument`
  now refuses to unload a copy that is no longer the current one.

Checked:

- `spec/rooms.test.ts` (guests' lists, state, ending and revival, invites
  refused to non-hosts and bad logins), against dev and live.
- `npm run test:rooms` (in `app/`): the signed-in paths in-process, with a
  stub GitHub lookup: an invite reaching only the invitee, the same reply
  for Riff and non-Riff accounts, accepting past a lock, the grace timer
  ending a room and dropping its invites, a restart turning live rooms
  away, colleagues private and logged. Three mutations (invites shown to
  everyone, a restart keeping the old last-seen time, ending without
  deleting invites) each turned one test red.
- `npm run test:collaboration`: the Hocuspocus bug, red before the fix.
- `npm run test:rooms-browser` (dev only: it writes a signed-in user into
  the dev database): two browsers, invite by username, accept with a taken
  name, colleagues, the host leaving, at 1920×1080 and 390×844.

Not checked: a real GitHub account inviting another on live (the lookup is
stubbed in tests; the live spec covers only the refusals).

## The case for the options we didn't pick

- **A public directory** finds rooms with no code at all, and at a crit it's
  the room you're standing in. But it shows every room to everyone, and a
  room's name and host are already more than strangers need (ADR 0006).
- **Any member invites:** the person who knows the latecomer may not be the
  host, and the host is busy driving. Against it: it bypasses the lock, and
  the host is the one answerable for who's in.
- **The login as typed:** no GitHub call, so no rate limit and no outage to
  handle. Against it: a rename hands the invite to whoever takes the name
  next. Short-lived invites make that rare, not impossible.
- **Polling every 15 seconds** is less code and no extra socket. An invite
  arriving 15 seconds late is fine; a list that's out of date when you click
  isn't, and the brief asks for real time.
- **Server-sent events** are one-way, which fits, but `EventSource` can only
  `GET`, so guests' secrets would go in the URL and into logs. nginx would
  also need buffering turned off for it.
- **A per-user Yjs document** reuses Hocuspocus, but it would copy rows
  that already live in tables into a second, append-only store, and keep
  them after they're deleted.
- **Colleagues only derived** needs no new table and no UI. But the people
  you work with every week would vanish when old rooms are pruned, and
  ADR 0003 prunes on purpose.
