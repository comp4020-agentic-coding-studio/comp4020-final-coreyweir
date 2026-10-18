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
| [0003](docs/adr/0003-room-lifecycle-and-board-retention.md) | 5-minute host grace, then the room ends. Host chooses at creation whether the board is kept (default: keep). No promised retention. Local copies for everyone. Export and import | Partly: lifecycle, keeping, End room (`7928bac`, `8066106`, `d9a7766`, 18 Oct); not pruning, size cap, local copies, export |
| [0004](docs/adr/0004-queue-release-manual-by-default.md) | Queue release: manual Send by default, auto toggle on turn end | No |
| [0005](docs/adr/0005-identity-github-sign-in-and-room-scoped-guests.md) | Identity: GitHub sign-in on the server, guests exist only inside their room, encrypted push token in the browser | Yes (`389ffff`, `4acb32b`; push token in the client 18 Oct) |
| [0006](docs/adr/0006-who-may-see-and-change-what.md) | Who may see and change what, removal/lock/rotate, the who-did-what log. Crit 10's written decision. Amended 18 Oct: participants don't queue | Yes (`389ffff`, `4acb32b`, `f78b367`, `381dfba`) |
| [0007](docs/adr/0007-credentials-stay-in-the-tab.md) | The host's tokens stay in the page; the guest holds placeholders, swapped by our service worker (P1.6) | Yes (18 Oct) |
| [0008](docs/adr/0008-your-rooms-invites-and-colleagues.md) | Your rooms (members' and invited rooms only, live over a websocket), host-only invites by GitHub id, colleagues you keep; the room state half of 0003 | Yes (`a0bee0f`, `ef1401f`, `7e6023e`, `79a008f`, 18 Oct) |

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
  - pruning (oldest opened first, past a volume threshold) and a per-room
    size cap. **Needs a decision first:** the threshold, the cap, and what
    the cap does when reached.
- **Local copies:**
  - file y-indexeddb copies under the permanent id;
  - "Rooms you hosted" and "Boards you've been in" lists, with delete;
  - copies never pushed back to an ended room, except the host reviving it.
- **Export:**
  - Room file: quickdraw `getSnapshot()` JSON with images as they are, plus
    the prompts and metadata. Optionally a PNG via `exportImage()`.
  - Workspace: zip of OPFS (fflate), including Claude transcripts from
    `~/.claude/projects/-work-repo/`, never credentials.
- **Import:**
  - Room file into a new room, the host's choice. Known fields only,
    images byte-for-byte.
  - If time allows: check each image decodes, matches its type
    (PNG, JPEG, WebP or GIF, no SVG) and fits within 2048px.
  - Transcripts: allowed, with warnings on both export and import.
- **OPFS workspace.**
  - The host's filesystem survives a reload or crash, one workspace per repo.
  - Check: reload mid-task, and unpushed edits are still there.
- **Clone the host's repository automatically.** The host form's "Git
  repository" field is never used to clone: today it only makes the room
  ask for GitHub (`App.tsx`, `RoomGate`), and Claude has to be told to
  clone. Clone it into `/work/repo` at boot with the push token (or
  anonymously for a public repo). Goes with the OPFS workspace, which is
  keyed by the same repository: an existing workspace is opened, not
  re-cloned.
- **Queue release** (ADR 0004):
  - Send submits with newlines intact; an auto toggle, visible to the room.
  - Planned mechanism: a Claude Code mod. That needs the bundle upgraded
    from 2.1.221 to 2.1.287+ and the `claudeBundle.ts` patches redone, which
    also brings newer models.
  - Fallback: `Stop` and `UserPromptSubmit` settings hooks, plus a
    bracketed paste and a separate enter.
  - Either way, `riff-hook` is the channel to the page, as a Nodepod
    `externalCommands` entry.
- **Clipboard.** Claude Code copies a selection with OSC 52, which xterm.js
  ignores. Load `@xterm/addon-clipboard`. Fallback: `copyOnSelect: false` in
  `/home/user/.claude.json` and Shift+drag. Check the participants' mirror
  too.
- **Terminal redeploy gap** (ADR 0001): forget the host's last snapshot when
  the relay accepts the host again.

### P3: if there's time
- **A mode with no API key.** OpenCode Zen is likely ruled out: its terms
  restrict use to "your own internal use", it only offers
  `/v1/chat/completions`, and it sends no CORS headers. Options: an
  in-browser model (WebLLM, transformers.js, Chrome's built-in model), or the
  marker's course key.

## Still open

- **The host's preview runs Claude-written code on our origin, unsandboxed**
  (to revisit after the first P2 items)
  (`App.tsx:214`; participants' frames are sandboxed without
  `allow-same-origin`). It can read localStorage and call `/api` with the
  host's cookie. Accepted for now: the alternative routes the host's own
  preview through the server and back. Revisit with the guest-preview
  subdomain question.
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
