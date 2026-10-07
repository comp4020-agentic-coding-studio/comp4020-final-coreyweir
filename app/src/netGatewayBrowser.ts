// Browser-side WASIX network gateway: speaks the virtual-net 0.601.0
// bincode protocol (see ./netGatewayCodec.ts) over an in-page MessagePort,
// and re-originates guest plaintext HTTP traffic via this tab's own
// `fetch()`. This intentionally replaces the earlier Node-hosted
// server/netGateway.mjs design for the reasons recorded in
// docs/maintenance.md and archive/completed-investigations/
// CURL_VIRTUAL_NET_GATEWAY.md: routing arbitrary guest-issued network
// requests through a standing, unauthenticated host service turned an
// intentionally browser-scoped feature into an open egress proxy. Running
// origination inside the tab means real network reach is bound by this
// user's own browser (real CORS, real TLS-validated-by-browser to the
// actual origin).
//
// The gateway terminates curl's TLS 1.3 connection in this same tab when it
// reaches port 443, then sends the decoded HTTP request through browser fetch.
// This is not a raw TCP tunnel: browser fetch establishes a separate, native
// TLS connection to the real origin. Guest listeners (ListenTcp, BindUdp,
// BindRaw, BindIcmp) remain unsupported, as in the prior design. Unlike the
// retired Node gateway, this module applies
// no private-IP/loopback/port-allowlist egress policy: the browser tab's
// own reach (subject to CORS and TLS trust) is the real security boundary
// now that origination happens client-side, not in a standing host process.
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
  type DecodedRequest,
  type InterfaceRequest,
  type IpAddr,
  type SocketAddr,
  type SocketRequest,
} from "./netGatewayCodec.ts";
import { BrowserTlsServer } from "lemon-tls/browser/tls-server";
import { createCertificateAuthority } from "lemon-tls/browser/x509";

type BrowserCertificateAuthority = ReturnType<typeof createCertificateAuthority>;

const GUEST_IP: IpAddr = { family: 4, octets: [10, 0, 0, 2] };
// Send-window bytes advertised when a connect completes; the client's
// poll_write_ready blocks until the first Sent frame arrives.
const INITIAL_SEND_WINDOW = 1024 * 1024;
const STATUS_OPENED = 1;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const CONNECTION_TIMEOUT_MS = 60_000;
const MAX_SOCKETS = 64;

const CRLFCRLF = [13, 10, 13, 10];

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function indexOfSubarray(haystack: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Byte-identity string codec matching Node's "latin1" encoding. Browser
// TextDecoder's "iso-8859-1" label maps to windows-1252 per the WHATWG
// Encoding spec, not true byte-identity Latin-1, so it cannot be reused
// here for HTTP head framing.
function latin1Decode(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function latin1Encode(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d|0)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d|0)){3}$/;
const IPV6_RE =
  /^(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:))$/;

// A coarse, non-security-critical IP-literal classifier (this file applies
// no egress policy, so this only affects hostname vs. IP-literal parsing
// branches, never an access-control decision).
function isIP(host: string): 0 | 4 | 6 {
  if (IPV4_RE.test(host)) return 4;
  if (IPV6_RE.test(host)) return 6;
  return 0;
}

function authorityUrl(authority: string, scheme: "http" | "https", port: number): URL {
  if (!/^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?$/.test(authority)) {
    throw new Error("invalid Host authority");
  }
  const url = new URL(`${scheme}://${authority}/`);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !isIP(hostname) &&
    (hostname.length > 253 ||
      !hostname
        .replace(/\.$/, "")
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
  ) {
    throw new Error("invalid hostname");
  }
  if (Number(url.port || (scheme === "https" ? 443 : 80)) !== port) throw new Error("Host port differs from connection");
  return url;
}

const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const HOP_HEADERS = ["connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function hopHeaders(connection = ""): Set<string> {
  const nominated = connection ? connection.split(",").map((name) => name.trim().toLowerCase()) : [];
  if (nominated.some((name) => !HEADER_TOKEN.test(name))) throw new Error("invalid Connection header");
  return new Set([...HOP_HEADERS, ...nominated]);
}

