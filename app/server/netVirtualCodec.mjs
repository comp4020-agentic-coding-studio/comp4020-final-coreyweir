// Bincode (1.3 default fixint) codec for the virtual-net 0.601.0 wire
// protocol, mirrored from the crate's meta.rs declaration order. One
// MessageRequest/MessageResponse per WebSocket binary message, both
// directions (measured against the fork's dist client in
// research tmp-work/vecdump reference vectors).
//
// Encoding rules the vectors confirmed:
// - enum variant discriminator: u32 LE (unit and struct/newtype variants)
// - struct fields in declaration order
// - Option<T>: u8 tag (0/1) + T
// - String / Vec<u8>: u64 LE length + payload
// - u64/u32/u16/u8: fixed-width LE; bool: u8
// - IpAddr: u32 variant (0=V4, 1=V6) + raw octets
// - SocketAddr: u32 variant + raw octets + u16 LE port

const VARIANT = { NONE: 0, ERR: 1, DURATION: 2, AMOUNT: 3, FLAG: 4, IP_LIST: 5, IP: 6, ADDR_LIST: 7, ADDR: 8, MAC: 9, CIDR_LIST: 10, ROUTE_LIST: 11, SOCKET: 12, TTL: 13, STATUS: 14 };

// NetworkError variant indices, lib.rs declaration order.
export const NETWORK_ERROR = {
  InvalidFd: 0,
  AlreadyExists: 1,
  Lock: 2,
  IOError: 3,
  AddressInUse: 4,
  AddressNotAvailable: 5,
  BrokenPipe: 6,
  InsufficientMemory: 7,
  ConnectionAborted: 8,
  ConnectionRefused: 9,
  ConnectionReset: 10,
  Interrupted: 11,
  InvalidData: 12,
  InvalidInput: 13,
  NotConnected: 14,
  NoDevice: 15,
  PermissionDenied: 16,
  TimedOut: 17,
  UnexpectedEof: 18,
};

class Reader {
  constructor(buffer) {
    this.b = buffer;
    this.o = 0;
  }
  u8() { return this.b.readUInt8(this.o++); }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  bool() { const v = this.u8(); if (v > 1) throw new Error("invalid boolean"); return v === 1; }
  bytes(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.b.length - this.o) throw new Error("truncated or oversized byte vector");
    const v = this.b.subarray(this.o, this.o + n); this.o += n; return v;
  }
  vec() { return Buffer.from(this.bytes(Number(this.u64()))); }
  string() { return this.vec().toString("utf8"); }
  option() { return this.bool(); }
  ipAddr() {
    const variant = this.u32();
    if (variant === 0) return { family: 4, octets: [...this.bytes(4)] };
    if (variant === 1) return { family: 6, octets: [...this.bytes(16)] };
    throw new Error(`bad IpAddr variant ${variant}`);
  }
  socketAddr() {
    const ip = this.ipAddr();
    return { ip, port: this.u16() };
  }
  duration() { return { secs: this.u64(), nanos: this.u32() }; }
  optionDuration() { return this.option() ? this.duration() : null; }
  cidr() { return { ip: this.ipAddr(), prefix: this.u8() }; }
  route() {
    return {
      cidr: this.cidr(),
      viaRouter: this.ipAddr(),
      preferredUntil: this.optionDuration(),
      expiresAt: this.optionDuration(),
    };
  }
  shutdown() { return this.u32(); }
  security() { return this.u32(); }
}

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(chunk) { this.chunks.push(chunk); this.length += chunk.length; }
  u8(v) { this.push(Buffer.from([v])); return this; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.push(b); return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  vec(bytes) { this.u64(bytes.length); this.push(Buffer.from(bytes)); return this; }
  string(s) { return this.vec(Buffer.from(s, "utf8")); }
  optionSome(some) { return this.u8(some ? 1 : 0); }
  ipAddr(ip) {
    this.u32(ip.family === 4 ? 0 : 1);
    this.push(Buffer.from(ip.octets));
    return this;
  }
  socketAddr(a) { return this.ipAddr(a.ip).u16(a.port); }
  duration(d) { return this.u64(d.secs).u32(d.nanos); }
  optionDuration(d) { return d === null || d === undefined ? this.u8(0) : this.u8(1).duration(d); }
  finish() { return Buffer.concat(this.chunks, this.length); }
}

