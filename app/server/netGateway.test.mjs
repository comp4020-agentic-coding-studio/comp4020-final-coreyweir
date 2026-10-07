import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import dns from "node:dns";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";
import tls from "node:tls";
import { gzipSync } from "node:zlib";
import { WebSocket } from "ws";
import { createNetGateway, EphemeralCa, HttpOriginator, resolveEgressTarget } from "./netGateway.mjs";
import { decodeMessageRequest, encodeSocketAddr, NETWORK_ERROR } from "./netVirtualCodec.mjs";

const PUBLIC_IP = "93.184.216.34";
const publicRecord = { address: PUBLIC_IP, family: 4 };

function publicDns(t) {
  return t.mock.method(dns.promises, "lookup", async () => [publicRecord]);
}

function parser(t, scheme = "http", port = 80) {
  const output = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
  });
  const originator = new HttpOriginator(socket, scheme, port);
  t.after(() => socket.destroy());
  return { originator, socket, text: () => Buffer.concat(output).toString("latin1") };
}

async function exchange(t, fragments, options = {}) {
  const result = parser(t, options.scheme, options.port);
  const finished = once(result.socket, "finish");
  for (const fragment of fragments) result.originator.onPlaintext(Buffer.from(fragment));
  if (options.eof) result.socket.emit("end");
  await finished;
  return result.text();
}

test("egress policy rejects private, special-use, loopback and mapped addresses", async () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "100.64.0.1", "169.254.169.254",
    "172.16.0.1", "192.168.1.1", "192.0.0.1", "192.0.2.1", "192.88.99.1",
    "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.1.1",
    "::127.0.0.1", "fc00::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1",
    "64:ff9b::7f00:1", "2001::1", "2001:db8::1", "2002:7f00:1::", "3fff::1",
  ]) await assert.rejects(resolveEgressTarget(address), /blocked|invalid IPv6/, address);
  for (const address of [PUBLIC_IP, "2606:4700:4700::1111", "::ffff:93.184.216.34"]) {
    assert.equal((await resolveEgressTarget(address)).address, address);
  }
});

test("DNS policy checks every answer, including mixed public/private families", async (t) => {
  const lookup = t.mock.method(dns.promises, "lookup", async () => [publicRecord, { address: "::1", family: 6 }]);
  await assert.rejects(resolveEgressTarget("example.test"), /blocked/);
  assert.equal(lookup.mock.callCount(), 1);
});

test("parser rejects authority, URL and request-smuggling ambiguities", (t) => {
  const { originator } = parser(t);
  const requests = [
    "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test",
    "GET http://example.test/ HTTP/1.1\r\nHost: example.test",
    "GET //127.0.0.1/ HTTP/1.1\r\nHost: example.test",
    "GET /\\127.0.0.1/ HTTP/1.1\r\nHost: example.test",
    "GET /#fragment HTTP/1.1\r\nHost: example.test",
    "GET /bad%xx HTTP/1.1\r\nHost: example.test",
    "GET / HTTP/1.1 extra\r\nHost: example.test",
    "GET / HTTP/1.0\r\nHost: example.test",
    "GET / HTTP/1.1\r\nHost: user@example.test",
    "GET / HTTP/1.1\r\nHost: example.test/path",
    "GET / HTTP/1.1\r\nHost: example.test\\@127.0.0.1",
    "GET / HTTP/1.1\r\nHost: example.test#@127.0.0.1",
    "GET / HTTP/1.1\r\nHost: %31%32%37.0.0.1",
    "GET / HTTP/1.1\r\nHost: example.test:",
    "GET / HTTP/1.1\r\nHost: example.test\u00a0",
    "GET / HTTP/1.1\r\nHost: example.test:443",
    "GET / HTTP/1.1\r\nHost: ::1",
    "GET / HTTP/1.1\r\nHost: example.test\r\nHost: other.test",
    "GET / HTTP/1.1\r\nHost : example.test",
    "GET / HTTP/1.1\r\nHost: example.test\r\nNo-Colon",
    "GET / HTTP/1.1\r\nHost: example.test\r\n folded: value",
    "GET / HTTP/1.1\r\nHost: example.test\r\nX-Test: a\u0000b",
    "GET / HTTP/1.1\r\nHost: example.test\r\nConnection: x-test,",
    "GET / HTTP/1.1\r\nHost: example.test\r\nConnection: Host",
    "GET / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 1",
    "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 1\r\nContent-Length: 1",
    "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 1, 1",
    "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: +1",
    "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 1e2",
    "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 10485761",
    "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 9007199254740993",
    "POST / HTTP/1.1\r\nHost: example.test\r\nTransfer-Encoding: chunked",
    "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 1\r\nTransfer-Encoding: identity",
    "POST / HTTP/1.1\r\nHost: example.test\r\nExpect: something-else",
  ];
  for (const request of requests) assert.throws(() => originator.parseHead(request), undefined, request);
  for (const host of ["[::1]", "[::ffff:127.0.0.1]", "127.1", "2130706433", "0x7f000001"]) {
    const request = originator.parseHead(`GET / HTTP/1.1\r\nHost: ${host}`);
    assert.match(request.url.hostname, /127\.0\.0\.1|\[::1\]|\[::ffff:7f00:1\]/);
  }
  const request = originator.parseHead("GET /%2f%2fevil.test/?x=%23 HTTP/1.1\r\nHost: EXAMPLE.TEST\r\n__proto__: safe");
  assert.equal(request.url.origin, "http://example.test");
  assert.equal(Object.getPrototypeOf(request.headers), null);
});

