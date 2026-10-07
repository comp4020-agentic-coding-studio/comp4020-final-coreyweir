import type { WasixSession } from "./wasixSession.ts";

/**
 * Bridge protocol between a WASIX guest stub and the host.
 *
 * Guest stubs share a single request pipe. Each stub sends one request frame:
 *   [u32 LE len][type u8 = 0][JSON {pid,cwd,argv,env}]
 *
 * The host reads the request, plants a per-pid response pipe, and writes typed
 * frames to it:
 *   [u32 LE len][type u8 = 1][stdout bytes]
 *   [u32 LE len][type u8 = 2][stderr bytes]
 *   [u32 LE len][type u8 = 3][i32 LE exit code]
 *   [u32 LE len][type u8 = 4][error text]
 *
 * Each stub reads only its own pid's response pipe, so any number of stubs can
 * be in flight concurrently (e.g. Claude Code under node, dev servers).
 *
 * Guest->host signal frames ride the shared request pipe, which only the host
 * reads, so they cannot be stolen by another stub:
 *   [u32 LE len][type u8 = 5][i32 LE pid][u8 signal]
 * The host routes them to the in-flight request with that pid. (The guest pid
 * is reused across top-level instances — each `session.run` starts a process
 * tree at pid 1 — so the host serializes requests per pid.)
 */

export type BridgeRequest = {
  pid: number;
  cwd: string;
  argv: string[];
  env: string[];
};

/** Frame-encoding output sinks handed to the host-side command handler. */
export type BridgeOutput = {
  writeStdout(chunk: Uint8Array): Promise<void>;
  writeStderr(chunk: Uint8Array): Promise<void>;
  /** Called when the guest stub receives a signal and forwards it. */
  onSignal(signal: number): void;
};

export type BridgeHostHandler = (
  request: BridgeRequest,
  output: BridgeOutput,
) => Promise<number | void>;

export type BridgeProcessRegistration = (
  request: BridgeRequest,
  signal: (signal: number) => void,
) => () => void;

/** The I/O surface a host needs to serve the bridge protocol. */
export type BridgeIo = {
  /** Read the next chunk from the shared request pipe (blocks until a stub writes). */
  read(): Promise<Uint8Array>;
  /** Plant (idempotently) a response pipe so the guest can open it. */
  openResp(channel: string, pid: number): Promise<void>;
  /** Write a chunk to a request's response pipe. */
  writeTo(channel: string, pid: number, data: Uint8Array): Promise<void>;
  /**
   * The channel directory a request's stub is reading, derived from the
   * `RIFF_BRIDGE_ROOT` it was launched with.
   */
  channelOf(request: BridgeRequest): string;
};

const MAX_FRAME = 65536;
const decoder = new TextDecoder();

/** Read one complete frame from a pipe, accumulating across reads. */
export async function readFrame(read: () => Promise<Uint8Array>): Promise<{ type: number; body: Uint8Array }> {
  const buf: number[] = [];
  while (buf.length < 4) {
    const chunk = await read();
    if (chunk.byteLength === 0) throw new Error("bridge pipe EOF while reading frame header");
    for (const b of chunk) buf.push(b);
  }
  const len = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
  if (len === 0 || len > MAX_FRAME) throw new Error(`bridge bad frame length ${len}`);
  while (buf.length < 4 + len) {
    const chunk = await read();
    if (chunk.byteLength === 0) throw new Error("bridge pipe EOF while reading frame body");
    for (const b of chunk) buf.push(b);
  }
  const body = new Uint8Array(len);
  for (let i = 0; i < len; i++) body[i] = buf[4 + i];
  return { type: body[0], body: body.subarray(1) };
}

export function writeFrame(write: (data: Uint8Array) => Promise<void>, type: number, payload: Uint8Array): Promise<void> {
  const frame = new Uint8Array(4 + 1 + payload.byteLength);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, 1 + payload.byteLength, true);
  frame[4] = type;
  frame.set(payload, 5);
  return write(frame);
}

/** Frame-encoding output sinks backed by a raw bridge writer. */
export function frameSinks(write: (data: Uint8Array) => Promise<void>): BridgeOutput {
  return {
    writeStdout: (chunk) => writeFrame(write, 1, chunk),
    writeStderr: (chunk) => writeFrame(write, 2, chunk),
    onSignal: () => {},
  };
}

/** Build a frame's bytes without a writer. */
function writeFrameBytes(type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + 1 + payload.byteLength);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, 1 + payload.byteLength, true);
  frame[4] = type;
  frame.set(payload, 5);
  return frame;
}

/**
 * Serve one bridge request/response cycle to a specific pid. `writeTo` is the
 * per-pid writer; the request was already read from the shared request pipe.
 */