// Deterministic, functionally arbitrary per-hostname synthetic address for
// Resolve/GetAddrPeer bookkeeping. The real request hostname always comes
// from the HTTP Host header at HttpOriginator-equivalent parse time, never
// from this address, so it never needs to be a real DNS answer.
function syntheticIpForHost(host: string): IpAddr {
  let hash = 0x811c9dc5;
  for (let i = 0; i < host.length; i++) {
    hash ^= host.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash >>>= 0;
  return { family: 4, octets: [10, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff] };
}

interface ParsedRequest {
  method: string;
  target: string;
  headers: Record<string, string>;
  url: URL;
  body?: Uint8Array;
}

type ConnectionState = "head" | "body" | "dispatching" | "done";

// A guest-visible plaintext HTTP connection: buffers guest bytes, parses one
// HTTP/1.1 request, dispatches it via this tab's own fetch(), and streams
// the response back to the guest as chunked-encoded bytes. Ported from
// server/netGateway.mjs's VirtualSocket+HttpOriginator pair, merged into one
// class since there is no TLS-wrapping split in this increment.
class GatewayConnection {
  state: ConnectionState = "head";
  head = new Uint8Array(0);
  bodyChunks: Uint8Array[] = [];
  bodyBytes = 0;
  bodyNeeded = 0;
  pendingRequest?: ParsedRequest;
  responseStarted = false;
  closedSent = false;
  eofFromGuest = false;
  readonly abort = new AbortController();
  readonly session: BrowserGatewaySession;
  readonly socketId: bigint;
  readonly defaultPort: number;
  readonly peerAddr: SocketAddr;
  readonly localAddr: SocketAddr;
  readonly scheme: "http" | "https";
  readonly tls?: BrowserTlsServer;
  private readonly deadline: ReturnType<typeof setTimeout>;

  constructor(
    session: BrowserGatewaySession,
    socketId: bigint,
    defaultPort: number,
    peerAddr: SocketAddr,
    localAddr: SocketAddr,
    authority?: BrowserCertificateAuthority,
  ) {
    this.session = session;
    this.socketId = socketId;
    this.defaultPort = defaultPort;
    this.peerAddr = peerAddr;
    this.localAddr = localAddr;
    this.scheme = defaultPort === 443 ? "https" : "http";
    if (authority) {
      const tls = new BrowserTlsServer(authority);
      tls.on("output", (data) => {
        if (data instanceof Uint8Array) this.session.sendFrame(messageRecv(this.socketId, data));
      });
      tls.on("data", (data) => {
        if (data instanceof Uint8Array) this.onPlaintext(data);
      });
      tls.on("error", () => this.closeFromGateway());
      this.tls = tls;
    }
    // Bound incomplete requests as well as upstream work. Unref where the
    // host supports it (Node) so a lingering connection cannot hold the
    // process open; browsers clean up with the tab.
    const deadline = setTimeout(() => this.closeFromGateway(), CONNECTION_TIMEOUT_MS);
    if (typeof deadline === "object" && deadline !== null && "unref" in deadline) {
      (deadline as { unref(): void }).unref();
    }
    this.deadline = deadline;
  }

  pushFromGuest(chunk: Uint8Array | null): void {
    if (this.state === "done") return;
    if (chunk === null) {
      this.eofFromGuest = true;
      if (this.state === "head" || this.state === "body") this.fail("incomplete request");
      return;
    }
    if (this.tls) this.tls.write(chunk);
    else this.onPlaintext(chunk);
  }

  private onPlaintext(chunk: Uint8Array): void {
    if (this.state === "done" || chunk.length === 0) return;
    if (this.state === "body") {
      this.onBody(chunk);
      return;
    }
    if (this.state === "dispatching") {
      this.fail("pipelining is not supported");
      return;
    }
    const buffered = concatBytes(this.head, chunk);
    const end = indexOfSubarray(buffered, CRLFCRLF);
    if (end === -1 ? buffered.length > MAX_HEAD_BYTES : end + 4 > MAX_HEAD_BYTES) {
      this.fail("head too large");
      return;
    }
    if (end === -1) {
      this.head = buffered;
      return;
    }
    this.head = new Uint8Array(0);
    let request: ParsedRequest;
    try {
      request = this.parseHead(latin1Decode(buffered.subarray(0, end)));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.pendingRequest = request;
    this.bodyNeeded = Number(request.headers["content-length"] ?? "0");
    this.state = "body";
    if (request.headers.expect && buffered.length - end - 4 < this.bodyNeeded) {
      this.writeToGuest(latin1Encode("HTTP/1.1 100 Continue\r\n\r\n"));
    }
    this.onBody(buffered.subarray(end + 4));
  }

  private onBody(chunk: Uint8Array): void {
    this.bodyBytes += chunk.length;
    if (this.bodyBytes > this.bodyNeeded) {
      this.fail("request body exceeded content-length");
      return;
    }
    if (chunk.length) this.bodyChunks.push(chunk);
    if (this.bodyBytes === this.bodyNeeded && this.pendingRequest) {
      this.pendingRequest.body = concatAll(this.bodyChunks);
      this.bodyChunks = [];
      this.state = "dispatching";
      void this.dispatch(this.pendingRequest);
    }
  }

  private parseHead(headText: string): ParsedRequest {
    const lines = headText.split("\r\n");
    const requestLine = lines.shift() ?? "";
    const match = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/[^\x00-\x20\x7f-\xff]*) HTTP\/1\.1$/.exec(requestLine);
    if (!match) throw new Error("unsupported HTTP/1.1 request line");
    const [, method, target] = match;
    if (target.startsWith("//") || /[\\#]/.test(target) || /%(?![0-9a-f]{2})/i.test(target)) {
      throw new Error("invalid origin-form target");
    }
    const headers: Record<string, string> = Object.create(null);
    for (const line of lines) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).toLowerCase();
      const rawValue = line.slice(colon + 1);
      if (colon <= 0 || !HEADER_TOKEN.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(rawValue)) {
        throw new Error("malformed header");
      }
      const value = rawValue.replace(/^[ \t]+|[ \t]+$/g, "");
      if (name in headers && ["host", "content-length", "transfer-encoding", "expect"].includes(name)) {
        throw new Error("duplicate framing header");
      }
      if (name in headers) headers[name] += `${name === "cookie" ? "; " : ", "}${value}`;
      else headers[name] = value;
    }
    if (!headers.host) throw new Error("missing Host");
    if ("transfer-encoding" in headers) throw new Error("transfer-encoding is not supported");
    const length = headers["content-length"] ?? "0";
    if (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BODY_BYTES) {
      throw new Error("unsupported request body size");
    }
    if ((method === "GET" || method === "HEAD") && Number(length) !== 0) throw new Error("GET/HEAD body is not supported");
    if (headers.expect !== undefined && headers.expect.toLowerCase() !== "100-continue") throw new Error("unsupported expectation");
    const stripped = hopHeaders(headers.connection);
    if (["host", "content-length"].some((name) => stripped.has(name))) throw new Error("Connection nominates framing header");
    const base = authorityUrl(headers.host, this.scheme, this.defaultPort);
    const url = new URL(target, base);
    if (url.origin !== base.origin || url.username || url.password) throw new Error("target changes authority");
    return { method, target, headers, url };
  }

  private async dispatch(request: ParsedRequest): Promise<void> {
    try {
      const headers: Record<string, string> = { ...request.headers };
      for (const name of hopHeaders(headers.connection)) delete headers[name];
      delete headers.host;
      delete headers["content-length"];
      delete headers.expect;
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : (request.body ?? new Uint8Array(0)),
        redirect: "manual",
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(CONNECTION_TIMEOUT_MS)]),
      });
      this.abort.signal.throwIfAborted();
      // fetch decodes these codings without rewriting its response headers.
      // Refuse other encodings rather than guessing what got decoded.
      const encoding = response.headers.get("content-encoding");
      if (
        response.body &&
        encoding &&
        encoding.trim().toLowerCase() !== "identity" &&
        !encoding.split(",").every((coding) => /^(gzip|x-gzip|deflate|br)$/i.test(coding.trim()))
      ) {
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
        // Browsers intentionally hide Set-Cookie and may not implement
        // getSetCookie(); Node's fetch exposes it for the legacy gateway.
        for (const cookie of response.headers.getSetCookie?.() ?? []) headLines.push(`set-cookie: ${cookie}`);
      }
      if (response.body) headLines.push("transfer-encoding: chunked");
      headLines.push("connection: close");
      this.responseStarted = true;
      this.writeToGuest(latin1Encode(`${headLines.join("\r\n")}\r\n\r\n`));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.writeToGuest(concatBytes(concatBytes(latin1Encode(`${value.byteLength.toString(16)}\r\n`), value), latin1Encode("\r\n")));
        }
        this.writeToGuest(latin1Encode("0\r\n\r\n"));
      }
      this.finishResponse();
    } catch {
      if (this.state === "done") return;
      if (this.responseStarted) this.closeFromGateway();
      else this.respondSimple(request, 502, "gateway upstream failure");
    }
  }

  private respondSimple(request: ParsedRequest | undefined, status: number, text: string): void {
    const bodyText = `${text}\n`;
    const bodyBytes = latin1Encode(bodyText);
    this.responseStarted = true;
    const head = `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : "Bad Gateway"}\r\ncontent-type: text/plain\r\ncontent-length: ${bodyBytes.length}\r\nconnection: close\r\n\r\n${
      request?.method === "HEAD" ? "" : bodyText
    }`;
    this.writeToGuest(latin1Encode(head));
    this.finishResponse();
  }

  private finishResponse(): void {
    if (this.state === "done") return;
    this.state = "done";
    this.head = new Uint8Array(0);
    this.bodyChunks = [];
    this.pendingRequest = undefined;
    this.closeFromGateway();
  }

  private fail(message: string): void {
    if (this.state === "done") return;
    this.abort.abort();
    if (this.responseStarted) {
      this.state = "done";
      this.closeFromGateway();
    } else {
      this.respondSimple(this.pendingRequest, 400, message);
    }
  }

  private writeToGuest(bytes: Uint8Array): void {
    if (this.tls) this.tls.send(bytes);
    else this.session.sendFrame(messageRecv(this.socketId, bytes));
  }

  closeFromGateway(): void {
    this.state = "done";
    this.abort.abort();
    clearTimeout(this.deadline);
    this.tls?.close();
    if (!this.closedSent) {
      this.closedSent = true;
      this.session.sendFrame(messageClosed(this.socketId));
    }
    this.session.closeSocket(this.socketId);
  }
}