test("complete and fragmented POST bodies dispatch exactly once, stripping hop headers", async (t) => {
  publicDns(t);
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response("accepted"));
  const head = "POST /submit HTTP/1.1\r\nHost: example.test\r\nContent-Length: 6\r\nConnection: keep-alive, X-Secret\r\nX-Secret: remove\r\nProxy-Authorization: secret\r\nTE: trailers\r\nTrailer: x-test\r\nUpgrade: websocket\r\nCookie: a=1\r\nCookie: b=2\r\n\r\n";
  for (const fragments of [[head + "abcdef"], [head.slice(0, 17), head.slice(17) + "ab", "cd", "ef"], [...(head + "abcdef")]]) {
    const text = await exchange(t, fragments);
    assert.match(text, /^HTTP\/1.1 200 /);
    assert.equal(responseBody(text), "accepted");
  }
  assert.equal(fetched.mock.callCount(), 3);
  for (const call of fetched.mock.calls) {
    const [url, options] = call.arguments;
    assert.equal(url.href, "http://example.test/submit");
    assert.equal(options.body.toString(), "abcdef");
    assert.equal(options.headers.cookie, "a=1; b=2");
    assert.equal(options.headers["accept-encoding"], "identity");
    for (const header of ["host", "connection", "x-secret", "proxy-authorization", "te", "trailer", "upgrade", "content-length"]) assert.equal(options.headers[header], undefined);
    assert.equal(options.redirect, "manual");
    assert.ok(options.dispatcher);
  }
});

test("Expect: 100-continue opens the body phase without premature fetch", async (t) => {
  publicDns(t);
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  const { originator, socket, text } = parser(t);
  const finished = once(socket, "finish");
  originator.onPlaintext(Buffer.from("POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 3\r\nExpect: 100-continue\r\n\r\n"));
  assert.equal(text(), "HTTP/1.1 100 Continue\r\n\r\n");
  assert.equal(fetched.mock.callCount(), 0);
  originator.onPlaintext(Buffer.from("abc"));
  await finished;
  assert.equal(fetched.mock.callCount(), 1);
  assert.match(text(), /HTTP\/1.1 204 /);
});

test("oversized heads, excess bodies, premature EOF and pipelining fail closed", async (t) => {
  const fetched = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  for (const fragments of [
    ["GET / HTTP/1.1\r\nHost: example.test\r\nX: " + "a".repeat(65536)],
    ["GET / HTTP/1.1\r\nHost: example.test\r\nX: " + "a".repeat(65536) + "\r\n\r\n"],
    ["POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 2\r\n\r\nabc"],
    ["GET / HTTP/1.1\r\nHost: example.test\r\n\r\nGET /other HTTP/1.1\r\n\r\n"],
    ["POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 3\r\n\r\na"],
    ["GET / HTTP/1.1\r\nHost: example.test"],
  ]) assert.match(await exchange(t, fragments, { eof: true }), /^HTTP\/1.1 400 /);
  assert.equal(fetched.mock.callCount(), 0);
});