async function serveRequest(
  request: BridgeRequest,
  io: BridgeIo,
  handler: BridgeHostHandler,
  signals: Map<number, (signal: number) => void>,
): Promise<void> {
  // Plant the response pipe up front so the guest stub can open it even if the
  // host command takes a while to produce its first output frame.
  const channel = io.channelOf(request);
  await io.openResp(channel, request.pid);
  const write = (data: Uint8Array) => io.writeTo(channel, request.pid, data);
  const sinks = frameSinks(write);
  signals.set(request.pid, (signal) => sinks.onSignal(signal));
  try {
    const exitCode = await handler(request, sinks);
    const code = new Uint8Array(new Int32Array([Number(exitCode ?? 0) | 0]).buffer);
    await write(writeFrameBytes(3, code));
  } catch (error) {
    const message = new TextEncoder().encode(`bridge: host command failed: ${error instanceof Error ? error.message : String(error)}`);
    await write(writeFrameBytes(4, message));
  } finally {
    signals.delete(request.pid);
  }
}

/**
 * Serve the bridge protocol forever: read frames off the shared pipe and
 * dispatch requests to the handler concurrently, writing responses to each
 * request's own per-pid pipe. Signal frames (type 5) are routed to the
 * in-flight request with the matching pid. Resolves when the read side EOFs
 * (session teardown).
 *
 * The guest pid is reused across top-level instances, so a request for a pid
 * that already has one in flight waits for the previous one to finish (the
 * two are different guest processes sharing a pipe path).
 */
export async function bridgeServeAll(
  io: BridgeIo,
  handler: BridgeHostHandler,
): Promise<void> {
  const signals = new Map<number, (signal: number) => void>();
  const inFlight = new Map<string, Promise<void>>();

  const dispatch = (frame: { type: number; body: Uint8Array }) => {
    if (frame.type === 5) {
      // Guest signal: body = [i32 LE pid][u8 sig].
      const body = frame.body;
      if (body.byteLength < 5) return;
      const pid = body[0] | (body[1] << 8) | (body[2] << 16) | (body[3] << 24);
      const signal = body[4];
      signals.get(pid)?.(signal);
      return;
    }
    if (frame.type !== 0) return;
    let request: BridgeRequest;
    try {
      request = JSON.parse(decoder.decode(frame.body)) as BridgeRequest;
    } catch {
      return;
    }
    if (!Number.isInteger(request.pid) || !Array.isArray(request.argv) || typeof request.cwd !== "string") {
      return;
    }
    // Keyed by channel+pid: two concurrent commands both have a stub at the
    // same pid, but they read different pipes, so they must not serialize
    // against each other.
    const key = `${io.channelOf(request)}/${request.pid}`;
    const previous = inFlight.get(key);
    const current = (previous ?? Promise.resolve()).then(() => serveRequest(request, io, handler, signals));
    inFlight.set(key, current.catch(() => {}));
  };

  for (;;) {
    let frame;
    try {
      frame = await readFrame(io.read);
    } catch (error) {
      // EOF or session teardown — stop serving.
      break;
    }
    dispatch(frame);
  }
}

/**
 * Convenience for a host that wants to drive the cycle itself (single request).
 * Kept for the mock probes; production uses `bridgeServeAll`.
 */
export async function bridgeServe(
  read: () => Promise<Uint8Array>,
  write: (data: Uint8Array) => Promise<void>,
  handler: BridgeHostHandler,
): Promise<void> {
  const frame = await readFrame(read);
  if (frame.type !== 0) {
    await writeFrame(write, 4, new TextEncoder().encode(`bridge: expected request frame, got type ${frame.type}`));
    return;
  }
  let request: BridgeRequest;
  try {
    request = JSON.parse(decoder.decode(frame.body)) as BridgeRequest;
  } catch (error) {
    await writeFrame(write, 4, new TextEncoder().encode(`bridge: bad request JSON: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  if (!Array.isArray(request.argv) || typeof request.cwd !== "string") {
    await writeFrame(write, 4, new TextEncoder().encode(`bridge: malformed request: ${JSON.stringify(request)}`));
    return;
  }
  const sinks = frameSinks(write);
  try {
    const exitCode = await handler(request, sinks);
    await writeFrame(write, 3, new Uint8Array(new Int32Array([Number(exitCode ?? 0)].map((n) => n | 0)).buffer));
  } catch (error) {
    await writeFrame(write, 4, new TextEncoder().encode(`bridge: host command failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** Convenience for a host that wants to drive the cycle itself. */
export function sessionBridge(session: WasixSession): BridgeIo {
  return {
    read: () => session.bridgeRead(),
    openResp: (channel, pid) => session.bridgeOpenResp(channel, pid),
    writeTo: async (channel, pid, data) => {
      await session.bridgeOpenResp(channel, pid);
      await session.bridgeWriteTo(channel, pid, data);
    },
    channelOf: (request) => session.channelForBridgeRoot(bridgeRootOf(request)),
  };
}

/** The `RIFF_BRIDGE_ROOT` a request's stub was launched with, if any. */
export function bridgeRootOf(request: BridgeRequest): string | undefined {
  for (const entry of request.env ?? []) {
    if (entry.startsWith("RIFF_BRIDGE_ROOT=")) return entry.slice("RIFF_BRIDGE_ROOT=".length);
  }
  return undefined;
}
