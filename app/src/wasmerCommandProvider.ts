import type { MemoryVolume } from "@scelar/nodepod";
import fsProbeUrl from "./assets/wasmer/fs-probe-wasi-0.1.0.webc?url";

function concatBytes(parts: readonly Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

const PYTHON_PACKAGE_URL = "https://cdn.wasmer.io/webcimages/fc2d303b48e6d0f4ce3d7d199c57b55190788fda685b54f1506378a72e5a5d6c.webc";

type FileEntry = { type: "file"; data: Uint8Array; hash?: string; size?: number };
type DirectoryEntry = { type: "dir" };
type WorkspaceEntry = FileEntry | DirectoryEntry;
type WorkspaceEntries = Map<string, WorkspaceEntry>;
type SerializedEntry =
  | [path: string, entry: { type: "dir" }]
  | [path: string, entry: { type: "file"; data: ArrayBuffer }];

export type WasmerRunDiagnostics = {
  packageCached: boolean;
  packageMs: number;
  loadMs: number;
};

type WorkerResponse = {
  id: number;
  kind: "ready";
} | {
  id: number;
  kind: "stdin-ack";
  ok: boolean;
  error?: string;
} | {
  id: number;
  kind: "output";
  stream: "stdout" | "stderr";
  data: ArrayBuffer;
} | {
  id: number;
  kind: "done";
  code: number;
  entries: SerializedEntry[];
  diagnostics: WasmerRunDiagnostics;
} | {
  id: number;
  kind: "error";
  error: { name: string; message: string; stack?: string };
};

export type WasmerCommandResult = {
  stdout: Uint8Array;
  stderr: Uint8Array;
  code: number;
  diagnostics: WasmerRunDiagnostics;
};

type WasmerRunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdinBytes?: Uint8Array;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
  onReady?: (
    write: (chunk: Uint8Array) => Promise<void>,
    end: () => Promise<void>,
  ) => void | Promise<void>;
};

export type WasmerCommandDescriptor = {
  name: string;
  packageUrl: string;
  packageSha256: string;
  command: string;
  defaultArgs?: readonly string[];
  env?: Readonly<Record<string, string>>;
};

function join(root: string, relative: string) {
  return relative ? `${root.replace(/\/$/, "")}/${relative}` : root;
}

function depth(path: string) {
  return path.split("/").length;
}

function scanVolume(
  volume: MemoryVolume,
  root: string,
  relative = "",
  entries: WorkspaceEntries = new Map(),
): WorkspaceEntries {
  for (const name of volume.readdirSync(join(root, relative))) {
    const child = relative ? `${relative}/${name}` : name;
    const target = join(root, child);
    const stat = volume.lstatSync(target);
    if (stat.isDirectory()) {
      entries.set(child, { type: "dir" });
      scanVolume(volume, root, child, entries);
    } else if (stat.isFile()) {
      entries.set(child, {
        type: "file",
        data: new Uint8Array(volume.readFileSync(target) as Uint8Array),
      });
    } else {
      throw new Error(`Unsupported Nodepod entry: ${target}`);
    }
  }
  return entries;
}

async function hashEntries(entries: WorkspaceEntries) {
  for (const entry of entries.values()) {
    if (entry.type !== "file") continue;
    const digest = await crypto.subtle.digest("SHA-256", entry.data as Uint8Array<ArrayBuffer>);
    entry.hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    entry.size = entry.data.byteLength;
  }
  return entries;
}

function sameEntry(left?: WorkspaceEntry, right?: WorkspaceEntry) {
  return left?.type === right?.type
    && (left?.type !== "file" || right?.type !== "file" || left.hash === right.hash);
}

async function applyDirectory(entries: WorkspaceEntries, volume: MemoryVolume, root: string) {
  const current = await hashEntries(scanVolume(volume, root));
  const removals = [...current]
    .filter(([relative, entry]) => !entries.has(relative) || entries.get(relative)!.type !== entry.type)
    .sort(([a], [b]) => depth(b) - depth(a));
  for (const [relative] of removals) {
    const target = join(root, relative);
    if (volume.existsSync(target)) volume.removeTreeSync(target);
  }

  const directories = [...entries]
    .filter(([, entry]) => entry.type === "dir")
    .sort(([a], [b]) => depth(a) - depth(b));
  for (const [relative] of directories) {
    const target = join(root, relative);
    if (!volume.existsSync(target)) volume.mkdirSync(target, { recursive: true });
  }
  for (const [relative, entry] of entries) {
    if (entry.type === "file" && !sameEntry(entry, current.get(relative))) {
      volume.writeFileSync(join(root, relative), entry.data);
    }
  }
}

export class WorkspaceConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`Workspace changed while a Wasmer command was running: ${paths.join(", ")}`);
    this.name = "WorkspaceConflictError";
  }
}

export class WasmerCommandProvider {
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private activeCancel: (() => void) | null = null;
  private nextRunId = 1;