test("canonical IP spellings and IPv6 Hosts cannot bypass egress checks", async (t) => {
  const fetched = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  for (const host of ["127.1", "2130706433", "0x7f000001", "[::1]", "[::ffff:127.0.0.1]"]) {
    assert.match(await exchange(t, [`GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`]), /^HTTP\/1.1 403 /);
  }
  assert.equal(fetched.mock.callCount(), 0);
});

test("HEAD and null-body statuses finish; redirect and response hop headers are not followed/forwarded", async (t) => {
  publicDns(t);
  let response;
  const fetched = t.mock.method(globalThis, "fetch", async () => response);
  for (const [method, status] of [["HEAD", 200], ["GET", 204], ["GET", 304], ["GET", 302]]) {
    response = new Response(null, { status, headers: {
      connection: "close, x-hop", "x-hop": "remove", "keep-alive": "timeout=10",
      "proxy-authenticate": "secret", "content-length": "42", "content-encoding": "gzip",
      location: "http://127.0.0.1/", "set-cookie": "a=1",
    } });
    const text = await exchange(t, [`${method} / HTTP/1.1\r\nHost: example.test\r\n\r\n`]);
    assert.match(text, new RegExp(`^HTTP/1.1 ${status} `));
    assert.ok(text.endsWith("\r\n\r\n"));
    assert.doesNotMatch(text, /x-hop|keep-alive|proxy-authenticate|content-length/i);
    assert.match(text, /location: http:\/\/127.0.0.1\//);
  }
  assert.equal(fetched.mock.callCount(), 4);
});

test("unsupported content codings are rejected rather than mislabeled", async (t) => {
  publicDns(t);
  t.mock.method(globalThis, "fetch", async () => new Response("encoded", { headers: { "content-encoding": "unknown" } }));
  assert.match(await exchange(t, ["GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"]), /^HTTP\/1.1 502 /);
});

test("closing the guest socket aborts an in-flight fetch", async (t) => {
  publicDns(t);
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    started.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      aborted.resolve();
      reject(signal.reason);
    }, { once: true }));
  });
  const { originator, socket, text } = parser(t);
  originator.onPlaintext(Buffer.from("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"));
  await started.promise;
  socket.destroy();
  await aborted.promise;
  assert.equal(text(), "");
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  return server.address().port;
}

function allowPort(t, port) {
  const previous = process.env.RIFF_NET_ALLOW_PORTS;
  process.env.RIFF_NET_ALLOW_PORTS = String(port);
  t.after(() => {
    if (previous === undefined) delete process.env.RIFF_NET_ALLOW_PORTS;
    else process.env.RIFF_NET_ALLOW_PORTS = previous;
  });
}

// Only the test's final dial is redirected to loopback. The production lookup
// must first return the checked public IP; the real fetch and TLS stacks run.
function localDial(t, module, ca) {
  const original = module.connect;
  const observations = [];
  t.mock.method(module, "connect", function (options, ...args) {
    assert.equal(typeof options.lookup, "function");
    const lookup = options.lookup;
    observations.push(options);
    return original.call(this, {
      ...options,
      ...(ca ? { ca } : {}),
      lookup(hostname, opts, callback) {
        lookup(hostname, opts, (error, address, family) => {
          assert.ifError(error);
          if (opts.all) assert.deepEqual(address, [publicRecord]);
          else { assert.equal(address, PUBLIC_IP); assert.equal(family, 4); }
          if (opts.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        });
      },
    }, ...args);
  });
  return observations;
}

test("real Node fetch uses the pinned IP once, preserves Host, and repairs gzip metadata", { timeout: 10000 }, async (t) => {
  let received;
  const body = gzipSync("decoded response");
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { headers: request.headers, body: Buffer.concat(chunks).toString() };
    response.writeHead(200, {
      "content-encoding": "gzip", "content-length": body.length,
      connection: "close, x-remove", "x-remove": "secret", "set-cookie": ["a=1", "b=2"],
    });
    response.end(body);
  });
  const port = await listen(t, server);
  allowPort(t, port);
  let lookups = 0;
  t.mock.method(dns.promises, "lookup", async () => ++lookups === 1 ? [publicRecord] : [{ address: "127.0.0.1", family: 4 }]);
  t.mock.method(dns, "lookup", () => assert.fail("fetch must not resolve DNS again"));
  const dials = localDial(t, net);
  const text = await exchange(t, [`POST / HTTP/1.1\r\nHost: example.test:${port}\r\nContent-Length: 6\r\n\r\nab`, "cd", "ef"], { port });
  assert.equal(lookups, 1);
  assert.equal(dials.length, 1);
  assert.equal(received.headers.host, `example.test:${port}`);
  assert.equal(received.body, "abcdef");
  assert.ok(text.endsWith("10\r\ndecoded response\r\n0\r\n\r\n"));
  assert.doesNotMatch(text, /content-encoding|content-length|x-remove/i);
  assert.match(text, /transfer-encoding: chunked/i);
  assert.match(text, /set-cookie: a=1\r\nset-cookie: b=2/);
});

