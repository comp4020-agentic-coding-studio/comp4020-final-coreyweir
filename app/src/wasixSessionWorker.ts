import { Directory, Runtime, Wasmer, init } from "@wasmer/sdk";

/** Shared request pipe path inside the session's control directory. */
export const BRIDGE_PIPE_DIRECTORY_PATH = "/.wasix-session/bridge/req";

/** Response pipes live under this directory, one per guest pid. */
export const BRIDGE_RESP_DIRECTORY_PATH = "/.wasix-session/bridge";

type SessionConfigWire = {
  root: string;
  sharedSystemPaths: string[];
  networkGatewayUrl?: string;
  networkGatewayPort?: MessagePort;
};

type CommandWire = {
  packageUrl: string;
  packageSha256: string;
  command: string;
  retainPackage?: boolean;
  entrypoint?: boolean;
  registrySpecifier?: string;
  uses?: string[];
};

type OpenMessage = {
  id: number;
  kind: "open-session";
  config: SessionConfigWire;
  memory: WebAssembly.Memory;
  storePointer: number;
  storeBytes: number;
  cols?: number;
  rows?: number;
};

type ExecMessage = {
  id: number;
  kind: "exec";
  command: CommandWire;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdinBytes?: ArrayBuffer;
  liveStdin: boolean;
};

type BridgeReadMessage = {
  id: number;
  kind: "bridge-read";
};

type BridgeWriteMessage = {
  id: number;
  kind: "bridge-write";
  data: ArrayBuffer;
};

type BridgeRespOpenMessage = {
  id: number;
  kind: "bridge-resp-open";
  /** Directory-root path of the channel directory holding this pid's pipe. */
  channel: string;
  pid: number;
};

type BridgeRespWriteMessage = {
  id: number;
  kind: "bridge-resp-write";
  channel: string;
  pid: number;
  data: ArrayBuffer;
};

type WorkerMessage = OpenMessage | ExecMessage | BridgeReadMessage | BridgeWriteMessage | BridgeRespOpenMessage | BridgeRespWriteMessage | {
  kind: "resize";
  cols: number;
  rows: number;
} | {
  id: number;
  kind: "stdin-write";
  data: ArrayBuffer;
} | {
  id: number;
  kind: "stdin-end";
} | {
  kind: "signal";
  /** Exec id of the command to signal; other in-flight commands are untouched. */
  execId: number;
  signal: number;
} | {
  id: number;
  kind: "signal-foreground";
  execId: number;
  signal: number;
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};

const scope = self as unknown as WorkerScope;

let directory: Directory | null = null;
let mounts: Record<string, Directory> | null = null;
let sessionRoot: string | null = null;

/** WASI signal number, so the precedence rule below reads as what it means. */
const SIGKILL = 9;

type ExecEntry = {
  signaller: import("@wasmer/sdk").InstanceSignaller | null;
  /**
   * A signal that arrived before it could be delivered, held until it can be
   * (SESSION_STALL_PLAN §2.4).
   *
   * An exec is not signallable for most of its startup: `activeExecs` gains
   * the entry before `loadPackage`, but `signaller` only exists once
   * `command.run` resolves, and the runtime binds the process's handler later
   * still, on the pool thread. Dropping a signal that lands in either window
   * is how a Bash-tool timeout left its own command running: Claude gives up,
   * the work does not stop, and the congestion that caused the timeout gets
   * worse. Latching costs one nullable field.
   */
  pendingSignal: number | null;
};

/**
 * Every top-level command in flight, by exec id, with the handle that can
 * signal it. Claude Code spawns one `bash -c` per Bash tool call and
 * auto-backgrounds long-running ones, so overlapping commands are the normal
 * case, not an edge case: a dev server holds an exec open for minutes while
 * edit/test calls come and go. A single-slot guard rejected all of them with
 * "A WASIX command is already running in this session".
 */
const activeExecs = new Map<number, ExecEntry>();
let runtime: Runtime | null = null;
let hostPipe: import("@wasmer/sdk").HostPipe | null = null;
/**
 * Response pipes, keyed by their full Directory-root path.
 *
 * Not by pid: every top-level instance starts its own process tree at pid 1,
 * so two concurrent commands hand out the same pids. Keyed by pid alone, both
 * stubs opened the *same* pipe device, the host's exit frame went to whichever
 * read first, and the other blocked forever. Each exec gets its own channel
 * directory, so the pid is only unique within it.
 */
const respPipes = new Map<string, import("@wasmer/sdk").HostPipe>();
const stdinWriters = new Map<number, {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  pending: Promise<void>;
}>();

const PACKAGE_CACHE_NAME = "riff-wasmer-packages-v1";

type RetainedPackage = {
  key: string;
  promise: Promise<Wasmer>;
};

let retainedPackage: RetainedPackage | null = null;

