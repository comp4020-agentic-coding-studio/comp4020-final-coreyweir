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

Week 10. Crit 9 ("All at once") was today; its decision is `docs/adr/0001`.
Next is crit 10 on 19 October: the server tells people apart, checks what
each may see and change, and logs who did what in a way that outlives the
crit. That is built (`docs/adr/0005`, `docs/adr/0006`, checked in
`spec/permissions.test.ts`); what's left of it is in `PLAN.md`. A3 is due at
noon on 9 November.

Update this section at each crit. A harness describing last week's project
steers the agent into last week's work.

## How we work: phases

The project moves in phases, and the commit history should show it. Don't
skip ahead to building something the current phase hasn't decided on.
`PLAN.md` holds the order of work and its details. Read it before starting
an item, and update it when the item lands.

1. **Port** (done, `c8792b8..7af9c15`): the existing Riff deployed on fly,
   with server-side persistence.
2. **Assess and plan** (now): measure Riff against the brief and the README,
   and settle priorities and architecture. Decisions are recorded as ADRs in
   `docs/adr/`, with the options, the choice and its cost.
3. **Implement**, in priority order. Each change goes: decision (an ADR if it
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
- The client still keeps its own IndexedDB copy of each room. "It persisted"
  has to say which store it came from.
- `/readme/` is generated from `README.md` at image build time. Editing the
  README changes nothing live until a redeploy.
- No local Docker. Build and deploy with `flyctl deploy --remote-only
  --ha=false -a comp4020-final-coreyweir`, run through `mise exec` from the
  repo root (the fly token lives in `mise.local.toml`).
- Don't assume the host is on a desktop. Hosting works on a phone (tested on
  a Pixel 6), so both roles have to work at 390×844.
- **`RIFF_ORIGIN` is required.** The server checks `Origin` on every POST and
  websocket upgrade against it and builds the GitHub `redirect_uri` from it,
  never from the `Host` header. Production sets it in `fly.toml`; dev
  defaults to `http://127.0.0.1:8093`. Use `127.0.0.1`, never `localhost`:
  cookies are per host and GitHub's callback is registered for `127.0.0.1`.
- Start the dev server through `mise exec -- npx vite --host 127.0.0.1
  --port 8093 --strictPort` (in `app/`), or it has no GitHub client secret
  or session secret and sign-in answers 503.
- **Fly's proxy holds a websocket open after the server closes it.** The
  browser only finds out ~3 s later. Anything that shuts someone out tells
  the client in-band first (Hocuspocus `PermissionDenied`, a relay `error`
  message), then closes with `hangUp` (`app/server/sockets.mjs`). Checked
  live, not just on dev, where nginx closes at once.
- Type-check the client with `npm run typecheck` (`tsc -b`). `tsc -p .`
  checks nothing, because the root tsconfig only holds references.
- Preview relaying routes on path prefixes (`/room-preview/`,
  `/preview-control/`). fly.dev can't do wildcard subdomains, so keep it that
  way.

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
