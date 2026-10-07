import { Directory, Wasmer, init } from "@wasmer/sdk";
import interactiveBashUrl from "./assets/wasmer/bash-1.0.25-riff.webc?url";
import openwriteStubUrl from "./assets/wasmer/openwrite-stub.wasm?url";

type WasixCommand = { run: (opts: Record<string, unknown>) => Promise<WasixInstance> };
type WasixInstance = {
  wait: () => Promise<{ code: number; stdout: string; stderr: string }>;
  stdin?: WritableStream<Uint8Array> | null;
};

const CLOSED_STDIN = "";
const decoder = new TextDecoder();

export type PipeWriteLeg = {
  label: string;
  exit: boolean;
  code: number;
  stdout: string;
  stderr: string;
  hostGot: string;
  hostMs: number;
};

export type PipeWriteResult = {
  log: string[];
  directBash: PipeWriteLeg;
  viaWasm: PipeWriteLeg;
};

function note(log: string[], message: string): void {
  const line = `${Date.now()} ${message}`;
  log.push(line);
  console.log(`[PWRITE] ${line}`);
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Minimal sanity probe: can a process write to a planted pipe device at all,
 * and does the host read it? Uses `printf` via bash with fd redirection.
 */
export async function probePipeWrite(): Promise<PipeWriteResult> {
  const log: string[] = [];
  note(log, "init");
  await init();

  const bashBytes = new Uint8Array(await (await fetch(interactiveBashUrl)).arrayBuffer());
  const bashPkg = await Wasmer.fromFile(bashBytes);
  const bash = bashPkg.entrypoint ?? bashPkg.commands["bash"];
  if (!bash) throw new Error("bash webc has no bash command");

  const dir = new Directory();
  const pipe = dir.installHostPipe("/bridge");
  const hostReadP = withTimeout(
    pipe.read().then((b) => decoder.decode(b)),
    20_000,
    "host read",
  );

  const startedAt = Date.now();
  note(log, "directBash.run");
  const instance = await bash.run({
    mount: { "/mounted": dir },
    cwd: "/mounted",
    args: ["-c", "echo -n hello-from-guest > /mounted/bridge"],
    uses: ["wasmer/coreutils@1.0.25"],
    stdin: CLOSED_STDIN,
  });
  const hostGot = await hostReadP;
  const hostMs = Date.now() - startedAt;
  note(log, `host read ${JSON.stringify(hostGot)} after ${hostMs}ms`);

  const output = await withTimeout(instance.wait(), 20_000, "directBash wait");
  note(log, `directBash exited ${output.code}`);

  // Leg 2: a wasm binary opens the pipe O_RDWR and writes. Does the host get it?
  const dir2 = new Directory();
  await dir2.createDir("/.wasix-session");
  await dir2.createDir("/.wasix-session/bin");
  const openwriteBytes = new Uint8Array(await (await fetch(openwriteStubUrl)).arrayBuffer());
  await dir2.writeFile("/.wasix-session/bin/openwrite", openwriteBytes);
  const pipe2 = dir2.installHostPipe("/bridge");
  const hostRead2P = withTimeout(
    pipe2.read().then((b) => decoder.decode(b)),
    20_000,
    "viaWasm host read",
  );
  const startedAt2 = Date.now();
  note(log, "viaWasm.run");
  const instance2 = await bash.run({
    mount: { "/mounted": dir2 },
    cwd: "/mounted",
    args: ["-c", "PATH=/mounted/.wasix-session/bin:$PATH; openwrite /mounted/bridge"],
    uses: ["wasmer/coreutils@1.0.25"],
    stdin: CLOSED_STDIN,
  });
  const hostGot2 = await hostRead2P;
  const hostMs2 = Date.now() - startedAt2;
  note(log, `viaWasm host read ${JSON.stringify(hostGot2)} after ${hostMs2}ms`);
  const output2 = await withTimeout(instance2.wait(), 20_000, "viaWasm wait");
  note(log, `viaWasm exited ${output2.code}`);

  return {
    log,
    directBash: {
      label: "directBash",
      exit: true,
      code: output.code,
      stdout: output.stdout,
      stderr: output.stderr,
      hostGot,
      hostMs,
    },
    viaWasm: {
      label: "viaWasm",
      exit: true,
      code: output2.code,
      stdout: output2.stdout,
      stderr: output2.stderr,
      hostGot: hostGot2,
      hostMs: hostMs2,
    },
  };
}

export function probePipeWriteInWorker(): Promise<PipeWriteResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./wasixPipeWriteProbeWorker.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Pipe write probe timed out after 120s"));
    }, 120_000);
    worker.onmessage = (event: MessageEvent<{ kind: string; result?: PipeWriteResult; error?: string }>) => {
      if (event.data.kind === "log") return;
      clearTimeout(timer);
      worker.terminate();
      if (event.data.kind === "done" && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "Pipe write worker failed"));
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage("start");
  });
}
