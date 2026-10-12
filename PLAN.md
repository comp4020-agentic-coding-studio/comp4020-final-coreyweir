# Plan

Where the project is headed and why, between now and A3 (noon, 9 November).
Decisions live in `docs/adr/`. This file is the order of work, plus the
details that would otherwise get lost between sessions. Update it when the
order changes or an item lands. Strike an item through, don't delete it,
so the plan's history stays readable.

## Phases

1. **Port** (done, `c8792b8..7af9c15`): the existing Riff, deployed on fly
   with server-side persistence.
2. **Assess and plan** (week 10, now): this file, and ADRs 0001–0004.
3. **Implement**, in the order below. Each change goes:
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
| [0002](docs/adr/0002-room-state-in-sqlite-as-an-append-log.md) | Room state in SQLite (`node:sqlite`) as an append-only update log, served by Hocuspocus | No |
| [0003](docs/adr/0003-room-lifecycle-and-board-retention.md) | 5-minute host grace, then the room ends. Host chooses at creation whether the board is kept (default: keep). No promised retention. Local copies for everyone. Export and import | No |
| [0004](docs/adr/0004-queue-release-manual-by-default.md) | Queue release: manual Send by default, auto toggle on turn end | No |

## Work, in order

### P0: crit 9 (today)
- [ ] Push the week-10 commits, run preflight.
- [ ] PROCESS.md update and `reflections/crit-9.md` (mine).

### P1: before crit 10 (19 Oct)

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
     - Unmeasured since: a dev server Claude starts with a wrapped
       `pnpm run dev` staying up under WASIX bash (the Mithic smoke was the
       only check). Test it before a crit relies on a Claude-started preview.
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
   - Left: `/data/yjs` (36 KB) is still on the volume; delete it once
     nobody needs an old room.
3. **Identity.**
   - Our own GitHub OAuth app. Sign-in asks for no permissions. "Connect
     GitHub for pushing" asks again for `repo` or `public_repo` when
     hosting. The course org restricts third-party OAuth apps: personal and
     public repos may be enough, or ask the convenor.
   - Authorization code flow with `state` and PKCE. The callback swaps the
     code for a token and holds it in memory, single use, for about 60s,
     tied to the session cookie. It then 303s to a clean URL, and the page
     POSTs `/api/github/token` to collect the token once. **The GitHub token
     is never stored on the server.** The server stores only
     `users(github_id, login, avatar)` and a signed httpOnly session cookie.
   - The landing page offers sign in with GitHub, or host or join without
     signing in. Guest mode stays.
4. **Server-side permissions** (needs an ADR; crit 10's written decision).
   - The server mints the host capability when the room is created,
     instead of letting the first connection claim it.
   - The server knows who the host is, instead of trusting the
     client-claimed `?host=1`.
   - The queue is host-only, enforced on the server (today `canQueue` only
     hides it in the UI). Hocuspocus `onAuthenticate` and read-only
     connections.
   - Decide who may view a kept, ended board (left open in ADR 0003).
5. **Audit log.** A who-did-what table with readable events: joined, left,
   prompt staged, sent (host or auto), room ended. Also printed to stdout,
   so I can narrate from `flyctl logs` at the crit.
6. **API proxy, so no secrets reach the guest.** Today the model token and
   GitHub token are in the guest's environment (`claudePod.ts:371-377`,
   `:603`), so `env` shows them live to the room.
   - Model it on the curl path. The net gateway already terminates guest TLS
     inside the tab, using a CA the browser generates (`netGatewayBrowser.ts`; design
     notes in `collab_riff/nodepod_wasix_fs_research/archive/completed-investigations/CURL_VIRTUAL_NET_GATEWAY.md`). So the tab can add the real credential
     to requests for the model API and GitHub.
   - The guest holds only a placeholder. Don't add the credential inside
     the guest (as in `nodepod_poc`'s `run.cjs`), where Claude can read it.

### P2: toward A3
- **Room lifecycle** (ADR 0003):
  - room records: state, the host's last-seen time, and a permanent id
    beside the join code;
  - a grace timer that survives restarts;
  - the "host away" and "ended" banners;
  - read-only connections for kept ended rooms, refused ones for not-kept;
  - pruning (oldest opened first, past a volume threshold) and a per-room
    size cap.
- **Local copies:**
  - file y-indexeddb copies under the permanent id;
  - "Rooms you hosted" and "Boards you've been in" lists, with delete;
  - copies never pushed back to an ended room, except the host reviving it.
- **Room list:**
  - live rooms you can join, plus rooms you hosted, and whether this
    browser still has their workspace in OPFS;
  - never a public directory.
- **Invite by GitHub username:**
  - look up the id via the public `GET /users/:login`;
  - the reply never says whether the account exists ("If those users have
    accounts, they've been invited");
  - invites last only as long as the room;
  - "colleagues" means people you've been in a room with.
- **OPFS workspace.**
  - The host's filesystem survives a reload or crash, one workspace per repo.
  - Check: reload mid-task, and unpushed edits are still there.
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

- **Phone hosts and the 5-minute grace.** Android suspends background tabs,
  so test on the Pixel before settling on 5 minutes.
- **The course org's OAuth app restriction.** Personal repos only, or ask the
  convenor.
- **Who may view a kept, ended board.** Decided with crit 10's permissions.
- ~~**How Claude Code reaches the build** (P1.1).~~ It doesn't: the browser derives it.
- ~~**Build the client in the Docker image**, or keep committing `app/dist/`.~~ Built in the image.

## Measuring claims

Every claim gets measured on the far side of the boundaries it crosses: the
host's browser to the relay to a participant, the client to the server to
disk, local to fly. Anything unmeasured is labelled a hypothesis. Persistence
claims are proved across `flyctl machine restart`.
