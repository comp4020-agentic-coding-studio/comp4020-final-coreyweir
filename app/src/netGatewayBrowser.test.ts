// Focused tests for the browser-side net gateway (src/netGatewayBrowser.ts),
// exercised over a real in-process MessageChannel pair exactly as the app
// wires it (main thread attaches port1, the WASIX worker receives port2).
// Runs under `node --test` (Node 26 type stripping); the guest side is a
// hand-rolled virtual-net client speaking the same bincode frames the Rust
// client sends. A real local Node HTTP server stands in for the upstream
// origin so the dispatch path (fetch, chunked re-framing, header hygiene)
// is measured end to end.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  NETWORK_ERROR,
  decodeMessageRequest,
  encodeSocketAddr,
  type DecodedRequest,
} from "./netGatewayCodec.ts";
import { attachNetGatewayBrowser } from "./netGatewayBrowser.ts";

// --- guest-side frame builders (Uint8Array/DataView; no Buffer) ---

function bytesOf(parts: Array<number | Uint8Array>): Uint8Array {
  const flat = parts.flatMap((p) => (typeof p === "number" ? [p] : [...p]));
  return Uint8Array.from(flat);
}

function u32(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, true);
  return b;
}

function u64(value: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(value), true);
  return b;
}

function reqId(id: number): Uint8Array {
  // Option<u64>: tag byte 1, then the u64.
  const value = u64(id);
  const out = new Uint8Array(1 + value.length);
  out[0] = 1;
  out.set(value, 1);
  return out;
}

function ip4(address: string) {
  return { family: 4 as const, octets: address.split(".").map(Number) };
}

function connectFrame(id: number, port: number, ip = ip4("93.184.216.34"), request = id): Uint8Array {
  // MessageRequest::Interface (0), RequestType::ConnectTcp (18),
  // payload { socket_id, addr (local bind), peer (destination) }, req_id.
  const local = { ip: ip4("0.0.0.0"), port: 0 };
  return bytesOf([
    u32(0),
    u32(18),
    u64(id),
    encodeSocketAddr(local),
    encodeSocketAddr({ ip, port }),
    reqId(request),
  ]);
}

function sendFrame(id: number, data: string): Uint8Array {
  // MessageRequest::Send (2): socket, vec payload, req_id = None.
  const payload = new TextEncoder().encode(data);
  return bytesOf([u32(2), u64(id), u64(payload.length), payload, 0]);
}

function socketFrame(id: number, request: number, name: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  // MessageRequest::Socket (1): socket, RequestType, payload, req_id.
  return bytesOf([u32(1), u64(id), u32(name), payload, reqId(request)]);
}

function shutdownWriteFrame(id: number, request: number): Uint8Array {
  // RequestType::Shutdown (41), Shutdown::Write = 1.
  return socketFrame(id, request, 41, u32(1));
}

function resolveFrame(request: number, host: string): Uint8Array {
  // MessageRequest::Interface (0), RequestType::Resolve (19),
  // payload { host, port: None, dns_server: None }, req_id.
  const hostBytes = new TextEncoder().encode(host);
  return bytesOf([u32(0), u32(19), u64(hostBytes.length), hostBytes, 0, 0, reqId(request)]);
}

// Response-frame predicates and accessors.
const isReply = (id: number) => (frame: Uint8Array) =>
  readU32(frame, 0) === 0 && readU64(frame, 4) === BigInt(id);
const isClosed = (id: number) => (frame: Uint8Array) =>
  readU32(frame, 0) === 6 && readU64(frame, 4) === BigInt(id);
const isSent = (id: number) => (frame: Uint8Array) =>
  readU32(frame, 0) === 3 && readU64(frame, 4) === BigInt(id);

function readU32(frame: Uint8Array, offset: number): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(offset, true);
}
function readU64(frame: Uint8Array, offset: number): bigint {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(offset, true);
}

function receivedText(frames: Uint8Array[]): string {
  const recv = frames.filter((f) => readU32(f, 0) === 1);
  const chunks = recv.map((f) => f.subarray(20));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("latin1").decode(out);
}