  private constructor(
    private readonly volume: MemoryVolume,
    private readonly commands: ReadonlyMap<string, WasmerCommandDescriptor>,
    private readonly workspaceRoot = "/work/repo",
  ) {}

  static async create(options: {
    volume: MemoryVolume;
    commands: readonly WasmerCommandDescriptor[];
    workspaceRoot?: string;
  }) {
    const commands = new Map<string, WasmerCommandDescriptor>();
    for (const descriptor of options.commands) {
      if (commands.has(descriptor.name)) {
        throw new Error(`Duplicate Wasmer command: ${descriptor.name}`);
      }
      if (!/^[0-9a-f]{64}$/.test(descriptor.packageSha256)) {
        throw new Error(`Invalid SHA-256 for Wasmer command: ${descriptor.name}`);
      }
      commands.set(descriptor.name, Object.freeze({
        ...descriptor,
        defaultArgs: descriptor.defaultArgs ? Object.freeze([...descriptor.defaultArgs]) : undefined,
        env: descriptor.env ? Object.freeze({ ...descriptor.env }) : undefined,
      }));
    }
    return new WasmerCommandProvider(
      options.volume,
      commands,
      options.workspaceRoot,
    );
  }

  has(name: string) {
    return this.commands.has(name);
  }


  run(name: string, args: readonly string[], options: WasmerRunOptions = {}) {
    const pending = this.queue.then(() => this.runExclusive(name, args, options));
    this.queue = pending.catch(() => {});
    return pending;
  }

  private runInWorker(
    descriptor: WasmerCommandDescriptor,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    stdinBytes: Uint8Array | undefined,
    entries: WorkspaceEntries,
    signal: AbortSignal | undefined,
    onOutput: WasmerRunOptions["onOutput"],
    onReady: WasmerRunOptions["onReady"],
  ): Promise<{
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    entries: WorkspaceEntries;
    diagnostics: WasmerRunDiagnostics;
  }> {
    if (signal?.aborted) return Promise.reject(new DOMException("Command aborted", "AbortError"));
    const worker = new Worker(new URL("./wasmerCommandWorker.ts", import.meta.url), { type: "module" });
    const id = this.nextRunId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      // Pending stdin ack promises are rejected when the operation ends so the
      // caller's writeStdin()/endStdin() never hangs on a dead worker.
      const pendingAcks = new Set<(error: Error) => void>();
      const failPendingAcks = (error: Error) => {
        for (const fail of pendingAcks) fail(error);
        pendingAcks.clear();
      };
      const finish = (callback: () => void, error?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (this.activeCancel === cancel) this.activeCancel = null;
        worker.terminate();
        failPendingAcks(error ?? new Error("Wasmer command ended"));
        callback();
      };
      const cancel = () => finish(() => reject(new DOMException("Command aborted", "AbortError")));
      const abort = () => cancel();
      this.activeCancel = cancel;
      signal?.addEventListener("abort", abort, { once: true });
      worker.onerror = (event) => finish(() => reject(new Error(event.message)));
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        if (response.id !== id) return;
        if (response.kind === "error") {
          const error = new Error(response.error.message);
          error.name = response.error.name;
          if (response.error.stack) error.stack = response.error.stack;
          finish(() => reject(error), error);
          return;
        }
        if (response.kind === "ready") {
          void onReady?.(
            (chunk) => new Promise((resolve, reject) => {
              const data = chunk.slice().buffer;
              const fail = (error: Error) => {
                pendingAcks.delete(fail);
                worker.removeEventListener("message", listener);
                clearTimeout(timer);
                reject(error);
              };
              const finishAck = () => {
                pendingAcks.delete(fail);
                worker.removeEventListener("message", listener);
                clearTimeout(timer);
                resolve();
              };
              const listener = (event: MessageEvent<WorkerResponse>) => {
                if (event.data.id !== id || event.data.kind !== "stdin-ack") return;
                if (event.data.ok) finishAck();
                else fail(new Error(event.data.error));
              };
              worker.addEventListener("message", listener);
              // Never leave a write promise pending forever: the worker may
              // have died or finished before acking.
              const timer = setTimeout(() => {
                fail(new Error("Timed out waiting for stdin acknowledgement"));
              }, 15_000);
              pendingAcks.add(fail);
              worker.postMessage({ id, kind: "stdin-write", data }, [data]);
            },
            ),
            () => new Promise((resolve, reject) => {
              const fail = (error: Error) => {
                pendingAcks.delete(fail);
                worker.removeEventListener("message", listener);
                clearTimeout(timer);
                reject(error);
              };
              const finishAck = () => {
                pendingAcks.delete(fail);
                worker.removeEventListener("message", listener);
                clearTimeout(timer);
                resolve();
              };
              const listener = (event: MessageEvent<WorkerResponse>) => {
                if (event.data.id !== id || event.data.kind !== "stdin-ack") return;
                if (event.data.ok) finishAck();
                else fail(new Error(event.data.error));
              };
              worker.addEventListener("message", listener);
              const timer = setTimeout(() => {
                fail(new Error("Timed out waiting for stdin EOF acknowledgement"));
              }, 15_000);
              pendingAcks.add(fail);
              worker.postMessage({ id, kind: "stdin-end" }, []);
            }),
          );
          return;
        }
        if (response.kind === "stdin-ack") return;
        if (response.kind === "output") {
          const chunk = new Uint8Array(response.data);
          (response.stream === "stdout" ? stdout : stderr).push(chunk);
          onOutput?.(response.stream, chunk);
          return;
        }
        const resultEntries: WorkspaceEntries = new Map(response.entries.map(([path, entry]) => [
          path,
          entry.type === "file"
            ? { type: "file" as const, data: new Uint8Array(entry.data) }
            : { type: "dir" as const },
        ]));
        finish(() => resolve({
          code: response.code,
          stdout: concatBytes(stdout),
          stderr: concatBytes(stderr),
          entries: resultEntries,
          diagnostics: response.diagnostics,
        }));
      };

