# Harness

## What this repo is

**Riff**: a room where a group prompts one Claude Code together. The host runs
Claude Code in their own browser (Nodepod + WASIX). Everyone else shares the
room: a whiteboard, prompts they write together, a facilitator queue, a
read-only view of the host's terminal, and a live preview of the host's dev
server. It is the COMP4020 final project: a multi-user, real-time website that
has to be *good*, judged against `README.md`.

Riff existed before this repo. It is my own earlier work, imported as one
commit (`c8792b8`, from `collab_riff/site_poc/riff_oauth@993c5a3`). The marker
reads that commit as the boundary: **everything after it is what gets marked**.
Reused code does not answer the brief. What I change, decide and justify does.

## Where we are

Week 13, the last stretch before A3 (noon, 9 November). The crits are
over. Built so far: identity, rooms and permissions with the who-did-what
log (ADRs 0005, 0006), credentials kept out of the guest (0007), "Your
rooms", invites and colleagues (0008), the room lifecycle, size cap,
pruning, local copies, board export/import (JSON and PNG), reopening,
leaving and deleting (0003), Riff's own free models for hosts (0009), the
OPFS workspace with clone at boot, workspace export and import (0010,
0003), queue auto-release (0004), the preview on its own origin (0011,
2a), MCP servers for the host's Claude (0012), and the week-12 crit's
bugs (`docs/week-12.md`).

What's left is measured against `README.md`: verification on live, the
preview's 2b (ADR 0011, designed), and polish (see `PLAN.md`). Work is
done in parallel, each in its own git worktree; only the main checkout
deploys.

Update this section at each crit. A harness describing last week's project
steers the agent into last week's work.

## How we work: phases

The project moves in phases, and the commit history should show it. Don't
skip ahead to building something the current phase hasn't decided on.
`PLAN.md` holds the order of work and its details. Read it before starting
an item, and update it when the item lands.

1. **Port** (done, `c8792b8..7af9c15`): the existing Riff deployed on fly,
   with server-side persistence.
2. **Assess and plan** (done, ADRs 0001–0006 and `PLAN.md`; later ADRs come with the work): measure Riff
   against the brief and the README, and settle priorities and
   architecture. Decisions are recorded as ADRs in `docs/adr/`, with the
   options, the choice and its cost.
3. **Implement** (now), in priority order. Each change goes: decision (an ADR if it
   changes how people share a room), then a check in `spec/` where it can be
   tested, then the change, then verification on the live app, then a commit.

The README's definition of good is meant to change as the work teaches us
what good is, up to 9 November. When it does, the "What good means" section
below changes in the same commit.

## What good means

Derived from `README.md`. If the README changes, this section changes in the
same commit. Each README quality turns into what it means for a change:

- **Ease of use.** Joining takes a name and a room code, nothing more. Hosting
  takes a name, an API endpoint and token, and GitHub. A change that adds a
  step to either path needs my sign-off. Test the first-run path in a fresh
  browser profile, because a stored identity hides it.
- **Resilience.** The host's filesystem survives a reload or a crash. Verify a
  change to Nodepod storage or the session lifecycle by reloading mid-task
  and confirming unpushed edits are still there.
- **Versatility.** Never special-case Vite, JS or one port. The terminal and
  preview relays must not assume a framework or a language.
- **Communications reliability.** A prompt arrives exactly once. A change to
  the prompt or queue path needs a two-client check for both drops and
  duplicates. Judge terminal output from a participant's session, not the
  host's.
- **Not too opinionated.** Where hosts could reasonably differ (manual versus
  automatic release from the queue), make it a setting, not a hard-coded
  behaviour. Ask me before picking the default.
- **Information durability.** Shared room state persists server-side: every
  update is a row in SQLite on the fly volume (`/data/riff.sqlite`,
  `docs/adr/0002`). Don't add room state that lives only in one client or
  in server memory. The one deliberate exception is the terminal mirror: it
  stays in memory and never reaches disk, because it can show secrets
  (`docs/adr/0001`). Don't "fix" that.
- **No lock-in.** Anything that stores someone's work needs a way to export it.
  Don't add a store without one.

## Layout

- `app/`: the Riff tree (an npm project; its own `package.json` and lockfile).
  `app/server/` is the node server: `riff.mjs` assembles it (store, sign-in,
  rooms API, Hocuspocus, relays, log) and both `index.mjs` (production) and
  the Vite dev server mount it. `app/src/` is the client.
- `app/dist/`: build output, gitignored. The Docker image builds the client
  itself (first stage of `Dockerfile`), so a deploy always ships the source.
- `deploy/`: nginx config and the start script. `Dockerfile` at the root.
- Root `package.json` (pnpm) is the course harness only: `spec/` and the
  checks. Never mix the two package managers or their lockfiles.
