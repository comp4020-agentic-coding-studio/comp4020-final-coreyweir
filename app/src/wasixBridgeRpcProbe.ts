import { Directory, Wasmer, init } from "@wasmer/sdk";
import interactiveBashUrl from "./assets/wasmer/bash-1.0.25-riff.webc?url";
import bridgeStubUrl from "./assets/wasmer/bridge-stub.wasm?url";

type WasixCommand = { run: (opts: Record<string, unknown>) => Promise<WasixInstance> };
type WasixInstance = {
  wait: () => Promise<{ code: number; stdout: string; stderr: string }>;
  stdin?: WritableStream<Uint8Array> | null;
};

const CLOSED_STDIN = "";
const MAX_FRAME = 65536;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type BridgeLeg = {
  label: string;
  exit: boolean;
  code: number;
  stdout: string;
  stderr: string;
  request: Record<string, unknown>;
};

export type BridgeRpcResult = {
  log: string[];
  echo: BridgeLeg;
  exit: BridgeLeg;
};

function note(log: string[], message: string): void {
  const line = `${Date.now()} ${message}`;
  log.push(line);
  console.log(`[BRIDGE] ${line}`);
}

/** Read one frame [u32 LE len][bytes] from the pipe, accumulating across reads. */
async function readFrame(pipe: { read(): Promise<Uint8Array> }): Promise<{ type: number; body: Uint8Array }> {
  const buf: number[] = [];
  while (buf.length < 4) {
    const chunk = await pipe.read();
    if (chunk.byteLength === 0) throw new Error("bridge pipe EOF while reading frame header");
    for (const b of chunk) buf.push(b);
  }
  let len = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
  if (len === 0 || len > MAX_FRAME) throw new Error(`bridge bad frame length ${len}`);
  while (buf.length < 4 + len) {
    const chunk = await pipe.read();
    if (chunk.byteLength === 0) throw new Error("bridge pipe EOF while reading frame body");
    for (const b of chunk) buf.push(b);
  }
  const body = new Uint8Array(len);
  for (let i = 0; i < len; i++) body[i] = buf[4 + i];
  return { type: body[0], body: body.subarray(1) };
}

async function writeFrame(pipe: { write(c: Uint8Array): Promise<void> }, type: number, payload: Uint8Array): Promise<void> {
  const frame = new Uint8Array(4 + 1 + payload.byteLength);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, 1 + payload.byteLength, true);
  frame[4] = type;
  frame.set(payload, 5);
  await pipe.write(frame);
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
 * Host-side mock dispatcher (v2): reads a request off the shared request
 * pipe. The caller installs a per-pid response pipe and writes the replies.
 */
async function mockHost(
  dir: Directory,
  pipe: { read(): Promise<Uint8Array> },
  log: string[],
): Promise<Record<string, unknown>> {
  const frame = await readFrame(pipe);
  const body = decoder.decode(frame.body);
  const req = JSON.parse(body);
  note(log, `mockHost request pid=${req.pid} argv=${JSON.stringify(req.argv)}`);
  return req;
}

/**
 * Run one stub invocation under bash: the mock host reads the request off the
 * shared request pipe, plants a per-pid response pipe, and writes the replies.
 */
