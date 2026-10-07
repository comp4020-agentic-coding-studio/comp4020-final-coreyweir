import { Directory, Wasmer, init } from "@wasmer/sdk";

type SerializedEntry =
  | [path: string, entry: { type: "dir" }]
  | [path: string, entry: { type: "file"; data: ArrayBuffer }];

type RunRequest = {
  id: number;
  packageUrl: string;
  packageSha256: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdinBytes?: ArrayBuffer;
  liveStdin?: boolean;
  workspaceRoot: string;
  entries: SerializedEntry[];
};

type WorkerMessage = RunRequest | {
  id: number;
  kind: "stdin-write";
  data: ArrayBuffer;
} | {
  id: number;
  kind: "stdin-end";
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;
const stdinWriters = new Map<number, {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  pending: Promise<void>;
  closed: Promise<void>;
  resolveClosed: () => void;
}>();
type OutputReader = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  released: boolean;
};
const outputReaders = new Map<number, OutputReader[]>();

// Wasmer package bodies are digest addressed and up to ~115MB. The CDN sends no
// Cache-Control, and Chrome's HTTP cache refuses entries that large, so every run
// re-downloaded the package. Cache Storage is disk backed and has no such limit.
const PACKAGE_CACHE_NAME = "riff-wasmer-packages-v1";

async function openPackageCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(PACKAGE_CACHE_NAME);
  } catch {
    return null;
  }
}

async function digestHex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchPackage(url: string, expectedSha256: string) {
  const cache = await openPackageCache();
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (await digestHex(bytes) === expectedSha256) return { bytes, packageCached: true };
    // A stored body that no longer matches its own digest key is unusable.
    await cache?.delete(url).catch(() => undefined);
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await digestHex(bytes);
  if (digest !== expectedSha256) {
    throw new Error(`Wasmer package digest mismatch: expected ${expectedSha256}, got ${digest}`);
  }
  // Storage pressure must degrade to a slow run, never a failed one.
  await cache?.put(url, new Response(bytes)).catch(() => undefined);
  return { bytes, packageCached: false };
}

function pathInDirectory(relative: string) {
  return relative ? `/${relative}` : "/";
}

function depth(path: string) {
  return path.split("/").length;
}

async function populateDirectory(directory: Directory, entries: SerializedEntry[]) {
  const directories = entries
    .filter((entry): entry is [string, { type: "dir" }] => entry[1].type === "dir")
    .sort(([left], [right]) => depth(left) - depth(right));
  for (const [relative] of directories) await directory.createDir(pathInDirectory(relative));
  for (const [relative, entry] of entries) {
    if (entry.type === "file") {
      await directory.writeFile(pathInDirectory(relative), new Uint8Array(entry.data));
    }
  }
}

async function scanDirectory(
  directory: Directory,
  relative = "",
  entries: SerializedEntry[] = [],
): Promise<SerializedEntry[]> {
  for (const entry of await directory.readDir(pathInDirectory(relative))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.type === "dir") {
      entries.push([child, { type: "dir" }]);
      await scanDirectory(directory, child, entries);
    } else if (entry.type === "file") {
      const data = await directory.readFile(pathInDirectory(child));
      entries.push([child, { type: "file", data: data.slice().buffer }]);
    } else {
      throw new Error(`Unsupported Wasmer entry: ${child}`);
    }
  }
  return entries;
}