- `THIRD_PARTY_NOTICES.md` and `third_party/`: license obligations for what we
  ship. They are not optional.

## Traps

- **The client builds here, from `app/` alone** (`npm ci && npm run build`).
  The three forks are packed archives in `app/vendor/`, and `app/public/`
  holds the Claude launcher (`shim.cjs`, `run.cjs`). Nothing may point outside the repo
  again (`file:../../…`, a `publicDir` or `fs.allow` beyond `app/`). A fork
  change is made in its own repo, packed, and installed per
  `app/vendor/README.md`.
- **Claude Code is never in the repo or the build.** The browser derives it
  from the npm tarball (`app/src/claudeBundle.ts`). Don't copy
  `claude-booted*` into `app/public/`, whatever `nodepod_wasm_wip` does.
- **`.dockerignore` patterns match from the context root.** Write
  `**/node_modules`, not `node_modules`, or 200 MB of `app/node_modules`
  uploads with every deploy.
- fly.toml sets `PORT=8080` for nginx. The node server also reads `PORT`, so
  `deploy/start.sh` pins node to 8093. Don't "simplify" that away.
- Every HTML and JS response needs COOP `same-origin` and COEP `require-corp`,
  or SharedArrayBuffer disappears and the host can't start Claude Code. A new
  nginx `location` that serves app files needs the headers too, plus CSP
  `upgrade-insecure-requests` (without it the guest's plain-http requests are
  blocked as mixed content). `spec/headers.test.ts` checks the page, a room
  link and one script, not every path. Never add that CSP to Vite's dev
  server: on `http://127.0.0.1` it upgrades the page's own assets.
- A change is saved when the server **acknowledges** it. The store writes
  each update from the Yjs document's own `update` event, which runs before
  Hocuspocus sends the ack. Its `onChange` hook runs after the ack, so don't
  move the write there. Wait on the ack (`unsyncedChanges` reaching 0), never
  on a sleep.
- A room that survives a reconnect proves nothing about a restart. Prove
  persistence with `flyctl machine restart` and read the room back; the log
  line `doc <name> loaded: N rows` shows it came from disk.
  `npm run test:collaboration` (in `app/`) covers SIGKILL and compaction.
- A server write to a room document (`change()` in
  `app/server/collaboration.mjs`) unloads it afterwards, and Hocuspocus
  4.7.0 does that twice, by name. The `beforeUnloadDocument` guard there
  stops the second one dropping a copy a client opened in between. Don't
  remove it; `npm run test:collaboration` checks it. When a client "stops
  receiving" server writes while still connected, suspect a document that
  was unloaded under it before suspecting the client.
- spec/ can't read the log of a deployed app. A change to what the log
  records gets a check in `npm run test:audit-log` (in `app/`), which reads
  the `events` table back, and a look at `flyctl logs` after deploying.
- **A room holds 4 MB, and a full room is read-only for everyone for
  good** (`docs/adr/0003`, amendment): 16 MB ran the 256 MB machine out of
  memory. Don't raise it without measuring node's memory on the machine.
  A smoke or spec that fills rooms should use rooms that aren't kept and
  end them, so the board is deleted. Room creation is rate-limited per IP
  (60 per 10 minutes): many smoke runs against dev end in 429
  `slow_down`; restart the dev server.
- The client still keeps its own IndexedDB copy of each room, listed on
  the room's row in "Your rooms" (`app/src/copies.ts`). "It persisted" has to say
  which store it came from. Open a copy through `openCopy()`, never a bare
  `IndexeddbPersistence`, so deleting it from another tab doesn't break the
  tab that has it open.
- A board file is read with `parseBoardFile()` (`app/src/boardFile.ts`),
  which copies known fields only. A new quickdraw shape type or prop needs
  adding there, or import silently leaves it out (it says so in "Left out").
- `/readme/` is generated from `README.md` at image build time. Editing the
  README changes nothing live until a redeploy.
- Push to `origin` (HTTPS, a token approved for the course organisation,
  deliberately without the `workflow` scope). When a push is refused
  because it changes `.github/workflows/`, push the same commits through
  the `ssh` remote. Don't suggest changing the token's scopes.
- Deploy only with `flyctl deploy --remote-only --ha=false -a
  comp4020-final-coreyweir`, run through `mise exec` from the repo root
  (the fly token lives in `mise.local.toml`). Local Docker works and is
  for reproducing CI, never for deploying: build the image and run it as
  `.github/workflows/checks.yml` does (`docker build -t riff-ci .`, then
  `docker run` with its env on a spare port, then `pnpm check` with
  `APP_URL` on that port). It's the only local setup with nginx in front,
  so a fault that passes on dev and fly but fails in CI shows up there.
