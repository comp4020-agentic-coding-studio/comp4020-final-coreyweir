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

Week 9. Crit 8 ("It's alive!") is today. Riff is deployed and room state
persists on the server. First job after the crit: make the client build
from `app/` (see Traps). Then crit 9 (real-time, plus one written decision on
multi-user behaviour), crit 10 (a structured server log line for every user
action, plus a live view), then A3 at noon on 9 November.

Update this section at each crit. A harness describing last week's project
steers the agent into last week's work.

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
- **Information durability.** Shared room state persists server-side (y-leveldb
  on the fly volume). Don't add room state that lives only in one client or
  in server memory.
- **No lock-in.** Anything that stores someone's work needs a way to export it.
  Don't add a store without one.

## Layout

- `app/`: the Riff tree (an npm project; its own `package.json` and lockfile).
  `app/server/` holds the node relays. `app/src/` is the client.
- `app/dist/`: the **prebuilt** client, committed. Deployed as-is.
- `deploy/`: nginx config and the start script. `Dockerfile` at the root.
- Root `package.json` (pnpm) is the course harness only: `spec/` and the
  checks. Never mix the two package managers or their lockfiles.
- `THIRD_PARTY_NOTICES.md` and `third_party/`: license obligations for what we
  ship. They are not optional.

## Traps

- **The client does not build from this repo yet.** `app/package.json` points
  `@wasmer/sdk` and `lemon-tls` at `file:../../…`, and Vite's `publicDir` at
  `../../nodepod_wasm_wip/…`. Those paths were written for
  `collab_riff/site_poc/riff_oauth` and resolve wrongly from `app/`. Until
  that's fixed, a client change means rebuilding in `collab_riff`, copying
  `dist/` across, and saying so in the commit. Never hand-edit `app/dist/`.
- **Changing the client without rebuilding changes nothing that's deployed.**
  Check that `app/dist/` matches the source change before calling it done.
- fly.toml sets `PORT=8080` for nginx. The node server also reads `PORT`, so
  `deploy/start.sh` pins node to 8093. Don't "simplify" that away.
- Every HTML and JS response needs COOP `same-origin` and COEP `require-corp`,
  or SharedArrayBuffer disappears and the host can't start Claude Code. A new
  nginx `location` that serves app files needs the headers too. `spec/` checks
  `/`, not every path.
- y-websocket keeps an empty room **in memory** whether or not persistence is
  on. A room that survives a reconnect proves nothing about a restart. Prove
  persistence with `flyctl machine restart` and then read the room back.
- The client still keeps its own IndexedDB copy of each room. "It persisted"
  has to say which store it came from.
- `/readme/` is generated from `README.md` at image build time. Editing the
  README changes nothing live until a redeploy.
- No local Docker. Build and deploy with `flyctl deploy --remote-only
  --ha=false -a comp4020-final-coreyweir`, run through `mise exec` from the
  repo root (the fly token lives in `mise.local.toml`).
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