/** Safety bound against a future runtime stream teardown regression. */
const DRAIN_TIMEOUT_MS = 2_000;

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchPackage(command: CommandWire): Promise<Uint8Array> {
  const cache = typeof caches === "undefined" ? null : await caches.open(PACKAGE_CACHE_NAME).catch(() => null);
  const cached = await cache?.match(command.packageUrl).catch(() => undefined);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (await digestHex(bytes) === command.packageSha256) return bytes;
    await cache?.delete(command.packageUrl).catch(() => undefined);
  }

  const response = await fetch(command.packageUrl);
  if (!response.ok) throw new Error(`Could not load ${command.packageUrl} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await digestHex(bytes);
  if (digest !== command.packageSha256) {
    throw new Error(`Wasmer package digest mismatch: expected ${command.packageSha256}, got ${digest}`);
  }
  await cache?.put(command.packageUrl, new Response(bytes)).catch(() => undefined);
  return bytes;
}

function packageKey(command: CommandWire): string {
  return command.registrySpecifier ?? `${command.packageUrl}#${command.packageSha256}`;
}

async function loadPackage(command: CommandWire): Promise<{
  pkg: Wasmer;
  packageCached: boolean;
  fetchMs: number;
  loadMs: number;
}> {
  const key = packageKey(command);
  if (command.retainPackage && retainedPackage !== null) {
    if (retainedPackage.key !== key) throw new Error("A WASIX session can retain only one package");
    const startedAt = performance.now();
    const pkg = await retainedPackage.promise;
    return { pkg, packageCached: true, fetchMs: 0, loadMs: performance.now() - startedAt };
  }

  let fetchMs = 0;
  let loadMs = 0;
  const load = async () => {
    const fetchStartedAt = performance.now();
    const specifier = command.registrySpecifier;
    const bytes = specifier === undefined ? await fetchPackage(command) : null;
    fetchMs = performance.now() - fetchStartedAt;
    const loadStartedAt = performance.now();
    const pkg = bytes === null
      ? await Wasmer.fromRegistry(specifier!, runtime ?? undefined)
      : await Wasmer.fromFile(bytes, runtime ?? undefined);
    loadMs = performance.now() - loadStartedAt;
    return pkg;
  };

  if (!command.retainPackage) {
    return { pkg: await load(), packageCached: false, fetchMs, loadMs };
  }

  const entry: RetainedPackage = { key, promise: load() };
  retainedPackage = entry;
  try {
    return { pkg: await entry.promise, packageCached: false, fetchMs, loadMs };
  } catch (error) {
    if (retainedPackage === entry) retainedPackage = null;
    throw error;
  }
}

function requireSession(): { directory: Directory; mounts: Record<string, Directory>; root: string } {
  if (directory === null || mounts === null || sessionRoot === null) {
    throw new Error("No WASIX session is open");
  }
  return { directory, mounts, root: sessionRoot };
}

function postError(id: number, error: unknown): void {
  scope.postMessage({
    id,
    kind: "error",
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
}

async function open(message: OpenMessage): Promise<void> {
  if (directory !== null) throw new Error("A WASIX session is already open");
  await init({ memory: message.memory });
  // The network gateway transport: a MessagePort pairs this worker with an
  // in-page gateway (fetch runs in the browser tab, not on a host service);
  // the URL form remains for the legacy WebSocket gateway.
  const nextRuntime = message.config.networkGatewayPort !== undefined
    ? new Runtime({ networkGatewayPort: message.config.networkGatewayPort })
    : message.config.networkGatewayUrl === undefined
    ? new Runtime()
    : new Runtime({ networkGateway: message.config.networkGatewayUrl });
  if (message.cols !== undefined && message.rows !== undefined) nextRuntime.setTtySize(message.cols, message.rows);
  const nextMounts: Record<string, Directory> = {};
  for (const path of new Set([message.config.root, ...message.config.sharedSystemPaths])) {
    nextMounts[path] = Directory.openSharedStore(message.storePointer, message.storeBytes, path);
  }
  const nextDirectory = nextMounts[message.config.root];
  directory = nextDirectory;
  mounts = nextMounts;
  runtime = nextRuntime;
  sessionRoot = message.config.root;
  const pipe = typeof nextDirectory.installHostPipe === "function";
  if (pipe) {
    await nextDirectory.createDir("/.wasix-session").catch(() => {});
    await nextDirectory.createDir(BRIDGE_RESP_DIRECTORY_PATH).catch(() => {});
    hostPipe = nextDirectory.installHostPipe(BRIDGE_PIPE_DIRECTORY_PATH) as import("@wasmer/sdk").HostPipe;
  }
  scope.postMessage({ id: message.id, kind: "opened", capabilities: { pipe } });
}

async function pump(id: number, stream: "stdout" | "stderr", readable: ReadableStream): Promise<void> {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const data = new Uint8Array(value).slice().buffer;
      scope.postMessage({ id, kind: "output", stream, data }, [data]);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A terminated session may have already released the stream reader.
    }
  }
}