- Don't assume the host is on a desktop. Hosting works on a phone (tested on
  a Pixel 6), so both roles have to work at 390×844.
- **`RIFF_ORIGIN` is required.** The server checks `Origin` on every POST and
  websocket upgrade against it and builds the GitHub `redirect_uri` from it,
  never from the `Host` header. Production sets it in `fly.toml`; dev
  defaults to `http://127.0.0.1:8093`. Use `127.0.0.1`, never `localhost`:
  cookies are per host and GitHub's callback is registered for `127.0.0.1`.
- Start the dev server through `mise exec -- npx vite --host 127.0.0.1
  --port 8093 --strictPort` (in `app/`), or it has no GitHub client secret
  or session secret and sign-in answers 503. In a git worktree, copy
  `mise.local.toml` from the main checkout first, without its
  `FLY_API_TOKEN` line (it's gitignored; never commit it). Use your own
  port, with `RIFF_ORIGIN` set after mise's (`mise exec -- env
  RIFF_ORIGIN=http://127.0.0.1:<port> npx vite … --port <port>`), so
  parallel dev servers don't collide. Each worktree's `app/.data/` is its
  own database.
- **Fly's proxy holds a websocket open after the server closes it.** The
  browser only finds out ~3 s later. Anything that shuts someone out tells
  the client in-band first (Hocuspocus `PermissionDenied`, a relay `error`
  message), then closes with `hangUp` (`app/server/sockets.mjs`). Checked
  live, not just on dev, where nginx closes at once.
- Vite restarts the dev server when a server file changes, and a restart
  that reads a half-edited set of files fails and **leaves the old server
  running**. After editing several server files, check its output for
  "server restart failed" and `touch app/server/riff.mjs` if needed.
- In a browser smoke, wait inside the participant's preview iframe with
  `{ polling: 100 }`. The default polls on animation frames, which Chrome
  starves in a sandboxed iframe it runs out of process (as on https), so a
  wait times out on live while passing on dev.
- Type-check the client with `npm run typecheck` (`tsc -b`). `tsc -p .`
  checks nothing, because the root tsconfig only holds references.
- **No real credential goes into the guest** (its environment, files or
  launcher), whatever is convenient. The guest gets a placeholder from
  `app/src/credentials.ts` and `app/public/riff-sw.js` swaps it in on the
  way out, for that credential's origins only (`docs/adr/0007`). Nodepod
  must keep booting with `swUrl: "/riff-sw.js"`, and a new credential needs
  its own origins. `npm run test:credentials-browser` checks it.
- **A preview never runs on Riff's origin** (`docs/adr/0011`). Each room's
  preview is served on `<label>.preview.airiff.tech` (`RIFF_PREVIEW_ORIGIN`
  in `fly.toml`: a custom domain with a wildcard DNS name and certificate
  on this same fly app); dev uses `*.preview.localhost:<port>`, which
  Chrome and Node resolve to loopback. A preview host reaches only the
  relay, and Riff's host refuses `/room-preview/`; the node server enforces
  both, so check on dev, not just behind nginx. Don't frame or open
  `/__virtual__/` on Riff's origin (`riff-sw.js` refuses it), and don't drop
  `allow-same-origin` from the preview frame "to be safe": storage needs it,
  and the foreign origin is what keeps it safe. The relay itself still
  routes on path prefixes (`/room-preview/`, `/preview-control/`).

## Working rules

- `pnpm check` (with `APP_URL` set to the running app or the live URL) before
  reporting anything done. A spec test that passes for the wrong reason is
  worse than a red one. Say what the test can't tell apart.
- Commit as you go, one logical change per commit, with messages that say
  *why*. These commits are the evidence PROCESS.md cites.
- When I correct something that will recur, add the rule here in the same
  commit as the fix.
- Shipping a new third-party binary or dependency means updating
  `THIRD_PARTY_NOTICES.md` in the same commit. A GPL binary also needs its
  corresponding source in `third_party/`.
- Measure a claim on the far side of every boundary it crosses: host browser
  to relay to participant, client to server to disk, local to fly. Label
  anything unmeasured as a hypothesis.
- Prefer principled fixes over timing heuristics. This system has several
  runtimes, and a sleep that works here fails somewhere else.
- Fork changes (wasmer-js-fork, lemon-tls-browser, nodepod, bash-wasix-fork)
  are made and committed in the repo that owns the source, then rebuilt here.
  `collab_riff/nodepod_wasix_fs_research/docs/maintenance.md` says which repo
  owns what.
- Bring me the decision, not the finished feature, when it changes how people
  share a room (who can do what, what's visible to whom, what persists). Those
  calls are the project.
- README.md, PROCESS.md and reflections are mine to write. Help by checking
  facts and finding commits, not by drafting prose.