// RequestType variant indices (meta.rs declaration order). `shape` tells the
// decoder how to consume each variant's payload.
const REQUEST = [
  { name: "Bridge", shape: "bridge" },
  { name: "Flush", shape: null },
  { name: "Unbridge", shape: null },
  { name: "DhcpAcquire", shape: null },
  { name: "IpAdd", shape: "ip-prefix" },
  { name: "IpRemove", shape: "ip" },
  { name: "IpClear", shape: null },
  { name: "GetIpList", shape: null },
  { name: "GetMac", shape: null },
  { name: "GatewaySet", shape: "ip" },
  { name: "RouteAdd", shape: "route-add" },
  { name: "RouteRemove", shape: "ip" },
  { name: "RouteClear", shape: null },
  { name: "GetRouteList", shape: null },
  { name: "BindRaw", shape: "socket-id" },
  { name: "ListenTcp", shape: "listen-tcp" },
  { name: "BindUdp", shape: "bind-udp" },
  { name: "BindIcmp", shape: "socket-id-ip" },
  { name: "ConnectTcp", shape: "connect-tcp" },
  { name: "Resolve", shape: "resolve" },
  { name: "Close", shape: null },
  { name: "BeginAccept", shape: "socket-id" },
  { name: "GetAddrLocal", shape: null },
  { name: "GetAddrPeer", shape: null },
  { name: "SetTtl", shape: "u32" },
  { name: "GetTtl", shape: null },
  { name: "GetStatus", shape: null },
  { name: "SetLinger", shape: "option-duration" },
  { name: "GetLinger", shape: null },
  { name: "SetPromiscuous", shape: "bool" },
  { name: "GetPromiscuous", shape: null },
  { name: "SetRecvBufSize", shape: "u64" },
  { name: "GetRecvBufSize", shape: null },
  { name: "SetSendBufSize", shape: "u64" },
  { name: "GetSendBufSize", shape: null },
  { name: "SetNoDelay", shape: "bool" },
  { name: "GetNoDelay", shape: null },
  { name: "SetKeepAlive", shape: "bool" },
  { name: "GetKeepAlive", shape: null },
  { name: "SetDontRoute", shape: "bool" },
  { name: "GetDontRoute", shape: null },
  { name: "Shutdown", shape: "shutdown" },
  { name: "IsClosed", shape: null },
  { name: "SetBroadcast", shape: "bool" },
  { name: "GetBroadcast", shape: null },
  { name: "SetMulticastLoopV4", shape: "bool" },
  { name: "GetMulticastLoopV4", shape: null },
  { name: "SetMulticastLoopV6", shape: "bool" },
  { name: "GetMulticastLoopV6", shape: null },
  { name: "SetMulticastTtlV4", shape: "u32" },
  { name: "GetMulticastTtlV4", shape: null },
  { name: "JoinMulticastV4", shape: "join-v4" },
  { name: "LeaveMulticastV4", shape: "join-v4" },
  { name: "JoinMulticastV6", shape: "join-v6" },
  { name: "LeaveMulticastV6", shape: "join-v6" },
];

function readRequestPayload(r, shape) {
  switch (shape) {
    case null: return {};
    case "bridge": return { network: r.string(), accessToken: r.string(), security: r.security() };
    case "ip-prefix": return { ip: r.ipAddr(), prefix: r.u8() };
    case "ip": return { ip: r.ipAddr() };
    case "route-add": return { cidr: r.cidr(), viaRouter: r.ipAddr(), preferredUntil: r.optionDuration(), expiresAt: r.optionDuration() };
    case "socket-id": return { socketId: r.u64() };
    case "listen-tcp": return { socketId: r.u64(), addr: r.socketAddr(), onlyV6: r.bool(), reusePort: r.bool(), reuseAddr: r.bool() };
    case "bind-udp": return { socketId: r.u64(), addr: r.socketAddr(), reusePort: r.bool(), reuseAddr: r.bool() };
    case "socket-id-ip": return { socketId: r.u64(), addr: r.ipAddr() };
    case "connect-tcp": return { socketId: r.u64(), addr: r.socketAddr(), peer: r.socketAddr() };
    case "resolve": return { host: r.string(), port: r.option() ? r.u16() : null, dnsServer: r.option() ? r.ipAddr() : null };
    case "u32": return { value: r.u32() };
    case "u64": return { value: r.u64() };
    case "bool": return { value: r.bool() };
    case "option-duration": return { value: r.optionDuration() };
    case "shutdown": return { value: r.shutdown() };
    case "join-v4": return { multiaddr: [...r.bytes(4)], iface: [...r.bytes(4)] };
    case "join-v6": return { multiaddr: [...r.bytes(16)], iface: r.u32() };
    default: throw new Error(`unknown request shape ${shape}`);
  }
}

export function decodeMessageRequest(buffer) {
  const r = new Reader(buffer);
  const message = readMessageRequest(r);
  if (r.o !== buffer.length) throw new Error("trailing frame bytes");
  return message;
}

