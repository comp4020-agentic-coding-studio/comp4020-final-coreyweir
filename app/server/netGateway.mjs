// WASIX network gateway: speaks the virtual-net 0.601.0 bincode protocol
// (see ./netVirtualCodec.mjs) over a WebSocket at /net-gateway/, and
// re-originates guest HTTP(S) traffic via fetch. HTTPS is terminated here
// with an ephemeral CA (guest trusts it through CURL_CA_BUNDLE), so every
// request is policy-checked and non-HTTP tunnels are refused by design.
//
// Egress policy: only ports 80/443, and every target host must resolve
// outside private/loopback/link-local space. Guest listeners (ListenTcp,
// BindUdp, BindRaw, BindIcmp) are refused in this increment.
import { Agent } from "undici";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import {
  NETWORK_ERROR,
  decodeMessageRequest,
  messageClosed,
  messageRecv,
  messageSendError,
  messageSent,
  responseAmount,
  responseErr,
  responseFlag,
  responseIpAddress,
  responseIpAddressList,
  responseMac,
  responseNone,
  responseRouteList,
  responseSocket,
  responseSocketAddr,
  responseStatus,
  responseTtl,
} from "./netVirtualCodec.mjs";

const execFileP = promisify(execFile);

const GUEST_IP = { family: 4, octets: [10, 0, 0, 2] };
// Send-window bytes advertised when a connect completes; the client's
// poll_write_ready blocks until the first Sent frame arrives.
const INITIAL_SEND_WINDOW = 1024 * 1024;
const STATUS_OPENED = 1;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function allowedPorts() {
  const extra = (process.env.RIFF_NET_ALLOW_PORTS ?? "").split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
  return new Set([80, 443, ...extra]);
}

