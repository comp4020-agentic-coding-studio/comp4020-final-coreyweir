import {
  Nodepod,
  type ExternalCommandContext,
  type ExternalCommandRequest,
  type NodepodProcess,
  type NodepodServerInfo,
  type NodepodTerminal,
} from "@scelar/nodepod";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createRiffWasmerProvider, type WasmerCommandProvider } from "./wasmerCommandProvider";
import { loadClaudeBundle } from "./claudeBundle";
import { SIGINT, WASIX_SESSION_CONTROL_DIR, WasixSession, type WasixSessionCommand } from "./wasixSession";
import { attachNetGatewayBrowser, type NetGatewayBrowserHandle } from "./netGatewayBrowser";
import { createCertificateAuthority } from "lemon-tls/browser/x509";
import { Osc133Parser } from "./osc133";
import { bridgeRootOf, bridgeServeAll, sessionBridge, type BridgeHostHandler, type BridgeProcessRegistration, type BridgeRequest } from "./wasixBridge";
import interactiveBashUrl from "./assets/wasmer/bash-1.0.25-riff.webc?url";
import bridgeStubUrl from "./assets/wasmer/bridge-stub.wasm?url";
import uutilsCoreutilsUrl from "./assets/wasmer/uutils-coreutils-0.11.0.wasm?url";
import wasinixJqUrl from "./assets/wasmer/wasinix-jq-1.8.2.wasm?url";
import wasinixRgUrl from "./assets/wasmer/wasinix-rg-15.2.0.wasm?url";
import wasinixNanoUrl from "./assets/wasmer/wasinix-nano-9.2.0.wasm?url";
import wasinixCurlUrl from "./assets/wasmer/wasinix-curl-8.21.0.wasm?url";
import wasinixCoreutilsUrl from "./assets/wasmer/wasinix-coreutils-9.11.0.wasm?url";

/**
 * Multicall applets re-provided ahead of the composed `wasmer/coreutils@1.0.25`
 * (uutils 0.0.7), whose compiled dispatch map lacks applets its manifest
 * advertises: `tail` exits "function/utility not found" after Claude pipes a
 * pipeline into it. The 0.11.0 wasip1 build (uutils/coreutils release asset,
 * sha256 496a929668f6cb15ad0723987f658c8f2332a63a2db014311ab2e3918f8494be,
 * plain wasi_snapshot_preview1 imports) dispatches each applet from `argv[0]`
 * basename, so one atom installed under several names works. A rebuilt GNU
 * coreutils 9.11.0 atom now covers `env`/`stat`/`du`/`id`/`timeout`/`chmod`
 * (see `WASINIX_COREUTILS_NAMES`). The unpatched wasinix GNU webc
 * (`kilyanni/coreutils@9.11.0-wasmer-6907`) still needs wide-arithmetic and
 * is rejected at spawn.
 */
const UUTILS_MULTICALL_NAMES = ["tail", "sort", "uname"] as const;

/**
 * Single-binary wasinix tools built from the wasix-org/wasinix Nix flake
 * (fetched through its binary cache, nix-cache.wasix.org) and installed as
 * session-bin entries ahead of the composed packages. ripgrep is what Claude
 * prefers over its grep fallback; jq covers JSON pipelines. Both need the
 * fork's backported `proc_spawn3` (posix_spawn); imports are otherwise
 * supplied by the pinned runtime.
 *
 * - wasinix-jq-1.8.2.wasm: sha256 5764df32f83e81c68beefb4242bbc660129796bb4bcc4f9505c9f9ff0f206d8b
 * - wasinix-rg-15.2.0.wasm: sha256 3a2aa5b7d4ca91abcc33c7c8269019ee5c89b0b6b7f9d30786c9979d788a3ae7
 * - wasinix-nano-9.2.0.wasm: sha256 f5dc70ffa951d8f26ea76c631ca88592d0f3d66979ff330cabbd49d91ec13366
 * - wasinix-curl-8.21.0.wasm: sha256 29050f9e08f9626e931adf860787809dd1fccead90932e1cb8ae143c1037e5b7
 *   (built locally with the toolchain-wide `-mno-wide-arithmetic` patch so the
 *   fork engine can validate it, socketpair rather than eventfd wakeups, and
 *   the blocking resolver so helper threads cannot outlive the request;
 *   reaches plaintext HTTP through an in-page MessageChannel virtual-net
 *   bridge and browser-native fetch; TLS 1.3 is terminated inside the tab
 *   before a separate browser-native fetch reaches the real origin)
 */
const WASINIX_BINARIES = [
  { name: "jq", url: wasinixJqUrl },
  { name: "rg", url: wasinixRgUrl },
  { name: "nano", url: wasinixNanoUrl },
  { name: "curl", url: wasinixCurlUrl },
] as const;

