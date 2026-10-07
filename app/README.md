# Riff Functional Spike

The first functional implementation of the collaborative studio space. This is deliberately narrower than the visual prototypes: it validates shared whiteboard records, collaborative prompt text, room presence, and reconnect persistence before Claude and preview transport are introduced.

## Run

```sh
npm install
npm run dev
```

Open the printed local URL, then host a new room or join with an existing room ID. Host configuration is remembered in that browser. Use **Share room** to copy a participant link, then open it in another browser or private window to test collaboration.

### GitHub authentication PoC

Open `/?poc=github-auth` to test GitHub's OAuth device flow separately from room creation and Nodepod. During this development spike, the flow uses GitHub CLI's public OAuth client identity and retains the resulting token only in page memory. Reloading or leaving the page forgets it.

The Vite development server provides the fixed-purpose same-origin proxy required because GitHub's OAuth token endpoints do not support browser CORS. No client secret is used. Override the temporary client identity when a project-owned OAuth app is available:

```sh
GITHUB_OAUTH_CLIENT_ID="your-client-id" npm run dev
```

This authentication identity must be replaced before student-facing deployment.

When a facilitator creates or refreshes a room with a Git repository configured, Riff requires this authentication before opening the workspace. The token is added to the in-memory Nodepod environment as `GITHUB_TOKEN` and `GH_TOKEN`, making it available to Claude and Nodepod's Git wrapper. It is never added to the persisted host configuration or collaborative room state.

The postinstall patch also delegates Git commands invoked synchronously by Claude's Mithic shell to Nodepod's child-worker command path. This keeps fast local queries such as `git --version` synchronous while allowing implemented commands such as `clone`, `fetch`, `pull`, and `push` to perform asynchronous GitHub API requests.

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
- Session-only GitHub authentication through device OAuth or a provided PAT

## Intentional boundaries

- Terminal publication uses a host capability kept out of participant links, but room creation is not yet authenticated against a durable server identity.
- Relay traffic is not yet encrypted.
- Anyone with a room code can access that room's relayed Preview while its facilitator is connected.
- Quickdraw records currently use whole-record Yjs conflict resolution.

## Claude integration spike

The Nodepod PoC remains a read-only sibling dependency. With Claude credentials in the environment, validate that one persistent process accepts multiple structured turns:

```sh
npm run test:claude-stream
```

The smoke test boots the existing Nodepod bundle, starts a structured session with one prompt, writes a follow-up `stream-json` user message through the public process API, and verifies that both results use the same Claude session. This validates an automation seam alongside the primary facilitator-owned interactive terminal.

See [`docs/claude-nodepod-integration.md`](docs/claude-nodepod-integration.md) for the controller boundary and the local-versus-shared preview constraint.

During this prototype, Vite serves the prepared Mithic browser assets and the Claude launcher (`shim.cjs`, `run.cjs`) read-only from `../../nodepod_wasm_wip/browser/public`. The pinned Nodepod compatibility patch is also invoked from that sibling project after install. A deployable package or artifact pipeline is still required before `riff-app` can stand alone.

### Claude runtime derivation

Riff does not serve or ship a prebuilt `claude-booted.patched.js`. [`src/claudeBundle.ts`](src/claudeBundle.ts) derives it in the browser on first boot: it streams the published `@anthropic-ai/claude-code-darwin-x64` tarball from registry.npmjs.org, gunzips and untars it on the fly, reads the JavaScript bundle out of the Bun executable's Mach-O `__BUN,__bun` section, and applies the boot and Nodepod source patches. Only the ~23 MB of JavaScript is retained; the surrounding ~280 MB streams past and is discarded. The result is verified against `CLAUDE_BUNDLE_SHA256` and kept in Cache Storage, so the ~82 MB transfer happens once per browser (about 8 s cold, 40 ms warm).

Bumping `CLAUDE_VERSION` requires re-pinning `CLAUDE_BUNDLE_SHA256` and re-checking every patch in `patchClaudeSource`, which matches against minified identifiers. `npm run test:claude-bundle` prints the digest it derived and names any patch that stopped applying. The prebuilt copies in the shared publicDir belong to `nodepod_wasm_wip`; the `riff-exclude-claude-bundle` Vite plugin keeps them out of Riff's dev server and build output.

## Tests

The collaboration test starts its own temporary relay, so the development server does not need to be running:

```sh
npm run test:collaboration
npm run test:terminal-relay
npm run test:github-auth
npm run test:git-sync
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