// Decode the chunked-encoded response body the guest received.
function responseBody(response: string): string {
  let chunked = response.slice(response.indexOf("\r\n\r\n") + 4);
  let body = "";
  for (;;) {
    const line = chunked.indexOf("\r\n");
    const length = Number.parseInt(chunked.slice(0, line), 16);
    if (length === 0) return body;
    body += chunked.slice(line + 2, line + 2 + length);
    chunked = chunked.slice(line + 2 + length + 2);
  }
}

// --- harness ---

interface Guest {
  frames: Uint8Array[];
  send(frame: Uint8Array): void;
  clear(): void;
  wait(predicate: (frame: Uint8Array) => boolean): Promise<Uint8Array>;
}

function makeGuest(t: test.TestContext, dispose: (fn: () => void) => void): { guest: Guest } {
  const channel = new MessageChannel();
  const handle = attachNetGatewayBrowser(channel.port1);
  dispose(() => {
    handle.dispose();
    channel.port2.close();
  });
  const frames: Uint8Array[] = [];
  const pending: Array<() => void> = [];
  channel.port2.onmessage = (event: MessageEvent) => {
    const data = event.data as ArrayBuffer;
    frames.push(new Uint8Array(data));
    for (const resolve of pending.splice(0)) resolve();
  };
  const guest: Guest = {
    frames,
    send(frame) {
      channel.port2.postMessage(frame, [frame.buffer]);
    },
    clear() {
      frames.length = 0;
    },
    async wait(predicate) {
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        await new Promise<void>((resolve) => pending.push(resolve));
      }
    },
  };
  return { guest };
}

async function listenHttp(t: test.TestContext, handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<number> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return (server.address() as AddressInfo).port;
}

// --- tests ---

test("wire: ConnectTcp answers Socket then exactly one 1MiB Sent; GetStatus does not re-arm; duplicate connect refused", async (t) => {
  const disposals: Array<() => void> = [];
  t.after(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
  });
  const port = await listenHttp(t, (_req, res) => res.end("x"));
  const { guest } = makeGuest(t, (fn) => disposals.push(fn));
  guest.clear();

  guest.send(connectFrame(1, port));
  await guest.wait(isSent(1));
  assert.deepEqual(
    guest.frames.map((f) => readU32(f, 0)),
    [0, 3], // Socket reply, then Sent; nothing else.
  );
  const socketReply = guest.frames[0];
  assert.equal(readU32(socketReply, 12), 12); // ResponseType::Socket
  assert.equal(readU64(socketReply, 16), 1n);
  assert.equal(readU64(guest.frames[1], 20), 1024n * 1024n);

  guest.clear();
  guest.send(socketFrame(1, 2, 26)); // GetStatus must not re-arm the window.
  await guest.wait(isReply(2));
  assert.deepEqual(
    guest.frames.map((f) => readU32(f, 0)),
    [0], // Only the reply.
  );

  guest.clear();
  guest.send(connectFrame(1, port, ip4("93.184.216.34"), 3));
  const duplicate = await guest.wait(isReply(3));
  assert.equal(readU32(duplicate, 12), 1); // ResponseType::Err
  assert.equal(readU32(duplicate, 16), NETWORK_ERROR.AlreadyExists);
});