      const stdin = stdinBytes?.slice().buffer;
      const serialized: SerializedEntry[] = [...entries].map(([path, entry]) => entry.type === "file"
        ? [path, { type: "file", data: entry.data.slice().buffer }]
        : [path, { type: "dir" }]);
      const transfer: Transferable[] = [];
      if (stdin) transfer.push(stdin);
      for (const [, entry] of serialized) {
        if (entry.type === "file") transfer.push(entry.data);
      }
      worker.postMessage({
        id,
        packageUrl: descriptor.packageUrl,
        packageSha256: descriptor.packageSha256,
        command: descriptor.command,
        args,
        cwd,
        env,
        stdinBytes: stdin,
        workspaceRoot: this.workspaceRoot,
        entries: serialized,
        liveStdin: Boolean(onReady),
      }, transfer);
    });
  }

  private async runExclusive(
    name: string,
    args: readonly string[],
    { cwd, env, stdinBytes, signal, onOutput, onReady }: WasmerRunOptions,
  ): Promise<WasmerCommandResult> {
    if (this.disposed) throw new Error("Wasmer command provider is disposed");
    if (signal?.aborted) throw new DOMException("Command aborted", "AbortError");
    const descriptor = this.commands.get(name);
    if (!descriptor) throw new Error(`Unknown Wasmer command: ${name}`);

    const concurrentChanges = new Set<string>();
    let applyingWasmerChanges = false;
    const stopWatching = this.volume.onGlobalChange((path) => {
      if (!applyingWasmerChanges
        && (path === this.workspaceRoot || path.startsWith(`${this.workspaceRoot}/`))) {
        concurrentChanges.add(path);
      }
    });

    try {
      const source = await hashEntries(scanVolume(this.volume, this.workspaceRoot));
      if (concurrentChanges.size > 0) {
        throw new WorkspaceConflictError([...concurrentChanges].sort());
      }

      const cwdInWorkspace = cwd === this.workspaceRoot || cwd?.startsWith(`${this.workspaceRoot}/`);
      const output = await this.runInWorker(
        descriptor,
        args.length > 0 ? [...args] : [...(descriptor.defaultArgs ?? [])],
        cwdInWorkspace ? cwd! : this.workspaceRoot,
        { ...descriptor.env, ...(env ?? {}) },
        stdinBytes,
        source,
        signal,
        onOutput,
        onReady,
      );
      const resultEntries = await hashEntries(output.entries);
      if (concurrentChanges.size > 0) {
        throw new WorkspaceConflictError([...concurrentChanges].sort());
      }
      applyingWasmerChanges = true;
      await applyDirectory(resultEntries, this.volume, this.workspaceRoot);
      return {
        stdout: output.stdout,
        stderr: output.stderr,
        code: output.code,
        diagnostics: output.diagnostics,
      };
    } finally {
      stopWatching();
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.activeCancel?.();
    await this.queue.catch(() => {});
  }
}

export async function createRiffWasmerProvider(volume: MemoryVolume) {
  if (!crossOriginIsolated) throw new Error("Wasmer commands require cross-origin isolation");
  return WasmerCommandProvider.create({
    volume,
    commands: [
      {
        name: "wasm-fs-probe",
        packageUrl: fsProbeUrl,
        packageSha256: "45bc09f20ff1d41bb3495885f8b6db351ffb6681fbef1a898fc7053c8b0555d1",
        command: "fs-probe",
        defaultArgs: ["/work/repo"],
        env: { WASIX_PROBE_ROOT: "/work/repo" },
      },
      {
        name: "python",
        packageUrl: PYTHON_PACKAGE_URL,
        packageSha256: "fc2d303b48e6d0f4ce3d7d199c57b55190788fda685b54f1506378a72e5a5d6c",
        command: "python",
      },
    ],
  });
}