test("HTTPS pinned dial retains SNI and rejects an upstream hostname mismatch", { timeout: 10000 }, async (t) => {
  const ca = new EphemeralCa();
  t.after(() => ca.dispose());
  const leaf = await ca.leaf("origin.test");
  let sni;
  const server = https.createServer(leaf, (request, response) => {
    sni = request.socket.servername;
    response.end("secure upstream");
  });
  const port = await listen(t, server);
  allowPort(t, port);
  publicDns(t);
  const dials = localDial(t, tls, ca.caPem());
  const text = await exchange(t, [`GET / HTTP/1.1\r\nHost: origin.test:${port}\r\n\r\n`], { scheme: "https", port });
  assert.equal(responseBody(text), "secure upstream");
  assert.equal(sni, "origin.test");
  assert.equal(dials[0].rejectUnauthorized, true);
  const rejected = await exchange(t, [`GET / HTTP/1.1\r\nHost: wrong.test:${port}\r\n\r\n`], { scheme: "https", port });
  assert.match(rejected, /^HTTP\/1.1 502 /);
});

function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; }
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
const reqId = (id) => Buffer.concat([Buffer.from([1]), u64(id)]);
const ip4 = (address) => ({ family: 4, octets: address.split(".").map(Number) });
function connectFrame(id, port = 80, ip = ip4(PUBLIC_IP), request = id) {
  return Buffer.concat([u32(0), u32(18), u64(id), encodeSocketAddr({ ip: ip4("0.0.0.0"), port: 0 }), encodeSocketAddr({ ip, port }), reqId(request)]);
}
function sendFrame(id, data) {
  const bytes = Buffer.from(data);
  return Buffer.concat([u32(2), u64(id), u64(bytes.length), bytes, Buffer.from([0])]);
}
function socketFrame(id, request, name, payload = Buffer.alloc(0)) {
  return Buffer.concat([u32(1), u64(id), u32(name), payload, reqId(request)]);
}