async function runLeg(
  log: string[],
  bash: WasixCommand,
  dir: Directory,
  reqPipe: { read(): Promise<Uint8Array> },
  opts: {
    label: string;
    shell: string;
    env: Record<string, string>;
    replies: (req: Record<string, unknown>) => Array<{ type: number; payload: Uint8Array }>;
  },
): Promise<BridgeLeg> {
  note(log, `${opts.label}.run`);
  const startedAt = Date.now();
  const requestP = (async () => {
    const req = await withTimeout(mockHost(dir, reqPipe, log), 30_000, `${opts.label} host request`);
    const pid = Number(req.pid);
    const resp = dir.installHostPipe(`/.wasix-session/bridge/${pid}`);
    for (const reply of opts.replies(req)) {
      await writeFrame(resp, reply.type, reply.payload);
    }
    return req;
  })();
  const instance = await bash.run({
    mount: { "/mounted": dir },
    cwd: "/mounted",
    args: ["-c", opts.shell],
    env: opts.env,
    uses: ["wasmer/coreutils@1.0.25"],
    stdin: CLOSED_STDIN,
  });
  const output = await withTimeout(instance.wait(), 60_000, `${opts.label} instance.wait()`);
  const ms = Date.now() - startedAt;
  note(log, `${opts.label} exited ${output.code} after ${ms}ms stderr=${JSON.stringify(output.stderr)}`);
  let request: Record<string, unknown> | undefined;
  try {
    request = await withTimeout(requestP, 10_000, `${opts.label} request after exit`);
  } catch (error) {
    note(log, `${opts.label} request never arrived: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    label: opts.label,
    exit: true,
    code: output.code,
    stdout: output.stdout,
    stderr: output.stderr,
    request: request ?? {},
  };
}

export async function probeBridgeRpc(): Promise<BridgeRpcResult> {
  const log: string[] = [];
  await init();
  note(log, "init");
  const bashBytes = new Uint8Array(await (await fetch(interactiveBashUrl)).arrayBuffer());
  const bash = await Wasmer.fromFile(bashBytes);
  const bashCommand = bash.entrypoint ?? bash.commands["bash"];
  if (!bashCommand) throw new Error("bash webc has no bash command");
  note(log, "bash ready");
  const dir = new Directory();
  await dir.createDir("/.wasix-session");
  await dir.createDir("/.wasix-session/bridge");
  await dir.createDir("/.wasix-session/bin");
  const stubBytes = new Uint8Array(await (await fetch(bridgeStubUrl)).arrayBuffer());
  await dir.writeFile("/.wasix-session/bin/argv", stubBytes);
  note(log, `stub ${stubBytes.byteLength} bytes`);
  const reqPipe = dir.installHostPipe("/.wasix-session/bridge/req");
  const encode = (s: string): Uint8Array => encoder.encode(s);
  const env: Record<string, string> = {
    RIFF_BRIDGE_ROOT: "/mounted",
    RIFF_BRIDGE_PIPE: "/mounted/.wasix-session/bridge/req",
    PATH: "/mounted/.wasix-session/bin:/usr/local/bin:/bin:/usr/bin",
  };
  const echo = await runLeg(log, bashCommand, dir, reqPipe, {
    label: "echo",
    shell: "argv one two",
    env,
    replies: (req) => [
      { type: 1, payload: encode(`mock argv=${JSON.stringify(req.argv)}\n`) },
      { type: 1, payload: encode(`mock cwd=${req.cwd}\n`) },
      { type: 3, payload: new Uint8Array(new Int32Array([7]).buffer) },
    ],
  });
  const exit = await runLeg(log, bashCommand, dir, reqPipe, {
    label: "exit",
    shell: "argv",
    env,
    replies: (req) => [
      { type: 1, payload: encode("after=42\n") },
      { type: 3, payload: new Uint8Array(new Int32Array([42]).buffer) },
    ],
  });
  return { log, echo, exit };
}

export function probeBridgeRpcInWorker(): Promise<BridgeRpcResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./wasixBridgeRpcProbeWorker.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Bridge RPC probe timed out after 180s"));
    }, 180_000);
    worker.onmessage = (event: MessageEvent<{ kind: string; result?: BridgeRpcResult; error?: string }>) => {
      if (event.data.kind === "log") return;
      clearTimeout(timer);
      worker.terminate();
      if (event.data.kind === "done" && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "Bridge worker failed"));
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(`worker error: ${event.message} @ ${event.filename ?? "?"}:${event.lineno ?? "?"}:${event.colno ?? "?"}`));
    };
    worker.postMessage("start");
  });
}