async function exec(message: ExecMessage): Promise<void> {
  const session = requireSession();
  if (activeExecs.has(message.id)) throw new Error(`WASIX exec ${message.id} is already running`);
  const entry: ExecEntry = { signaller: null, pendingSignal: null };
  activeExecs.set(message.id, entry);
  let pkg: Wasmer | null = null;
  let releasePackage = true;
  try {
    // Stage timings: SESSION_STALL_PLAN §6. `command.run` is the one that
    // matters -- it resolves and compiles every `uses:` package, and the
    // runtime's module cache is thread-local, so a scheduler that does not
    // reuse pool threads recompiles the whole composed toolset per call. Four
    // Timing reads are cheap enough to leave on permanently.
    const t0 = performance.now();
    const loaded = await loadPackage(message.command);
    pkg = loaded.pkg;
    releasePackage = !message.command.retainPackage;
    const t2 = performance.now();
    // Not done here: skipping `command.run` outright when a SIGKILL is already
    // latched. It would save spawning a process nobody is waiting for, but only
    // when the signal lands inside `loadPackage`, and it needs a synthetic exit
    // frame that no other path produces. With a warm package the signal always
    // arrives after this point, so that branch is unreachable from the browser
    // suite and would ship untested. The latches below already cut the
    // abandoned command from a full run to a sub-second one; revisit if a cold
    // start ever measures as the term that matters.
    const command = message.command.entrypoint ? pkg.entrypoint : pkg.commands[message.command.command];
    if (!command) throw new Error(`Unknown command in Wasmer package: ${message.command.command}`);
    const instance = await command.run({
      mount: session.mounts,
      cwd: message.cwd,
      args: message.args,
      env: message.env,
      uses: message.command.uses,
      ...(message.liveStdin
        ? {}
        : { stdin: message.stdinBytes === undefined ? undefined : new Uint8Array(message.stdinBytes) }),
    });
    const t3 = performance.now();
    entry.signaller = instance.signaller;
    flushPendingSignal(entry);
    const stdout = pump(message.id, "stdout", instance.stdout);
    const stderr = pump(message.id, "stderr", instance.stderr);
    if (message.liveStdin) {
      if (!instance.stdin) throw new Error("Wasmer command did not expose stdin");
      stdinWriters.set(message.id, { writer: instance.stdin.getWriter(), pending: Promise.resolve() });
      scope.postMessage({ id: message.id, kind: "ready" });
    }
    const output = await instance.wait();
    const t4 = performance.now();
    const drained = await Promise.race([
      Promise.all([stdout, stderr]).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
    ]);
    const t5 = performance.now();
    scope.postMessage({
      id: message.id,
      kind: "exit",
      code: output.code,
      timings: {
        fetchMs: loaded.fetchMs,
        loadMs: loaded.loadMs,
        packageCached: loaded.packageCached,
        runMs: t3 - t2,
        waitMs: t4 - t3,
        drainMs: t5 - t4,
        execMs: t5 - t0,
        drained,
      },
    });
  } finally {
    const stdin = stdinWriters.get(message.id);
    stdinWriters.delete(message.id);
    stdin?.writer.releaseLock();
    if (releasePackage) pkg?.free();
    activeExecs.delete(message.id);
  }
}

function stdinWrite(id: number, data: ArrayBuffer): void {
  const state = stdinWriters.get(id);
  if (state === undefined) {
    postError(id, new Error("No live stdin is available for this command"));
    return;
  }
  state.pending = state.pending.then(async () => {
    for (const byte of new Uint8Array(data)) {
      await state.writer.ready;
      await state.writer.write(Uint8Array.of(byte));
    }
  });
  void state.pending.then(
    () => scope.postMessage({ id, kind: "stdin-ack", ok: true }),
    (error) => scope.postMessage({ id, kind: "stdin-ack", ok: false, error: String(error) }),
  );
}

function stdinEnd(id: number): void {
  const state = stdinWriters.get(id);
  if (state === undefined) {
    postError(id, new Error("No live stdin is available for this command"));
    return;
  }
  state.pending = state.pending.catch(() => {}).then(async () => {
    void state.writer.close().catch(() => {});
  });
  void state.pending.then(
    () => scope.postMessage({ id, kind: "stdin-ack", ok: true }),
    (error) => scope.postMessage({ id, kind: "stdin-ack", ok: false, error: String(error) }),
  );
}

async function bridgeRead(message: BridgeReadMessage): Promise<void> {
  if (hostPipe === null) throw new Error("Bridge pipe is not available in this session");
  const chunk = await hostPipe.read();
  const copy = chunk.slice().buffer;
  scope.postMessage({ id: message.id, kind: "bridge-frame", data: copy }, [copy]);
}