function isPrivateV4(octets) {
  if (octets.length !== 4 || octets.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function isPrivateV6(octets) {
  if (octets.length !== 16 || octets.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return true;
  if (octets.slice(0, 10).every((b) => b === 0) && octets[10] === 255 && octets[11] === 255) {
    return isPrivateV4(octets.slice(12));
  }
  // Only global unicast, excluding special-use, documentation and transition
  // ranges. This also refuses ::, ::1, NAT64, link/site-local and multicast.
  return (octets[0] & 0xe0) !== 0x20 ||
    (octets[0] === 0x20 && octets[1] === 0x01 &&
      (octets[2] < 2 || (octets[2] === 0x0d && octets[3] === 0xb8))) ||
    (octets[0] === 0x20 && octets[1] === 0x02) ||
    (octets[0] === 0x3f && octets[1] === 0xff && (octets[2] & 0xf0) === 0);
}

class PolicyError extends Error {}

// The returned address must be pinned into the connection, not just checked
// before a second DNS lookup by fetch (which would permit DNS rebinding).
export async function resolveEgressTarget(hostname) {
  const family = net.isIP(hostname);
  const records = family ? [{ address: hostname, family }] :
    await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error("no addresses");
  for (const record of records) {
    if (net.isIP(record.address) !== record.family ||
        (record.family === 4 ? isPrivateV4(record.address.split(".").map(Number)) :
          record.family !== 6 || isPrivateV6(ipv6Bytes(record.address)))) {
      throw new PolicyError("non-public address blocked");
    }
  }
  return records.find((r) => r.family === 4) ?? records[0];
}

function ipv6Bytes(address) {
  if (net.isIP(address) !== 6 || address.includes("%")) throw new PolicyError("invalid IPv6 address");
  // Expand dotted IPv4 tails before counting the compressed 16-bit groups.
  const expanded = address.replace(/\d+\.\d+\.\d+\.\d+$/, (v4) => {
    const [a, b, c, d] = v4.split(".").map(Number);
    return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  });
  const groups = expanded.split("::");
  const head = groups[0] ? groups[0].split(":").filter(Boolean) : [];
  const tail = groups[1] !== undefined ? (groups[1] ? groups[1].split(":").filter(Boolean) : []) : [];
  const fill = 8 - head.length - tail.length;
  const words = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail].map((w) => parseInt(w, 16));
  const bytes = [];
  for (const word of words) bytes.push((word >> 8) & 0xff, word & 0xff);
  return bytes;
}

function authorityUrl(authority, scheme, port) {
  if (!/^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?$/.test(authority)) {
    throw new Error("invalid Host authority");
  }
  const url = new URL(`${scheme}://${authority}/`);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!net.isIP(hostname) && (hostname.length > 253 ||
      !hostname.replace(/\.$/, "").split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
    throw new Error("invalid hostname");
  }
  if (Number(url.port || (scheme === "https" ? 443 : 80)) !== port) throw new Error("Host port differs from connection");
  return url;
}

const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const HOP_HEADERS = ["connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function hopHeaders(connection = "") {
  const nominated = connection ? connection.split(",").map((name) => name.trim().toLowerCase()) : [];
  if (nominated.some((name) => !HEADER_TOKEN.test(name))) throw new Error("invalid Connection header");
  return new Set([...HOP_HEADERS, ...nominated]);
}

// One ephemeral CA per server process. Leaf certificates are generated on
// first SNI for a hostname and cached. The CA certificate is served to the
// embedder (GET /net-gateway-ca) so the session can install it as
// CURL_CA_BUNDLE; the CA private key never leaves this process.
export class EphemeralCa {
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "riff-net-ca-"));
    this.caCertPath = path.join(this.dir, "ca.crt");
    this.caKeyPath = path.join(this.dir, "ca.key");
    this.leaves = new Map();
    this.serial = 1;
    this.abort = new AbortController();
    this.onExit = () => {
      this.abort.abort();
      fs.rmSync(this.dir, { recursive: true, force: true });
    };
    process.once("exit", this.onExit);
  }

  ready() {
    if (this.abort.signal.aborted) return Promise.reject(new Error("CA disposed"));
    this.initializing ??= this.runOpenSsl([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", this.caKeyPath, "-out", this.caCertPath,
      "-days", "30",
      "-subj", "/CN=Riff Gateway Dev CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign",
    ]);
    return this.initializing;
  }

  async runOpenSsl(args) {
    const task = execFileP("openssl", args, { signal: this.abort.signal });
    // Abort rejects execFile before the child has necessarily exited. Do not
    // remove its paths until close confirms it can no longer write them.
    const closed = new Promise((resolve) => task.child.once("close", resolve));
    try { await task; } finally { await closed; }
  }

  caPem() {
    return fs.readFileSync(this.caCertPath, "utf8");
  }

  leaf(hostname) {
    if (this.abort.signal.aborted) return Promise.reject(new Error("CA disposed"));
    try {
      const url = authorityUrl(hostname, "https", 443);
      hostname = url.hostname.replace(/^\[|\]$/g, "");
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = this.leaves.get(hostname);
    if (existing) return existing;
    if (this.leaves.size >= 128) return Promise.reject(new Error("CA leaf limit reached"));
    // Reserve both the cache slot and unique paths before any asynchronous work.
    const id = this.serial++;
    const pending = (async () => {
      await this.ready();
      const keyPath = path.join(this.dir, `leaf-${id}.key`);
      const certPath = path.join(this.dir, `leaf-${id}.crt`);
      const csrPath = path.join(this.dir, `leaf-${id}.csr`);
      const extPath = path.join(this.dir, `leaf-${id}.ext`);
      try {
        await this.runOpenSsl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath, "-subj", "/CN=Riff Gateway Leaf"]);
        fs.writeFileSync(extPath, `subjectAltName=${net.isIP(hostname) ? "IP" : "DNS"}:${hostname}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
        await this.runOpenSsl(["x509", "-req", "-in", csrPath, "-CA", this.caCertPath, "-CAkey", this.caKeyPath, "-set_serial", String(id), "-days", "30", "-extfile", extPath, "-out", certPath]);
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      } finally {
        for (const file of [keyPath, certPath, csrPath, extPath]) fs.rmSync(file, { force: true });
      }
    })().catch((error) => {
      this.leaves.delete(hostname);
      throw error;
    });
    this.leaves.set(hostname, pending);
    return pending;
  }

  dispose() {
    this.disposing ??= (async () => {
      this.abort.abort();
      await Promise.allSettled([this.initializing, ...this.leaves.values()]);
      this.leaves.clear();
      this.onExit();
      process.removeListener("exit", this.onExit);
    })();
    return this.disposing;
  }
}

// A guest-visible TCP socket. Bytes the guest sends arrive through
// pushFromGuest; bytes the gateway writes go to the guest as Recv frames.
class VirtualSocket extends Duplex {
  constructor(session, socketId) {
    // A guest write-half shutdown is EOF to the parser, not to our response.
    super({ allowHalfOpen: true });
    this.session = session;
    this.socketId = socketId;
    this.closedSent = false;
  }

  _read() {}

  pushFromGuest(chunk) {
    if (this.destroyed) return;
    this.push(chunk);
  }

  _write(chunk, _encoding, callback) {
    this.session.sendFrame(messageRecv(this.socketId, chunk), callback);
  }

  _final(callback) {
    this.closeFromGateway();
    callback();
  }

  _destroy(_error, callback) {
    if (!this.closedSent) {
      this.closedSent = true;
      this.session.sendFrame(messageClosed(this.socketId));
    }
    this.session.closeSocket(this.socketId);
    callback();
  }

  closeFromGateway() {
    this.destroy();
  }
}

// Plaintext HTTP/1.1 handling shared by the :80 and the post-TLS :443 paths.
export class HttpOriginator extends EventEmitter {
  constructor(socket, scheme, defaultPort) {
    super();
    this.socket = socket;
    this.scheme = scheme;
    this.defaultPort = defaultPort;
    this.head = Buffer.alloc(0);
    this.state = "head";
    this.body = [];
    this.bodyBytes = 0;
    this.abort = new AbortController();
    socket.on("end", () => {
      if (this.state === "head" || this.state === "body") this.fail("incomplete request");
    });
    socket.on("close", () => this.abort.abort());
    socket.on("error", () => this.abort.abort());
  }

  onPlaintext(chunk) {
    if (this.state === "done" || chunk.length === 0) return;
    if (this.state === "body") return this.onBody(chunk);
    if (this.state === "dispatching") return this.fail("pipelining is not supported");
    const buffered = Buffer.concat([this.head, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1 ? buffered.length > MAX_HEAD_BYTES : end + 4 > MAX_HEAD_BYTES) {
      this.fail("head too large");
      return;
    }
    if (end === -1) {
      this.head = buffered;
      return;
    }
    this.head = Buffer.alloc(0);
    try {
      this.pendingRequest = this.parseHead(buffered.subarray(0, end).toString("latin1"));
    } catch (error) {
      this.fail(error.message);
      return;
    }
    this.bodyNeeded = Number(this.pendingRequest.headers["content-length"] ?? 0);
    this.state = "body";
    if (this.pendingRequest.headers.expect && buffered.length - end - 4 < this.bodyNeeded) {
      this.socket.write("HTTP/1.1 100 Continue\r\n\r\n");
    }
    this.onBody(buffered.subarray(end + 4));
  }

  onBody(chunk) {
    this.bodyBytes += chunk.length;
    if (this.bodyBytes > this.bodyNeeded) {
      this.fail("request body exceeded content-length");
      return;
    }
    if (chunk.length) this.body.push(chunk);
    if (this.bodyBytes === this.bodyNeeded) {
      this.pendingRequest.body = Buffer.concat(this.body);
      this.body = [];
      this.state = "dispatching";
      void this.dispatch(this.pendingRequest);
    }
  }

  parseHead(headText) {
    const lines = headText.split("\r\n");
    const match = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/[^\x00-\x20\x7f-\xff]*) HTTP\/1\.1$/.exec(lines.shift());
    if (!match) throw new Error("unsupported HTTP/1.1 request line");
    const [, method, target] = match;
    if (target.startsWith("//") || /[\\#]/.test(target) || /%(?![0-9a-f]{2})/i.test(target)) throw new Error("invalid origin-form target");
    const headers = Object.create(null);
    for (const line of lines) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).toLowerCase();
      const rawValue = line.slice(colon + 1);
      if (colon <= 0 || !HEADER_TOKEN.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(rawValue)) throw new Error("malformed header");
      const value = rawValue.replace(/^[ \t]+|[ \t]+$/g, "");
      if (name in headers && ["host", "content-length", "transfer-encoding", "expect"].includes(name)) throw new Error("duplicate framing header");
      if (name in headers) headers[name] += `${name === "cookie" ? "; " : ", "}${value}`;
      else headers[name] = value;
    }
    if (!headers.host) throw new Error("missing Host");
    if ("transfer-encoding" in headers) throw new Error("transfer-encoding is not supported");
    const length = headers["content-length"] ?? "0";
    if (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BODY_BYTES) throw new Error("unsupported request body size");
    if ((method === "GET" || method === "HEAD") && Number(length) !== 0) throw new Error("GET/HEAD body is not supported");
    if (headers.expect !== undefined && headers.expect.toLowerCase() !== "100-continue") throw new Error("unsupported expectation");
    const stripped = hopHeaders(headers.connection);
    if (["host", "content-length"].some((name) => stripped.has(name))) throw new Error("Connection nominates framing header");
    const base = authorityUrl(headers.host, this.scheme, this.defaultPort);
    if (this.hostname && base.hostname !== this.hostname) throw new Error("Host differs from TLS SNI");
    const url = new URL(target, base);
    if (url.origin !== base.origin || url.username || url.password) throw new Error("target changes authority");
    return { method, target, headers, url };
  }

  async dispatch(request) {
    let dispatcher;
    try {
      if (!allowedPorts().has(this.defaultPort)) throw new PolicyError("port not allowed");
      const hostname = request.url.hostname.replace(/^\[|\]$/g, "");
      const pinned = await resolveEgressTarget(hostname);
      this.abort.signal.throwIfAborted();
      dispatcher = new Agent({
        connect: {
          rejectUnauthorized: true,
          autoSelectFamily: false,
          lookup: (name, options, callback) => {
            if (name !== hostname) return callback(new Error("unexpected lookup hostname"));
            if (options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
      });
      const headers = { ...request.headers };
      for (const name of [...hopHeaders(headers.connection), "host", "content-length", "expect"]) delete headers[name];
      headers["accept-encoding"] = "identity";
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : (request.body ?? Buffer.alloc(0)),
        redirect: "manual",
        dispatcher,
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(60_000)]),
      });
      this.abort.signal.throwIfAborted();
      // fetch decodes these codings without rewriting its response headers.
      // Refuse other encodings rather than guessing what a Node version decoded.
      const encoding = response.headers.get("content-encoding");
      if (response.body && encoding && encoding.trim().toLowerCase() !== "identity" &&
          !encoding.split(",").every((coding) => /^(gzip|x-gzip|deflate|br)$/i.test(coding.trim()))) {
        await response.body.cancel();
        throw new Error("unsupported upstream content-encoding");
      }
      const stripped = hopHeaders(response.headers.get("connection") ?? "");
      stripped.add("content-length");
      if (response.body) stripped.add("content-encoding");
      const statusText = response.statusText || "OK";
      const headLines = [`HTTP/1.1 ${response.status} ${statusText}`];
      for (const [name, value] of response.headers) {
        if (!stripped.has(name) && name !== "set-cookie") headLines.push(`${name}: ${value}`);
      }
      if (!stripped.has("set-cookie")) {
        for (const cookie of response.headers.getSetCookie()) headLines.push(`set-cookie: ${cookie}`);
      }
      if (response.body) headLines.push("transfer-encoding: chunked");
      headLines.push("connection: close");
      this.responseStarted = true;
      this.socket.write(Buffer.from(`${headLines.join("\r\n")}\r\n\r\n`, "latin1"));
      if (response.body) {
        for await (const chunk of response.body) {
          const framed = Buffer.concat([
            Buffer.from(`${chunk.byteLength.toString(16)}\r\n`, "ascii"),
            Buffer.from(chunk),
            Buffer.from("\r\n", "ascii"),
          ]);
          await new Promise((resolve, reject) => this.socket.write(framed, (error) => error ? reject(error) : resolve()));
        }
        await new Promise((resolve, reject) => this.socket.write("0\r\n\r\n", (error) => error ? reject(error) : resolve()));
      }
      this.finishResponse();
    } catch (error) {
      if (this.state === "done" || this.socket.destroyed) return;
      if (this.responseStarted) this.socket.destroy();
      else this.respondSimple(request, error instanceof PolicyError ? 403 : 502,
        error instanceof PolicyError ? "blocked by gateway policy" : "gateway upstream failure");
    } finally {
      await dispatcher?.destroy();
    }
  }

  respondSimple(request, status, text) {
    const body = `${text}\n`;
    this.responseStarted = true;
    this.socket.write(Buffer.from(`HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Bad Gateway"}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${request?.method === "HEAD" ? "" : body}`, "latin1"));
    this.finishResponse();
  }

  finishResponse() {
    if (this.state === "done") return;
    this.state = "done";
    this.head = Buffer.alloc(0);
    this.body = [];
    this.pendingRequest = undefined;
    this.emit("done");
    this.socket.end();
  }

  fail(message) {
    if (this.state === "done") return;
    this.abort.abort();
    if (this.responseStarted || this.socket.destroyed) {
      this.state = "done";
      this.socket.destroy();
    } else this.respondSimple(this.pendingRequest, 400, message);
  }
}

export function createNetGateway({ ca }) {
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_HEAD_BYTES + MAX_BODY_BYTES });
  const sessions = new Set();

  socketServer.on("connection", (websocket) => {
    const session = new GatewaySession(websocket, ca);
    sessions.add(session);
    websocket.on("close", () => {
      sessions.delete(session);
      session.dispose();
    });
  });

  return {
    handleUpgrade(request, socket, head) {
      socketServer.handleUpgrade(request, socket, head, (websocket) => {
        socketServer.emit("connection", websocket, request);
      });
    },
    sessionCount() {
      return sessions.size;
    },
    close() {
      for (const session of sessions) session.dispose();
      sessions.clear();
      socketServer.close();
      return ca.dispose();
    },
  };
}