scope.onmessage = (event) => {
  const message = event.data;
  if ("kind" in message && message.kind === "stdin-write") {
    const state = stdinWriters.get(message.id);
    if (state) {
      state.pending = state.pending.then(async () => {
        const bytes = new Uint8Array(message.data);
        // WASIX TTY line discipline expects terminal input at byte granularity.
        for (const byte of bytes) {
          await state.writer.ready;
          await state.writer.write(Uint8Array.of(byte));
        }
      });
      void state.pending.then(
        () => scope.postMessage({ id: message.id, kind: "stdin-ack", ok: true }, []),
        (error) => scope.postMessage({
          id: message.id,
          kind: "stdin-ack",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, []),
      );
    }
    return;
  }
  if ("kind" in message && message.kind === "stdin-end") {
    const state = stdinWriters.get(message.id);
    if (state) {
      state.pending = state.pending.catch(() => {}).then(async () => {
        // The SDK's writer.close() may wait for the command to terminate. Do
        // not use that promise as the gate for instance.wait(), or both sides
        // wait on each other. Initiate EOF and release the command lifecycle.
        try { void state.writer.close().catch(() => {}); } catch { /* closed */ }
        state.resolveClosed();
      });
      void state.pending.then(
        () => scope.postMessage({ id: message.id, kind: "stdin-ack", ok: true }, []),
        (error) => scope.postMessage({
          id: message.id,
          kind: "stdin-ack",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, []),
      );
    }
    return;
  }
  const request = message as RunRequest;
  void (async () => {
    let directory: Directory | null = null;
    let pkg: Wasmer | null = null;
    try {
      await init();
      directory = new Directory();
      await populateDirectory(directory, request.entries);
      const packageStarted = performance.now();
      const { bytes, packageCached } = await fetchPackage(request.packageUrl, request.packageSha256);
      const packageMs = performance.now() - packageStarted;
      const loadStarted = performance.now();
      pkg = await Wasmer.fromFile(bytes);
      const loadMs = performance.now() - loadStarted;
      const command = pkg.commands[request.command];
      if (!command) throw new Error(`Unknown command in Wasmer package: ${request.command}`);
      const runOptions = {
        mount: { [request.workspaceRoot]: directory },
        cwd: request.cwd,
        args: request.args,
        env: request.env,
        ...(request.liveStdin
          ? {}
          : { stdin: request.stdinBytes ? new Uint8Array(request.stdinBytes) : undefined }),
      };
      const instance = await command.run(runOptions);
      const pump = async (stream: "stdout" | "stderr", readable: ReadableStream) => {
        const reader = readable.getReader();
        const readers = outputReaders.get(request.id);
        const entry = { reader, released: false };
        readers?.push(entry);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const data = new Uint8Array(value).slice().buffer;
            scope.postMessage({ id: request.id, kind: "output", stream, data }, [data]);
          }
        } finally {
          entry.released = true;
          try {
            reader.releaseLock();
          } catch {
            // Already released by the outer finally's cancel(); ignore.
          }
        }
      };
      // Keep the readers available so EOF can release them before wait().
      // This mirrors the SDK's interactive integration test lifecycle.
      outputReaders.set(request.id, []);
      const stdoutPump = pump("stdout", instance.stdout);
      const stderrPump = pump("stderr", instance.stderr);
      if (request.liveStdin) {
        if (!instance.stdin) throw new Error("Wasmer command did not expose stdin");
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
        stdinWriters.set(request.id, {
          writer: instance.stdin.getWriter(),
          pending: Promise.resolve(),
          closed,
          resolveClosed,
        });
        scope.postMessage({ id: request.id, kind: "ready" }, []);
      }
      const streamsDone = Promise.all([stdoutPump, stderrPump]);
      // The writer is acquired before wait(), so the SDK does not destroy the
      // stdin handle before interactive input can arrive. Start wait() now:
      // programs that do not read stdin may exit without requiring EOF, while
      // interactive programs naturally remain pending until their input ends.
      const output = await instance.wait();
      // Drain any output the command wrote just before exiting; terminating
      // the worker here would discard it. Bound the wait because the SDK stream
      // may not signal EOF after exit on every package, and a stuck pump must
      // not leave the command hanging after the process has finished.
      await Promise.race([
        streamsDone,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      const entries = await scanDirectory(directory);
      const transfer: Transferable[] = [];
      for (const [, entry] of entries) {
        if (entry.type === "file") transfer.push(entry.data);
      }
      scope.postMessage({
        id: request.id,
        kind: "done",
        code: output.code,
        entries,
        diagnostics: { packageCached, packageMs, loadMs },
      }, transfer);
    } catch (error) {
      scope.postMessage({
        id: request.id,
        kind: "error",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      }, []);
    } finally {
      const stdinState = stdinWriters.get(request.id);
      stdinWriters.delete(request.id);
      for (const entry of outputReaders.get(request.id) ?? []) {
        if (entry.released) continue;
        try { void entry.reader.cancel().catch(() => {}); } catch { /* already released */ }
      }
      stdinState?.writer.releaseLock();
      outputReaders.delete(request.id);
      directory?.free();
      pkg?.free();
    }
  })();
};