/**
 * GNU coreutils 9.11.0, rebuilt from wasix-org/wasinix at
 * `ec2c39877d2718d2c18f33d5ca2492bbc3cf18ba` with the same toolchain-wide
 * `-mno-wide-arithmetic` patch as curl. The unpatched wasinix atom still
 * fails engine validation. This build imports proc_exec4/proc_spawn3, execs
 * a child by bare name, and rejects invalid `stat`/`id` usage with a nonzero
 * status rather than a usage banner. Installed ahead of composed
 * `wasmer/coreutils@1.0.25` so `env` is no longer the old-libc uutils 0.0.7
 * atom. sha256 7534fb8088b1fb508878cab3cd37dcb22db4076e0579255b914b8b22d9b71296.
 */
const WASINIX_COREUTILS_NAMES = ["env", "stat", "du", "id", "timeout", "chmod"] as const;

export type HostConfig = { baseUrl: string; token: string; repo: string; githubToken?: string };
export type PreviewRequest = { method?: string; path?: string; headers?: Record<string, string>; body?: Uint8Array | null };
export type PreviewResponse = { status: number; headers: Record<string, string | string[]>; body: Uint8Array };
const NODEPOD_WORKER_URL = import.meta.env.DEV
  ? `/__worker__.js?dev=${Date.now()}`
  : "/__worker__.js?riff-nodepod-fixes-v5";

type TerminalInternals = {
  _dataDisposable?: { dispose: () => void } | null;
  _handleInput?: (data: string) => void;
  _running?: boolean;
  _wiring?: { onResize?: (cols: number, rows: number) => void };
};

type ProcessManagerInternals = {
  _processes?: Map<unknown, { state?: string; resize?: (cols: number, rows: number) => void }>;
};
type PodInternals = { processManager?: ProcessManagerInternals };

/** Exported so probes launch the same byte-pinned shell the Room terminal does. */
export const INTERACTIVE_BASH: WasixSessionCommand = {
  packageUrl: interactiveBashUrl,
  packageSha256: "6bf621c2561b2d1f0f982fe6aea04f158c81d7e9b7378d8f7ee7f3543b6d3293",
  command: "bash",
  entrypoint: true,
  retainPackage: true,
  // Composed toolset (USABILITY_ROADMAP W4 route 1): every entry import-checked
  // against the pinned runtime (check-package-imports.py) and browser-verified
  // by test:wasix-registry-tools-browser (~1.7 s incremental cold compose,
  // functional grep/sed/find/tar/gzip/less, coherent sed -i sync-back).
  // Registry specifiers, like coreutils — byte-pin by vendoring webcs if the
  // supply chain ever needs hardening.
  uses: [
    "wasmer/coreutils@1.0.25",
    "wasmer/grep@3.12.0",
    "wasmer/sed@4.9.0",
    "wasmer/tar@1.35.0",
    "wasmer/gzip@1.14.0",
    "wasmer/less@685.0.1",
  ],
};

async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.text();
}

async function fetchBytes(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Bridge requests carry env as `["K=V", ...]`; Nodepod wants a record. */
export function envFromBridge(request: BridgeRequest): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of request.env ?? []) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * The production bridge handler: spawn a real Nodepod process per guest stub
 * request and relay its output frames back over the pipe. Exported so browser
 * smokes can drive the exact same code path the session uses.
 */
export function createBridgeHostHandler(
  pod: Nodepod,
  report: (status: string) => void,
  register?: BridgeProcessRegistration,
): BridgeHostHandler {
  return async (request, output) => {
    const cwd = request.cwd;
    const argv = request.argv.length > 1 ? request.argv.slice(1) : [];
    const commandName = request.argv[0] ?? "";
    report(`[bridge] pid=${request.pid} ${commandName} ${argv.join(" ")}`);
    const process = await pod.spawn(commandName, argv, { cwd, env: envFromBridge(request) });
    const encoder = new TextEncoder();
    process.on("output", (chunk: string) => {
      void output.writeStdout(encoder.encode(chunk));
    });
    process.on("error", (chunk: string) => {
      void output.writeStderr(encoder.encode(chunk));
    });
    const signalProcess = (signal: number) => {
      const name = signal === 2 ? "SIGINT" : signal === 15 ? "SIGTERM" : `SIG${signal}`;
      report(`[bridge] ${commandName} signal ${name}`);
      process.kill(name);
    };
    output.onSignal = signalProcess;
    const unregister = register?.(request, signalProcess);
    try {
      return await new Promise<number>((resolve) => {
        process.on("exit", (code) => resolve(code ?? 1));
      });
    } finally {
      unregister?.();
    }
  };
}