class GatewaySession {
  constructor(websocket, ca) {
    this.websocket = websocket;
    this.ca = ca;
    this.sockets = new Map();
    this.disposed = false;
    websocket.on("message", (data) => this.onFrame(data));
    websocket.on("error", () => this.dispose());
  }

  sendFrame(buffer, callback) {
    if (this.disposed || this.websocket.readyState !== 1) {
      callback?.(new Error("gateway session closed"));
      return;
    }
    this.websocket.send(buffer, { binary: true }, callback ?? ((error) => { if (error) this.dispose(); }));
  }

  onFrame(data) {
    let message;
    try {
      message = decodeMessageRequest(Buffer.from(data));
    } catch {
      this.dispose();
      return;
    }
    try {
      this.dispatch(message);
    } catch {
      this.dispose();
    }
  }

  reply(reqId, frame) {
    if (reqId !== null && reqId !== undefined) this.sendFrame(frame);
  }

  dispatch(message) {
    if (message.kind === "Reconnect") return;
    if (message.kind === "Send") {
      const entry = this.sockets.get(String(message.socket));
      if (!entry || entry.socket.readableEnded || entry.socket.readablePushedEof) {
        this.sendFrame(messageSendError(message.socket, message.reqId ?? 0n, NETWORK_ERROR.NotConnected));
        return;
      }
      // Guest bytes always enter the socket's readable side: for the TLS
      // paths the TLSSocket wraps the VirtualSocket and consumes them for
      // decryption; for plaintext HTTP the readable side feeds the
      // originator. Writing would loop the bytes back to the guest.
      entry.socket.pushFromGuest(Buffer.from(message.data));
      // The client sends fire-and-forget (req_id null) and counts window
      // from server-pushed Sent frames, so the ack must be unconditional.
      this.sendFrame(messageSent(message.socket, message.reqId ?? null, BigInt(message.data.length)));
      return;
    }
    if (message.kind === "SendTo") {
      this.reply(message.reqId, responseErr(message.reqId, NETWORK_ERROR.AddressNotAvailable));
      return;
    }

    // Interface or Socket request.
    const reqId = message.reqId;
    const respondErr = (code) => this.reply(reqId, responseErr(reqId, code));
    switch (message.name) {
      case "Bridge":
      case "IpAdd":
      case "IpRemove":
      case "IpClear":
      case "GatewaySet":
      case "RouteAdd":
      case "RouteRemove":
      case "RouteClear":
      case "SetTtl":
      case "SetLinger":
      case "SetPromiscuous":
      case "SetRecvBufSize":
      case "SetSendBufSize":
      case "SetNoDelay":
      case "SetKeepAlive":
      case "SetDontRoute":
      case "SetBroadcast":
      case "SetMulticastLoopV4":
      case "SetMulticastLoopV6":
      case "SetMulticastTtlV4":
      case "Unbridge":
        this.reply(reqId, responseNone(reqId));
        return;
      case "DhcpAcquire":
        this.reply(reqId, responseIpAddress(reqId, GUEST_IP));
        return;
      case "GetIpList":
        this.reply(reqId, responseIpAddressList(reqId, [GUEST_IP]));
        return;
      case "Resolve":
        this.handleResolve(reqId, message);
        return;
      case "GetMac":
        this.reply(reqId, responseMac(reqId, [0x02, 0x52, 0x49, 0x46, 0x46, 0x01]));
        return;
      case "GetRouteList":
        this.reply(reqId, responseRouteList(reqId));
        return;
      case "GetStatus":
        this.reply(reqId, responseStatus(reqId, STATUS_OPENED));
        return;
      case "GetTtl":
        this.reply(reqId, responseTtl(reqId, 64));
        return;
      case "GetNoDelay":
      case "GetKeepAlive":
      case "GetBroadcast":
      case "GetPromiscuous":
      case "GetDontRoute":
      case "IsClosed":
      case "GetLinger":
        this.reply(reqId, responseFlag(reqId, message.name === "IsClosed" && !this.sockets.has(String(message.socket))));
        return;
      case "GetRecvBufSize":
      case "GetSendBufSize":
        this.reply(reqId, responseAmount(reqId, 1 << 20));
        return;
      case "ConnectTcp":
        this.handleConnectTcp(message);
        return;
      case "ListenTcp":
      case "BindUdp":
      case "BindIcmp":
      case "BindRaw":
      case "BeginAccept":
        respondErr(NETWORK_ERROR.PermissionDenied);
        return;
      case "Flush":
        this.reply(reqId, responseAmount(reqId, 0));
        return;
      case "Shutdown": {
        const entry = this.sockets.get(String(message.socket));
        if (entry) {
          if (message.value === 1) {
            entry.socket.readablePushedEof = true;
            entry.socket.pushFromGuest(null);
          }
          if (message.value === 0 || message.value === 2) entry.socket.destroy();
        }
        this.reply(reqId, responseNone(reqId));
        return;
      }
      case "Close": {
        const entry = this.sockets.get(String(message.socket));
        if (entry) entry.socket.closeFromGateway();
        this.reply(reqId, responseNone(reqId));
        return;
      }
      case "GetAddrLocal": {
        const entry = this.sockets.get(String(message.socket));
        this.reply(reqId, responseSocketAddr(reqId, entry?.localAddr ?? { ip: GUEST_IP, port: 0 }));
        return;
      }
      case "GetAddrPeer": {
        const entry = this.sockets.get(String(message.socket));
        this.reply(reqId, responseSocketAddr(reqId, entry?.peerAddr ?? { ip: { family: 4, octets: [0, 0, 0, 0] }, port: 0 }));
        return;
      }
      default:
        this.reply(reqId, responseNone(reqId));
    }
  }

