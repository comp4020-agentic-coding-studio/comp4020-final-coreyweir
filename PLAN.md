# Plan

Where the project is headed and why, between now and A3 (noon, 9 November).
Decisions live in `docs/adr/`. This file is the order of work, plus the
details that would otherwise get lost between sessions. Update it when the
order changes or an item lands. Strike an item through, don't delete it,
so the plan's history stays readable.

## Phases

1. **Port** (done, `c8792b8..7af9c15`): the existing Riff, deployed on fly
   with server-side persistence.
2. **Assess and plan** (week 10, done): this file, and ADRs 0001–0006.
3. **Implement** (now), in the order below. Each change goes:
   1. a decision (an ADR if it changes how people share a room);
   2. a check in `spec/`;
   3. the change;
   4. verification on the live app;
   5. a commit.

## Deadlines

| When | What | Needs |
|---|---|---|
| Mon 12 Oct, 13:30 | Crit 9 cutoff | Real-time (done, `spec/realtime.test.ts`), one written decision (ADR 0001), PROCESS.md overview, `reflections/crit-9.md` |
| Mon 19 Oct, 13:30 | Crit 10 cutoff | The server tells people apart and checks what each may see and change (written down, with why). Server-side who-did-what log that outlives the crit. Two pod members use it from the URL alone while I narrate from `flyctl logs`. `reflections/crit-10.md` |
| Mon 9 Nov, 12:00 | A3 | Live at both viewports, multi-user, real-time, persists (marker returns the next day). README defines good. `pnpm check` and `check:evidence` pass. PROCESS.md, CLAUDE.md, commit history |

README, PROCESS.md and the reflections are mine to write.

## Decisions so far