export class ClaudePodController {
  private pod: Nodepod | null = null;
  private terminal: NodepodTerminal | null = null;
  private process: NodepodProcess | null = null;
  private wasmerProvider: Promise<WasmerCommandProvider> | null = null;
  private wasixSession: WasixSession | null = null;
  private netGateway: NetGatewayBrowserHandle | null = null;
  private wasixShell: Promise<unknown> | null = null;
  /** Exec id of the interactive shell, so Ctrl-C can target it alone. */
  private wasixShellExecId: number | null = null;
  private wasixShellBridgeRoot: string | null = null;
  /** Memoised session and bridge so Claude's bash spawns and the human
   * terminal share one WASIX session (USABILITY_ROADMAP W1 decision). */
  private wasixBootstrap: Promise<{
    session: WasixSession;
    bridge: { pipeEnv: Record<string, string>; pathEntry: string };
  }> | null = null;
  private bridgeLoop: Promise<void> | null = null;
  private bridgeDisposed = false;
  private writeWasixStdin: ((data: Uint8Array) => Promise<void>) | null = null;
  private wasixStdinTail: Promise<void> = Promise.resolve();
  private wasixPromptGeneration = 0;
  private wasixAtPrompt = false;
  private wasixInterruptPending = false;
  private foregroundBridgeProcesses = new Map<number, (signal: number) => void>();
  private rawInput: { dispose: () => void } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fitTimers: number[] = [];
  private previewServers = new Map<string, NodepodServerInfo>();
  private activePreview: NodepodServerInfo | null = null;
  private onServerListen = (server: NodepodServerInfo) => {
    const key = `${server.pid}:${server.port}`;
    this.previewServers.delete(key);
    this.previewServers.set(key, server);
    this.activePreview = server;
    this.reportPreview(server.url);
  };
  private onServerClose = (server: NodepodServerInfo) => {
    const key = `${server.pid}:${server.port}`;
    this.previewServers.delete(key);
    if (this.activePreview?.pid !== server.pid || this.activePreview.port !== server.port) return;
    this.activePreview = [...this.previewServers.values()].at(-1) ?? null;
    this.reportPreview(this.activePreview?.url ?? null);
  };

  private registerBridgeProcess: BridgeProcessRegistration = (request, signal) => {
    if (bridgeRootOf(request) !== this.wasixShellBridgeRoot) return () => {};
    this.foregroundBridgeProcesses.set(request.pid, signal);
    return () => {
      if (this.foregroundBridgeProcesses.get(request.pid) === signal) {
        this.foregroundBridgeProcesses.delete(request.pid);
      }
    };
  };