async function bridgeWrite(message: BridgeWriteMessage): Promise<void> {
  if (hostPipe === null) throw new Error("Bridge pipe is not available in this session");
  await hostPipe.write(new Uint8Array(message.data));
  scope.postMessage({ id: message.id, kind: "bridge-wrote" });
}

async function respPipeFor(channel: string, pid: number): Promise<import("@wasmer/sdk").HostPipe> {
  const path = `${channel}/${pid}`;
  const existing = respPipes.get(path);
  if (existing !== undefined) return existing;
  const asDirectory = (directory as unknown as Directory);
  // installHostPipe needs its parent directories to exist already.
  let prefix = "";
  for (const segment of channel.split("/").filter(Boolean)) {
    prefix += `/${segment}`;
    await asDirectory.createDir(prefix).catch(() => {});
  }
  const pipe = asDirectory.installHostPipe(path) as import("@wasmer/sdk").HostPipe;
  respPipes.set(path, pipe);
  return pipe;
}

async function bridgeRespOpen(message: BridgeRespOpenMessage): Promise<void> {
  if (directory === null) throw new Error("No WASIX session is open");
  await respPipeFor(message.channel, message.pid);
  scope.postMessage({ id: message.id, kind: "bridge-resp-opened" });
}

async function bridgeRespWrite(message: BridgeRespWriteMessage): Promise<void> {
  const pipe = await respPipeFor(message.channel, message.pid);
  await pipe.write(new Uint8Array(message.data));
  scope.postMessage({ id: message.id, kind: "bridge-resp-wrote" });
}

/**
 * Try to hand one signal to the runtime, and say whether it landed.
 *
 * `InstanceSignaller.signal` returns false while no handler is bound — the
 * process is still starting — so its result is the only trustworthy answer to
 * "was this delivered". Discarding it is what made the drop silent.
 */
function deliverSignal(entry: ExecEntry, signal: number): boolean {
  return entry.signaller?.signal(signal) === true;
}

/**
 * Deliver whatever is latched, if it can be delivered now.
 *
 * Called at each point where an exec gains the ability to act on a signal it
 * could not act on before.
 */
function flushPendingSignal(entry: ExecEntry): void {
  const pending = entry.pendingSignal;
  if (pending === null) return;
  if (deliverSignal(entry, pending)) entry.pendingSignal = null;
}

/**
 * Deliver a signal to one running command, now or as soon as it is possible.
 *
 * `Instance.signaller` is bound to that instance's own process handler, so
 * sibling commands are untouched. Before it existed the only way to stop a
 * running WASIX program was to terminate the worker, which took every other
 * command — including a backgrounded dev server — down with it.
 */
function signalExec(execId: number, signal: number): void {
  const entry = activeExecs.get(execId);
  // No entry means the exec already finished; there is nothing to signal and
  // nothing to latch for, since the latch dies with the entry.
  if (entry === undefined) return;
  if (deliverSignal(entry, signal)) return;
  // SIGKILL outranks anything else waiting: the caller has abandoned this
  // command, so a queued SIGINT that would merely interrupt it is moot.
  // Otherwise the most recent signal is the caller's current intent.
  if (entry.pendingSignal !== SIGKILL) entry.pendingSignal = signal;
}

function signalForeground(message: { id: number; execId: number; signal: number }): void {
  const entry = activeExecs.get(message.execId);
  // `foregroundPid` reads through the same unbound handler, so a null pid here
  // and a failed delivery are the same condition: the process is not up yet.
  const pid = entry?.signaller?.foregroundPid() ?? null;
  if (entry !== undefined) signalExec(message.execId, message.signal);
  scope.postMessage({ id: message.id, kind: "foreground-signalled", pid });
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.kind === "stdin-write") {
    stdinWrite(message.id, message.data);
    return;
  }
  if (message.kind === "stdin-end") {
    stdinEnd(message.id);
    return;
  }
  if (message.kind === "signal") {
    signalExec(message.execId, message.signal);
    return;
  }
  if (message.kind === "signal-foreground") {
    signalForeground(message);
    return;
  }
  if (message.kind === "resize") {
    runtime?.setTtySize(message.cols, message.rows);
    return;
  }
  void (async () => {
    try {
      switch (message.kind) {
        case "open-session": await open(message); break;
        case "exec": await exec(message); break;
        case "bridge-read": await bridgeRead(message); break;
        case "bridge-write": await bridgeWrite(message); break;
        case "bridge-resp-open": await bridgeRespOpen(message); break;
        case "bridge-resp-write": await bridgeRespWrite(message); break;
      }
    } catch (error) {
      postError(message.id, error);
    }
  })();
};
