import { Directory, Wasmer, init } from "@wasmer/sdk";
import interactiveBashUrl from "./assets/wasmer/bash-1.0.25-riff.webc?url";

type WasixCommand = { run: (opts: Record<string, unknown>) => Promise<WasixInstance> };
type WasixInstance = {
  wait: () => Promise<{ code: number; stdout: string; stderr: string }>;
  stdin?: WritableStream<Uint8Array> | null;
};
type Race<T> =
  | { kind: "done"; value: T }
  | { kind: "blocked" };

const HOST_PAYLOAD = "hello-from-host\n";
const GUEST_PAYLOAD = "hello-from-guest\n";
const FRAME_REQ = "PING";
const FRAME_REPLY = "PONG";
/** Empty stdin so `Instance.wait()` skips WritableStream.close() on a live stdin pipe. */
const CLOSED_STDIN = "";

export type HostToGuestEofResult = {
  blockedMs: number;
  exitedBeforeWrite: boolean;
  code: number;
  stdout: string;
  stderr: string;
  closeToExitMs: number;
};

export type HostToGuestSizedResult = {
  blockedMs: number;
  exitedBeforeWrite: boolean;
  code: number;
  stdout: string;
  stderr: string;
  writeToExitMs: number;
};

export type GuestToHostResult = {
  blockedMs: number;
  readBeforeWrite: boolean;
  text: string;
  writeToReadMs: number;
  bashExited: boolean;
  bashWaitMs: number;
};

export type FramedRoundTripResult = {
  request: string;
  stdout: string;
  stderr: string;
  code: number;
  requestMs: number;
  replyToExitMs: number;
};

export type FpipeProbeResult = {
  commands: string[];
  log: string[];
  hostToGuestEof: HostToGuestEofResult;
  hostToGuestSized: HostToGuestSizedResult;
  guestToHost: GuestToHostResult;
  framed: FramedRoundTripResult;
};

function note(log: string[], message: string): void {
  const line = `${Date.now()} ${message}`;
  log.push(line);
  console.log(`[FPIPE] ${line}`);
}