  private runWasmerCommand = async (
    request: ExternalCommandRequest,
    context: ExternalCommandContext,
  ) => {
    if (!this.pod) throw new Error("Workspace has not booted");
    this.wasmerProvider ??= createRiffWasmerProvider(this.pod.volume);
    const provider = await this.wasmerProvider;
    const supportsLiveStdin = (request as ExternalCommandRequest & { liveStdin?: boolean }).liveStdin === true;
    let stdinBytes: Uint8Array | undefined;
    if (!supportsLiveStdin) {
      const reader = context.stdin.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        for (;;) {
          if (context.signal.aborted) throw new DOMException("Command aborted", "AbortError");
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          byteLength += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      stdinBytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        stdinBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    const streamed = { stdout: false, stderr: false };
    let stdinPump: Promise<void> | undefined;
    let cancelStdin = () => {};
    let endStdinOnce: (() => Promise<void>) | null = null;
    const result = await provider.run(request.command, request.args, {
      cwd: request.cwd,
      env: { ...request.env },
      stdinBytes,
      signal: context.signal,
      onReady: supportsLiveStdin ? (writeStdin, endStdin) => {
        // Single-shot so a failed EOF is not re-sent (the worker's writer.close
        // is not guaranteed idempotent).
        endStdinOnce = () => {
          const pending = endStdin();
          endStdinOnce = null;
          return pending;
        };
        stdinPump = (async () => {
          const reader = context.stdin.getReader();
          let released = false;
          cancelStdin = () => {
            if (released) return;
            released = true;
            // Swallow both sync throw and rejection: the pump's finally may
            // already have released this reader, and cancelling a released
            // reader throws an uncaught page error.
            try { void reader.cancel().catch(() => {}); } catch { /* already released */ }
          };
          try {
            for (;;) {
              if (context.signal.aborted) throw new DOMException("Command aborted", "AbortError");
              const { done, value } = await reader.read();
              if (done) break;
              await writeStdin(value);
            }
            await endStdinOnce?.();
          } finally {
            released = true;
            try { reader.releaseLock(); } catch { /* already released */ }
          }
        })();
        // A rejected pump must not re-send EOF (that would double-close) nor
        // surface an unhandled rejection; the write/EOF error is already lost,
        // so just release the reader.
        void stdinPump.catch(() => cancelStdin());
      } : undefined,
      onOutput: (stream, chunk) => {
        streamed[stream] = true;
        if (stream === "stdout") context.writeStdout(chunk);
        else context.writeStderr(chunk);
      },
    });
    // Interactive programs may exit while their stdin remains open. Do not
    // wait forever for EOF from the parent after Wasmer has completed.
    cancelStdin();
    // Wasmer already produced bytes; hand them over unchanged so binary output
    // survives the trip to the guest process.
    return {
      exitCode: result.code,
      ...(streamed.stdout ? {} : { stdout: result.stdout }),
      ...(streamed.stderr ? {} : { stderr: result.stderr }),
    };
  };

  constructor(
    private config: HostConfig,
    private report: (status: string) => void,
    private reportPreview: (url: string | null) => void = () => {},
    private emitOutput: (data: string) => void = () => {},
  ) {}

  async boot() {
    if (this.pod) return;
    this.report("Loading Claude runtime");
    const [shim, run, claude, mithicShell, mithicCoreutils, mithicRunner, bash] = await Promise.all([
      fetchText("/claude/shim.cjs"),
      fetchText("/claude/run.cjs"),
      // Derived in-browser from the published npm tarball rather than served as
      // a prebuilt artifact; cached after the first cold boot.
      loadClaudeBundle({ report: this.report }),
      fetchBytes("/mithic/mithic-shell.cjs"),
      fetchBytes("/mithic/mithic-coreutils.cjs"),
      fetchText("/mithic/run-mithic.cjs"),
      fetchText("/mithic/bash.cjs"),
    ]);

    const env: Record<string, string> = {
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      SHELL: "bash",
      // Claude snapshots its parent PATH and restores it inside Bash. Include
      // the session's bridge stubs before that snapshot can be generated.
      PATH: `/work/repo/${WASIX_SESSION_CONTROL_DIR}/bin:/usr/local/bin:/usr/bin:/bin:/node_modules/.bin`,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
      CLAUDE_CODE_NO_FLICKER: "1",
      CLAUDE_CODE_RELAUNCH_TERMINAL_SIZE: "80x24",
      NODEPOD_EXTERNAL_COMMANDS: "wasm-fs-probe:python:bash",
      ANTHROPIC_BASE_URL: this.config.baseUrl,
    };
    if (new URL(this.config.baseUrl).hostname === "api.anthropic.com") env.ANTHROPIC_API_KEY = this.config.token;
    else env.ANTHROPIC_AUTH_TOKEN = this.config.token;
    if (this.config.githubToken) {
      env.GITHUB_TOKEN = this.config.githubToken;
      env.GH_TOKEN = this.config.githubToken;
    }

    this.report("Booting browser workspace");
    this.pod = await Nodepod.boot({
      serviceWorker: true,
      workerUrl: NODEPOD_WORKER_URL,
      workdir: "/work/repo",
      files: {
        "/opt/claude/shim.cjs": shim,
        "/opt/claude/run.cjs": run,
        "/opt/claude/claude-booted.patched.js": claude,
        "/opt/mithic/mithic-shell.cjs": mithicShell,
        "/opt/mithic/mithic-coreutils.cjs": mithicCoreutils,
        "/opt/mithic/run-mithic.cjs": mithicRunner,
        "/bin/bash": bash,
        "/work/repo/.keep": "",
        "/home/user/.claude.json": JSON.stringify({
          firstStartTime: new Date().toISOString(),
          hasCompletedOnboarding: true,
          projects: { "/work/repo": { hasTrustDialogAccepted: true } },
        }),
        "/home/user/.claude/settings.json": JSON.stringify({
          showThinkingSummaries: true,
          verbose: true,
          permissions: { defaultMode: "bypassPermissions" },
        }),
        "/home/user/.claude/.keep": "",
      },
      env,
      preloadEsbuild: false,
      allowedFetchDomains: null,
      onServerListen: this.onServerListen,
      onServerClose: this.onServerClose,
      externalCommands: {
        "wasm-fs-probe": this.runWasmerCommand,
        python: this.runWasmerCommand,
        // W1: Claude Code's Bash tool resolves $SHELL ("bash") or the absolute
        // "/bin/bash" — cover both exact keys. The mithic shim file stays on
        // disk as a fallback; spawn-request interception shadows it.
        bash: this.runBashExternal,
        "/bin/bash": this.runBashExternal,
      },
      memory: {
        budgetMB: 768,
        heapWarnThresholdMB: 650,
        maxProcessOutputBytes: 16 * 1024 * 1024,
        transformCacheMaxBytes: 64 * 1024 * 1024,
      },
    });
    this.report("Workspace ready");
  }

  attach(target: HTMLElement) {
    if (!this.pod) throw new Error("Workspace has not booted");
    if (!this.terminal) {
      const terminal = this.pod.createTerminal({
        Terminal,
        FitAddon,
        SerializeAddon,
        fontSize: 12,
        fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
        prompt: (cwd) => `\x1b[38;5;244mnodepod:${cwd}$\x1b[0m `,
      });
      this.terminal = terminal;
    }

    this.terminal.attach(target);
    this.terminal.xterm.options.lineHeight = 1.1;
    let lastShiftEnter = 0;
    this.terminal.xterm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.shiftKey) return true;
      const now = Date.now();
      if (event.type === "keydown" && now - lastShiftEnter > 80) {
        lastShiftEnter = now;
        event.preventDefault();
        if (this.process && !this.process.exited) this.process.write("\x1b[106;5u");
      }
      return false;
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (target.offsetParent !== null) {
        this.terminal?.fit();
        this.notifyResize();
      }
    });
    this.resizeObserver.observe(target);
    this.fitTimers = [0, 100, 300].map((delay) => window.setTimeout(() => this.terminal?.fit(), delay));
  }

  async startClaude() {
    if (!this.pod || !this.terminal) throw new Error("Terminal has not been attached");
    if (this.isRunning()) return;
    await this.waitForTerminalIdle();

    const terminal = this.terminal;
    const xterm = terminal.xterm;
    const launchMessage = "\x1b[38;5;244mLaunching Claude Code...\x1b[0m";
    terminal.writeln("");
    terminal.writeln(launchMessage);
    this.emitOutput(`\r\n${launchMessage}\r\n`);
    const process = await this.pod.spawn("node", ["/opt/claude/run.cjs"], { cwd: "/work/repo" });
    this.process = process;

    const internal = terminal as unknown as TerminalInternals;
    internal._dataDisposable?.dispose();
    internal._dataDisposable = null;
    this.rawInput?.dispose();
    this.rawInput = xterm.onData((data: string) => process.write(data));

    let previousEndedWithCarriageReturn = false;
    const write = (text: string) => {
      const value = String(text);
      const splitCrLf = previousEndedWithCarriageReturn && value.startsWith("\n");
      const rest = splitCrLf ? value.slice(1) : value;
      const data = `${splitCrLf ? "\n" : ""}${rest.replace(/(^|[^\r])\n/g, "$1\r\n")}`;
      xterm.write(data);
      this.emitOutput(data);
      previousEndedWithCarriageReturn = value.endsWith("\r");
    };
    process.on("output", write);
    process.on("error", write);
    process.on("exit", () => {
      if (this.process !== process) return;
      this.process = null;
      this.restoreTerminalInput();
      terminal.showPrompt();
      this.report("Terminal ready");
    });

    this.notifyResize();
    xterm.focus();
    this.report("Claude running");
  }

  /**
   * One shared WASIX session for the Room terminal and Claude's bash spawns.
   * Memoised so concurrent first callers (Start Bash button + a bash external
   * command) boot exactly one session; null it on dispose/restart.
   */
  private async ensureWasixSession(cols = 80, rows = 24) {
    this.wasixBootstrap ??= (async () => {
      this.report("Starting WASIX session");
      // The in-page network gateway: one end of the channel runs here in the
      // tab and re-originates guest HTTP via this tab's own fetch(); the
      // other end is transferred into the session worker's Runtime. No host
      // service carries guest traffic, and reach is bounded by this user's
      // own browser (CORS, TLS trust). TLS termination and its ephemeral CA
      // stay in this tab; the app server never sees guest network plaintext.
      const channel = new MessageChannel();
      const certificateAuthority = createCertificateAuthority();
      this.netGateway = attachNetGatewayBrowser(channel.port1, certificateAuthority);
      const session = await WasixSession.open({
        volume: this.pod!.volume,
        root: "/work/repo",
        cols,
        rows,
        networkGatewayPort: channel.port2,
      });
      this.wasixSession = session;
      await session.installSessionFile("ca.pem", new TextEncoder().encode(certificateAuthority.pem));
      const bridgeStubBytes = await fetchBytes(bridgeStubUrl);
      // Every name here must resolve host-side via createBridgeHostHandler →
      // pod.spawn; these are all native Nodepod commands like npm/git
      // (nodepod_fork/src/shell/commands/, registered in
      // polyfills/child_process.ts). One 83 KB stub copy per name in session
      // shared-store control directory.
      const bridge = await session.installBridge(new Map([
        ["node", bridgeStubBytes],
        ["npm", bridgeStubBytes],
        ["npx", bridgeStubBytes],
        ["pnpm", bridgeStubBytes],
        ["yarn", bridgeStubBytes],
        ["bun", bridgeStubBytes],
        ["bunx", bridgeStubBytes],
        ["git", bridgeStubBytes],
      ]));
      // One uutils 0.11.0 atom fetch, installed under each multicall name.
      // The shared-store write cost of repeated bytes is accepted for now;
      // revisit if session memory ever measures as the term that matters.
      const uutilsBytes = await fetchBytes(uutilsCoreutilsUrl);
      await session.installBinaries(new Map(
        UUTILS_MULTICALL_NAMES.map((name) => [name, uutilsBytes]),
      ));
      const gnuCoreutilsBytes = await fetchBytes(wasinixCoreutilsUrl);
      await session.installBinaries(new Map(
        WASINIX_COREUTILS_NAMES.map((name) => [name, gnuCoreutilsBytes]),
      ));
      // Single-binary wasinix tools (jq, ripgrep, nano, curl).
      for (const binary of WASINIX_BINARIES) {
        const bytes = await fetchBytes(binary.url);
        await session.installBinaries(new Map([[binary.name, bytes]]));
      }
      return { session, bridge };
    })().catch(async (error) => {
      const failedSession = this.wasixSession;
      this.wasixSession = null;
      const failedGateway = this.netGateway;
      this.netGateway = null;
      failedGateway?.dispose();
      if (failedSession) await failedSession.dispose().catch(() => {});
      this.wasixBootstrap = null;
      throw error;
    });
    const bootstrap = await this.wasixBootstrap;
    // The serve loop must be live before any bash -c can reach bridged
    // commands (node/npm/git stubs block on their response pipe otherwise).
    this.startBridge();
    return bootstrap;
  }

  /** Session env shared by the interactive terminal and Claude's bash runs. */
  private wasixBaseEnv(bridge: { pipeEnv: Record<string, string>; pathEntry: string }): Record<string, string> {
    return {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: "/home/user",
      USER: "user",
      TMPDIR: "/tmp",
      // curl verifies the browser-generated leaf presented by the in-tab TLS
      // server. The subsequent browser fetch performs real-origin TLS checks.
      CURL_CA_BUNDLE: "/work/repo/.wasix-session/ca.pem",
      // Bridged processes inherit the guest env verbatim (ProcessContext
      // env is replace-not-merge), so auth tokens must ride the session
      // env for `git push` et al to work. Same pair Claude mode sets.
      ...(this.config.githubToken
        ? { GITHUB_TOKEN: this.config.githubToken, GH_TOKEN: this.config.githubToken }
        : {}),
      ...bridge.pipeEnv,
      // Prepend the bridge stub dir to the WASIX runtime default PATH
      // (/usr/local/bin:/bin:/usr/bin, where `uses` coreutils land). Do NOT
      // write `$PATH` here: that stays literal inside an inherited env value,
      // so bash would never see coreutils and `ls`/`sed`/`awk`/etc. would be
      // "command not found".
      PATH: `${bridge.pathEntry}:/usr/local/bin:/bin:/usr/bin`,
    };
  }

  /**
   * Non-interactive `bash -c` never issues the WASIX getcwd that would sync
   * wasix-libc's statically-initialised working directory, so with only the
   * SDK runner's `cwd` option the shell's own redirects and relative creates
   * anchor at the filesystem root and land detached from the volume (measured
   * 2026-09-06: `echo > rel.txt` under `cwd: /work/repo` created `/rel.txt`).
   * An explicit `cd` is the only thing the shell libc obeys, so prepend one;
   * the runner `cwd` option stays because the runtime side resolves absolute
   * paths and forked children correctly from it.
   */
  private bashArgsWithCd(cwd: string, args: readonly string[]): string[] {
    if (args[0] !== "-c" || args.length < 2) return [...args];
    const command = args[args.length - 1];
    if (typeof command !== "string") return [...args];
    const escaped = cwd.replace(/'/g, "'\\''");
    return [...args.slice(0, -1), `cd '${escaped}' && ${command}`];
  }

  /**
   * The W1 swap: Claude Code's Bash tool resolves $SHELL and spawns
   * `bash [-l] [-i] -c <cmd>` inside Nodepod; this handler forwards those
   * argv to the real WASIX bash session and streams output back. Registered
   * under both "bash" ($SHELL by name) and "/bin/bash" (absolute path).
   */
  private runBashExternal = async (
    request: ExternalCommandRequest,
    context: ExternalCommandContext,
  ): Promise<{ exitCode: number }> => {
    const { session, bridge } = await this.ensureWasixSession();
    const report = (message: string) => this.report(message);
    try {
      const cwd = request.cwd || session.root;
      const result = await session.run(INTERACTIVE_BASH, this.bashArgsWithCd(cwd, request.args), {
          cwd,
          // Deliberately the WASIX base env, not arbitrary request.env overrides:
          // keep the bridge paths and composed tools available at shell startup.
          // Tokens already ride the base env (W5).
          env: this.wasixBaseEnv(bridge),
          signal: context.signal,
          onOutput: (stream, chunk) => {
            if (stream === "stdout") context.writeStdout(chunk);
            else context.writeStderr(chunk);
          },
        });
      // A tool timeout aborts via context.signal, which now SIGKILLs this one
      // command instead of tearing the session down. The command therefore
      // *completes*, with whatever exit code the kill produced, rather than
      // rejecting — so the abort has to be recognised here, on the success
      // path, and still reported as SIGINT-ish 130.
      if (context.signal?.aborted) {
        report(`[bash] aborted (${request.args.join(" ").slice(0, 60)})`);
        return { exitCode: 130 };
      }
      report(`[bash] exited ${result.code}`);
      return { exitCode: result.code };
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError"
        || (error as { name?: string })?.name === "AbortError";
      if (aborted) {
        report(`[bash] aborted (${request.args.join(" ").slice(0, 60)})`);
        return { exitCode: 130 };
      }
      report(`[bash] failed: ${String(error)}`);
      return { exitCode: 1 };
    }
  };

  async startWasixBash() {
    if (!this.pod || !this.terminal) throw new Error("Terminal has not been attached");
    if (this.isRunning()) return;
    this.report("Starting WASIX Bash");
    await this.waitForTerminalIdle();

    const { session, bridge } = await this.ensureWasixSession(
      this.terminal.xterm.cols || 80,
      this.terminal.xterm.rows || 24,
    );
    const interactive = await session.installInteractiveBash();
    const terminal = this.terminal;
    const xterm = terminal.xterm;
    const internal = terminal as unknown as TerminalInternals;
    internal._dataDisposable?.dispose();
    internal._dataDisposable = null;
    this.rawInput?.dispose();

    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    let inputReady = false;
    let promptReady = false;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const decoder = new TextDecoder();
    const promptParser = new Osc133Parser();
    let previousEndedWithCarriageReturn = false;
    const announceReady = () => {
      if (inputReady && promptReady) readyResolve();
    };
    const writeOutput = (chunk: Uint8Array) => {
      for (const event of promptParser.push(chunk)) {
        if (event.code === "C") this.wasixAtPrompt = false;
        if (event.code === "B") {
          this.wasixAtPrompt = true;
          this.wasixPromptGeneration += 1;
          if (this.wasixInterruptPending) {
            this.wasixInterruptPending = false;
            this.report("WASIX Bash ready");
          }
          promptReady = true;
          announceReady();
        }
      }
      const value = decoder.decode(chunk, { stream: true });
      const splitCrLf = previousEndedWithCarriageReturn && value.startsWith("\n");
      const rest = splitCrLf ? value.slice(1) : value;
      const data = `${splitCrLf ? "\n" : ""}${rest.replace(/(^|[^\r])\n/g, "$1\r\n")}`;
      xterm.write(data);
      this.emitOutput(data);
      previousEndedWithCarriageReturn = value.endsWith("\r");
    };

    this.wasixShell = session.run(INTERACTIVE_BASH, interactive.args, {
      cwd: session.root,
      env: this.wasixBaseEnv(bridge),
      onStart: (execId) => {
        this.wasixShellExecId = execId;
        this.wasixShellBridgeRoot = WasixSession.bridgeChannel(session.root, execId).guestRoot;
      },
      onReady: (write) => {
        this.writeWasixStdin = write;
        this.rawInput = xterm.onData((data: string) => {
          if (data === "\x03") {
            this.interrupt();
            return;
          }
          this.wasixStdinTail = this.wasixStdinTail
            .then(() => write(new TextEncoder().encode(data)))
            .catch((error) => this.report(`WASIX input failed: ${String(error)}`));
        });
        inputReady = true;
        announceReady();
      },
      onOutput: (_stream, chunk) => writeOutput(chunk),
    });
    void this.wasixShell.then(() => {
      if (!inputReady || !promptReady) readyReject(new Error("WASIX Bash exited before its first prompt"));
      const final = decoder.decode();
      if (final) {
        const splitCrLf = previousEndedWithCarriageReturn && final.startsWith("\n");
        const rest = splitCrLf ? final.slice(1) : final;
        const data = `${splitCrLf ? "\n" : ""}${rest.replace(/(^|[^\r])\n/g, "$1\r\n")}`;
        xterm.write(data);
        this.emitOutput(data);
      }
    }).catch(readyReject).finally(() => {
      this.wasixShell = null;
      this.wasixShellExecId = null;
      this.wasixShellBridgeRoot = null;
      this.wasixAtPrompt = false;
      this.wasixInterruptPending = false;
      this.writeWasixStdin = null;
      this.restoreTerminalInput();
      terminal.showPrompt();
      this.report("Terminal ready");
    });

    await ready;
    xterm.focus();
    this.startBridge();
    this.report("WASIX Bash ready");
  }

  /**
   * Start the bridge dispatcher loop: serve host commands for guest stubs.
   * Runs until the session closes. Returns a promise that resolves when the
   * loop ends (normally on a closed pipe).
   */
  startBridge(): Promise<void> {
    if (this.bridgeLoop !== null) return this.bridgeLoop;
    if (!this.wasixSession) throw new Error("No WASIX session for the bridge");
    if (!this.pod) throw new Error("Workspace has not booted");
    const session = this.wasixSession;
    const pod = this.pod;
    this.bridgeDisposed = false;
    const bridge = sessionBridge(session);
    // Stage 7.E: both runtimes address the same store, so a bridged tool sees
    // preceding guest writes and Bash sees the tool's writes without a barrier.
    const handler = createBridgeHostHandler(pod, this.report, this.registerBridgeProcess);
    this.bridgeLoop = (async () => {
      try {
        await bridgeServeAll(bridge, handler);
      } catch (error) {
        if (this.bridgeDisposed) return;
        this.report(`[bridge] serve failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return this.bridgeLoop;
  }

  loadPrompt(prompt: string) {
    if (!this.terminal || !this.process || this.process.exited) return false;
    this.process.write(prompt.replace(/[\r\n]+/g, " "));
    this.terminal.xterm.focus();
    return true;
  }

  interrupt() {
    if (this.process && !this.process.exited) {
      this.process.write("\x03");
    } else if (this.writeWasixStdin) {
      const write = this.writeWasixStdin;
      if (this.wasixAtPrompt) {
        this.wasixStdinTail = this.wasixStdinTail
          .then(() => write(new Uint8Array([21, 13])))
          .catch(() => {});
        return;
      }
      const promptGeneration = this.wasixPromptGeneration;
      this.wasixInterruptPending = true;
      this.wasixStdinTail = this.wasixStdinTail.then(() => write(new Uint8Array([3]))).catch(() => {});
      const execId = this.wasixShellExecId;
      if (execId === null) return;
      void this.wasixSession?.interruptForeground(execId, SIGINT).then((pid) => {
        if (pid === null || this.wasixPromptGeneration !== promptGeneration) return;
        const bridgeSignal = this.foregroundBridgeProcesses.get(pid);
        if (bridgeSignal === undefined) return;
        this.wasixInterruptPending = false;
        bridgeSignal(SIGINT);
      }).catch((error) => this.report(`WASIX interrupt failed: ${String(error)}`));
      window.setTimeout(() => {
        if (this.wasixShellExecId !== execId || this.wasixPromptGeneration !== promptGeneration) return;
        this.wasixSession?.interruptExec(execId, SIGINT);
      }, 500);
    }
  }

  isRunning() {
    return this.process !== null && !this.process.exited || this.wasixShell !== null;
  }

  async requestPreview(init: PreviewRequest): Promise<PreviewResponse> {
    if (!this.pod || !this.activePreview) throw new Error("Preview is offline");
    const response = await this.pod.request(this.activePreview.port, init);
    return {
      status: response.statusCode,
      headers: response.headers,
      body: new Uint8Array(response.body),
    };
  }

  private notifyResize() {
    if (!this.terminal) return;
    const cols = this.terminal.xterm.cols || 80;
    const rows = this.terminal.xterm.rows || 24;
    this.wasixSession?.resize(cols, rows);
    const internal = this.terminal as unknown as TerminalInternals;
    internal._wiring?.onResize?.(cols, rows);
    const processes = (this.pod as unknown as PodInternals | null)?.processManager?._processes;
    processes?.forEach((process) => {
      if (process.state !== "exited") process.resize?.(cols, rows);
    });
  }

  private restoreTerminalInput() {
    this.rawInput?.dispose();
    this.rawInput = null;
    if (!this.terminal) return;
    const internal = this.terminal as unknown as TerminalInternals;
    if (!internal._dataDisposable) {
      internal._dataDisposable = this.terminal.xterm.onData((data: string) => internal._handleInput?.(data));
    }
  }

  private async waitForTerminalIdle(): Promise<void> {
    if (!this.terminal) return;
    const internal = this.terminal as unknown as TerminalInternals;
    const deadline = Date.now() + 30_000;
    while (internal._running) {
      if (Date.now() >= deadline) throw new Error("The current terminal command did not finish");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Nodepod clears `_running` just before its async input handler returns.
    // Yield once so that handler cannot consume the first byte of the new mode.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  snapshot() {
    if (!this.terminal) return null;
    return {
      ansi: this.terminal.serialize(),
      cols: this.terminal.xterm.cols || 80,
      rows: this.terminal.xterm.rows || 24,
    };
  }

  dimensions() {
    return {
      cols: this.terminal?.xterm.cols || 80,
      rows: this.terminal?.xterm.rows || 24,
    };
  }

  async dispose() {
    this.previewServers.clear();
    this.activePreview = null;
    this.reportPreview(null);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const timer of this.fitTimers) clearTimeout(timer);
    this.fitTimers = [];
    this.process?.kill();
    this.process = null;
    this.rawInput?.dispose();
    this.rawInput = null;
    const wasixSession = this.wasixSession;
    this.wasixSession = null;
    const netGateway = this.netGateway;
    this.netGateway = null;
    this.wasixBootstrap = null;
    this.bridgeDisposed = true;
    this.bridgeLoop = null;
    this.wasixShell = null;
    this.writeWasixStdin = null;
    if (wasixSession) await wasixSession.dispose();
    netGateway?.dispose();
    this.terminal?.detach();
    this.terminal = null;
    const wasmerProvider = this.wasmerProvider;
    this.wasmerProvider = null;
    if (wasmerProvider) await (await wasmerProvider).dispose();
    this.pod?.teardown();
    this.pod = null;
  }
}