function readMessageRequest(r) {
  const variant = r.u32();
  switch (variant) {
    case 0: {
      const req = r.u32();
      const def = REQUEST[req];
      if (!def) throw new Error(`unknown RequestType variant ${req}`);
      const payload = readRequestPayload(r, def.shape);
      return { kind: "Interface", name: def.name, ...payload, reqId: r.option() ? r.u64() : null };
    }
    case 1: {
      const socket = r.u64();
      const req = r.u32();
      const def = REQUEST[req];
      if (!def) throw new Error(`unknown RequestType variant ${req}`);
      const payload = readRequestPayload(r, def.shape);
      return { kind: "Socket", socket, name: def.name, ...payload, reqId: r.option() ? r.u64() : null };
    }
    case 2: {
      const socket = r.u64();
      const data = r.vec();
      return { kind: "Send", socket, data, reqId: r.option() ? r.u64() : null };
    }
    case 3: {
      const socket = r.u64();
      const data = r.vec();
      const addr = r.socketAddr();
      return { kind: "SendTo", socket, data, addr, reqId: r.option() ? r.u64() : null };
    }
    case 4:
      return { kind: "Reconnect" };
    default:
      throw new Error(`unknown MessageRequest variant ${variant}`);
  }
}

// --- Response encoders ---

function responseToRequest(reqId, resBytes) {
  const w = new Writer();
  w.u32(0); // MessageResponse::ResponseToRequest
  // Fire-and-forget requests carry no req_id; reply() drops the frame, but
  // the encoder must still accept null.
  w.u64(reqId ?? 0);
  w.push(resBytes);
  return w.finish();
}

function encodeResponseType(w, variant) {
  w.u32(variant);
  return w;
}

export function responseNone(reqId) {
  return responseToRequest(reqId, encodeResponseType(new Writer(), VARIANT.NONE).finish());
}

export function responseErr(reqId, errorIndex) {
  const w = encodeResponseType(new Writer(), VARIANT.ERR);
  w.u32(errorIndex);
  return responseToRequest(reqId, w.finish());
}

export function responseAmount(reqId, amount) {
  const w = encodeResponseType(new Writer(), VARIANT.AMOUNT);
  w.u64(amount);
  return responseToRequest(reqId, w.finish());
}

export function responseFlag(reqId, flag) {
  const w = encodeResponseType(new Writer(), VARIANT.FLAG);
  w.bool(flag);
  return responseToRequest(reqId, w.finish());
}

export function responseIpAddress(reqId, ip) {
  const w = encodeResponseType(new Writer(), VARIANT.IP);
  w.ipAddr(ip);
  return responseToRequest(reqId, w.finish());
}

export function responseIpAddressList(reqId, ips) {
  const w = encodeResponseType(new Writer(), VARIANT.IP_LIST);
  w.u64(ips.length);
  for (const ip of ips) w.ipAddr(ip);
  return responseToRequest(reqId, w.finish());
}

export function responseSocket(reqId, socketId) {
  const w = encodeResponseType(new Writer(), VARIANT.SOCKET);
  w.u64(socketId);
  return responseToRequest(reqId, w.finish());
}

export function responseSocketAddr(reqId, addr) {
  const w = encodeResponseType(new Writer(), VARIANT.ADDR);
  w.socketAddr(addr);
  return responseToRequest(reqId, w.finish());
}

export function responseMac(reqId, octets) {
  const w = encodeResponseType(new Writer(), VARIANT.MAC);
  w.push(Buffer.from(octets));
  return responseToRequest(reqId, w.finish());
}

export function responseRouteList(reqId) {
  const w = encodeResponseType(new Writer(), VARIANT.ROUTE_LIST);
  w.u64(0);
  return responseToRequest(reqId, w.finish());
}

export function responseStatus(reqId, statusIndex) {
  const w = encodeResponseType(new Writer(), VARIANT.STATUS);
  w.u32(statusIndex);
  return responseToRequest(reqId, w.finish());
}

export function responseTtl(reqId, ttl) {
  const w = encodeResponseType(new Writer(), VARIANT.TTL);
  w.u32(ttl);
  return responseToRequest(reqId, w.finish());
}

export function messageSent(socketId, reqId, amount) {
  const w = new Writer();
  w.u32(3); // MessageResponse::Sent
  w.u64(socketId).u64(reqId ?? 0).u64(amount);
  return w.finish();
}

export function messageRecv(socketId, data) {
  const w = new Writer();
  w.u32(1); // MessageResponse::Recv
  w.u64(socketId).vec(data);
  return w.finish();
}

export function messageClosed(socketId) {
  const w = new Writer();
  w.u32(6); // MessageResponse::Closed
  w.u64(socketId);
  return w.finish();
}

export function messageSendError(socketId, reqId, errorIndex) {
  const w = new Writer();
  w.u32(4); // MessageResponse::SendError
  w.u64(socketId).u64(reqId ?? 0).u32(errorIndex);
  return w.finish();
}

// A virtual socket address for listener contexts ({ ip, port }), reusing the
// SocketAddr encoding via Writer.
export function encodeSocketAddr(a) {
  return new Writer().socketAddr(a).finish();
}