async function raceBlocked<T>(work: Promise<T>, ms: number): Promise<Race<T>> {
  return Promise.race([
    work.then((value) => ({ kind: "done" as const, value })),
    new Promise<Race<T>>((resolve) => setTimeout(() => resolve({ kind: "blocked" }), ms)),
  ]);
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
 * Plant host pipes, split first-byte from EOF, then run one framed round-trip.
 * Must run in a worker. See FPIPE_SPIKE.md.
 */
export async function probeHostPipe(): Promise<FpipeProbeResult> {
  const log: string[] = [];
  note(log, "init");
  await init();
  const pkg = await Wasmer.fromRegistry("wasmer/coreutils@1.0.25");
  const commands = Object.keys(pkg.commands);
  note(log, `commands ${commands.length}`);
  const head = pkg.commands["head"];
  if (!head) {
    throw new Error(`wasmer/coreutils@1.0.25 missing head (have: ${commands.join(", ")})`);
  }

  note(log, "fetch bash");
  const bashBytes = new Uint8Array(await (await fetch(interactiveBashUrl)).arrayBuffer());
  const bashPkg = await Wasmer.fromFile(bashBytes);
  const bash = bashPkg.entrypoint ?? bashPkg.commands["bash"];
  if (!bash) throw new Error("bash webc has no bash command");

  // Sized `head` already showed host→guest completion is milliseconds
  // when `stdin: ""` lets wait() skip closing a live stdin stream.
  // Skip the EOF `cat` case so the remaining legs can finish.
  const hostToGuestSized = await probeHostToGuestSized(log, head);
  const hostToGuestEof = {
    blockedMs: -1,
    exitedBeforeWrite: false,
    code: -1,
    stdout: "",
    stderr: "skipped; sized head already measures host→guest wake",
    closeToExitMs: -1,
  };
  const guestToHost = await probeGuestToHost(log, bash);
  const framed = await probeFramedRoundTrip(log, bash);
  return { commands, log, hostToGuestEof, hostToGuestSized, guestToHost, framed };
}

/** `head -c 16` should exit when 16 bytes arrive, without waiting for EOF. */
async function probeHostToGuestSized(log: string[], head: WasixCommand): Promise<HostToGuestSizedResult> {
  const dir = new Directory();
  const host = dir.installHostPipe("/host-in");
  note(log, "host→guest sized head.run");
  const instance = await head.run({
    args: ["-c", String(HOST_PAYLOAD.length), "/mounted/host-in"],
    mount: { "/mounted": dir },
    stdin: CLOSED_STDIN,
  });
  const done = instance.wait();
  const blockedAt = Date.now();
  const early = await raceBlocked(done, 500);
  const blockedMs = Date.now() - blockedAt;
  note(log, `host→guest sized race ${early.kind} after ${blockedMs}ms`);
  if (early.kind === "done") {
    return {
      blockedMs,
      exitedBeforeWrite: true,
      code: early.value.code,
      stdout: early.value.stdout,
      stderr: early.value.stderr,
      writeToExitMs: 0,
    };
  }

  const wroteAt = Date.now();
  await host.write(new TextEncoder().encode(HOST_PAYLOAD));
  note(log, "host→guest sized wrote, pipe left open");
  const output = await done;
  const writeToExitMs = Date.now() - wroteAt;
  note(log, `host→guest sized exited ${output.code} after ${writeToExitMs}ms`);
  return {
    blockedMs,
    exitedBeforeWrite: false,
    code: output.code,
    stdout: output.stdout,
    stderr: output.stderr,
    writeToExitMs,
  };
}

/** `cat` waits for EOF, so this is close-to-exit, not first-byte. */
async function probeHostToGuestEof(log: string[], cat: WasixCommand): Promise<HostToGuestEofResult> {
  const dir = new Directory();
  const host = dir.installHostPipe("/host-in");
  note(log, "host→guest eof cat.run");
  const instance = await cat.run({
    args: ["/mounted/host-in"],
    mount: { "/mounted": dir },
    stdin: CLOSED_STDIN,
  });
  const done = instance.wait();
  const blockedAt = Date.now();
  const early = await raceBlocked(done, 500);
  const blockedMs = Date.now() - blockedAt;
  note(log, `host→guest eof race ${early.kind} after ${blockedMs}ms`);
  if (early.kind === "done") {
    return {
      blockedMs,
      exitedBeforeWrite: true,
      code: early.value.code,
      stdout: early.value.stdout,
      stderr: early.value.stderr,
      closeToExitMs: 0,
    };
  }

  await host.write(new TextEncoder().encode(HOST_PAYLOAD));
  const closedAt = Date.now();
  host.close();
  note(log, "host→guest eof closed");
  const output = await done;
  const closeToExitMs = Date.now() - closedAt;
  note(log, `host→guest eof exited ${output.code} after ${closeToExitMs}ms`);
  return {
    blockedMs,
    exitedBeforeWrite: false,
    code: output.code,
    stdout: output.stdout,
    stderr: output.stderr,
    closeToExitMs,
  };
}

/**
 * Guest writes the pipe with `echo`, not live WASIX stdin. Live stdin is a
 * different host→guest path and previously hung the probe.
 */
async function probeGuestToHost(log: string[], bash: WasixCommand): Promise<GuestToHostResult> {
  const dir = new Directory();
  const host = dir.installHostPipe("/guest-out");
  const decoder = new TextDecoder();
  const reading = withTimeout(
    host.read().then((bytes: Uint8Array) => decoder.decode(bytes)),
    30_000,
    "guest→host host.read()",
  );
  const blockedAt = Date.now();
  const early = await raceBlocked(reading, 500);
  const blockedMs = Date.now() - blockedAt;
  note(log, `guest→host race ${early.kind} after ${blockedMs}ms`);
  if (early.kind === "done") {
    return {
      blockedMs,
      readBeforeWrite: true,
      text: early.value,
      writeToReadMs: 0,
      bashExited: false,
      bashWaitMs: 0,
    };
  }

  note(log, "guest→host bash echo");
  const wroteAt = Date.now();
  const instance = await bash.run({
    args: ["-c", "echo hello-from-guest > /mounted/guest-out"],
    mount: { "/mounted": dir },
    uses: ["wasmer/coreutils@1.0.25"],
    stdin: CLOSED_STDIN,
  });
  const text = await reading;
  const writeToReadMs = Date.now() - wroteAt;
  note(log, `guest→host read ${JSON.stringify(text)} after ${writeToReadMs}ms`);
  host.close();
  const waitedAt = Date.now();
  const output = await Promise.race([
    instance.wait().then((value) => ({ kind: "done" as const, value })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 5_000),
    ),
  ]);
  const bashWaitMs = Date.now() - waitedAt;
  if (output.kind === "timeout") {
    note(log, `guest→host bash wait timed out after ${bashWaitMs}ms`);
    return {
      blockedMs,
      readBeforeWrite: false,
      text,
      writeToReadMs,
      bashExited: false,
      bashWaitMs,
    };
  }
  note(log, `guest→host bash exited ${output.value.code} after ${bashWaitMs}ms`);
  return {
    blockedMs,
    readBeforeWrite: false,
    text,
    writeToReadMs,
    bashExited: true,
    bashWaitMs,
  };
}