async function gatewayClient(t) {
  const ca = new EphemeralCa();
  const gateway = createNetGateway({ ca });
  t.after(() => gateway.close());
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  const port = await listen(t, server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/net-gateway/`);
  const frames = [];
  const events = new EventEmitter();
  ws.on("message", (bytes) => { frames.push(Buffer.from(bytes)); events.emit("frame"); });
  await once(ws, "open");
  t.after(() => ws.terminate());
  async function wait(predicate) {
    while (!frames.some(predicate)) await once(events, "frame");
    return frames.find(predicate);
  }
  return { ca, gateway, ws, frames, wait };
}

const isReply = (id) => (frame) => frame.readUInt32LE(0) === 0 && frame.readBigUInt64LE(4) === BigInt(id);
const isClosed = (id) => (frame) => frame.readUInt32LE(0) === 6 && frame.readBigUInt64LE(4) === BigInt(id);
function received(frames) {
  return Buffer.concat(frames.filter((f) => f.readUInt32LE(0) === 1).map((f) => f.subarray(20))).toString("latin1");
}

function responseBody(response) {
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

test("wire: Socket then exactly one initial Sent, HEAD EOF, duplicate connect and IsClosed", { timeout: 10000 }, async (t) => {
  publicDns(t);
  t.mock.method(globalThis, "fetch", async () => new Response(null));
  const { ws, frames, wait } = await gatewayClient(t);
  ws.send(connectFrame(1));
  ws.send(socketFrame(1, 2, 26)); // GetStatus must not re-arm the window.
  await wait(isReply(2));
  assert.deepEqual(frames.map((f) => f.readUInt32LE(0)), [0, 3, 0]);
  assert.equal(frames[1].readBigUInt64LE(20), 1024n * 1024n);
  ws.send(connectFrame(1, 80, ip4(PUBLIC_IP), 3));
  assert.equal((await wait(isReply(3))).readUInt32LE(16), NETWORK_ERROR.AlreadyExists);
  ws.send(sendFrame(1, "HEAD / HTTP/1.1\r\nHost: example.test\r\n\r\n"));
  await wait(isClosed(1));
  assert.match(received(frames), /^HTTP\/1.1 200 [^]*\r\n\r\n$/);
  ws.send(socketFrame(1, 4, 42)); // IsClosed
  assert.equal((await wait(isReply(4))).readUInt8(16), 1);
  ws.send(socketFrame(1, 5, 20)); // Repeated Close does not emit another Closed.
  await wait(isReply(5));
  assert.equal(frames.filter(isClosed(1)).length, 1);
});

test("wire: fragmented request survives guest write EOF and closes after response", { timeout: 10000 }, async (t) => {
  publicDns(t);
  const fetched = t.mock.method(globalThis, "fetch", async (_url, options) => new Response(options.body));
  const { ws, frames, wait } = await gatewayClient(t);
  ws.send(connectFrame(1));
  ws.send(sendFrame(1, "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 6\r\n\r\nab"));
  ws.send(sendFrame(1, "cd"));
  ws.send(sendFrame(1, "ef"));
  ws.send(socketFrame(1, 2, 41, u32(1))); // Shutdown::Write
  await wait(isClosed(1));
  assert.equal(fetched.mock.callCount(), 1);
  assert.equal(responseBody(received(frames)), "abcdef");
  assert.equal(frames.filter(isClosed(1)).length, 1);
});

test("wire: truncated body on EOF gets 400; private IPv6 ConnectTcp is refused", { timeout: 10000 }, async (t) => {
  const { ws, frames, wait } = await gatewayClient(t);
  for (const [id, octets] of [[1, [...Array(15).fill(0), 1]], [2, [...Array(10).fill(0), 255, 255, 127, 0, 0, 1]]]) {
    ws.send(connectFrame(id, 443, { family: 6, octets }));
    assert.equal((await wait(isReply(id))).readUInt32LE(16), NETWORK_ERROR.PermissionDenied);
  }
  ws.send(connectFrame(3));
  ws.send(sendFrame(3, "POST / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 3\r\n\r\na"));
  ws.send(socketFrame(3, 4, 41, u32(1)));
  await wait(isClosed(3));
  assert.match(received(frames), /^HTTP\/1.1 400 /);
});

test("wire: TLS guest trusts ephemeral leaf, binds Host to SNI, and receives EOF", { timeout: 15000 }, async (t) => {
  publicDns(t);
  const body = "TLS response bytes\n".repeat(12000);
  const fetched = t.mock.method(globalThis, "fetch", async (_url, { method }) => new Response(method === "HEAD" ? null : body));
  const { ca, ws, wait } = await gatewayClient(t);
  await ca.ready();
  for (const [id, method, host, status] of [[1, "HEAD", "example.test", 200], [2, "GET", "example.test", 200], [3, "HEAD", "other.test", 400]]) {
    const transport = new Duplex({
      read() {},
      write(chunk, _encoding, callback) { ws.send(sendFrame(id, chunk), callback); },
      final(callback) { ws.send(socketFrame(id, 100 + id, 41, u32(1)), callback); },
    });
    const onMessage = (frame) => {
      if (frame.readUInt32LE(0) === 1 && frame.readBigUInt64LE(4) === BigInt(id)) transport.push(frame.subarray(20));
      if (isClosed(id)(frame)) transport.push(null);
    };
    ws.on("message", onMessage);
    ws.send(connectFrame(id, 443));
    await wait(isReply(id));
    const client = tls.connect({ socket: transport, servername: "example.test", ca: ca.caPem(), ALPNProtocols: ["http/1.1"] });
    t.after(() => { client.destroy(); transport.destroy(); ws.off("message", onMessage); });
    await once(client, "secureConnect");
    assert.equal(client.authorized, true);
    assert.equal(client.alpnProtocol, "http/1.1");
    const chunks = [];
    client.on("data", (chunk) => chunks.push(chunk));
    const ended = once(client, "end");
    client.write(`${method} / HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    await ended;
    await wait(isClosed(id));
    const text = Buffer.concat(chunks).toString();
    assert.match(text, new RegExp(`^HTTP/1.1 ${status} `));
    if (method === "GET") assert.equal(responseBody(text), body);
  }
  assert.equal(fetched.mock.callCount(), 2);
});