const SET_NONE_REQUESTS = new Set([
  "Bridge",
  "IpAdd",
  "IpRemove",
  "IpClear",
  "GatewaySet",
  "RouteAdd",
  "RouteRemove",
  "RouteClear",
  "SetTtl",
  "SetLinger",
  "SetPromiscuous",
  "SetRecvBufSize",
  "SetSendBufSize",
  "SetNoDelay",
  "SetKeepAlive",
  "SetDontRoute",
  "SetBroadcast",
  "SetMulticastLoopV4",
  "SetMulticastLoopV6",
  "SetMulticastTtlV4",
  "Unbridge",
]);

const FLAG_QUERY_REQUESTS = new Set(["GetNoDelay", "GetKeepAlive", "GetBroadcast", "GetPromiscuous", "GetDontRoute", "IsClosed", "GetLinger"]);

class BrowserGatewaySession {
  private readonly sockets = new Map<string, GatewayConnection>();
  private disposed = false;
  private readonly port: MessagePort;
  private readonly authority: BrowserCertificateAuthority;

  constructor(port: MessagePort, authority: BrowserCertificateAuthority) {
    this.port = port;
    this.authority = authority;
    port.onmessage = (event: MessageEvent) => this.onFrame(event.data);
  }

  sendFrame(buffer: Uint8Array): void {
    if (this.disposed) return;
    const owned = buffer.slice();
    this.port.postMessage(owned.buffer, [owned.buffer]);
  }

