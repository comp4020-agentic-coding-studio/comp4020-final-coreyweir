# Claude and Nodepod integration

## Recommended boundary

Only the facilitator browser boots Nodepod and owns Claude credentials. Riff should wrap Nodepod behind a small controller rather than importing the DOM-bound PoC UI:

```ts
interface ClaudePodController {
  boot(config: HostConfig): Promise<void>;
  attachTerminal(target: HTMLElement): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  interrupt(): void;
  serializeTerminal(): string;
  previewUrl(port: number): string | null;
  dispose(): Promise<void>;
}
```

The initial implementation can recreate the boot logic from `nodepod_wasm_wip/browser/main.js` while treating that project as read-only. A later extraction into a reusable package is preferable once the boundary is proven.

## Interactive terminal

The primary interface is one interactive Claude Code terminal owned by the facilitator. Build it with Nodepod's `createTerminal()` and xterm.js, following the working raw-input and resize handling in `nodepod_wasm_wip/browser/main.js`. Only the facilitator page receives the host token, Nodepod instance, terminal input wiring, interrupt control, and permission prompts.

Claude itself is launched with direct `pod.spawn()` rather than by typing a command through Nodepod's shell terminal. Riff wires xterm input to `NodepodProcess.write()`, writes process output and errors explicitly into xterm, and pushes terminal dimensions to the live process wrapper. This matches the PoC path that reliably paints Claude's Ink UI; the shell-command path could run Claude without reliably forwarding its interactive output.

Riff currently applies local compatibility patches for dev servers launched by Claude. `patchMithicRunner()` intercepts simple `npm`, `pnpm`, `yarn`, and `bun` `dev` commands in Mithic's parsed command dispatcher, resolves the underlying package script, and delegates it through asynchronous `child_process.spawn()` instead of Mithic's blocking `execFileSync()` adapter. Dispatch-level interception is required because Claude wraps even a visible `pnpm run dev` in a generated shell program containing setup, `eval`, and working-directory bookkeeping. The patch marks only the delegated child with `RIFF_PERSISTENT_DEV_SERVER=1`. The Nodepod postinstall patch creates marked delegates as persistent `shell` workers, matching `createTerminal()`, and promotes their process context out of the loaded Mithic worker; normal children retain their existing lifecycle, and the existing `_childPids` mapping still provides recursive cancellation. Keep `scripts/nodepod-background-browser-smoke.mjs` passing when these changes are eventually merged into this repository's Nodepod runtime. Removing any layer regresses Claude's wrapped `pnpm run dev` while direct Nodepod terminal execution still works.

Participants render the same terminal state in xterm.js with input disabled. Riff batches normalized ANSI output into live relay events and publishes periodic serialized checkpoints. Late participants receive the latest checkpoint plus its retained output tail, while sequence gaps recover at the next checkpoint without putting terminal history in Yjs.

Queued prompts remain proposals until the facilitator runs them. The host controller can inject an approved prompt with `NodepodProcess.write()` when Claude is ready, while the facilitator can always type, answer permission prompts, interrupt, or decline the queued item directly in the authoritative terminal.

Mirroring a terminal can expose anything printed there. The host UI should state that terminal output is shared with the room, even though credentials and keystrokes remain local.

## Structured automation

Start one persistent process in `/work/repo`:

```text
node /opt/claude/run.cjs -p <first-prompt> \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --replay-user-messages \
  --session-id <uuid> \
  --permission-mode dontAsk
```

Lazily spawn the process with the first queued prompt as the `-p` argument. In the current Nodepod build, spawning without that argument and calling `write()` immediately races Claude's initial stdin check. Send later queued prompts with `NodepodProcess.write()` as newline-delimited user messages. A `result` event completes that queue item; a Stop hook is not required to advance the queue. Keep token deltas and hook progress ephemeral, but persist normalized user, assistant, tool, result, and error summaries for reconnecting participants.

This protocol is useful for tests, optional unattended queue runs, and normalized activity extraction. It is not the primary classroom UI. Use a conservative tool allowlist for unattended execution. `dontAsk` is appropriate only when all required tools are explicitly allowed; permission requests cannot be answered through ordinary user-message input.

`npm run test:claude-stream` exercises two prompts in one process and verifies session continuity. It requires host Claude credentials in the environment and imports only the existing sibling PoC helper.

## Queue authority

The shared Yjs queue is collaborative intent, not execution authority. The facilitator claims an item and explicitly sends it into the host terminal. Participants may create, edit, and reorder proposals, but they never receive the host token, terminal input access, interrupt control, or direct access to the Nodepod process.

The first implementation uses **Load** rather than automatic submission. It inserts a flattened queued prompt into Claude's input, leaving the facilitator to edit it and press Enter.

## Preview

Nodepod's browser API exposes guest servers through `onServerReady(port, url)`, `pod.port(port)`, and `pod.request(port, init)`. The facilitator can immediately render `pod.port(port)` in a local iframe after a guest dev server calls `listen()`.

That URL is not a shared preview URL. It targets a service-worker route backed by the facilitator browser's in-memory Nodepod instance, so another participant browser has no server registered for the same instance ID. The room must not mark preview live merely because a port number was synchronized.

Riff detects `onServerReady`, shows the virtual URL directly to the facilitator, and maintains a host-authenticated control WebSocket. The local Nodepod service-worker patch injects a virtual `<base>` into HTML before parsing so relative navigation and assets cannot race the service worker's stripped-path claim and fall through to Riff's own origin. Participant HTTP requests are relayed through the control socket to `pod.request`; relayed HTML receives its room relay base and root-relative URL attributes are rewritten under that base so Vite assets do not bypass the relay from the sandboxed iframe. Room membership is the participant admission boundary: anyone with the room code can use the relayed Preview while the facilitator is connected, but only the facilitator's private capability can publish or answer Preview traffic.

The relay base cannot carry the participant on its own. A `<base>` element governs markup, so it never reaches a module specifier, a `url()` reference, or a source map comment — a served `import "/carousel.ts"` resolves against Riff's origin and 404s there. The facilitator never sees this: their service worker claims those requests for the pod regardless of the URL's shape. A participant has no equivalent, and cannot be given one, because the preview iframe is sandboxed without `allow-same-origin` and a document on an opaque origin is never controlled by a service worker. The relay therefore rewrites root-relative URLs in the bytes of relayed JavaScript and CSS as well as in HTML attributes, inline module scripts, and inline styles, so every nested request stays under `/room-preview/<room>/<generation>/`. This is a textual rewrite of a dev server's own generated output, so it does not reach a URL a preview assembles at runtime — a hand-written `fetch("/api/…")` inside preview code still escapes the relay.

Synchronize only preview metadata in Yjs: status, port, generation, owner, and last error. Do not synchronize the facilitator-only virtual URL.

## Repository setup

Seed files into `/work/repo` before Claude starts. Nodepod exposes `pod.fs`, VFS boot files, snapshots, and a shell-level `git` command, but the current PoC has not validated cloning the optional repository input. Treat repository loading as a separate boot step with visible progress and failure state.

For the first implementation, support a public GitHub repository or a browser-provided source archive. Add private-repository credentials only when required, keep them local to the facilitator, and never reuse the Claude API token as a Git credential.