test("wire: failed TLS handshake closes the virtual socket without HTTP dispatch", { timeout: 10000 }, async (t) => {
  const fetched = t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const { ws, wait } = await gatewayClient(t);
  ws.send(connectFrame(1, 443));
  await wait(isReply(1));
  ws.send(sendFrame(1, "GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"));
  await wait(isClosed(1));
  assert.equal(fetched.mock.callCount(), 0);
});

test("CA coalesces concurrent leaves, uses distinct serials and removes generated files", { timeout: 15000 }, async (t) => {
  const ca = new EphemeralCa();
  t.after(() => ca.dispose());
  const first = ca.leaf("one.test");
  assert.equal(first, ca.leaf("ONE.TEST"));
  const [one, two] = await Promise.all([first, ca.leaf("two.test")]);
  const oneCert = new X509Certificate(one.cert);
  const twoCert = new X509Certificate(two.cert);
  const root = new X509Certificate(ca.caPem());
  assert.equal(oneCert.checkHost("one.test"), "one.test");
  assert.equal(twoCert.checkHost("two.test"), "two.test");
  assert.notEqual(oneCert.serialNumber, twoCert.serialNumber);
  assert.equal(oneCert.verify(root.publicKey), true);
  assert.equal(twoCert.verify(root.publicKey), true);
  assert.deepEqual(fs.readdirSync(ca.dir).sort(), ["ca.crt", "ca.key"]);
  await assert.rejects(ca.leaf("evil.test\nsubjectAltName=DNS:other.test"));
  await ca.dispose();
  assert.equal(fs.existsSync(ca.dir), false);
  await assert.rejects(ca.leaf("one.test"), /disposed/);
  await assert.rejects(ca.ready(), /disposed/);
});

test("CA disposal aborts concurrent generation and cleans its directory", { timeout: 10000 }, async () => {
  for (const initialized of [false, true]) {
    const ca = new EphemeralCa();
    if (initialized) await ca.ready();
    const settled = Promise.allSettled([ca.leaf("one.test"), ca.leaf("two.test")]);
    if (initialized) await new Promise((resolve) => setImmediate(resolve));
    await ca.dispose();
    assert.ok((await settled).every((result) => result.status === "rejected"));
    assert.equal(fs.existsSync(ca.dir), false);
  }
});

test("codec rejects truncated lengths, missing/invalid options and trailing bytes", () => {
  const valid = sendFrame(1, "data");
  assert.equal(decodeMessageRequest(valid).data.toString(), "data");
  for (let length = 0; length < valid.length; length++) assert.throws(() => decodeMessageRequest(valid.subarray(0, length)));
  assert.throws(() => decodeMessageRequest(Buffer.concat([valid, Buffer.from([0])])));
  const invalidOption = Buffer.from(valid);
  invalidOption[invalidOption.length - 1] = 2;
  assert.throws(() => decodeMessageRequest(invalidOption));
  const huge = Buffer.from(valid);
  huge.writeBigUInt64LE(2n ** 63n, 12);
  assert.throws(() => decodeMessageRequest(huge));
});

test("malformed wire frame terminates the session; gateway close terminates clients", { timeout: 10000 }, async (t) => {
  const { ws, gateway } = await gatewayClient(t);
  const closed = once(ws, "close");
  ws.send(Buffer.from([0]));
  await closed;
  const other = await gatewayClient(t);
  const otherClosed = once(other.ws, "close");
  await other.gateway.close();
  await otherClosed;
  assert.equal(other.gateway.sessionCount(), 0);
  assert.equal(gateway.sessionCount(), 0);
});