| ADR | Decision | Built? |
|---|---|---|
| [0001](docs/adr/0001-the-terminal-mirror-is-not-persisted.md) | The terminal mirror stays in server memory and is never persisted | Yes (today's behaviour) |
| [0002](docs/adr/0002-room-state-in-sqlite-as-an-append-log.md) | Room state in SQLite (`node:sqlite`) as an append-only update log, served by Hocuspocus | Yes (`36c41f6`) |
| [0003](docs/adr/0003-room-lifecycle-and-board-retention.md) | 5-minute host grace, then the room ends. Host chooses at creation whether the board is kept (default: keep). No promised retention. Local copies for everyone. Export and import. 4 MB per room, pruning from 70% of the volume | Partly: lifecycle, keeping, End room (`7928bac`, `8066106`, `d9a7766`), size cap and pruning (`f512b5a`, `7d27daa`), 18 Oct; local copies, export and import (`4e17a8f`, `65ba779`), 19 Oct; workspace export and import, 8 Nov |
| [0004](docs/adr/0004-queue-release-manual-by-default.md) | Queue release: manual Send by default, auto toggle on turn end | Yes (8 Nov, hooks fallback) |
| [0005](docs/adr/0005-identity-github-sign-in-and-room-scoped-guests.md) | Identity: GitHub sign-in on the server, guests exist only inside their room, encrypted push token in the browser | Yes (`389ffff`, `4acb32b`; push token in the client 18 Oct) |
| [0006](docs/adr/0006-who-may-see-and-change-what.md) | Who may see and change what, removal/lock/rotate, the who-did-what log. Crit 10's written decision. Amended 18 Oct: participants don't queue | Yes (`389ffff`, `4acb32b`, `f78b367`, `381dfba`) |
| [0007](docs/adr/0007-credentials-stay-in-the-tab.md) | The host's tokens stay in the page; the guest holds placeholders, swapped by our service worker (P1.6) | Yes (18 Oct) |
| [0008](docs/adr/0008-your-rooms-invites-and-colleagues.md) | Your rooms (members' and invited rooms only, live over a websocket), host-only invites by GitHub id, colleagues you keep; the room state half of 0003 | Yes (`a0bee0f`, `ef1401f`, `7e6023e`, `79a008f`, 18 Oct) |
| [0009](docs/adr/0009-riffs-own-free-models-for-hosts.md) | Hosts can use Riff's own free models (OpenRouter), through a host-only proxy on our server; the key never leaves the server | Yes (`e2ad15b`, `dc88e22`) |
| [0010](docs/adr/0010-the-hosts-workspace-persists-in-opfs.md) | The host's workspace persists in this browser (OPFS), one per room; the room's repository is cloned at boot | Yes (`16ee967`, `50bec09`, `b77233a`), 8 Nov |

## Work, in order

### P0: crit 9 (today)
- [x] Push the week-10 commits (pushed after the cutoff; crit 9 is made up in week 12). CI green from `2fd5829`.
- [ ] PROCESS.md update and `reflections/crit-9.md` (mine).

### P1: before crit 10 (19 Oct)

Left, in order (18 Oct): ~~the push token on the client (3)~~, ~~Load leaving
the queue with `queue.send` (5)~~, ~~the API proxy (6)~~, ~~then deleting
`/data/yjs` and the old `riff-*` rows~~ (all done 18 Oct).

1. ~~**Fix the client build.**~~ Done. The forks are packed archives in
   `app/vendor/` (`wasmer-sdk-0.10.0-riff.e56540d`,
   `lemon-tls-0.7.0-riff.e00e974`), and the launcher files are in
   `app/public/claude/` (the four Mithic files went later; see below).
   Claude Code needed nothing: the browser already derives it
   from the npm tarball (`src/claudeBundle.ts`), so it stays out of git. A
   clean clone builds. The output matches the committed `dist/` except that
   `@noble/hashes` 2.4.0 is now bundled twice (npm nests one copy under
   `lemon-tls` and one under `@noble/curves`, because nodepod's 1.8.0 holds the
   root). Same version, a few KB.
   - Left behind: `scripts/claude-stream-smoke.mjs` still imports from
     `nodepod_wasm_wip`. It's a research smoke, not part of the build.
   - ~~Mithic, the JavaScript shell from before WASIX bash.~~ Removed. Every
     way of starting bash in the pod (`execSync`, `spawnSync` and `spawn`, by
     name and by `/bin/bash`) was answered by WASIX bash, and a tripwire in
     place of Mithic's `/bin/bash` never fired. Nodepod checks exact external
     commands before PATH, for sync spawns too. Boot no longer fetches its
     604 KB. Its two smokes went with it.
     - ~~Unmeasured since: a dev server Claude starts with a wrapped
       `pnpm run dev` staying up under WASIX bash.~~ Fine in use (18 Oct).
     - Hypothesis: `execFileSync("/bin/bash", ["--version"])` fails with
       "not found" in the pod, Mithic or not. Claude's shell probe uses the
       async path, so it doesn't bite today.
     - `scripts/git-sync-browser-smoke.mjs` times out waiting for
       "Initialized empty Git repository" in the terminal text, before and
       after the removal alike. Git through bash itself works on every spawn
       path (via `.wasix-session/bin/git`), so the smoke's terminal harness is
       what broke. Fix or retire it.
   - ~~Build the client in the Docker image instead of committing
     `app/dist/`?~~ Done. Measured on the fly remote builder: 38 s for a cold
     build with a fresh `npm ci` (the client build itself 14 s), 7 s when
     nothing changed. The first image-built `dist/` hit the layer cache of
     the previous image's committed `dist/`, so the two were byte-identical.
     `app/dist/` is now gitignored. `.dockerignore` only matched
     `node_modules` at the root, so every deploy had also been uploading
     `app/node_modules`; it now says `**/node_modules`.
   - ~~Guest `curl http://…` got a 502 on the live site~~ (an https page
     blocks plain-http `fetch()` as mixed content; only images, audio and video
     are auto-upgraded). Fixed with CSP `upgrade-insecure-requests` in nginx,
     checked by `spec/headers.test.ts`, and verified with the curl smoke against
     the live bundle. Hosts who want real plain http can allow "Insecure
     content" for the site in Chrome. CORS still limits the guest to origins
     that allow cross-origin reads, over either scheme.
2. ~~**SQLite + Hocuspocus** (ADR 0002).~~ Done. `app/server/collaboration.mjs`
   on Hocuspocus 4.7.0, `/data/riff.sqlite`. Rows are written from the Yjs
   `update` event rather than `onChange`, because Hocuspocus acks before
   `onChange` runs (details in the ADR). Compaction at max(1 MB, snapshot
   size). Old `/data/yjs` rooms were dropped as planned.
   - Checked: `npm run test:collaboration` (SIGKILL mid-session, across
     compaction), `pnpm check` live (the realtime and persistence specs now
     wait on the server's ack), `flyctl machine restart` with a marker read
     back, and two browser profiles plus a headless client on the live room.
   - ~~Left: `/data/yjs` (36 KB) is still on the volume.~~ Deleted over
     `flyctl ssh` on 18 Oct.
3. ~~**Identity** (ADR 0005).~~ Built 12 Oct (`389ffff` server, `4acb32b`
   client); the ADR's "Implementation" section has the differences.
   - ~~Left: the host page reading the sealed push token (`#push=…`) and
     "Connect GitHub for pushing" in host setup; then the device flow goes.~~
     Done 18 Oct, with a pasted token sealed the same way (it must be the
     signed-in user's), and the device flow removed. ADR 0005's
     "Implementation" has the details.
     - ~~Left: a real push from a room on live.~~ Confirmed by hand on 18
       Oct (git from a live room, with the model call through the proxy).
   - ~~Left: sign in with a real GitHub account on the live site and check
     the session, `/api/me`, a GitHub member's badge, and sign-out.~~ Done
     by hand on live, 18 Oct.

   Design agreed 12 Oct:
   - ~~Device flow on our own OAuth app first~~ (`43f34f6`): client id
     `Ov23liF1O4v3obY6vdCc` from `GITHUB_CLIENT_ID` (Fly secret; `mise.local.toml`
     in dev, so start Vite through `mise exec`). No id → the proxy answers 503,
     so CI's secret-less image still starts. Checked: GitHub issues a device
     code for it on the dev server.
     - Org access for the app requested (convenor decides). Pull from
       course-org repos already works, which is enough to run a dev server
       on one of those projects. Push waits on approval; the web flow goes
       ahead regardless, and the device flow goes with it.
   - **GitHub users.** `users(id, github_id UNIQUE, login, avatar_url,
     created_at, last_seen)`. Rows come only from a completed sign-in.
   - **Sessions** for GitHub users only: `sessions(token_hash PK, user_id,
     created_at, last_seen, expires_at)`. Cookie `__Host-riff-session` (the
     prefix is the browser-enforced one: Secure, `Path=/`, no Domain), random
     32 bytes, HttpOnly, SameSite=Lax, 30 days sliding. The table holds the
     hash, so sign-out really ends it. A new id at every sign-in.
   - **Guests exist only inside a room.** No `users` row. Joining creates a
     `room_members` row with a room-scoped secret (localStorage
     `riff-member:<roomId>`, sent as the Hocuspocus `token` and in the relays'
     hello, as the host capability is today). Names are unique per room
     (case-insensitive, NFKC); a name held by a disconnected member can't be
     taken over without its secret, or the log could be impersonated.
   - **Web flow.** `GET /auth/github/start?purpose=identity|push&return=…`:
     state + PKCE verifier in a signed `__Host-oauth` cookie (10 min,
     `SESSION_SECRET`), explicit `redirect_uri` from `RIFF_ORIGIN/auth`, never
     the Host header. Scope empty for identity, `repo` for push. `GET /auth`:
     constant-time state check, exchange (secret, verifier, `redirect_uri`),
     `GET /user`, upsert, new session. An identity token is discarded.
   - **Push token in localStorage, encrypted by the server.** After a push
     sign-in the server encrypts the token (AES-GCM, key from `SESSION_SECRET`
     and the session id) and the page stores only the ciphertext. `POST
     /api/github/token/unwrap` returns it to a valid session. Sign-out, session
     expiry or a rotated secret kill it, and a copy of localStorage alone is
     useless. Code running on our own origin can still call unwrap; storing
     plaintext would have given it the token anyway, so this is accepted.
     The server never stores the token.
   - **Origin checks** on every WebSocket upgrade and POST, against
     `RIFF_ORIGIN` (browsers send cookies on cross-site WebSocket opens).
   - **Sweeper** at startup and hourly: expired sessions, events past 90
     days, and later ADR 0003's pruning. Lookups treat an expired session as
     absent, so the sweeper never needs to be on time.
   - **Landing page.** "Sign in with GitHub" or "Continue as guest", then host
     or join. Guests can host. "Connect GitHub for pushing" lives in host
     setup. `githubDeviceProxy.mjs` goes once the web flow covers pushing.
4. ~~**Rooms and permissions** (ADR 0006; crit 10's written decision).~~
   Built 12 Oct (`389ffff`, `4acb32b`, `f78b367`). Live: `pnpm check` 32/32,
   and two browser profiles at 1920×1080 and 390×844 through join, a
   refused duplicate name, staging, queueing, the People panel, a new code,
   a reload, and removal (shut out in about 20 ms).
   - ~~Left: participants proposing to the queue (stateless message).~~
     Dropped 18 Oct (ADR 0006 "Amendment"): with automatic release it would
     let a participant's prompt reach Claude unapproved. Staging is the
     proposal; the host's Queue is the approval.
   - ~~Left: gate the preview's HTTP side (`/room-preview/<id>/…`) to
     members.~~ Done 18 Oct: a per-member key in the path (HMAC, nothing
     stored), as a stop-gap until the separate-origin question is settled.
     Options and cost in ADR 0006's "Implementation".
   - ~~Left: a "this room predates sign-in" page for old `riff-<code>`
     links.~~ Dropped 18 Oct: nobody is using those rooms (crit-day tests
     and spec runs), and an old link already reaches the join form and
     "no live room", which is true. Their rows were deleted with `/data/yjs` (item 5).
   - ~~The browser smokes that drive a room haven't been run since.~~
     `terminal-browser-smoke.mjs` now hosts through the landing page and
     joins from the share link alone; it passes on dev and live (18 Oct).
     Its old check counted live data events only, which a late joiner
     needn't get while Claude sits idle: it now waits for the snapshot,
     then types on the host and waits for live data.
     - ~~Left: port the preview smokes.~~ `preview-participant-browser-smoke.mjs`
       now uses a real room (host secret, participant's preview key) and
       passes on dev and live. On live it had two waits that only worked by
       luck: animation-frame polling starved in the out-of-process sandboxed
       iframe, and a style check that raced its stylesheet.
       `preview-browser-smoke.mjs` is the host's own preview and never
       touched the relay; it passes as it was.
   - ~~A cold machine answers 502 for the second or two before node
     listens.~~ Fixed in `deploy/start.sh`: nginx starts only once node
     accepts connections, so fly's proxy holds the request. Measured with
     `flyctl machine stop` then requests: before, every request for the
     first seconds was 502; after, three rounds, the first request took
     ~4 s and got its real answer.

   Plan as agreed:
   - `rooms(id, code, keep, locked, state, host_last_seen, created_at,
     ended_at)`. `id` is permanent and random (128 bits) and names the
     documents; `code` is short, case-insensitive, no 0/O/1/I.
   - `room_members(id, room_id, user_id NULL, secret_hash NULL, is_host,
     name, name_key, joined_at, last_seen, removed_at)`, `STRICT`.
     `CHECK ((user_id IS NULL) <> (secret_hash IS NULL))`: a member is a
     GitHub user or a guest, never both. The host is the member with
     `is_host = 1`; a partial unique index (`ON room_members(room_id) WHERE
     is_host`) allows at most one per room. A `host_member_id` on `rooms`
     would make the two tables reference each other (deferred keys on every
     insert) and couldn't say more. The schema can't promise every room has
     a host, so creating a room inserts the room and its host member in one
     transaction. `UNIQUE (room_id, name_key)` and `UNIQUE (room_id,
     user_id)`. `PRAGMA foreign_keys = ON` per connection (SQLite leaves it
     off).
   - `POST /api/rooms` creates a room and makes the caller host.
     `GET /api/rooms/by-code/:code` resolves live rooms only. Both rate-limited
     per IP, since rooms are the one thing anyone can create.
   - Roles come from the server on every connection: host or participant.
     The terminal and preview relays use them instead of first-claim
     capabilities. A second host socket replaces the first (reload).
   - Two documents per room, because Hocuspocus can make a connection
     read-only per document but has no per-key permissions:
     `room/<id>/shared` (board, staged prompts; everyone writes) and
     `room/<id>/control` (queue, settings, preview state, member list; host
     writes, participants read). Participants propose to the queue with a
     stateless message the server checks and applies. The member list is
     written by the server, so a "verified" badge can't be faked from
     awareness.
   - Anyone in the room may edit or delete a staged prompt: drafts are
     shared work, like a shared doc. The log shows who did it.
   - **Removal, lock, rotate.** The host can remove a member (`removed_at`,
     sockets dropped, credential refused). A removed GitHub user can be
     invited back. A removed guest could rejoin with the code, so the host
     can also rotate the code (old code stops resolving, members stay
     connected) and lock the room (no new joins by code; members and invites
     still get in). Order for a leaked code: rotate, remove, lock.
   - Viewers of a kept, ended board: the host and its members (settles
     ADR 0003's open question).
5. ~~**Who-did-what log.**~~ Built with 4 (`app/server/audit.mjs`); what it
   records so far is listed in ADR 0006's "Implementation". Since 18 Oct it
   also logs connect and disconnect, and staged and queued prompts added
   and deleted, with who, read on dev and live. Left: end (with ADR 0003),
   a rehearsal of crit 10's narration from `flyctl logs`.
   - ~~Load takes the prompt out of the queue and the log says
     `queue.send`~~ (18 Oct). Load sets `roomState.lastSent` to the prompt's
     id in the same transaction as the delete, and the server's watcher
     reads it to log `queue.send` instead of `queue.delete`. That is the
     host's claim; the server never sees the terminal. Checked by
     `npm run test:audit-log` (in `app/`): the server in-process on a
     throwaway database, a host and a guest staging, queueing, sending and
     removing, every row read back from `events` (who, action, id, and no
     prompt text). Mutation: logging every queue delete as `queue.delete`
     turns it red. `terminal-browser-smoke.mjs` now carries a prompt from
     a participant's staging to the host's Load, gone from both queues; the
     dev log showed `queue.add` then `queue.send` for it.

   Plan as agreed: `events(seq, at, room_id, member_id, action,
   detail_json)`. `detail_json` is a flat object of scalars (ids, counts,
   bytes, setting names, denial reasons), never content. Each event is also
   printed to stdout as logfmt for `flyctl logs`:
   `[audit] room=K7MQ2P member=12 guest="Ada" role=participant action=denied what=control.write`.
   Actions: sign-in/out, room create/join/leave/end, queue propose/release/
   remove, settings, host claim/reject, member remove, code rotate, lock,
   denials. Edits are coalesced per connection and document about every 10 s.
   Kept 90 days. `doc_updates.user_id` stays but compaction merges it away,
   so it isn't the log.
   - ~~Specs (before the code)~~ written, red against today's server for
     the expected reason (no API yet): `spec/permissions.test.ts`,
     `spec/sign-in.test.ts`, and `spec/realtime.test.ts` and
     `spec/persistence.test.ts` moved onto real rooms (host creates, guest
     joins by code). Helpers in `spec/riff.ts`. They pin down this contract:
     - `POST /api/rooms {name}` → 201 `{room: {id, code}, member: {id, name,
       host, secret}}`; `POST /api/rooms/join {code, name}` → same shape, 404
       unknown code, 409 name taken (case-insensitive, host's too), 423
       locked; `GET /api/rooms/by-code/:code` → `{id, …}` or 404, any case.
     - Host only (`Authorization: Bearer <secret>` or the session cookie;
       401 without, 403 for a participant): `POST /api/rooms/:id/code` →
       `{code}`; `POST /api/rooms/:id/lock {locked}`; `DELETE
       /api/rooms/:id/members/:memberId` → 204, and the member's open socket
       is shut out.
     - One socket at `/collaboration` (no document in the path); Origin
       missing or foreign → 403 at the upgrade. Today nginx only proxies
       `/collaboration/`, so the bare path falls through to the SPA. Any
       document that isn't `room/<id>/shared|control` is refused.
     - `/auth`: bad or missing state, or a tampered `__Host-oauth` cookie →
       400 before contacting GitHub; GitHub refusing the code → 403; no
       client secret → 503. `return` must be a same-origin path. `GET
       /api/me` → `{user: null}` when signed out.
     - CI starts the container with `RIFF_ORIGIN`, the public
       `GITHUB_CLIENT_ID` and a throwaway `SESSION_SECRET`.
     - When the code lands, prove each check can fail: switch off the
       read-only flag, the origin check and the removal, one at a time.
     - Not checkable from outside: a GitHub user's path (needs a real
       sign-in), and the log (read with `flyctl logs`).
   - Old `riff-<code>` documents aren't migrated. ~~Their links get a "this
     room predates sign-in" page.~~ Dropped 18 Oct (no real users). Their 14
     rows (and 6 `spec-*` documents, <1 KB in all) were deleted on the
     volume over `flyctl ssh` the same day, along with `/data/yjs`.
6. ~~**API proxy, so no secrets reach the guest.**~~ Done 18 Oct, ADR 0007.
   The model token and GitHub token were in the guest's environment, so
   `env` showed them live to the room.
   - ~~Model it on the curl path.~~ Measured otherwise: Claude's model calls
     and Nodepod's `git` are the browser's `fetch` from Nodepod's workers,
     and only WASIX programs use the gateway. So the swap is in a service
     worker (`app/public/riff-sw.js`, wrapping Nodepod's `/__sw__.js`),
     which sees both.
   - The guest holds only a placeholder, new each boot. The real values
     stay in the host's page (`app/src/credentials.ts`) and only go to
     their own origins.
   - Built: `app/public/riff-sw.js`, `app/src/credentials.ts`, `claudePod.ts`
     (placeholders in both environments, `swUrl`). Checked by
     `npm run test:credentials-browser` (dev; two mutations red) and by
     running Claude Code against a mock endpoint, which received the real
     token and streamed its reply to the terminal.
   - ~~Run the smoke against live.~~ Passed 18 Oct with
     `ECHO_BASE=https://httpbin.org` and the built chunk: httpbin saw the
     real token, the guest's `env` showed only placeholders.
   - ~~Left: a real model call and a real push from a room on live.~~ Both
     confirmed by hand on 18 Oct.

### P2: toward A3

In this order (agreed 18 Oct): room list and invites, room lifecycle, board
export and import, OPFS and workspace export, the terminal redeploy gap.
The rest after. The host's preview (Still open) comes soon, and before
auto-release at the latest.

- ~~**Your rooms, invites and colleagues** (ADR 0008)~~. Built 18 Oct
  (`a0bee0f`, `ef1401f`, `79a008f`); see the ADR's Implementation section.
  On the way: a Hocuspocus bug that cut a client off from server writes
  (`7e6023e`). Checked by `spec/rooms.test.ts` (live), `npm run test:rooms`,
  `npm run test:rooms-browser` (dev, both sizes).
  - Left: one real GitHub account inviting another on live.
  - The OPFS column ("this browser still has the workspace") comes with
    OPFS. Never a public directory.
- **Room lifecycle** (ADR 0003):
  - ~~room records: state, the host's last-seen time, and a permanent id
    beside the join code~~ (the columns exist since P1.4);
  - ~~a grace timer that survives restarts~~ (built with ADR 0008);
  - ~~the "host away" and "ended" banners~~;
  - ~~read-only connections for kept ended rooms, refused ones for
    not-kept, and End room~~. Built 18 Oct (`f98a002` spec, `7928bac`
    server, `8066106` client, `d9a7766` log); see the ADR's Implementation
    section. Checked by `spec/rooms.test.ts` (live), `npm run test:rooms`,
    `npm run test:lifecycle-browser` (dev and live, both sizes).
    - Left: a host reviving a not-kept room in a browser (their IndexedDB
      copy should sync back; not measured); the 5-minute grace on a phone
      host (Still open).
  - ~~pruning (oldest opened first, past a volume threshold) and a per-room
    size cap~~. Decided 18 Oct (ADR 0003's amendment): the proposed 16 MB
    cap got node killed for memory on live, so 4 MB per room, hard, a full
    room read-only for everyone; 8 MB per websocket message; the client
    refuses an image that won't fit; prune ended kept rooms, least recently
    opened first, from 70% of the volume down to 60%. Built 18 Oct
    (`3e54ceb`/`b3df0f2` spec, `f512b5a` server, `7d27daa` client); checked
    by `spec/limits.test.ts` (live), `npm run test:rooms`,
    `npm run test:limits-browser` (dev and live, both sizes).
    - Left: ~~the banner says "Export it" once export exists~~ (`65ba779`); a full room's
      preview live flag stops reaching participants (accepted, see the
      ADR); pruning has only run against a stand-in disk.
- **Images out of the board document** (ADR 0003's amendment, option C),
  with export: the browser uploads each image once, the server stores it
  on the volume, the board holds a reference. Lifts the 4 MB cap to a disk
  limit.
- ~~**Local copies**, **room export** and **room import**~~ (decided 19 Oct,
  ADR 0003's second amendment; built 19 Oct, `4e17a8f` file, `65ba779`
  client): one "Boards on this browser" list (hosted/joined, Open, Export,
  Delete, "Delete all"), a read-only copy with no server, Delete taking the
  room secret too, sign-out offering to delete; `riff-<code>-<date>.json`
  with board, staged prompts and queue; import into a new room only, known
  fields only, images byte for byte and checked (type, magic bytes,
  2048px, decodes). Checked by `npm run test:board-file` and
  `npm run test:boards-browser` (dev and live, both sizes).
  - ~~Workspace export, a zip including Claude transcripts, never
    credentials.~~ Built 8 Nov (ADR 0003's third amendment): a host-only
    "Export" in the workspace controls, `app/src/workspaceExport.ts`
    (fflate), `repo/` with `.git`, transcripts by default, `node_modules`
    and the like left out unless ticked, Riff's `.wasix-session` and any
    token Riff holds never in, a manifest listing the commits and which
    are unpushed. Checked by `npm run test:workspace-export`,
    `test:workspace-export-browser` and `test:workspace-export-ui`.
    - Checked on dev and live (8 Nov), including a pod restored from OPFS:
      `test:workspace-export-ui` drives the page, so it runs against the
      built app; `test:workspace-export-browser` imports source and is dev
      only.
    - ~~Import~~ built 8 Nov (ADR 0003, "Import"): "Start from an exported
      workspace" on the host form, into the new room's workspace only; the
      export's repository wins over the room's; what it left out is named
      for reinstalling; transcripts behind an unticked box; Riff exports
      version 1 only. Checked by `npm run test:workspace-import` and
      `test:workspace-import-ui` (dev, both sizes); live still to run.
    - ~~"Export files" on a room's row~~ built 8 Nov (ADR 0003, "Export
      files from the landing page"), beside "Export board": the same zip
      from the saved workspace, no pod; refused while another tab holds
      it. Checked by `test:workspace-export-saved` and
      `test:workspace-export-files-ui` (dev, both sizes); live still to run.
    - Left: real-git
      history (Nodepod's git isn't git, see the ADR); a transcript Claude
      Code wrote itself wasn't measured; a `chmod` from WASIX bash doesn't
      reach the volume, so such a file exports as 644.
    - Seen while testing: a smoke typing `$(...)` into WASIX bash stalled
      the shell in about a third of runs (a command substitution forks a
      subshell); with none, 0 stalls in 10 runs. A hypothesis, not chased:
      not export's, but it will bite anything that types into the host's
      terminal.
- ~~**OPFS workspace.**~~ Decided and built 8 Nov (ADR 0010; `5deaaad`
  ADR, `16ee967` saving, `b77233a` list and delete). One workspace per
  *room* (its permanent id), not per repo as first planned: everything
  under `/work` and `/home/user` (`node_modules`, `.git`, Claude's
  transcripts), not `/tmp`, caches or what the boot rewrites. Saved
  behind the filesystem from its change reports (`onGlobalChange`, which
  sees the Rust store's ring), never making a writer wait; a manifest
  written last, in alternating slots, so a crash loses the save in
  progress and never half of one. One tab holds it (a Web Lock); a second
  asks, then takes over, and the first says it stopped saving. Listed on
  its board row in "Boards on this browser" (files, size, last saved,
  what is and isn't saved), with "Delete files"; the row's Delete and
  sign-out take it too. Checked by `npm run test:workspace-browser` (dev:
  bash, node and git writes, a delete and a rename, an unannounced reload
  restores an unpushed commit, bytes, mode 755 and a transcript; takeover;
  the landing page's delete paths). Measured on dev: 10,000 small files
  in OPFS about 10 s after they were written; boot with them restored
  about 1.3 s. On live, `npm run test:workspace-ui-browser` (8 Nov, at
  1600×1000 and 390×844): hosted from the landing page, Bash typed into,
  an unpushed commit and four raw bytes back after an unannounced reload,
  /tmp not, the second tab asking before it takes over and the first
  then not saving.
  - Found on the way: typing into the host's bash with no gap between
    keys stalls its input part-way through a command in about half the
    runs, on dev and live, with the workspace off too (the smoke types at
    20 ms a key; `TYPE_DELAY=0` reproduces).
  - Left: a reload mid-task with Claude itself on live, by hand, and on a
    real phone; the "Your rooms" marker (above) once that list wants it, through
    `listWorkspaces()`; Nodepod's `attachSharedStore` drops file modes
    (worked around with `reapplyModes`, belongs in the fork); WASIX
    bash's `chmod` doesn't reach the store; a crash (rather than a reload)
    is unmeasured.
- ~~**Clone the host's repository automatically.**~~ Built 8 Nov
  (`50bec09`, ADR 0010): at boot, when the room names a GitHub repository
  and `/work/repo` has no `.git`, Nodepod's `git clone` runs with the
  push token's placeholder (ADR 0007). A restored workspace is opened,
  never cloned or pulled again. Checked by the same smoke with
  `CLONE_TOKEN` (clone, reload, no second clone, same log).
  - Left: anonymous clone of a public repo (Nodepod's git needs a token,
    so without GitHub connected the terminal says it didn't clone);
    a clone on live.
- ~~**Queue release** (ADR 0004)~~. Built 8 Nov on the fallback (settings
  hooks, `riff-hook`, a bracketed paste and a separate Enter), which works
  on 2.1.221, so no bundle upgrade. Send submits with newlines intact,
  auto sends the next prompt whenever Claude is idle, and the room sees
  the toggle and what Claude is doing. The log says `queue.send by=host|auto`
  and `queue.auto on=…`. Details and what was measured in the ADR's
  Implementation section. Checked by `npm run test:queue-release-browser`
  (two clients, exactly once, dev), `npm run test:queue-release`,
  `npm run test:audit-log`, `spec/permissions.test.ts`.
  - Left: live verification. A slash command fires no hook, so auto pauses
    after one until the host turns it on again (measured, by design).
  - Resilience (8 Nov, `628ee23`): `npm run test:queue-release-resilience-browser`
    hides the host's tab for a minute, freezes it for 45 s mid-turn, exits
    and restarts Claude, and reloads mid-turn; auto carries on and every
    prompt arrives once. It found that a reloaded host page could leave the
    room seeing "Claude is working" for good (its "off" was written before
    the room's state arrived, and Yjs kept the old page's value); the page
    now publishes only once synced. After a reload Claude starts a new
    session: the turn that was running is gone, though its transcript is in
    the saved `/home/user/.claude`. Not handled: a Send typed while Claude
    shows a dialog mid-turn (a question or plan approval) goes into the
    dialog; Claude's `Notification` hook could tell Riff about one.
- ~~**Images into the host's Claude**~~ (8 Nov, `d07ddcc`). xterm reads
  only text from the clipboard, so a pasted screenshot did nothing. Claude
  Code 2.1.221 attaches an image itself when its absolute path is pasted
  (measured in Nodepod: `[Image #1]`, then an image block and
  `[Image source: …]` in the request), so a paste or drop on the host's
  terminal writes the image to `/tmp/riff/paste-N.<ext>` in the pod and
  pastes the path (`src/imagePaste.ts`). Claude silently attaches nothing
  over 2000 px a side and the pod has no `sharp`, so the page shrinks it
  first. Host only (a mirror has no pod); a clipboard with text too stays a
  text paste. Riff's free model reads text only (OpenRouter answers an
  image 404 "No endpoints found that support image input", measured), so
  with it the image isn't given to Claude and the footer says why. Checked
  by `npm run test:image-paste` and `npm run test:image-paste-browser`
  (dev, judged from the fake API: a 3000x1500 paste arrives as one
  2000x1000 block, a dropped 320x160 one as it was, text with an image as
  text); red with no shrinking, no text rule, or the path typed instead of
  pasted. Ctrl+V inside Claude stays broken (it reads the clipboard
  through `xclip`, which Nodepod's shell can't give it).
  - Left: a real paste from the OS clipboard and a drag from the desktop
    on live, with a real model; a paste on a phone host. Sending the board
    or a selection to Claude is in P3.
- ~~**Terminals the same size**~~ (crit 11; 8 Nov). The mirror already took
  the host's columns and rows, but at a fixed 12px, so a phone watching a
  desktop host saw the first 390px of a 1368px screen. Now the font follows
  the participant's box ("fit", the default) and the grid stays the host's;
  "Actual size" keeps the host's font and scrolls (`src/mirrorFit.ts`).
  Checked by `npm run test:terminal-size-browser` (dev): desktop host and
  phone participant and the reverse, the host resized mid-way, the screens
  equal row by row and inside the box. Red before (cut off), and red if the
  mirror stops taking the host's size.
  - The host's terminal keeps its own size (decided 8 Nov, Corey): the
    desktop host's experience isn't made worse to suit phones. A desktop
    host's 190 columns fit a phone at about 3px a character, a thumbnail;
    the phone can pinch-zoom, or switch to Actual size and scroll.
- ~~**Clipboard.**~~ (8 Nov.) Claude Code 2.1.221 copies with OSC 52 (`]52;c;`,
  read from the bundle), which xterm.js ignores. The host's terminal now
  honours copies, never queries (`src/terminalClipboard.ts`, our own OSC
  handler, not `@xterm/addon-clipboard`: the addon answers every query, if
  only with an empty clipboard, and the answer lands in the program's input,
  where bash took it for typing). The participants' mirror ignores OSC 52,
  or the host's output would write to everyone's clipboard. Checked by
  `npm run test:terminal-clipboard-browser` (dev, two browsers): a copy
  reaches the host's clipboard, a query gets no answer, the participant's
  clipboard is untouched. Red with the handler removed, and red with it on
  the mirror. Not driven: Claude's own copy (a printf sends the same bytes).
- ~~**Terminal redeploy gap** (ADR 0001): forget the host's last snapshot when
  the relay accepts the host again.~~ Done 8 Nov. On the way: a participant
  already watching also ignored the restarted relay, whose sequence starts
  at 1 again, until it passed the old count; each connection now starts the
  count afresh. `npm run test:terminal-redeploy-browser` (dev only: it
  restarts the dev server by touching `server/riff.mjs`, and keeps Vite's
  client from reloading the pages) was red before on both counts.
  - Needs live: a `flyctl deploy` with a host idle on Claude and a
    participant joining after it.
- ~~**Redesign the landing page.**~~ (8 Nov.) Sign-in, "Your rooms", "Boards on this
  browser", colleagues and both forms all sat in one card, which grew taller
  than the window and hid Create room (found by hand on live, 19 Oct; the
  stop-gap made the card scroll). Corey chose "two zones" from a sketch:
  the card holds only what you do now (invites on top, then Join | Host,
  the forms unchanged, so joining is still a name and a code and hosting
  gains no step); the account moves to the header and colleagues open over
  the page; beside the card on a wide screen, below it on a phone, one row
  per room, merging the server's list with this browser's copies (Enter,
  Open, Export, Delete). Open shows the copy's board in place of the hero
  with the forms still beside it, "as of" when this browser last had it
  open (Full page for the prompts too); on a phone it goes to the copy's
  own page. Checked by `test:rooms-browser` (invites, the colleagues
  overlay leaving the forms, a room and its copy as one row) and
  `test:boards-browser` (Enter, the peek on a wide screen, the copy page,
  Delete), both at 1920×1080 and 390×844 on dev. On a phone the line
  about why to sign in is hidden for room. The host's files (ADR 0010)
  ride on the same row ("Files: …", Delete files); files whose board copy
  has gone get a row of their own. `test:workspace-browser` reads them
  from the merged list.
- **Week-12 bugs** (`docs/week-12.md`), one at a time:
  - ~~"Everything missing" (curl, jq, pnpm all gone at once).~~ The session's
    tools, bridge stubs and bridge pipe lived in `/work/repo/.wasix-session`,
    inside the user's workspace. Measured on dev: `git status` listed all 22
    files (~57 MB of binaries for a `git add -A`), and emptying the workspace
    (`rm -rf` before a clone, `git clean`, a scaffolder clearing the
    directory) left every tool "command not found" and `node`/`git` unable
    to open the bridge pipe. That is the only thing curl, jq and pnpm have in
    common, so it is the likely cause; what emptied it at the crit wasn't
    recorded. Now the control directory is its own mount, `/opt/riff`, and
    a failed session start says why on the command's stderr. Checked by
    `test:wasix-claude-bash-browser` (wipes the workspace, then git, jq, rg,
    nano, node and npm must run; red with the old location) and
    `test:wasix-session-browser`. Also keeps the tools out of the OPFS
    workspace and its export.
  - ~~`npx create` hangs.~~ Reproduced on dev: `npm create vite@latest
    my-app -- --template react-ts` printed "added 1 package" and nothing for
    150 s. Two causes, both in Nodepod (fixed in `nodepod_fork`, riff.44):
    `npm create` regrouped the flags after the positionals, so create-vite
    got `--template` with no value; and every Nodepod process claims a TTY
    on stdin, so create-vite went interactive, but the WASIX bridge carries
    no stdin, so its prompt could never be answered. Arguments now pass
    through in order, and bridged processes see `stdin.isTTY === false`
    (`NODEPOD_STDIN_TTY=0`). Measured after: the command above, bare
    `npm create vite@latest` and `npx create-vite other-app` each scaffold
    in under a second. Left: the bridge still has no stdin at all, so
    `echo x | node script.js` and interactive `node` in the host's Bash
    get nothing (a change to the bridge stub and protocol).
  - ~~git failures.~~ Nodepod's git talks to GitHub's REST API, always with a
    token, so measured on dev: with no GitHub connected even a public clone
    fails ("authentication required. Set GITHUB_TOKEN", wrong advice in
    Riff, and the host gate claimed public repositories still worked); with
    a dead token, pull and fetch said only "couldn't find remote ref" and
    "could not list remote branches"; and clone and pull skipped any file
    they failed to fetch and reported success. Now (riff.45 and the app):
    every failure carries GitHub's status and message, a 401 says the token
    was refused, a missed file fails the command, no token says the host
    connects GitHub in Riff, and `riff-sw.js` tells the host page when an
    endpoint answers 401 to a real token, which the Workspace panel shows.
    What failed at the crit wasn't recorded, so which of these it was is a
    hypothesis. Checked by `test:credentials-browser` (red without the
    service worker's notice) and nodepod's `git-shell.test.ts` (red before).
    Reconnecting no longer needs a reload (8 Nov): the refusal banner opens
    "Connect GitHub again" in a new tab (`/?github=reconnect`, OAuth or a
    pasted token); the room's tab hears the new sealed token (a storage
    event), and the guest keeps its placeholder while `riff-sw.js` forgets
    the old value and asks the page for the new one. Claude keeps running.
    The refused token is forgotten on the spot, so the next boot doesn't
    reuse it. Checked by `test:github-reconnect-browser` (dev: a revoked
    token answers 401, a real one pasted in the other tab answers 200 from
    the same pod and placeholder; red when the worker isn't told to
    forget). A pod booted with no GitHub at all still needs Claude booted
    again: its guest has no placeholder to swap.
    Left: Nodepod's git ignores `.gitignore` and re-uploads every file on
    each push (secondary rate limits on big trees).
  - ~~"Insecure sources" in Chrome's address bar.~~ Every Nodepod worker ran
    the sqlite and zlib polyfills' Node fallbacks, a dynamic
    `import("node:fs")` (and `node:module`, `node:process`). A browser has
    no `node:` scheme, so each went out as a request for the URL `node:fs`,
    which Chrome counts as a script from an insecure source. Measured on
    dev: six `node:fs` script requests per Claude start, none after the fix
    (nodepod riff.46: the fallbacks run only under real Node).
    `test:wasix-claude-bash-browser` fails on any `node:` request (red on
    riff.45). Not yet looked at on live: the address bar itself.
  - ~~**Typing into the host's Bash stalls**~~ (found by the workspace
    smokes, above). Fixed 8 Nov: two bugs, one looked like the other.
    *A deadlock in wasmer-js* (the whole shell lost). Named by rebuilding
    the SDK with symbols: the guest's thread parks in `InlineWaker::block_on`
    while polling stdin, holding its own mutex, and tokio's
    `AtomicWaker::register_by_ref` wakes that waker inline when a key
    arrives mid-registration, so `wake_now` re-locks the same mutex on the
    same thread and parks it for good. The session worker's TTY copy then
    blocks on the pipe's receiver lock the parked thread holds, so it
    answers nothing. Any key racing a poll could do it; children ending and
    signals only made polls more frequent. `__asyncify_light_with_signals`
    (the `fd_read` path) had the same shape. Fixed in `wasmer-js-fork`
    (`e527ed5`, virtual-mio vendored in `f7e7630`): both park on a `woken`
    flag and never hold the lock while polling; installed as
    `wasmer-sdk-0.10.0-riff.e527ed5.tgz`. *Out-of-order output* (shell fine,
    screen garbled): stdout and stderr reach the page through separate pipes,
    so readline's echo (stderr) overtook command output mid-escape and could
    swallow a line into an escape sequence. The interactive Bash's rc now
    runs `exec 2>&1`, one stream, as a pty gives. Check:
    `test:terminal-input-browser` types at 0 ms a key, types ahead, types the
    moment a child, a background job or a signal ends, and pastes (one line,
    two lines); 110 inputs green on dev. Red on the old SDK (session worker
    stops answering: 4 stalls in a 5-round run), and 1 of 66 red with the `exec 2>&1`
    removed. `alias true=:` in the rc blames a hang on `$(true)` that was
    probably this deadlock; left alone, unmeasured.
- ~~**`python` in the host's Bash**~~ (versatility: not only JS). Done 8 Nov.
  Nodepod's own `python` runs in a separate worker on a copy of `/work/repo`,
  with no terminal, so it was no use from Bash or Claude's Bash tool. Now
  `python`/`python3` in the WASIX session are launchers
  (`app/src/pythonCommand.ts`) for the same pinned CPython 3.12 package, run
  as a session process: same terminal, cwd, files and pipes as Bash. The
  115 MB package isn't part of the session boot: the first `python` in a
  session asks the page over the bridge (`riff-python-fetch`) to install it in
  `/opt/riff`, from Cache Storage under the key Nodepod's `python` already
  uses, so a browser downloads it once (measured on dev: ~11 s download, ~5 s
  first start, ~0.4 s after). A `sitecustomize.py` fixes three things the
  package gets wrong under WASIX: relative paths resolved against `/`,
  `sys.executable` named a `/bin/python` that doesn't exist, and `subprocess`
  by bare name exited 45 for any program outside the first PATH directory
  (WASIX ends a child whose exec misses instead of failing the exec, so the
  child's PATH walk dies; names are now resolved in the parent). HTTPS works
  through the gateway's CA (`SSL_CERT_FILE`). Checked by
  `test:wasix-claude-bash-browser` (through Claude's real Bash provider:
  `-c`, stdin pipe, exit codes, a script in a subdirectory reading and writing
  relative paths, subprocess; red without the cwd fix and without the
  subprocess fix) and `test:wasix-terminal-browser` (the REPL in the host's
  terminal, Ctrl-C interrupting a running loop back to `>>>`, `exit()`).
  Doesn't work: **pip** (not in the package; the pip wheel ensurepip carries
  fails to import because this build has no `mmap`), packages with C
  extensions, Ctrl-C on a pure CPU loop that makes no syscalls (WASIX only
  delivers signals at syscalls; a loop that sleeps or does I/O stops at
  once), and `python -I`/`-E` (they skip the cwd fix, so relative paths land
  in `/`). The terminal smoke passed 6 of 8 runs with this change against 6
  of 6 without; both failures were in its older steps (a bridged
  `git --version` that never answered, before any Python ran; a third
  "Start Bash" not ready in 120 s), so whether they're related is open.
- ~~**The host's Bash says "I have no name!"**~~ Done 9 Nov. The prompt read
  `I have no name!@wasmer:/work/repo#` and `whoami` failed: the guest is
  uid 0 with an empty /etc. Now it reads `user@riff:/work/repo$`, and
  `whoami`, `id`, `groups` and `hostname` answer `user` and `riff`. /etc
  can't be shared like /home: the runtime creates /etc in every run's fresh
  root and a mount over it fails (virtual-fs `RootFileSystemBuilder`; mounting
  it stopped every command), so each bash writes passwd, group and hostname
  as it starts, from `BASH_ENV` (`app/src/sessionSystem.ts`). Checked by
  `test:wasix-terminal-browser` (prompt, `cd ~`, whoami/id/~/hostname) and
  `test:wasix-claude-bash-browser` (the same through Claude's Bash tool).
  An edit to /etc/passwd lasts one command.
- **A first-time user's Bash** (9 Nov), from a fresh host terminal. Working:
  `ls`, `cd ~`, Tab completion, history, `node -v`, `npm -v`, `python3 -V`,
  `git status` (says the empty workspace isn't a repository), nano. Fixed
  (`app/src/sessionSystem.ts`):
  - ~~`less` hung~~: it drew the file and then ignored every key, which
    queued up for bash (`q` turned the next command into `qecho`), until
    Ctrl-C. It reads keys from /dev/tty, which the session doesn't connect to
    the terminal. `less` and `more` now print the file; the terminal keeps
    scrollback.
  - ~~Long commands scrolled sideways~~ (a row starting `<`, the rest cut
    off): the session has no terminal description, so readline treated
    xterm as dumb. Bash's GNU termcap now gets an `xterm-256color` entry
    inline in `TERMCAP` (from ncurses, in THIRD_PARTY_NOTICES).
  - ~~`clear`, `which`, `man`~~ were "command not found"; `clear` and
    `which` are small scripts, `man` says there are no manual pages and to
    try `--help`.
  Checked by `test:wasix-terminal-browser` (less returns, a long line wraps;
  red without either fix) and `test:wasix-claude-bash-browser`.
  Left as they are: `ls -l` shows owners as `somebody somegroup` (the bash
  package's old uutils `ls`; GNU `ls` names `user` but shows every mode as
  `----------`, which is worse). Missing with bash's plain "command not
  found": `sudo`, `apt`/`apt-get`, `make`, `ssh`, `wget` (curl is there),
  `diff`, `patch`, `file`, `tput`, `ps`, `top`, `free`, `df`, `vi`/`vim`,
  `zip`/`unzip`; no /etc/os-release, and `uname` says
  `wasi riff 0.0.0 wasm32`. Any other program that reads keys from
  /dev/tty would hang the way less did. A `sudo` that runs its command
  (the guest is uid 0 already) would be cheap, but it pretends, so it's a
  call for Corey.

### P3: if there's time
- **A mode with no API key.** Decided 19 Oct (ADR 0009): Riff's own
  OpenRouter key behind a host-only proxy on our server. OpenCode Zen is
  out: measured 19 Oct, its free models answer 403 `FreeTierError` to
  anything but OpenCode itself. Being built now, ahead of the rest of P2,
  because without it a marker with no key can't see Claude work.
- **Send the board, or a selection, to Claude** (week-12 #5). Measured
  8 Nov on 2.1.221: pasting an absolute image path into Claude attaches
  the image, and the model gets an image block; images over 2000 px are
  dropped silently, so downscale in the browser first. A host-only button
  draws the shapes onto a canvas (quickdraw's `drawShape`/`pageBounds`),
  writes a PNG under `/tmp/riff/` in the pod and pastes its path. About
  2–3 h. Corey, 8 Nov: nice to have, not a priority. Participants
  attaching a selection to a staged prompt would be a sharing decision,
  not yet asked.

## Still open

- ~~**The host's preview runs Claude-written code on our origin, unsandboxed**~~
  Closed 8 Nov by ADR 0011 (option 2a, Corey's call): every member's
  preview loads from its room's own origin, `<label>.preview.airiff.tech`,
  through the relay, with `allow-same-origin` (storage works); a preview
  host reaches only the relay, Riff's host serves no relay documents, and
  Riff's worker refuses `/__virtual__/` navigations. Cost, measured: the
  host loses hot reload and its app's sockets, and round-trips. **Next
  (2b):** a service worker on the preview origin that forwards the host's
  frame's requests to its own Nodepod by `postMessage`, so the host's
  preview is local again.
- **Phone hosts and the 5-minute grace.** Android suspends background tabs,
  and how soon may vary by device and settings. Worth measuring on the
  Pixel before settling on 5 minutes; not urgent.
- **The course org's OAuth app restriction.** Still unapproved (18 Oct),
  and not blocking: course-org repos can be pulled, any other repo pushed,
  and a pasted token covers the rest.
- ~~**Who may view a kept, ended board.**~~ The host and its members (P1.4).
- ~~**How Claude Code reaches the build** (P1.1).~~ It doesn't: the browser derives it.
- ~~**Build the client in the Docker image**, or keep committing `app/dist/`.~~ Built in the image.

## Measuring claims

Every claim gets measured on the far side of the boundaries it crosses: the
host's browser to the relay to a participant, the client to the server to
disk, local to fly. Anything unmeasured is labelled a hypothesis. Persistence
claims are proved across `flyctl machine restart`.