  private onFrame(data: unknown): void {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (data instanceof Uint8Array) bytes = data;
    else return;
    let message: DecodedRequest;
    try {
      message = decodeMessageRequest(bytes);
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

  private reply(reqId: bigint | null | undefined, frame: Uint8Array): void {
    if (reqId !== null && reqId !== undefined) this.sendFrame(frame);
  }

  private dispatch(message: DecodedRequest): void {
    if (message.kind === "Reconnect") return;
    if (message.kind === "Send") {
      const entry = this.sockets.get(message.socket.toString());
      if (!entry || entry.state === "done" || entry.eofFromGuest) {
        this.sendFrame(messageSendError(message.socket, message.reqId ?? 0n, NETWORK_ERROR.NotConnected));
        return;
      }
      // Guest bytes always enter the connection's plaintext parser; there is
      // no TLS wrapping in this increment.
      entry.pushFromGuest(message.data);
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
    const respondErr = (code: number) => this.reply(reqId, responseErr(reqId, code));
    if (SET_NONE_REQUESTS.has(message.name)) {
      this.reply(reqId, responseNone(reqId));
      return;
    }
    switch (message.name) {
      case "DhcpAcquire":
        this.reply(reqId, responseIpAddress(reqId, GUEST_IP));
        return;
      case "GetIpList":
        this.reply(reqId, responseIpAddressList(reqId, [GUEST_IP]));
        return;
      case "Resolve":
        this.handleResolve(reqId, message as InterfaceRequest);
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
      case "GetRecvBufSize":
      case "GetSendBufSize":
        this.reply(reqId, responseAmount(reqId, 1 << 20));
        return;
      case "ConnectTcp":
        // ConnectTcp allocates a new socket id from its own payload, so the
        // wire client sends it as an Interface-kind request (variant 0), not
        // a Socket-kind request (variant 1) bound to an existing socket.
        this.handleConnectTcp(message as InterfaceRequest);
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
        const socketMessage = message as SocketRequest;
        const entry = this.sockets.get(socketMessage.socket.toString());
        if (entry) {
          const value = Number(socketMessage.value);
          if (value === 1) entry.pushFromGuest(null);
          if (value === 0 || value === 2) entry.closeFromGateway();
        }
        this.reply(reqId, responseNone(reqId));
        return;
      }
      case "Close": {
        const socketMessage = message as SocketRequest;
        const entry = this.sockets.get(socketMessage.socket.toString());
        if (entry) entry.closeFromGateway();
        this.reply(reqId, responseNone(reqId));
        return;
      }
      case "GetAddrLocal": {
        const socketMessage = message as SocketRequest;
        const entry = this.sockets.get(socketMessage.socket.toString());
        this.reply(reqId, responseSocketAddr(reqId, entry?.localAddr ?? { ip: GUEST_IP, port: 0 }));
        return;
      }
      case "GetAddrPeer": {
        const socketMessage = message as SocketRequest;
        const entry = this.sockets.get(socketMessage.socket.toString());
        this.reply(reqId, responseSocketAddr(reqId, entry?.peerAddr ?? { ip: { family: 4, octets: [0, 0, 0, 0] }, port: 0 }));
        return;
      }
      default:
        if (FLAG_QUERY_REQUESTS.has(message.name)) {
          const socketMessage = message as SocketRequest;
          const closed = message.name === "IsClosed" && !this.sockets.has(socketMessage.socket.toString());
          this.reply(reqId, responseFlag(reqId, closed));
          return;
        }
        this.reply(reqId, responseNone(reqId));
    }
  }

  private handleResolve(reqId: bigint | null, message: InterfaceRequest): void {
    const ip = syntheticIpForHost(String(message.host));
    this.reply(reqId, responseIpAddressList(reqId, [ip]));
  }

  private handleConnectTcp(message: InterfaceRequest): void {
    // Wire shape: { socket_id, addr: LOCAL bind, peer: DESTINATION }. The
    // authoritative socket id for a fresh connection is the payload's own
    // socket_id field, matching the Node gateway's proven behavior.
    const reqId = message.reqId;
    const peer = message.peer as SocketAddr;
    const sockId = BigInt(message.socketId as bigint | number);
    if (this.sockets.has(sockId.toString())) {
      this.reply(reqId, responseErr(reqId, NETWORK_ERROR.AlreadyExists));
      return;
    }
    if (this.sockets.size >= MAX_SOCKETS) {
      this.reply(reqId, responseErr(reqId, NETWORK_ERROR.InsufficientMemory));
      return;
    }
    const localAddr: SocketAddr = { ip: GUEST_IP, port: 40000 + Number(sockId % 20000n) };
    const conn = new GatewayConnection(this, sockId, peer.port, peer, localAddr, peer.port === 443 ? this.authority : undefined);
    this.sockets.set(sockId.toString(), conn);

    // The client must pre-register the socket before issuing ConnectTcp.
    this.reply(reqId, responseSocket(reqId, sockId));
    this.sendFrame(messageSent(sockId, null, INITIAL_SEND_WINDOW));
  }

  closeSocket(socketId: bigint): void {
    this.sockets.delete(socketId.toString());
  }

  dispose(): void {
    if (this.disposed) return;
    for (const conn of [...this.sockets.values()]) conn.closeFromGateway();
    this.sockets.clear();
    this.disposed = true;
    this.port.onmessage = null;
    this.port.close();
  }
}

export interface NetGatewayBrowserHandle {
  dispose(): void;
}

// Attach a plaintext-HTTP-only WASIX network gateway to one end of a
// MessageChannel. The caller transfers the other end (`channel.port2`) to
// the WASIX worker and passes it as `Runtime({ networkGatewayPort })`.
export function attachNetGatewayBrowser(port: MessagePort, authority = createCertificateAuthority()): NetGatewayBrowserHandle {
  const session = new BrowserGatewaySession(port, authority);
  return {
    dispose: () => session.dispose(),
  };
}