/**
 * One process writes a request, then reads a fixed-size reply. The host never
 * closes the reply pipe. That is the RPC shape stubs would use.
 */
async function probeFramedRoundTrip(log: string[], bash: WasixCommand): Promise<FramedRoundTripResult> {
  const dir = new Directory();
  const toHost = dir.installHostPipe("/to-host");
  const fromHost = dir.installHostPipe("/from-host");
  const decoder = new TextDecoder();
  const reading = withTimeout(
    toHost.read().then((bytes: Uint8Array) => decoder.decode(bytes)),
    30_000,
    "framed toHost.read()",
  );
  note(log, "framed bash.run");
  const startedAt = Date.now();
  const instance = await bash.run({
    args: [
      "-c",
      `printf ${FRAME_REQ} > /mounted/to-host; head -c ${FRAME_REPLY.length} /mounted/from-host`,
    ],
    mount: { "/mounted": dir },
    uses: ["wasmer/coreutils@1.0.25"],
    stdin: CLOSED_STDIN,
  });
  const done = instance.wait();
  const request = await reading;
  const requestMs = Date.now() - startedAt;
  note(log, `framed request ${JSON.stringify(request)} after ${requestMs}ms`);
  const repliedAt = Date.now();
  await fromHost.write(new TextEncoder().encode(FRAME_REPLY));
  note(log, "framed replied, pipes left open");
  const output = await withTimeout(done, 60_000, "framed instance.wait()");
  const replyToExitMs = Date.now() - repliedAt;
  note(log, `framed exited ${output.code} after ${replyToExitMs}ms stdout=${JSON.stringify(output.stdout)}`);
  return {
    request,
    stdout: output.stdout,
    stderr: output.stderr,
    code: output.code,
    requestMs,
    replyToExitMs,
  };
}

export function probeHostPipeInWorker(): Promise<FpipeProbeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./wasixFpipeProbeWorker.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("F-pipe probe timed out after 180s"));
    }, 180_000);
    worker.onmessage = (event: MessageEvent<{ kind: string; result?: FpipeProbeResult; error?: string }>) => {
      if (event.data.kind === "log") return;
      clearTimeout(timer);
      worker.terminate();
      if (event.data.kind === "done" && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "F-pipe worker failed"));
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage("start");
  });
}