test("wire: plain HTTP GET through a real local origin streams a chunked response and closes", async (t) => {
  const disposals: Array<() => void> = [];
  t.after(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
  });
  let seenHost: string | undefined;
  let seenSecret: string | string[] | undefined;
  const port = await listenHttp(t, (req, res) => {
    seenHost = req.headers.host;
    seenSecret = req.headers["x-secret"];
    res.setHeader("x-test", "yes");
    res.end("hello from origin");
  });
  const { guest } = makeGuest(t, (fn) => disposals.push(fn));

  guest.send(connectFrame(1, port, ip4("127.0.0.1")));
  await guest.wait(isSent(1));
  guest.clear();
  // Nominate a custom hop header; it and Connection itself must never reach
  // the origin (Node's undici adds its own connection header, so that one is
  // not asserted here — browser fetch would not send it).
  guest.send(
    sendFrame(1, `GET /path?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive, x-secret\r\nX-Secret: remove\r\n\r\n`),
  );
  await guest.wait(isClosed(1));

  assert.equal(seenHost, `127.0.0.1:${port}`);
  assert.equal(seenSecret, undefined); // nominated hop header stripped
  const text = receivedText(guest.frames);
  assert.match(text, /^HTTP\/1\.1 200 /);
  assert.match(text, /transfer-encoding: chunked/i);
  assert.match(text, /x-test: yes/i);
  assert.match(text, /connection: close/i);
  assert.equal(responseBody(text), "hello from origin");
  assert.equal(guest.frames.filter(isClosed(1)).length, 1);
});

test("wire: fragmented POST body completes after guest write-half shutdown, dispatches once", async (t) => {
  const disposals: Array<() => void> = [];
  t.after(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
  });
  let bodies = 0;
  let requestBody = "";
  const port = await listenHttp(t, (_req, res, body) => {
    bodies += 1;
    requestBody = body;
    res.end("accepted");
  });
  const { guest } = makeGuest(t, (fn) => disposals.push(fn));

  guest.send(connectFrame(1, port, ip4("127.0.0.1")));
  await guest.wait(isSent(1));
  guest.clear();
  guest.send(sendFrame(1, `POST /submit HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 6\r\n\r\nab`));
  guest.send(sendFrame(1, "cd"));
  guest.send(sendFrame(1, "ef"));
  guest.send(shutdownWriteFrame(1, 2));
  await guest.wait(isClosed(1));

  assert.equal(bodies, 1);
  assert.equal(requestBody, "abcdef");
  const text = receivedText(guest.frames);
  assert.match(text, /^HTTP\/1\.1 200 /);
  assert.equal(responseBody(text), "accepted");
});

test("wire: port 443 creates a TLS-wrapped virtual socket", async (t) => {
  const disposals: Array<() => void> = [];
  t.after(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
  });
  const { guest } = makeGuest(t, (fn) => disposals.push(fn));
  guest.send(connectFrame(1, 443, ip4("93.184.216.34")));
  const reply = await guest.wait(isReply(1));
  assert.equal(readU32(reply, 12), 12); // ResponseType::Socket
  await guest.wait(isSent(1));
});

test("wire: Resolve answers with a deterministic synthetic address list", async (t) => {
  const disposals: Array<() => void> = [];
  t.after(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
  });
  const { guest } = makeGuest(t, (fn) => disposals.push(fn));
  guest.send(resolveFrame(1, "example.test"));
  guest.send(resolveFrame(2, "example.test"));
  await guest.wait(isReply(2));
  const first = guest.frames.find(isReply(1));
  assert.ok(first);
  assert.equal(readU32(first, 12), 5); // ResponseType::IpAddressList
  const count = Number(readU64(first, 16));
  assert.equal(count, 1);
  assert.equal(readU32(first, 24), 0); // IpAddr::V4
  assert.equal(first[28], 10); // first octet of the synthetic 10.x.x.x range
  // Deterministic across repeated lookups.
  const second = guest.frames.find(isReply(2));
  assert.ok(second);
  for (let i = 0; i < 4; i++) assert.equal(second[28 + i], first[28 + i]);
});

test("codec: decodeMessageRequest accepts well-formed Send and rejects truncation/trailing bytes", () => {
  const valid = sendFrame(1, "data");
  const decoded: DecodedRequest = decodeMessageRequest(valid);
  assert.equal(decoded.kind, "Send");
  if (decoded.kind === "Send") {
    assert.equal(decoded.socket, 1n);
    assert.equal(new TextDecoder().decode(decoded.data), "data");
  }
  for (let length = 0; length < valid.length; length++) {
    assert.throws(() => decodeMessageRequest(valid.subarray(0, length)));
  }
  assert.throws(() => decodeMessageRequest(bytesOf([valid, 0])));
});