  async handleResolve(reqId, message) {
    try {
      const records = await dns.promises.lookup(message.host, { all: true, verbatim: true });
      // virtual-net's server answers Resolve with ResponseType::IpAddressList;
      // the Rust client rejects a bare IpAddress for this request.
      const ips = records.map((r) => r.family === 4
        ? { family: 4, octets: r.address.split(".").map(Number) }
        : { family: 6, octets: ipv6Bytes(r.address) });
      this.reply(reqId, responseIpAddressList(reqId, ips));
    } catch {
      this.reply(reqId, responseErr(reqId, NETWORK_ERROR.AddressNotAvailable));
    }
  }

  handleConnectTcp(message) {
    // Wire shape: { socket_id, addr: LOCAL bind, peer: DESTINATION }. All
    // policy and upstream decisions key off the peer, never the local bind
    // (which is typically 0.0.0.0:0).
    const { reqId, peer } = message;
    const sockId = BigInt(message.socketId);
    if (this.sockets.has(String(sockId))) {
      this.reply(reqId, responseErr(reqId, NETWORK_ERROR.AlreadyExists));
      return;
    }
    if (this.sockets.size >= 64) {
      this.reply(reqId, responseErr(reqId, NETWORK_ERROR.InsufficientMemory));
      return;
    }
    // The destination is already an IP here (the guest resolved first), so
    // the private-range refusal is a direct byte check rather than DNS.
    const blocked = peer.ip.family === 4
      ? isPrivateV4(peer.ip.octets)
      : peer.ip.family !== 6 || isPrivateV6(peer.ip.octets);
    if (!allowedPorts().has(peer.port) || blocked) {
      this.reply(reqId, responseErr(reqId, NETWORK_ERROR.PermissionDenied));
      return;
    }
    const virtual = new VirtualSocket(this, sockId);
    const entry = { socket: virtual, peerAddr: peer, localAddr: { ip: GUEST_IP, port: 40000 + Number(sockId % 20000n) } };
    this.sockets.set(sockId.toString(), entry);

    // Bound incomplete requests and TLS handshakes as well as upstream work.
    entry.deadline = setTimeout(() => virtual.closeFromGateway(), 60_000).unref();
    virtual.on("error", () => virtual.closeFromGateway());

    if (peer.port === 443) {
      // TLS is terminated on the virtual socket: guest ciphertext enters the
      // VirtualSocket readable side (pushFromGuest), the TLSSocket decrypts
      // it, and the plaintext side feeds an HttpOriginator. SNI is required;
      // there is deliberately no default certificate or non-HTTP tunnel.
      let originator;
      const tlsSocket = new tls.TLSSocket(virtual, {
        isServer: true,
        allowHalfOpen: true,
        ALPNProtocols: ["http/1.1"],
        SNICallback: (servername, callback) => {
          this.ca.leaf(servername).then((leaf) => {
            if (virtual.destroyed) return callback(new Error("socket closed"));
            originator.hostname = authorityUrl(servername, "https", 443).hostname;
            callback(null, tls.createSecureContext({ key: leaf.key, cert: leaf.cert }));
          }).catch((error) => callback(error));
        },
      });
      originator = new HttpOriginator(tlsSocket, "https", 443);
      virtual.originator = originator;
      tlsSocket.on("data", (chunk) => originator.onPlaintext(chunk));
      tlsSocket.on("error", () => virtual.closeFromGateway());
      tlsSocket.on("close", () => virtual.closeFromGateway());
      tlsSocket.on("finish", () => virtual.end());
      entry.upstream = tlsSocket;
    } else {
      const originator = new HttpOriginator(virtual, "http", peer.port);
      virtual.originator = originator;
      virtual.on("data", (chunk) => originator.onPlaintext(chunk));
    }

    // The client must pre-register the socket before issuing ConnectTcp.
    this.reply(reqId, responseSocket(reqId, sockId));
    this.sendFrame(messageSent(sockId, null, INITIAL_SEND_WINDOW));
  }

  closeSocket(socketId) {
    const entry = this.sockets.get(String(socketId));
    if (entry) {
      this.sockets.delete(String(socketId));
      clearTimeout(entry.deadline);
      entry.socket.originator?.abort.abort();
      entry.upstream?.destroy();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.sockets.values()) entry.socket.closeFromGateway();
    this.sockets.clear();
    this.websocket.terminate();
  }
}
