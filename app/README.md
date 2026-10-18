# Riff Functional Spike

The first functional implementation of the collaborative studio space. This is deliberately narrower than the visual prototypes: it validates shared whiteboard records, collaborative prompt text, room presence, and reconnect persistence before Claude and preview transport are introduced.

## Run

```sh
npm install
npm run dev
```

Open the printed local URL, then host a new room or join with an existing room ID. Host configuration is remembered in that browser. Use **Share room** to copy a participant link, then open it in another browser or private window to test collaboration.

### GitHub sign-in

Sign-in is GitHub's OAuth web flow with state and PKCE, answered by the node
server (`server/auth.mjs`, `docs/adr/0005` at the repo root). It needs
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` and
`RIFF_ORIGIN` (Fly secrets and `fly.toml` in production, `mise.local.toml`
locally); without the secret, sign-in answers 503. Start the dev server
through mise so it sees them:

```sh
mise exec -- npx vite --host 127.0.0.1 --port 8093 --strictPort
```

"GitHub for pushing", in host setup, is the same flow with the `repo` scope,
or a pasted token (which must belong to the signed-in user). The server
seals the token with a key from the session and the browser keeps only the
ciphertext (`riff-github-push` in localStorage); the host's page opens it
at room start (`POST /api/github/token/unwrap`). Signing out or the session
ending makes the stored copy useless, and the room tells the host before
Claude starts without it. `npm run test:github-push-browser` checks the
page's side.

### Credentials stay in the page

Neither the model token nor the GitHub token enters the guest
(`docs/adr/0007` at the repo root). The pod's `ANTHROPIC_AUTH_TOKEN` (or
`ANTHROPIC_API_KEY`), `GITHUB_TOKEN` and `GH_TOKEN` hold placeholders
(`riff-placeholder-<kind>-<hex>`, new each boot). Nodepod boots with
`public/riff-sw.js` as its service worker, which wraps Nodepod's own
`/__sw__.js`: a request carrying a placeholder gets the real value from the
host's page (`src/credentials.ts`), only if it is going to that
credential's own origins (the model endpoint; `api.github.com`,
`github.com`, `uploads.github.com`), and streams the reply back.
`npm run test:credentials-browser` (dev server) checks it end to end.

## Implemented

- Quickdraw infinite canvas with drawing, notes, images, selection, undo, pan, and zoom
- Quickdraw record diffs translated into a shared Yjs map
- Collaborative staged prompt bodies backed by `Y.Text`
- Facilitator queue action and shared queue state
- Yjs awareness-based participant presence
- Local IndexedDB persistence per room
- Yjs WebSocket relay attached to the Vite development server
- Host/join landing flow with explicit display names and locally remembered host configuration
- Room-scoped participant Preview relayed from the facilitator's browser-local Nodepod server
- Facilitator-owned interactive Claude Code terminal running in browser Nodepod
- Live read-only xterm output for participants with periodic recovery checkpoints
- GitHub sign-in (web flow); a push token, OAuth or pasted, sealed by the server for the host's browser
- Model and GitHub tokens kept out of the guest: placeholders in its environment, swapped by the page's service worker

## Intentional boundaries

- Relay traffic is not yet encrypted.
- Quickdraw records currently use whole-record Yjs conflict resolution.

## Claude integration spike

The Nodepod PoC remains a read-only sibling dependency. With Claude credentials in the environment, validate that one persistent process accepts multiple structured turns:

```sh
npm run test:claude-stream
```

The smoke test boots the existing Nodepod bundle, starts a structured session with one prompt, writes a follow-up `stream-json` user message through the public process API, and verifies that both results use the same Claude session. This validates an automation seam alongside the primary facilitator-owned interactive terminal.

See [`docs/claude-nodepod-integration.md`](docs/claude-nodepod-integration.md) for the controller boundary and the local-versus-shared preview constraint.

The Claude launcher (`shim.cjs`, `run.cjs`) lives in `public/claude/`, copied from `nodepod_wasm_wip/browser/public`. `@scelar/nodepod`, `@wasmer/sdk` and `lemon-tls` are packed fork builds in `vendor/` (see `vendor/README.md`), so `npm ci && npm run build` works from a clean clone with nothing beside it.

### Claude runtime derivation

Riff does not serve or ship a prebuilt `claude-booted.patched.js`. [`src/claudeBundle.ts`](src/claudeBundle.ts) derives it in the browser on first boot: it streams the published `@anthropic-ai/claude-code-darwin-x64` tarball from registry.npmjs.org, gunzips and untars it on the fly, reads the JavaScript bundle out of the Bun executable's Mach-O `__BUN,__bun` section, and applies the boot and Nodepod source patches. Only the ~23 MB of JavaScript is retained; the surrounding ~280 MB streams past and is discarded. The result is verified against `CLAUDE_BUNDLE_SHA256` and kept in Cache Storage, so the ~82 MB transfer happens once per browser (about 8 s cold, 40 ms warm).

Bumping `CLAUDE_VERSION` requires re-pinning `CLAUDE_BUNDLE_SHA256` and re-checking every patch in `patchClaudeSource`, which matches against minified identifiers. `npm run test:claude-bundle` prints the digest it derived and names any patch that stopped applying. `nodepod_wasm_wip` keeps prebuilt copies for its own demo; they were deliberately not copied into `public/`, and `.gitignore` refuses `public/claude/claude-booted*`.

## Tests

The collaboration test starts its own temporary relay, so the development server does not need to be running:

```sh
npm run test:collaboration
npm run test:audit-log             # the who-did-what log, read back from SQLite
npm run test:rooms                 # your rooms, invites, colleagues, the grace timer (signed in, in-process)
npm run test:rooms-browser         # needs the dev server; writes a signed-in user into the dev database
npm run test:lifecycle-browser     # needs the dev server, or RIFF_URL=<live>; W/H for the viewport
npm run test:limits-browser        # needs the dev server, or RIFF_URL=<live>; W/H for the viewport
npm run test:terminal-relay
npm run test:github-push-browser   # needs the dev server
npm run test:credentials-browser   # needs the dev server; ECHO_BASE=https://httpbin.org against live
npm run test:claude-bundle
```

`test:claude-bundle` downloads the 82 MB Claude tarball into `.cache/` the first time and replays it from a loopback server afterwards. Set `CLAUDE_BUNDLE_LIVE=1` to always fetch registry.npmjs.org instead.

With the development server running on port 8094, the browser Git regression can also be exercised directly:

```sh
npm run test:git-sync-browser
```

With the development server running on port 8093 and Chromium installed:

```sh
npm run test:terminal-browser
npm run test:claude-bundle-browser
```

### The WASIX suite

The WASIX work has twenty-odd individual suites. Run them as one command, which
starts a development server on 8093 if one is not already up and stops it
afterwards:

```sh
npm run test:wasix                      # everything
npm run test:wasix -- --list            # what would run, and in what order
npm run test:wasix -- --only bridge     # just the bridge family
npm run test:wasix -- --no-server       # a server is already running
```

Suites run cheapest-first — `typecheck` and the three Node-only suites before
any browser smoke — so a type error or a unit failure surfaces in seconds rather
than after twenty minutes of cold WASM starts. A failing suite does not stop the
run; the summary at the end is the point.

Environment: `RIFF_URL` (default `http://127.0.0.1:8093`), `RIFF_PORT`,
`CHROMIUM_PATH` (default `/usr/local/bin/chromium`), `RIFF_SUITE_TIMEOUT_MS`
(default 900000, per suite).
