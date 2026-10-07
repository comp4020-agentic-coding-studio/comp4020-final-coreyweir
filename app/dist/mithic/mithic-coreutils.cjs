var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// coreutils-entry.mjs
var coreutils_entry_exports = {};
__export(coreutils_entry_exports, {
  REGISTRY: () => REGISTRY
});
module.exports = __toCommonJS(coreutils_entry_exports);

// mithic/packages/protocol/dist/messages.js
function n(e11) {
  return typeof e11 == "object" && !!e11 && "id" in e11 && typeof e11.id == "number" && "ok" in e11 && typeof e11.ok == "boolean";
}
function r(e11) {
  return typeof e11 == "object" && !!e11 && "event" in e11 && typeof e11.event == "string" && !("id" in e11);
}

// mithic/packages/protocol/dist/pipe.js
var e = 10 * 1024;
var t = 16 * 1024;
var n2 = 4;
var r2 = 64 * 1024;
function i(e11) {
  return typeof e11 != "object" || !e11 || !("type" in e11) ? false : [
    "data",
    "end",
    "error",
    "credit"
  ].includes(e11.type);
}

// mithic/packages/protocol/dist/pipe-flow.js
var t2 = class {
  #e = 0;
  #t = [];
  #n;
  get credit() {
    return this.#e;
  }
  get broken() {
    return this.#n;
  }
  brokenError() {
    let e11 = this.#n?.code ?? "EPIPE";
    return Object.assign(Error(e11), { code: e11 });
  }
  addCredit(e11) {
    if (!this.#n) for (this.#e += e11; this.#t.length > 0 && this.#e >= this.#t[0].needed; ) this.#t.shift().resolve();
  }
  markBroken(e11) {
    if (this.#n) return;
    this.#n = { code: e11 };
    let t17 = this.brokenError(), n18 = this.#t.splice(0);
    for (let e12 of n18) e12.reject(t17);
  }
  reserve(e11) {
    return this.#n ? Promise.reject(this.brokenError()) : this.#e >= e11 ? (this.#e -= e11, Promise.resolve()) : new Promise((t17, n18) => {
      this.#t.push({
        needed: e11,
        resolve: () => {
          this.#e -= e11, t17();
        },
        reject: n18
      });
    });
  }
};
var n3 = class {
  #e;
  #t = 0;
  #n = 0;
  #r = false;
  constructor(t17 = r2) {
    this.#e = t17;
  }
  get window() {
    return this.#e;
  }
  get outstanding() {
    return this.#t;
  }
  open() {
    return this.#r ? 0 : (this.#r = true, this.#n = 0, this.#t += this.#e, this.#e);
  }
  recordArrival(e11) {
    this.#t -= e11, this.#n += e11;
  }
  replenish() {
    let e11 = this.#e - this.#t, t17 = Math.min(this.#n, e11);
    return t17 <= 0 ? 0 : (this.#n -= t17, this.#t += t17, t17);
  }
};

// mithic/packages/guest-runtime/dist/streams.js
function s(e11) {
  e11.start?.();
  let r16 = new t2();
  e11.onmessage = (e12) => {
    let t17 = e12.data;
    i(t17) && (t17.type === "credit" ? r16.addCredit(t17.bytes) : (t17.type === "end" || t17.type === "error") && r16.markBroken(t17.type === "error" ? t17.code : "EPIPE"));
  };
  let s30 = [], c37 = 0, l38 = null;
  function u37() {
    if (l38 !== null && (clearTimeout(l38), l38 = null), s30.length === 0) return r16.broken ? Promise.reject(r16.brokenError()) : Promise.resolve();
    let t17 = s30;
    return s30 = [], c37 = 0, (async () => {
      for (let n18 of t17) {
        await r16.reserve(n18.byteLength);
        let t18 = {
          type: "data",
          chunk: n18
        }, i22 = n18.byteLength >= e ? [n18.buffer] : [];
        e11.postMessage(t18, i22);
      }
    })();
  }
  return new WritableStream({
    write(e12) {
      return r16.broken ? Promise.reject(r16.brokenError()) : (s30.push(e12), c37 += e12.byteLength, c37 >= t ? u37() : l38 === null ? new Promise((e13, t17) => {
        l38 = setTimeout(() => {
          u37().then(e13, t17);
        }, n2);
      }) : Promise.resolve());
    },
    close() {
      return u37().then(() => {
        e11.postMessage({ type: "end" }), e11.close();
      });
    },
    abort() {
      l38 !== null && (clearTimeout(l38), l38 = null), e11.postMessage({
        type: "error",
        code: "EPIPE"
      }), e11.close();
    }
  });
}
function c(e11) {
  e11.start?.();
  let s30 = new n3(), c37 = new t2(), l38 = null, u37 = false;
  function d36(t17) {
    if (t17 <= 0) return;
    let n18 = {
      type: "credit",
      bytes: t17
    };
    e11.postMessage(n18);
  }
  e11.onmessage = (e12) => {
    let t17 = e12.data;
    i(t17) && (t17.type === "data" ? (s30.recordArrival(t17.chunk.byteLength), l38?.enqueue(t17.chunk)) : t17.type === "credit" ? c37.addCredit(t17.bytes) : t17.type === "end" ? u37 || (u37 = true, l38?.close()) : t17.type === "error" && (c37.markBroken(t17.code), u37 || (u37 = true, l38?.error(Error(t17.code)))));
  };
  let f32 = new ReadableStream({
    start(e12) {
      l38 = e12;
    },
    pull() {
      d36(s30.open() || s30.replenish());
    },
    cancel() {
      e11.postMessage({
        type: "error",
        code: "EPIPE"
      });
    }
  }), p31 = [], m24 = 0, h24 = null;
  function g18() {
    if (h24 !== null && (clearTimeout(h24), h24 = null), p31.length === 0) return c37.broken ? Promise.reject(c37.brokenError()) : Promise.resolve();
    let t17 = p31;
    return p31 = [], m24 = 0, (async () => {
      for (let n18 of t17) {
        await c37.reserve(n18.byteLength);
        let t18 = {
          type: "data",
          chunk: n18
        }, r16 = n18.byteLength >= e ? [n18.buffer] : [];
        e11.postMessage(t18, r16);
      }
    })();
  }
  return {
    readable: f32,
    writable: new WritableStream({
      write(e12) {
        return c37.broken ? Promise.reject(c37.brokenError()) : (p31.push(e12), m24 += e12.byteLength, m24 >= t ? g18() : h24 === null ? new Promise((e13, t17) => {
          h24 = setTimeout(() => {
            g18().then(e13, t17);
          }, n2);
        }) : Promise.resolve());
      },
      close() {
        return g18().then(() => {
          e11.postMessage({ type: "end" });
        });
      },
      abort() {
        h24 !== null && (clearTimeout(h24), h24 = null), e11.postMessage({
          type: "error",
          code: "EPIPE"
        });
      }
    })
  };
}
function l(e11, t17) {
  e11.start?.();
  let n18 = null, i22 = false, a20 = new n3();
  function s30(t18) {
    if (t18 <= 0) return;
    let n19 = {
      type: "credit",
      bytes: t18
    };
    e11.postMessage(n19);
  }
  function c37() {
    if (!i22) {
      i22 = true;
      try {
        e11.postMessage({
          type: "error",
          code: "EPIPE"
        }), e11.close();
      } catch {
      }
    }
  }
  return new ReadableStream({
    start(r16) {
      if (n18 = r16, e11.onmessage = (t18) => {
        let r17 = t18.data;
        i(r17) && (i22 || (r17.type === "data" ? (a20.recordArrival(r17.chunk.byteLength), n18.enqueue(r17.chunk)) : r17.type === "end" ? (i22 = true, n18.close(), e11.close()) : r17.type === "error" && (i22 = true, n18.error(Error(r17.code)), e11.close())));
      }, t17) {
        let e12 = () => {
          if (!i22) {
            c37();
            try {
              n18.error(d(t17));
            } catch {
            }
          }
        };
        t17.aborted ? e12() : t17.addEventListener("abort", e12, { once: true });
      }
    },
    pull() {
      s30(a20.open() || a20.replenish());
    },
    cancel() {
      c37();
    }
  });
}
function d(e11) {
  let t17 = e11.reason;
  return t17 instanceof Error ? t17 : /* @__PURE__ */ Error("aborted");
}

// mithic/packages/guest-runtime/dist/fetch.js
function t4(e11) {
  return e11 instanceof Uint8Array ? e11 : e11 instanceof ArrayBuffer || Array.isArray(e11) ? new Uint8Array(e11) : new Uint8Array();
}
function n4(e11) {
  return async function(t17, n18) {
    let i22 = new Request(t17, n18), l38 = i22.signal;
    if (l38.aborted) throw o(l38);
    let u37 = [];
    i22.headers.forEach((e12, t18) => {
      u37.push([t18, e12]);
    });
    let d36 = {
      method: i22.method,
      url: i22.url,
      headers: u37
    };
    if (i22.body !== null || a(n18)) {
      let e12 = await i22.arrayBuffer();
      (e12.byteLength > 0 || a(n18)) && (d36.body = new Uint8Array(e12));
    }
    let f32 = {};
    f32.signal = l38;
    let p31;
    try {
      p31 = await e11("net/fetch", d36, f32);
    } catch (e12) {
      let t18 = s2(e12);
      throw t18 === "ECANCELED" ? o(l38, e12) : t18 === "ETIMEDOUT" ? new DOMException(c2(e12), "TimeoutError") : e12;
    }
    let m24 = p31.result;
    return r3(m24, p31.ports ?? [], l38);
  };
}
function r3(n18, r16, a20) {
  let o23 = n18.status, s30 = {
    status: o23,
    headers: new Headers(n18.headers ?? [])
  };
  if (typeof n18.statusText == "string" && (s30.statusText = n18.statusText), i2(o23)) {
    for (let e11 of r16) try {
      e11.close();
    } catch {
    }
    return new Response(null, s30);
  }
  if (n18.bodyStream && r16[0]) {
    let t17 = l(r16[0], a20);
    return new Response(t17, s30);
  }
  let c37 = t4(n18.body);
  return new Response(c37.byteLength ? c37 : null, s30);
}
function i2(e11) {
  return e11 === 101 || e11 === 103 || e11 === 204 || e11 === 205 || e11 === 304;
}
function a(e11) {
  return e11 !== void 0 && e11.body !== void 0 && e11.body !== null;
}
function o(e11, t17) {
  let n18 = e11.reason;
  return n18 instanceof DOMException ? n18 : n18 instanceof Error ? new DOMException(n18.message, "AbortError") : new DOMException(t17 instanceof Error ? t17.message : "The operation was aborted.", "AbortError");
}
function s2(e11) {
  if (e11 && typeof e11 == "object" && "code" in e11) {
    let t17 = e11.code;
    if (typeof t17 == "string") return t17;
  }
}
function c2(e11) {
  return e11 instanceof Error ? e11.message : String(e11);
}

// mithic/packages/guest-runtime/dist/fs-access.js
var t5 = new TextEncoder();
var n5 = new TextDecoder();
var r4 = r2;
function i3(e11, t17) {
  if (t17.includes("/")) throw a2(`name must not contain "/": ${t17}`);
  if (t17 === "" || t17 === "." || t17 === "..") throw a2(`invalid name: ${t17}`);
  return `${e11 === "/" ? "" : e11}/${t17}`;
}
function a2(e11) {
  return TypeError(e11);
}
function o2(e11) {
  return new DOMException(e11, "NotFoundError");
}
function s3(e11) {
  if (e11 && typeof e11 == "object" && "code" in e11) {
    let t17 = e11.code;
    if (typeof t17 == "string") return t17;
  }
}
var c3 = class {
  name;
  size;
  type = "";
  lastModified;
  #e;
  #t;
  constructor(e11, t17, n18, r16, i22) {
    this.#e = e11, this.#t = t17, this.name = n18, this.size = r16, this.lastModified = i22;
  }
  stream() {
    let e11 = this.#e, t17 = this.#t, n18;
    return new ReadableStream({
      async start() {
        n18 = (await e11("fs/open", {
          path: t17,
          oflags: { read: true }
        })).fd;
      },
      async pull(t18) {
        try {
          let i22 = await l2(e11, n18, r4);
          if (i22.byteLength === 0) {
            t18.close(), await e11("fs/close", { fd: n18 }).catch(() => {
            });
            return;
          }
          t18.enqueue(i22);
        } catch (r16) {
          t18.error(r16), await e11("fs/close", { fd: n18 }).catch(() => {
          });
        }
      },
      async cancel() {
        n18 !== void 0 && await e11("fs/close", { fd: n18 }).catch(() => {
        });
      }
    });
  }
  async arrayBuffer() {
    let e11 = await this.bytes();
    return e11.buffer.slice(e11.byteOffset, e11.byteOffset + e11.byteLength);
  }
  async text() {
    return n5.decode(await this.bytes());
  }
  async bytes() {
    let e11 = this.stream().getReader(), t17 = [], n18 = 0;
    try {
      for (; ; ) {
        let { value: r17, done: i23 } = await e11.read();
        if (i23) break;
        r17 && (t17.push(r17), n18 += r17.byteLength);
      }
    } finally {
      e11.releaseLock();
    }
    let r16 = new Uint8Array(n18), i22 = 0;
    for (let e12 of t17) r16.set(e12, i22), i22 += e12.byteLength;
    return r16;
  }
};
async function l2(e11, t17, n18) {
  return u(await e11("fs/read", {
    fd: t17,
    len: n18
  }));
}
function u(e11) {
  if (e11 instanceof Uint8Array) return e11;
  if (e11 instanceof ArrayBuffer || Array.isArray(e11)) return new Uint8Array(e11);
  if (e11 && typeof e11 == "object" && "data" in e11) {
    let t17 = e11.data;
    if (t17 instanceof Uint8Array) return t17;
    if (t17 instanceof ArrayBuffer || Array.isArray(t17)) return new Uint8Array(t17);
  }
  return new Uint8Array();
}
var d2 = class {
  #e;
  #t;
  #n = 0;
  #r = false;
  constructor(e11, t17) {
    this.#e = e11, this.#t = t17;
  }
  async write(e11) {
    if (this.#r) throw a2("write on a closed writable stream");
    let t17 = p(f(e11)), n18 = 0;
    for (; n18 < t17.byteLength; ) {
      let e12 = t17.subarray(n18, n18 + 65536), { written: r16 } = await this.#e("fs/write", {
        fd: this.#t,
        data: e12,
        offset: this.#n
      }), i22 = r16 > 0 ? r16 : e12.byteLength;
      n18 += i22, this.#n += i22;
    }
    t17.byteLength === 0 && await this.#e("fs/write", {
      fd: this.#t,
      data: new Uint8Array(),
      offset: this.#n
    });
  }
  async close() {
    this.#r || (this.#r = true, await this.#e("fs/close", { fd: this.#t }).catch(() => {
    }));
  }
  async abort() {
    return this.close();
  }
};
function f(e11) {
  return e11 && typeof e11 == "object" && !(e11 instanceof Uint8Array) && !(e11 instanceof ArrayBuffer) && "data" in e11 ? e11.data : e11;
}
function p(e11) {
  return typeof e11 == "string" ? t5.encode(e11) : e11 instanceof ArrayBuffer ? new Uint8Array(e11) : e11;
}
var m = class {
  kind = "file";
  name;
  #e;
  #t;
  constructor(e11, t17, n18) {
    this.#e = e11, this.#t = t17, this.name = n18;
  }
  async getFile() {
    let e11 = await this.#e("fs/stat", { path: this.#t });
    return new c3(this.#e, this.#t, this.name, e11.size ?? 0, Date.now());
  }
  async createWritable(e11 = {}) {
    let t17 = e11.keepExistingData !== true, { fd: n18 } = await this.#e("fs/open", {
      path: this.#t,
      oflags: {
        create: true,
        write: true,
        truncate: t17
      }
    });
    return new d2(this.#e, n18);
  }
};
var h = class e3 {
  kind = "directory";
  name;
  #e;
  #t;
  constructor(e11, t17, n18) {
    this.#e = e11, this.#t = t17, this.name = n18;
  }
  async getFileHandle(e11, t17 = {}) {
    let n18 = i3(this.#t, e11), r16 = await this.#a(n18);
    if (r16 === "file") return new m(this.#e, n18, e11);
    if (r16 === "directory") throw new DOMException(`${e11} is a directory`, "TypeMismatchError");
    if (!t17.create) throw o2(`no such file: ${e11}`);
    let { fd: a20 } = await this.#e("fs/open", {
      path: n18,
      oflags: {
        create: true,
        write: true,
        truncate: true
      }
    });
    return await this.#e("fs/close", { fd: a20 }).catch(() => {
    }), new m(this.#e, n18, e11);
  }
  async getDirectoryHandle(t17, n18 = {}) {
    let r16 = i3(this.#t, t17), a20 = await this.#a(r16);
    if (a20 === "directory") return new e3(this.#e, r16, t17);
    if (a20 === "file") throw new DOMException(`${t17} is a file`, "TypeMismatchError");
    if (!n18.create) throw o2(`no such directory: ${t17}`);
    return await this.#e("fs/mkdir", { path: r16 }), new e3(this.#e, r16, t17);
  }
  async removeEntry(e11, t17 = {}) {
    let n18 = i3(this.#t, e11), r16 = await this.#a(n18);
    if (r16 === void 0) throw o2(`no such entry: ${e11}`);
    r16 === "directory" ? t17.recursive ? await this.#n(n18) : await this.#e("fs/rmdir", { path: n18 }) : await this.#e("fs/unlink", { path: n18 });
  }
  async #n(e11) {
    let t17 = await this.#e("fs/readdir", { path: e11 });
    for (let n18 of t17) {
      let t18 = i3(e11, n18.name);
      n18.type === "directory" ? await this.#n(t18) : await this.#e("fs/unlink", { path: t18 });
    }
    await this.#e("fs/rmdir", { path: e11 });
  }
  async *keys() {
    for (let e11 of await this.#r()) yield e11.name;
  }
  async *values() {
    for (let e11 of await this.#r()) yield this.#i(e11);
  }
  async *entries() {
    for (let e11 of await this.#r()) yield [e11.name, this.#i(e11)];
  }
  [Symbol.asyncIterator]() {
    return this.entries();
  }
  async #r() {
    return await this.#e("fs/readdir", { path: this.#t });
  }
  #i(t17) {
    let n18 = i3(this.#t, t17.name);
    return t17.type === "directory" ? new e3(this.#e, n18, t17.name) : new m(this.#e, n18, t17.name);
  }
  async #a(e11) {
    try {
      return (await this.#e("fs/stat", { path: e11 })).type === "directory" ? "directory" : "file";
    } catch (e12) {
      if (s3(e12) === "ENOENT") return;
      throw e12;
    }
  }
};
function g(e11) {
  return new h(e11, "/", "");
}
function _(e11, t17) {
  return {
    async getDirectory() {
      return g(e11);
    },
    async getCurrentDirectory() {
      let n18 = y(t17);
      return new h(e11, n18, n18 === "/" ? "" : n18.slice(n18.lastIndexOf("/") + 1));
    }
  };
}
function y(e11) {
  let t17 = [];
  for (let n18 of e11.split("/")) if (!(n18 === "" || n18 === ".")) {
    if (n18 === "..") {
      t17.pop();
      continue;
    }
    t17.push(n18);
  }
  return "/" + t17.join("/");
}

// mithic/packages/guest-runtime/dist/syscall-client.js
var t6 = class {
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  transport;
  timeoutMs;
  constructor(t17, n18 = {}) {
    this.transport = t17, this.timeoutMs = n18.timeoutMs, t17.onMessage((t18, n19) => {
      if (!n(t18)) return;
      let r16 = this.pending.get(t18.id);
      if (r16) if (this.#e(t18.id, r16), t18.ok) r16.resolve({
        result: t18.result,
        ports: n19 ?? []
      });
      else {
        let e11 = Object.assign(Error(t18.error.message), { code: t18.error.code });
        r16.reject(e11);
      }
    });
  }
  #e(e11, t17) {
    this.pending.delete(e11), t17.timer !== void 0 && clearTimeout(t17.timer), t17.signal && t17.onAbort && t17.signal.removeEventListener("abort", t17.onAbort);
  }
  syscall(e11, t17, n18 = {}) {
    return this.#t(e11, t17, n18).then((e12) => e12.result);
  }
  syscallPorts(e11, t17, n18 = {}) {
    return this.#t(e11, t17, n18);
  }
  #t(e11, t17, n18) {
    let r16 = this.nextId++, i22 = n18.timeoutMs ?? this.timeoutMs;
    return new Promise((a20, o23) => {
      if (n18.signal?.aborted) {
        o23(Object.assign(/* @__PURE__ */ Error(`syscall canceled: ${e11}`), { code: "ECANCELED" }));
        return;
      }
      let s30 = {
        resolve: a20,
        reject: o23,
        signal: n18.signal
      };
      i22 !== void 0 && (s30.timer = setTimeout(() => {
        let t18 = this.pending.get(r16);
        t18 && (this.#e(r16, t18), o23(Object.assign(/* @__PURE__ */ Error(`syscall timed out: ${e11}`), { code: "ETIMEDOUT" })));
      }, i22)), n18.signal && (s30.onAbort = () => {
        let t18 = this.pending.get(r16);
        t18 && (this.#e(r16, t18), o23(Object.assign(/* @__PURE__ */ Error(`syscall canceled: ${e11}`), { code: "ECANCELED" })));
      }, n18.signal.addEventListener("abort", s30.onAbort, { once: true })), this.pending.set(r16, s30), this.transport.send({
        id: r16,
        call: e11,
        args: t17
      }, n18.transfer ? [...n18.transfer] : void 0);
    });
  }
  close() {
    let e11 = Object.assign(/* @__PURE__ */ Error("transport closed"), { code: "EPIPE" });
    for (let t17 of this.pending.values()) t17.timer !== void 0 && clearTimeout(t17.timer), t17.signal && t17.onAbort && t17.signal.removeEventListener("abort", t17.onAbort), t17.reject(e11);
    this.pending.clear(), this.transport.close();
  }
};

// mithic/packages/guest-runtime/dist/guest.js
var s4 = /* @__PURE__ */ new Set(["SIGTERM", "SIGINT"]);
function c4({ control: c37, init: l38, preopenPorts: u37 = {} }) {
  let d36 = [], f32 = [], p31 = [], m24 = new AbortController();
  c37.start?.(), c37.onmessage = (e11) => {
    let t17 = e11.data;
    if (r(t17)) {
      if (t17.event === "signal") {
        let e12 = t17.payload, n18 = e12?.signal ?? "";
        for (let t18 of d36) t18(n18, e12?.extra);
        s4.has(n18) && !m24.signal.aborted && m24.abort(new DOMException(`terminated by ${n18}`, "AbortError"));
      } else if (t17.event === "dom/event") {
        let e12 = t17.payload;
        if (e12 && typeof e12.nodeId == "number" && typeof e12.eventType == "string") {
          let t18 = {
            nodeId: e12.nodeId,
            eventType: e12.eventType,
            payload: e12.payload ?? {}
          };
          for (let e13 of f32) e13(t18);
        }
      }
    } else {
      let n18 = e11.ports && e11.ports.length > 0 ? e11.ports : void 0;
      for (let e12 of p31) e12(t17, n18);
    }
  };
  let h24 = new t6({
    send(e11, t17 = []) {
      c37.postMessage(e11, t17);
    },
    onMessage(e11) {
      p31.push(e11);
    },
    close() {
      c37.close();
    }
  }), g18 = () => new WritableStream({ write() {
  } }), _21 = u37[0], v17 = u37[1], y18 = u37[2], b17 = _21 ? l(_21) : new ReadableStream(), x13 = v17 ? s(v17) : g18(), S11 = y18 ? s(y18) : g18(), C12 = false, w9;
  function T7() {
    if (!(C12 || !_21)) {
      C12 = true;
      try {
        _21.postMessage({
          type: "error",
          code: "EPIPE"
        }), _21.close();
      } catch {
      }
    }
  }
  return {
    pid: l38.pid,
    args: l38.args,
    env: l38.env,
    cwd: l38.cwd,
    stdin: b17,
    stdout: x13,
    stderr: S11,
    syscall: (e11, t17, n18) => h24.syscall(e11, t17, n18),
    syscallPorts: (e11, t17, n18) => h24.syscallPorts(e11, t17, n18),
    async pipe() {
      let { result: e11, ports: r16 } = await h24.syscallPorts("fs/pipe", {}), i22 = e11, a20 = r16[0], o23 = r16[1];
      return {
        readfd: i22.readfd,
        writefd: i22.writefd,
        readable: a20 ? l(a20) : void 0,
        writable: o23 ? s(o23) : void 0
      };
    },
    async connect(t17) {
      let { result: n18, ports: r16 } = await h24.syscallPorts("ipc/connect", { path: t17 }), i22 = n18, a20 = r16[0];
      if (!a20) return { connfd: i22.connfd };
      let { readable: o23, writable: s30 } = c(a20);
      return {
        connfd: i22.connfd,
        readable: o23,
        writable: s30
      };
    },
    fetch: n4((e11, t17, n18) => h24.syscallPorts(e11, t17, n18)),
    get fs() {
      return w9 ??= _((e11, t17, n18) => h24.syscall(e11, t17, n18), l38.cwd);
    },
    onSignal(e11) {
      d36.push(e11);
    },
    signal: m24.signal,
    onDomEvent(e11) {
      f32.push(e11);
    },
    isatty(e11) {
      return l38.preopens?.[e11]?.tty === true;
    },
    display: l38.display,
    exit(e11) {
      T7(), c37.postMessage({
        type: "exit",
        code: e11
      }), h24.close();
    }
  };
}

// mithic/packages/coreutils/dist/harness.js
function t7(e11, t17 = {}) {
  let n18 = new Set(t17.string ?? []), r16 = new Set(t17.count ?? []), i22 = t17.alias ?? {}, a20 = (e12) => i22[e12] ?? e12, o23 = t17.unknown === "error", s30 = /* @__PURE__ */ new Set([
    ...t17.boolean ?? [],
    ...t17.string ?? [],
    ...t17.count ?? [],
    ...Object.keys(i22),
    ...Object.values(i22)
  ]), c37 = [], l38 = (e12) => s30.has(e12) || s30.has(a20(e12)), u37 = [], d36 = {}, f32 = (e12) => {
    let t18 = a20(e12);
    r16.has(t18) ? d36[t18] = (typeof d36[t18] == "number" ? d36[t18] : 0) + 1 : d36[t18] = true;
  }, p31 = (e12, t18) => {
    d36[a20(e12)] = t18;
  }, m24 = 0;
  for (; m24 < e11.length; m24++) {
    let t18 = e11[m24];
    if (t18 === "--") {
      m24++;
      break;
    }
    if (t18 === "-" || !t18.startsWith("-")) {
      u37.push(t18);
      continue;
    }
    if (t18.startsWith("--")) {
      let r18 = t18.slice(2), i23 = r18.indexOf("="), s31 = i23 >= 0 ? r18.slice(0, i23) : r18;
      if (i23 >= 0) {
        if (o23 && !l38(s31)) {
          c37.push("--" + s31);
          continue;
        }
        p31(s31, r18.slice(i23 + 1));
        continue;
      }
      if (n18.has(a20(s31)) || n18.has(s31)) {
        let t19 = e11[m24 + 1];
        t19 === void 0 ? p31(s31, "") : (p31(s31, t19), m24++);
      } else o23 && !l38(s31) ? c37.push("--" + s31) : f32(s31);
      continue;
    }
    let r17 = t18.slice(1);
    for (let t19 = 0; t19 < r17.length; t19++) {
      let i23 = r17[t19], s31 = a20(i23);
      if (n18.has(s31) || n18.has(i23)) {
        let n19 = r17.slice(t19 + 1);
        if (n19.length > 0) p31(i23, n19);
        else {
          let t20 = e11[m24 + 1];
          t20 === void 0 ? p31(i23, "") : (p31(i23, t20), m24++);
        }
        break;
      }
      if (o23 && !l38(i23)) {
        c37.push("-" + i23);
        continue;
      }
      f32(i23);
    }
  }
  for (; m24 < e11.length; m24++) u37.push(e11[m24]);
  return {
    positionals: u37,
    flags: d36,
    unknown: c37
  };
}
var n6 = new TextEncoder();
function r5(e11) {
  switch (e11?.code) {
    case "no-entry":
      return "No such file or directory";
    case "access":
      return "Permission denied";
    case "exist":
      return "File exists";
    case "not-directory":
      return "Not a directory";
    case "is-directory":
      return "Is a directory";
    case "cross-device":
      return "Invalid cross-device link";
    case "not-empty":
      return "Directory not empty";
    case "invalid":
      return "Invalid argument";
    case "no-space":
      return "No space left on device";
    case "io":
      return "Input/output error";
    default: {
      let t17 = e11?.message;
      return t17 && t17.trim() !== "" ? t17 : "No such file or directory";
    }
  }
}
var i4 = 256 * 1024 * 1024;
var a3 = class extends Error {
  limit;
  constructor(e11) {
    super("input too large"), this.name = "InputTooLargeError", this.limit = e11;
  }
};
async function o3(e11, t17 = i4) {
  let n18 = e11.getReader(), r16 = [], o23 = 0;
  try {
    for (; ; ) {
      let { value: i22, done: s31 } = await n18.read();
      if (s31) break;
      if (i22) {
        if (o23 += i22.byteLength, o23 > t17) throw n18.releaseLock(), await e11.cancel().catch(() => {
        }), new a3(t17);
        r16.push(i22);
      }
    }
  } finally {
    try {
      n18.releaseLock();
    } catch {
    }
  }
  let s30 = new Uint8Array(o23), c37 = 0;
  for (let e12 of r16) s30.set(e12, c37), c37 += e12.byteLength;
  return s30;
}
async function s5(e11, t17 = i4) {
  return new TextDecoder().decode(await o3(e11, t17));
}
async function* l3(e11) {
  let t17 = e11.getReader(), n18 = new TextDecoder(), r16 = "";
  try {
    for (; ; ) {
      let { value: e12, done: i22 } = await t17.read();
      if (i22) break;
      if (!e12 || e12.byteLength === 0) continue;
      r16 += n18.decode(e12, { stream: true });
      let a20 = r16.indexOf("\n");
      for (; a20 !== -1; ) yield {
        line: r16.slice(0, a20),
        eol: true
      }, r16 = r16.slice(a20 + 1), a20 = r16.indexOf("\n");
    }
    r16 += n18.decode(), r16 !== "" && (yield {
      line: r16,
      eol: false
    });
  } finally {
    t17.releaseLock();
  }
}
function u2(e11) {
  let t17 = e11?.code, n18 = e11?.message ?? "";
  return t17 === "EPIPE" || /EPIPE|broken pipe|closed|abort/i.test(n18);
}
var d3 = class e4 {
  static FLUSH_THRESHOLD = 32 * 1024;
  #e;
  #t = [];
  #n = 0;
  constructor(e11) {
    this.#e = e11;
  }
  async push(t17) {
    t17 !== "" && (this.#t.push(t17), this.#n += t17.length, this.#n >= e4.FLUSH_THRESHOLD && await this.flush());
  }
  async flush() {
    if (this.#t.length === 0) return;
    let t17 = n6.encode(this.#t.join(""));
    this.#t = [], this.#n = 0;
    let r16 = e4.FLUSH_THRESHOLD;
    for (let e11 = 0; e11 < t17.byteLength; e11 += r16) await this.#e.write(t17.subarray(e11, Math.min(e11 + r16, t17.byteLength)));
  }
};
function f2(e11, t17) {
  return e11.write(t17);
}
function p2(e11, t17) {
  return e11.write(n6.encode(t17));
}
function m2(e11, t17) {
  return e11.write(n6.encode(t17 + "\n"));
}
function h2(e11, t17) {
  return `${t17.startsWith("--") ? `${e11}: unrecognized option '${t17}'` : `${e11}: invalid option -- '${t17.replace(/^-/, "")}'`}
Try '${e11} --help' for more information.`;
}
async function g2(e11, t17, n18) {
  return n18 !== void 0 && await m2(e11, n18), t17;
}
function _2(t17) {
  return async function(n18) {
    let r16 = c4(n18), i22 = {
      args: r16.args,
      env: r16.env,
      cwd: r16.cwd,
      stdin: r16.stdin,
      stdout: r16.stdout,
      stderr: r16.stderr,
      syscall: (e11, t18) => r16.syscall(e11, t18),
      isatty: (e11) => r16.isatty(e11)
    }, a20 = 0;
    try {
      a20 = await t17(i22);
    } catch (e11) {
      let t18 = i22.args[0] ?? "coreutils";
      try {
        let n19 = i22.stderr.getWriter();
        await m2(n19, `${t18}: ${e11.message}`), await n19.close().catch(() => {
        });
      } catch {
      }
      a20 = 1;
    }
    await v(i22.stdout), await v(i22.stderr), r16.exit(a20);
  };
}
async function v(e11) {
  if (!e11.locked) try {
    await e11.close();
  } catch {
  }
}

// mithic/packages/coreutils/dist/commands/cat.js
async function c5(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return i22;
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
async function l4(e11, t17, n18) {
  let { fd: i22 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    for (; ; ) {
      let t18 = await e11.syscall("fs/read", {
        fd: i22,
        len: 65536
      });
      if (!t18 || t18.byteLength === 0) break;
      try {
        await f2(n18, t18);
      } catch (e12) {
        if (u2(e12)) return true;
        throw e12;
      }
    }
    return false;
  } finally {
    await e11.syscall("fs/close", { fd: i22 }).catch(() => {
    });
  }
}
var u3 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EXDEV: "Invalid cross-device link",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
  EIO: "Input/output error"
};
function d4(e11) {
  let t17 = e11?.code;
  return (t17 && u3[t17]) ?? r5(e11);
}
function f3(e11, t17, n18) {
  if (e11 === 9) {
    t17.showTabs ? n18.push(94, 73) : n18.push(9);
    return;
  }
  if (!t17.showNonprint) {
    n18.push(e11);
    return;
  }
  let r16 = e11;
  r16 >= 128 && (n18.push(77, 45), r16 -= 128), r16 < 32 ? n18.push(94, r16 + 64) : r16 === 127 ? n18.push(94, 63) : n18.push(r16);
}
function p3(e11, t17, n18) {
  let r16 = [], i22 = t17.number || t17.numberNonblank, a20 = (e12) => [...String(e12).padStart(6, " ") + "	"].map((e13) => e13.charCodeAt(0)), o23 = 0;
  for (; o23 < e11.length; ) {
    let s30 = o23;
    for (; s30 < e11.length && e11[s30] !== 10; ) s30++;
    let c37 = s30 < e11.length, l38 = s30 === o23;
    if (t17.squeeze && l38) {
      if (n18.blanks++, n18.blanks > 1) {
        o23 = c37 ? s30 + 1 : s30;
        continue;
      }
    } else l38 || (n18.blanks = 0);
    i22 && (t17.numberNonblank && l38 || r16.push(...a20(n18.lineNo++)));
    for (let n19 = o23; n19 < s30; n19++) f3(e11[n19], t17, r16);
    c37 ? (t17.showEnds && r16.push(36), r16.push(10), o23 = s30 + 1) : o23 = s30;
  }
  return new Uint8Array(r16);
}
var m3 = async (e11) => {
  let n18 = t7(e11.args.slice(1), {
    boolean: [
      "n",
      "number",
      "b",
      "number-nonblank",
      "s",
      "squeeze-blank",
      "E",
      "show-ends",
      "T",
      "show-tabs",
      "v",
      "show-nonprinting",
      "A",
      "show-all",
      "e",
      "t",
      "u"
    ],
    alias: {
      number: "n",
      "number-nonblank": "b",
      "squeeze-blank": "s",
      "show-ends": "E",
      "show-tabs": "T",
      "show-nonprinting": "v",
      "show-all": "A"
    },
    unknown: "error"
  }), u37 = e11.args[0] ?? "cat", f32 = e11.stdout.getWriter(), m24 = e11.stderr.getWriter();
  if (n18.unknown.length) try {
    return await g2(m24, 1, h2(u37, n18.unknown[0]));
  } finally {
    await f32.close().catch(() => {
    }), await m24.close().catch(() => {
    });
  }
  let { positionals: h24, flags: g18 } = n18, _21 = {
    number: !!g18.n,
    numberNonblank: !!g18.b,
    squeeze: !!g18.s,
    showEnds: !!g18.E || !!g18.A || !!g18.e,
    showTabs: !!g18.T || !!g18.A || !!g18.t,
    showNonprint: !!g18.v || !!g18.A || !!g18.e || !!g18.t
  }, v17 = _21.number || _21.numberNonblank || _21.squeeze || _21.showEnds || _21.showTabs || _21.showNonprint, y18 = h24.length > 0 ? h24 : ["-"], b17 = 0, x13 = false, S11 = {
    lineNo: 1,
    blanks: 0
  };
  try {
    for (let t17 of y18) {
      if (t17 === "-") {
        if (!v17) {
          let t19 = e11.stdin.getReader();
          try {
            for (; ; ) {
              let { value: e12, done: n21 } = await t19.read();
              if (n21) break;
              !e12 || e12.byteLength === 0 || await f2(f32, e12);
            }
          } catch (e12) {
            if (u2(e12)) x13 = true;
            else throw e12;
          } finally {
            t19.releaseLock();
          }
          continue;
        }
        let t18 = [], n20 = 0, i22 = e11.stdin.getReader();
        try {
          for (; ; ) {
            let { value: e12, done: r16 } = await i22.read();
            if (r16) break;
            e12 && (t18.push(e12), n20 += e12.byteLength);
          }
        } finally {
          i22.releaseLock();
        }
        let a20 = new Uint8Array(n20), s30 = 0;
        for (let e12 of t18) a20.set(e12, s30), s30 += e12.byteLength;
        await f2(f32, p3(a20, _21, S11));
        continue;
      }
      if (!v17) {
        try {
          if (await l4(e11, t17, f32)) {
            x13 = true;
            break;
          }
        } catch (e12) {
          await m2(m24, `${u37}: ${t17}: ${d4(e12)}`), b17 = 1;
        }
        continue;
      }
      let n19;
      try {
        n19 = await c5(e11, t17);
      } catch (e12) {
        await m2(m24, `${u37}: ${t17}: ${d4(e12)}`), b17 = 1;
        continue;
      }
      await f2(f32, p3(n19, _21, S11));
    }
  } finally {
    await f32.close().catch(() => {
    }), await m24.close().catch(() => {
    }), x13 && await e11.stdin.cancel().catch(() => {
    });
  }
  return b17;
};
var h3 = _2(m3);

// mithic/packages/coreutils/dist/commands/_regex.js
function e5(e11) {
  return e11.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var t8 = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "0-9A-Za-z",
  upper: "A-Z",
  lower: "a-z",
  space: "\\t\\n\\v\\f\\r ",
  blank: " \\t",
  xdigit: "0-9A-Fa-f",
  punct: "!-/:-@\\[-`{-~",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e"
};
function n7(e11) {
  let n18 = "", r16 = 0, i22 = false, a20 = false;
  for (; r16 < e11.length; ) {
    if (e11[r16] === "[" && e11[r16 + 1] === ":") {
      let o24 = e11.indexOf(":]", r16 + 2);
      if (o24 >= 0) {
        let s30 = t8[e11.slice(r16 + 2, o24)];
        if (s30 !== void 0) {
          n18 += i22 ? s30 : "[" + s30 + "]", r16 = o24 + 2, a20 = false;
          continue;
        }
      }
    }
    let o23 = e11[r16];
    if (!i22) {
      if (o23 === "\\" && r16 + 1 < e11.length) {
        n18 += o23 + e11[r16 + 1], r16 += 2;
        continue;
      }
      if (o23 === "[") {
        i22 = true, a20 = true, n18 += o23, r16++;
        continue;
      }
      n18 += o23, r16++;
      continue;
    }
    if (n18 += o23, o23 === "^" && a20) {
      a20 = true, r16++;
      continue;
    }
    o23 === "]" && !a20 && (i22 = false), a20 = false, r16++;
  }
  return n18;
}
function r6(e11) {
  let t17 = /* @__PURE__ */ new Set([
    "(",
    ")",
    "{",
    "}",
    "+",
    "?",
    "|"
  ]), n18 = "", r16 = 0, i22 = false;
  for (; r16 < e11.length; ) {
    let a20 = e11[r16];
    if (i22) {
      n18 += a20, a20 === "]" && (i22 = false), r16++;
      continue;
    }
    if (a20 === "[") {
      i22 = true, n18 += a20, r16++;
      continue;
    }
    if (a20 === "\\" && r16 + 1 < e11.length) {
      let i23 = e11[r16 + 1];
      t17.has(i23) ? n18 += i23 : n18 += "\\" + i23, r16 += 2;
      continue;
    }
    if (t17.has(a20)) {
      n18 += "\\" + a20, r16++;
      continue;
    }
    n18 += a20, r16++;
  }
  return n18;
}
function i5(t17, i22) {
  let a20;
  switch (i22.syntax) {
    case "fixed":
      a20 = e5(t17);
      break;
    case "ere":
      a20 = n7(t17);
      break;
    case "bre":
      a20 = r6(n7(t17));
      break;
  }
  return new RegExp(a20 === "" ? "(?:)" : a20, i22.flags ?? "");
}

// mithic/packages/coreutils/dist/commands/grep.js
function u4(e11) {
  let t17 = "";
  for (let n18 = 0; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 === "*") t17 += "[^/]*";
    else if (r16 === "?") t17 += "[^/]";
    else if (r16 === "[") {
      let r17 = n18 + 1, i22 = "[";
      for (e11[r17] === "!" && (i22 += "^", r17++); r17 < e11.length && e11[r17] !== "]"; ) i22 += e11[r17], r17++;
      i22 += "]", t17 += i22, n18 = r17;
    } else ".+^${}()|\\".includes(r16) ? t17 += "\\" + r16 : t17 += r16;
  }
  return RegExp("^" + t17 + "$");
}
function d5(e11) {
  let t17 = e11.lastIndexOf("/");
  return t17 < 0 ? e11 : e11.slice(t17 + 1);
}
var f4 = "\x1B[m\x1B[K";
var p4 = "\x1B[01;31m\x1B[K";
var m4 = "\x1B[35m\x1B[K";
var h4 = "\x1B[32m\x1B[K";
var g3 = "\x1B[36m\x1B[K";
var _3 = p4;
var v2 = f4;
function y2(e11) {
  return m4 + e11 + f4;
}
function b(e11) {
  return h4 + e11 + f4;
}
function x(e11) {
  return g3 + e11 + f4;
}
async function S(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    dirfd: -100,
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return new TextDecoder().decode(i22);
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
async function C(e11, t17, n18, r16, i22) {
  let a20;
  try {
    a20 = await e11.syscall("fs/stat", {
      dirfd: -100,
      path: t17
    });
  } catch {
    return;
  }
  if (a20.type === "directory") {
    let a21;
    try {
      a21 = await e11.syscall("fs/readdir", {
        dirfd: -100,
        path: t17
      });
    } catch {
      return;
    }
    let o23 = a21.map((e12) => e12.name).sort(), s30 = t17.endsWith("/") ? t17.slice(0, -1) : t17;
    for (let t18 of o23) await C(e11, `${s30}/${t18}`, n18, r16, i22);
  } else if (a20.type === "file" || a20.type === void 0) {
    let e12 = d5(t17);
    if (r16.length > 0 && !r16.some((t18) => t18.test(e12)) || i22.some((t18) => t18.test(e12))) return;
    n18.push(t17);
  }
}
function w(e11) {
  let t17 = {
    ignoreCase: false,
    invert: false,
    lineNumber: false,
    count: false,
    listMatches: false,
    listNoMatches: false,
    onlyMatching: false,
    word: false,
    line: false,
    recursive: false,
    syntax: "bre",
    perl: false,
    after: 0,
    before: 0,
    color: false,
    colorAuto: false,
    quiet: false,
    maxCount: 0,
    withFilename: false,
    noFilename: false,
    byteOffset: false,
    nulData: false,
    include: [],
    exclude: [],
    patterns: [],
    patternFiles: [],
    files: []
  }, n18 = false, r16 = 0, i22 = (e12) => {
    let t18 = Number(e12);
    return Number.isFinite(t18) && t18 >= 0 ? Math.floor(t18) : 0;
  };
  for (; r16 < e11.length; ) {
    let a20 = e11[r16];
    if (a20 === "--") {
      for (r16++; r16 < e11.length; ) T(t17, e11[r16], () => n18, (e12) => {
        n18 = e12;
      }), r16++;
      break;
    }
    if (a20.startsWith("--")) {
      let o23 = a20.indexOf("="), s30 = o23 >= 0 ? a20.slice(2, o23) : a20.slice(2), c37 = o23 >= 0 ? a20.slice(o23 + 1) : void 0;
      switch (s30) {
        case "ignore-case":
          t17.ignoreCase = true;
          break;
        case "invert-match":
          t17.invert = true;
          break;
        case "line-number":
          t17.lineNumber = true;
          break;
        case "count":
          t17.count = true;
          break;
        case "files-with-matches":
          t17.listMatches = true;
          break;
        case "files-without-match":
          t17.listNoMatches = true;
          break;
        case "only-matching":
          t17.onlyMatching = true;
          break;
        case "word-regexp":
          t17.word = true;
          break;
        case "line-regexp":
          t17.line = true;
          break;
        case "recursive":
          t17.recursive = true;
          break;
        case "extended-regexp":
          t17.syntax = "ere";
          break;
        case "fixed-strings":
          t17.syntax = "fixed";
          break;
        case "perl-regexp":
          t17.perl = true;
          break;
        case "with-filename":
          t17.withFilename = true;
          break;
        case "no-filename":
          t17.noFilename = true;
          break;
        case "byte-offset":
          t17.byteOffset = true;
          break;
        case "null-data":
          t17.nulData = true;
          break;
        case "regexp":
          c37 === void 0 ? (t17.patterns.push(e11[++r16] ?? ""), n18 = true) : (t17.patterns.push(c37), n18 = true);
          break;
        case "file":
          c37 === void 0 ? t17.patternFiles.push(e11[++r16] ?? "") : t17.patternFiles.push(c37), n18 = true;
          break;
        case "after-context":
          t17.after = i22(c37 ?? e11[++r16]);
          break;
        case "before-context":
          t17.before = i22(c37 ?? e11[++r16]);
          break;
        case "context": {
          let n19 = i22(c37 ?? e11[++r16]);
          t17.after = n19, t17.before = n19;
          break;
        }
        case "color":
        case "colour":
          t17.color = c37 === "always", t17.colorAuto = c37 === void 0 || c37 === "auto";
          break;
        case "quiet":
        case "silent":
          t17.quiet = true;
          break;
        case "max-count":
          t17.maxCount = i22(c37 ?? e11[++r16]);
          break;
        case "include":
          t17.include.push(u4(c37 ?? e11[++r16] ?? ""));
          break;
        case "exclude":
          t17.exclude.push(u4(c37 ?? e11[++r16] ?? ""));
          break;
        default:
          break;
      }
      r16++;
      continue;
    }
    if (a20.startsWith("-") && a20.length > 1) {
      let o23 = a20.slice(1);
      for (let a21 = 0; a21 < o23.length; a21++) {
        let s30 = o23[a21];
        switch (s30) {
          case "i":
            t17.ignoreCase = true;
            break;
          case "v":
            t17.invert = true;
            break;
          case "n":
            t17.lineNumber = true;
            break;
          case "c":
            t17.count = true;
            break;
          case "l":
            t17.listMatches = true;
            break;
          case "L":
            t17.listNoMatches = true;
            break;
          case "o":
            t17.onlyMatching = true;
            break;
          case "w":
            t17.word = true;
            break;
          case "x":
            t17.line = true;
            break;
          case "r":
          case "R":
            t17.recursive = true;
            break;
          case "q":
            t17.quiet = true;
            break;
          case "E":
            t17.syntax = "ere";
            break;
          case "F":
            t17.syntax = "fixed";
            break;
          case "P":
            t17.perl = true;
            break;
          case "H":
            t17.withFilename = true;
            break;
          case "h":
            t17.noFilename = true;
            break;
          case "b":
            t17.byteOffset = true;
            break;
          case "z":
            t17.nulData = true;
            break;
          case "m": {
            let n19 = o23.slice(a21 + 1);
            t17.maxCount = n19.length > 0 ? i22(n19) : i22(e11[++r16]), a21 = o23.length;
            break;
          }
          case "e": {
            let i23 = o23.slice(a21 + 1);
            i23.length > 0 ? t17.patterns.push(i23) : t17.patterns.push(e11[++r16] ?? ""), n18 = true, a21 = o23.length;
            break;
          }
          case "f": {
            let i23 = o23.slice(a21 + 1);
            i23.length > 0 ? t17.patternFiles.push(i23) : t17.patternFiles.push(e11[++r16] ?? ""), n18 = true, a21 = o23.length;
            break;
          }
          case "A":
          case "B":
          case "C": {
            let n19 = o23.slice(a21 + 1), c37 = n19.length > 0 ? i22(n19) : i22(e11[++r16]);
            s30 === "A" ? t17.after = c37 : (s30 === "B" || (t17.after = c37), t17.before = c37), a21 = o23.length;
            break;
          }
          default:
            break;
        }
      }
      r16++;
      continue;
    }
    T(t17, a20, () => n18, (e12) => {
      n18 = e12;
    }), r16++;
  }
  return t17;
}
function T(e11, t17, n18, r16) {
  !n18() && e11.patterns.length === 0 && e11.patternFiles.length === 0 ? (e11.patterns.push(t17), r16(true)) : e11.files.push(t17);
}
function E(e11) {
  let t17 = "", n18 = 0, r16 = false;
  for (; n18 < e11.length; ) {
    let i22 = e11[n18];
    if (r16) {
      t17 += i22, i22 === "]" && (r16 = false), n18++;
      continue;
    }
    if (i22 === "[") {
      r16 = true, t17 += i22, n18++;
      continue;
    }
    if (i22 === "\\" && (e11[n18 + 1] === "<" || e11[n18 + 1] === ">")) {
      t17 += "\\b", n18 += 2;
      continue;
    }
    if (i22 === "\\" && n18 + 1 < e11.length) {
      t17 += i22 + e11[n18 + 1], n18 += 2;
      continue;
    }
    t17 += i22, n18++;
  }
  return t17;
}
function D(e11, t17) {
  if (t17) {
    let t18, n18 = e11;
    do
      t18 = n18, n18 = t18.replace(/(^|[(|])[*+?]/g, (e12, t19) => t19);
    while (n18 !== t18);
    return n18;
  }
  return e11.replace(/(^|[(|])(\*)/g, (e12, t18, n18) => t18 + "\\" + n18);
}
function O(e11) {
  let t17 = /^\(\?([a-zA-Z]*(?:-[a-zA-Z]+)?)\)/.exec(e11);
  if (!t17) return e11;
  let n18 = t17[1].replace(/x/g, "").replace(/-$/, ""), r16 = e11.slice(t17[0].length);
  return n18 === "" || n18 === "-" ? r16 : `(?${n18}:${r16})`;
}
function k(r16) {
  let i22 = r16.ignoreCase ? "i" : "", a20 = r16.patterns.map((i23) => {
    let a21;
    if (r16.perl) a21 = i23 === "" ? "(?:)" : O(i23);
    else if (r16.syntax === "fixed") a21 = e5(i23);
    else {
      let t17 = r16.syntax === "ere", o24 = n7(i23), s31 = D(E(t17 ? o24 : r6(o24)), t17);
      a21 = s31 === "" ? "(?:)" : s31;
    }
    return `(?:${a21})`;
  }), o23 = a20.length === 1 ? a20[0] : a20.join("|"), s30 = o23 === "" ? "(?:)" : o23;
  r16.line ? s30 = `^(?:${s30})$` : r16.word && (s30 = `(?<![A-Za-z0-9_])(?:${s30})(?![A-Za-z0-9_])`);
  let c37 = new RegExp(s30, i22), l38 = new RegExp(s30, i22 + "g");
  return {
    rawMatch: (e11) => (c37.lastIndex = 0, c37.test(e11)),
    spans: (e11) => {
      let t17 = [];
      l38.lastIndex = 0;
      let n18;
      for (; (n18 = l38.exec(e11)) !== null; ) t17.push({
        start: n18.index,
        end: n18.index + n18[0].length
      }), n18[0].length === 0 && l38.lastIndex++;
      return t17;
    }
  };
}
function A(e11, t17) {
  if (t17.length === 0) return e11;
  let n18 = "", r16 = 0;
  for (let i22 of t17) i22.end !== i22.start && (n18 += e11.slice(r16, i22.start) + _3 + e11.slice(i22.start, i22.end) + v2, r16 = i22.end);
  return n18 += e11.slice(r16), n18;
}
var j = new TextEncoder();
function M(e11) {
  return j.encode(e11).length;
}
function N(e11, t17, n18, r16, i22) {
  let a20 = "", o23 = e11.color ? x(i22) : i22;
  return t17 !== void 0 && (a20 += (e11.color ? y2(t17) : t17) + o23), e11.byteOffset && n18 !== void 0 && (a20 += (e11.color ? b(String(n18)) : String(n18)) + o23), e11.lineNumber && (a20 += (e11.color ? b(String(r16)) : String(r16)) + o23), a20;
}
function P(e11, t17, n18, r16, i22) {
  let a20 = [];
  for (let r17 = 0; r17 < e11.length; r17++) {
    let i23 = t17.rawMatch(e11[r17]);
    if ((n18.invert ? !i23 : i23) && a20.push(r17), n18.maxCount > 0 && a20.length >= n18.maxCount) break;
  }
  let o23 = a20.length > 0;
  if (n18.count) return {
    output: [r16 === void 0 ? `${a20.length}` : `${r16}:${a20.length}`],
    matched: o23,
    matchCount: a20.length
  };
  let s30 = (e12, a21, o24) => {
    let s31 = e12;
    return n18.color && o24 === ":" && !n18.invert && (s31 = A(e12, t17.spans(e12))), N(n18, r16, i22 ? i22[a21] : void 0, a21 + 1, o24) + s31;
  }, c37 = [];
  if (n18.onlyMatching && !n18.invert) {
    for (let o24 of a20) {
      let a21 = i22 ? i22[o24] : void 0;
      for (let i23 of t17.spans(e11[o24])) {
        if (i23.end === i23.start) continue;
        let t18 = e11[o24].slice(i23.start, i23.end);
        n18.color && (t18 = _3 + t18 + v2);
        let s31 = a21 === void 0 ? void 0 : a21 + M(e11[o24].slice(0, i23.start));
        c37.push(N(n18, r16, s31, o24 + 1, ":") + t18);
      }
    }
    return {
      output: c37,
      matched: o23,
      matchCount: a20.length
    };
  }
  if (n18.after === 0 && n18.before === 0) {
    for (let t18 of a20) c37.push(s30(e11[t18], t18, ":"));
    return {
      output: c37,
      matched: o23,
      matchCount: a20.length
    };
  }
  let l38 = -1, u37 = new Set(a20);
  for (let t18 of a20) {
    let r17 = Math.max(0, t18 - n18.before), i23 = Math.min(e11.length - 1, t18 + n18.after);
    l38 >= 0 && r17 > l38 + 1 && c37.push("--");
    let a21 = l38 >= 0 && r17 <= l38 + 1 ? l38 + 1 : r17;
    for (let t19 = a21; t19 <= i23; t19++) c37.push(s30(e11[t19], t19, u37.has(t19) ? ":" : "-"));
    i23 > l38 && (l38 = i23);
  }
  return {
    output: c37,
    matched: o23,
    matchCount: a20.length
  };
}
function F(e11) {
  if (e11 === "") return [];
  let t17 = e11.split("\n");
  return t17[t17.length - 1] === "" && t17.pop(), t17;
}
function I(e11) {
  if (e11 === "") return [];
  let t17 = e11.split("\0");
  return t17[t17.length - 1] === "" && t17.pop(), t17;
}
function L(e11) {
  let t17 = [], n18 = 0;
  for (let r16 of e11) t17.push(n18), n18 += M(r16) + 1;
  return t17;
}
function R(e11, t17, n18, r16, i22, a20, o23) {
  let s30 = n18.rawMatch(e11);
  if (!(r16.invert ? !s30 : s30)) return "";
  if (r16.onlyMatching && !r16.invert) {
    let s31 = "";
    for (let c38 of n18.spans(e11)) {
      if (c38.end === c38.start) continue;
      let n19 = e11.slice(c38.start, c38.end);
      r16.color && (n19 = _3 + n19 + v2);
      let l38 = a20 === void 0 ? void 0 : a20 + M(e11.slice(0, c38.start));
      s31 += N(r16, i22, l38, t17, ":") + n19 + o23;
    }
    return s31;
  }
  let c37 = e11;
  return r16.color && !r16.invert && (c37 = A(e11, n18.spans(e11))), N(r16, i22, a20, t17, ":") + c37 + o23;
}
var z = async (e11) => {
  let t17 = e11.args[0] ?? "grep", n18 = w(e11.args.slice(1));
  t17 === "egrep" && (n18.syntax = "ere"), t17 === "fgrep" && (n18.syntax = "fixed"), n18.colorAuto && (e11.isatty?.(1) ?? false) && (n18.color = true);
  let i22 = e11.stderr.getWriter(), u37 = e11.stdout.getWriter(), d36 = new TextEncoder();
  try {
    for (let r16 of n18.patternFiles) {
      let a20;
      try {
        a20 = await S(e11, r16);
      } catch {
        return await m2(i22, `${t17}: ${r16}: No such file or directory`), 2;
      }
      for (let e12 of F(a20)) n18.patterns.push(e12);
    }
    if (n18.patterns.length === 0) return await m2(i22, `Usage: ${t17} [OPTION]... PATTERN [FILE]...`), 2;
    let f32;
    try {
      f32 = k(n18);
    } catch (e12) {
      return await m2(i22, `${t17}: ${e12.message}`), 2;
    }
    n18.recursive && n18.files.length === 0 && n18.files.push(".");
    let p31 = n18.files;
    if (n18.recursive) {
      let t18 = [];
      for (let r16 of n18.files) await C(e11, r16, t18, n18.include, n18.exclude);
      p31 = t18;
    }
    let m24 = p31.length > 1, h24 = n18.withFilename || !n18.noFilename && (m24 || n18.recursive), g18 = n18.nulData ? I : F, _21 = n18.nulData ? "\0" : "\n", v17 = n18.count ? "\n" : _21, y18 = false, b17 = false;
    if (n18.listMatches || n18.listNoMatches) {
      let r16 = p31.length > 0 ? p31 : ["-"];
      for (let a20 of r16) {
        let r17;
        try {
          r17 = a20 === "-" ? await s5(e11.stdin) : await S(e11, a20);
        } catch {
          await m2(i22, `${t17}: ${a20}: No such file or directory`), b17 = true;
          continue;
        }
        let s30 = g18(r17).some((e12) => n18.invert ? !f32.rawMatch(e12) : f32.rawMatch(e12)), c37 = a20 === "-" ? "(standard input)" : a20;
        n18.listMatches && s30 && (await m2(u37, c37), y18 = true), n18.listNoMatches && !s30 && await m2(u37, c37), s30 && (y18 = true);
      }
      return b17 ? 2 : +!y18;
    }
    if (n18.quiet) {
      let t18 = (e12) => n18.invert ? !f32.rawMatch(e12) : f32.rawMatch(e12);
      if (p31.length === 0) {
        try {
          for await (let { line: n19 } of l3(e11.stdin)) if (t18(n19)) return await e11.stdin.cancel().catch(() => {
          }), 0;
        } catch (e12) {
          if (!u2(e12)) throw e12;
        }
        return 1;
      }
      for (let n19 of p31) {
        let r16;
        try {
          r16 = await S(e11, n19);
        } catch {
          b17 = true;
          continue;
        }
        if (g18(r16).some(t18)) return 0;
      }
      return b17 ? 2 : 1;
    }
    if (p31.length === 0) {
      let t18 = h24 ? "(standard input)" : void 0;
      if (!n18.count && n18.after === 0 && n18.before === 0 && !n18.byteOffset && !n18.nulData) {
        let i24 = new d3(u37), o23 = 0, c37 = false, l39 = 0;
        try {
          for await (let { line: r16 } of l3(e11.stdin)) {
            o23++;
            let a20 = f32.rawMatch(r16);
            if (!(n18.invert ? !a20 : a20)) continue;
            c37 = true, l39++;
            let s30 = R(r16, o23, f32, n18, t18, void 0, _21);
            if (s30 !== "" && await i24.push(s30), n18.maxCount > 0 && l39 >= n18.maxCount) {
              await e11.stdin.cancel().catch(() => {
              });
              break;
            }
          }
          await i24.flush();
        } catch (t19) {
          if (u2(t19)) return await e11.stdin.cancel().catch(() => {
          }), +!c37;
          throw t19;
        }
        return +!c37;
      }
      let i23 = g18(await s5(e11.stdin)), l38 = n18.byteOffset ? L(i23) : void 0, p32 = P(i23, f32, n18, t18, l38);
      for (let e12 of p32.output) await f2(u37, d36.encode(e12 + v17));
      return +!p32.matched;
    }
    for (let r16 of p31) {
      let a20;
      try {
        a20 = await S(e11, r16);
      } catch {
        await m2(i22, `${t17}: ${r16}: No such file or directory`), b17 = true;
        continue;
      }
      let o23 = h24 ? r16 : void 0, s30 = g18(a20), p32 = n18.byteOffset ? L(s30) : void 0, m25 = P(s30, f32, n18, o23, p32);
      for (let e12 of m25.output) await f2(u37, d36.encode(e12 + v17));
      m25.matched && (y18 = true);
    }
    return b17 ? 2 : +!y18;
  } finally {
    await u37.close().catch(() => {
    }), await i22.close().catch(() => {
    });
  }
};
var B = _2(z);

// mithic/packages/coreutils/dist/commands/sed.js
function a4(e11) {
  let t17 = {
    suppress: false,
    inPlace: false,
    syntax: "bre",
    nulData: false,
    expressions: [],
    files: []
  }, n18 = false, r16 = 0;
  for (; r16 < e11.length; ) {
    let i22 = e11[r16];
    if (i22 === "--") {
      for (r16++; r16 < e11.length; ) t17.files.push(e11[r16]), r16++;
      break;
    }
    if (i22.startsWith("--")) {
      let a20 = i22.indexOf("="), o23 = a20 >= 0 ? i22.slice(2, a20) : i22.slice(2), s30 = a20 >= 0 ? i22.slice(a20 + 1) : void 0;
      switch (o23) {
        case "in-place":
          t17.inPlace = true;
          break;
        case "quiet":
        case "silent":
          t17.suppress = true;
          break;
        case "regexp-extended":
          t17.syntax = "ere";
          break;
        case "null-data":
        case "zero-terminated":
          t17.nulData = true;
          break;
        case "expression":
          t17.expressions.push(s30 === void 0 ? e11[++r16] ?? "" : s30), n18 = true;
          break;
        default:
          break;
      }
      r16++;
      continue;
    }
    if (i22.startsWith("-") && i22.length > 1) {
      let a20 = i22.slice(1);
      for (let i23 = 0; i23 < a20.length; i23++) {
        let o23 = a20[i23];
        if (o23 === "i") t17.inPlace = true;
        else if (o23 === "n") t17.suppress = true;
        else if (o23 === "r" || o23 === "E") t17.syntax = "ere";
        else if (o23 === "z") t17.nulData = true;
        else if (o23 === "e") {
          let o24 = a20.slice(i23 + 1);
          t17.expressions.push(o24.length > 0 ? o24 : e11[++r16] ?? ""), n18 = true, i23 = a20.length;
        }
      }
      r16++;
      continue;
    }
    !n18 && t17.expressions.length === 0 ? (t17.expressions.push(i22), n18 = true) : t17.files.push(i22), r16++;
  }
  return t17;
}
function o4(e11) {
  let t17 = e11.source;
  if (!t17.includes("\\`") && !t17.includes("\\'")) return e11;
  let n18 = "", r16 = 0, i22 = false;
  for (; r16 < t17.length; ) {
    let e12 = t17[r16];
    if (i22) {
      n18 += e12, e12 === "]" && (i22 = false), r16++;
      continue;
    }
    if (e12 === "[") {
      i22 = true, n18 += e12, r16++;
      continue;
    }
    if (e12 === "\\" && t17[r16 + 1] === "`") {
      n18 += "(?<![\\s\\S])", r16 += 2;
      continue;
    }
    if (e12 === "\\" && t17[r16 + 1] === "'") {
      n18 += "(?![\\s\\S])", r16 += 2;
      continue;
    }
    if (e12 === "\\" && r16 + 1 < t17.length) {
      n18 += e12 + t17[r16 + 1], r16 += 2;
      continue;
    }
    n18 += e12, r16++;
  }
  return new RegExp(n18, e11.flags);
}
var s6 = class {
  #e;
  #t;
  constructor(e11, t17 = false) {
    this.#e = e11, this.#t = t17;
  }
  #n(e11) {
    return e11 && !this.#t ? "m" : "";
  }
  #r(t17, n18 = "") {
    return o4(i5(t17, {
      syntax: this.#e,
      flags: n18
    }));
  }
  parse(e11) {
    let t17 = [], n18 = [], r16 = 0, i22 = e11.length;
    for (; r16 < i22; ) {
      for (; r16 < i22 && (e11[r16] === ";" || e11[r16] === "\n" || e11[r16] === " " || e11[r16] === "	"); ) r16++;
      if (r16 >= i22) break;
      if (e11[r16] === "}") {
        let e12 = n18.pop();
        if (e12 === void 0) throw Error("unexpected `}'");
        let i23 = t17.length;
        t17.push({ type: "}" }), t17[e12].close = i23, r16++;
        continue;
      }
      let a20 = this.#o(e11, r16);
      a20.cmd.type === "{" && n18.push(t17.length), t17.push(a20.cmd), r16 = a20.next;
    }
    if (n18.length > 0) throw Error("unmatched `{'");
    return t17;
  }
  #i(e11, t17) {
    let n18 = e11[t17];
    if (n18 === "$") return {
      addr: { kind: "last" },
      next: t17 + 1
    };
    if (n18 >= "0" && n18 <= "9") {
      let n19 = t17;
      for (; n19 < e11.length && e11[n19] >= "0" && e11[n19] <= "9"; ) n19++;
      let r16 = Number(e11.slice(t17, n19));
      if (e11[n19] === "~") {
        let t18 = n19 + 1;
        for (; t18 < e11.length && e11[t18] >= "0" && e11[t18] <= "9"; ) t18++;
        return {
          addr: {
            kind: "step",
            first: r16,
            step: Number(e11.slice(n19 + 1, t18))
          },
          next: t18
        };
      }
      return {
        addr: {
          kind: "line",
          n: r16
        },
        next: n19
      };
    }
    if (n18 === "/" || n18 === "\\") {
      let r16 = "/", i22 = t17 + 1;
      n18 === "\\" && (r16 = e11[t17 + 1], i22 = t17 + 2);
      let a20 = "";
      for (; i22 < e11.length && e11[i22] !== r16; ) {
        if (e11[i22] === "\\" && i22 + 1 < e11.length) {
          if (e11[i22 + 1] === r16) {
            a20 += r16, i22 += 2;
            continue;
          }
          a20 += e11[i22] + e11[i22 + 1], i22 += 2;
          continue;
        }
        a20 += e11[i22], i22++;
      }
      if (e11[i22] !== r16) throw Error("unterminated address regex");
      i22++;
      let o23 = "";
      for (; e11[i22] === "I" || e11[i22] === "M"; ) o23 += e11[i22], i22++;
      let s30 = (/I/.test(o23) ? "i" : "") + this.#n(/M/.test(o23));
      return {
        addr: {
          kind: "regex",
          re: a20 === "" ? void 0 : this.#r(a20, s30)
        },
        next: i22
      };
    }
    return { next: t17 };
  }
  #a(e11, t17) {
    let n18 = t17, r16 = {}, i22 = this.#i(e11, n18);
    if (i22.addr && (r16.start = i22.addr, n18 = i22.next, e11[n18] === ",")) if (n18++, e11[n18] === "+" || e11[n18] === "~") {
      let t18 = e11[n18] === "+" ? "plus" : "multiple", i23 = n18 + 1;
      for (; i23 < e11.length && e11[i23] >= "0" && e11[i23] <= "9"; ) i23++;
      r16.end = {
        kind: t18,
        n: Number(e11.slice(n18 + 1, i23))
      }, n18 = i23;
    } else {
      let t18 = this.#i(e11, n18);
      if (!t18.addr) throw Error("expected second address");
      r16.end = t18.addr, n18 = t18.next;
    }
    for (; e11[n18] === " " || e11[n18] === "	"; ) n18++;
    if (e11[n18] === "!") for (r16.negate = true, n18++; e11[n18] === " " || e11[n18] === "	"; ) n18++;
    return {
      spec: r16,
      next: n18
    };
  }
  #o(e11, t17) {
    let n18 = this.#a(e11, t17), r16 = n18.spec, i22 = n18.next, a20 = e11[i22];
    if (a20 === void 0) throw Error("missing command");
    switch (i22++, a20) {
      case "{":
        return {
          cmd: {
            ...r16,
            type: "{",
            close: -1
          },
          next: i22
        };
      case "s":
        return this.#u(e11, i22, r16);
      case "y":
        return this.#d(e11, i22, r16);
      case "p":
        return {
          cmd: {
            ...r16,
            type: "p"
          },
          next: i22
        };
      case "P":
        return {
          cmd: {
            ...r16,
            type: "P"
          },
          next: i22
        };
      case "d":
        return {
          cmd: {
            ...r16,
            type: "d"
          },
          next: i22
        };
      case "D":
        return {
          cmd: {
            ...r16,
            type: "D"
          },
          next: i22
        };
      case "q":
      case "Q": {
        let t18 = i22;
        for (; t18 < e11.length && e11[t18] >= "0" && e11[t18] <= "9"; ) t18++;
        let n19 = t18 > i22 ? Number(e11.slice(i22, t18)) : 0;
        return {
          cmd: {
            ...r16,
            type: a20,
            code: n19
          },
          next: t18
        };
      }
      case "=":
        return {
          cmd: {
            ...r16,
            type: "="
          },
          next: i22
        };
      case "h":
        return {
          cmd: {
            ...r16,
            type: "h"
          },
          next: i22
        };
      case "H":
        return {
          cmd: {
            ...r16,
            type: "H"
          },
          next: i22
        };
      case "g":
        return {
          cmd: {
            ...r16,
            type: "g"
          },
          next: i22
        };
      case "G":
        return {
          cmd: {
            ...r16,
            type: "G"
          },
          next: i22
        };
      case "x":
        return {
          cmd: {
            ...r16,
            type: "x"
          },
          next: i22
        };
      case "n":
        return {
          cmd: {
            ...r16,
            type: "n"
          },
          next: i22
        };
      case "N":
        return {
          cmd: {
            ...r16,
            type: "N"
          },
          next: i22
        };
      case "b":
      case "t":
      case "T": {
        let t18 = this.#s(e11, i22);
        return {
          cmd: {
            ...r16,
            type: a20,
            label: t18.label
          },
          next: t18.next
        };
      }
      case ":": {
        let t18 = this.#s(e11, i22);
        if (t18.label === "") throw Error('":" lacks a label');
        return {
          cmd: {
            ...r16,
            type: ":",
            label: t18.label
          },
          next: t18.next
        };
      }
      case "a":
      case "i":
      case "c": {
        let t18 = this.#l(e11, i22);
        return {
          cmd: {
            ...r16,
            type: a20,
            text: t18.text
          },
          next: t18.next
        };
      }
      case "l": {
        for (; e11[i22] === " " || e11[i22] === "	"; ) i22++;
        let t18 = i22;
        for (; t18 < e11.length && e11[t18] >= "0" && e11[t18] <= "9"; ) t18++;
        let n19 = t18 > i22 ? Number(e11.slice(i22, t18)) : void 0;
        return {
          cmd: {
            ...r16,
            type: "l",
            width: n19
          },
          next: t18
        };
      }
      case "z":
        return {
          cmd: {
            ...r16,
            type: "z"
          },
          next: i22
        };
      case "F":
        return {
          cmd: {
            ...r16,
            type: "F"
          },
          next: i22
        };
      case "v":
        for (; i22 < e11.length && e11[i22] !== ";" && e11[i22] !== "\n" && e11[i22] !== "}"; ) i22++;
        return {
          cmd: {
            ...r16,
            type: "v"
          },
          next: i22
        };
      case "e":
        for (; i22 < e11.length && e11[i22] !== "\n"; ) i22++;
        return {
          cmd: {
            ...r16,
            type: "v"
          },
          next: i22
        };
      case "r":
      case "R":
      case "w":
      case "W": {
        let t18 = this.#c(e11, i22);
        return {
          cmd: {
            ...r16,
            type: a20,
            file: t18.file
          },
          next: t18.next
        };
      }
      default:
        throw Error(`unknown command: \`${a20}'`);
    }
  }
  #s(e11, t17) {
    for (; e11[t17] === " " || e11[t17] === "	"; ) t17++;
    let n18 = "";
    for (; t17 < e11.length && e11[t17] !== ";" && e11[t17] !== "\n" && e11[t17] !== "}"; ) n18 += e11[t17], t17++;
    return {
      label: n18.trim(),
      next: t17
    };
  }
  #c(e11, t17) {
    for (; e11[t17] === " " || e11[t17] === "	"; ) t17++;
    let n18 = "";
    for (; t17 < e11.length && e11[t17] !== "\n"; ) n18 += e11[t17], t17++;
    return {
      file: n18,
      next: t17
    };
  }
  #l(e11, t17) {
    if (e11[t17] === "\\") {
      if (t17++, t17 >= e11.length) return {
        text: void 0,
        next: t17
      };
      e11[t17] === "\n" && t17++;
    } else for (; e11[t17] === " " || e11[t17] === "	"; ) t17++;
    let n18 = "";
    for (; t17 < e11.length && e11[t17] !== "\n"; ) {
      if (e11[t17] === "\\" && t17 + 1 < e11.length) {
        let r16 = e11[t17 + 1];
        r16 === "n" ? n18 += "\n" : r16 === "t" ? n18 += "	" : n18 += r16, t17 += 2;
        continue;
      }
      n18 += e11[t17], t17++;
    }
    return {
      text: n18,
      next: t17
    };
  }
  #u(t17, n18, r16) {
    let i22 = t17[n18];
    if (i22 === void 0) throw Error("unterminated `s' command");
    n18++;
    let a20 = () => {
      let e11 = "";
      for (; n18 < t17.length && t17[n18] !== i22; ) {
        if (t17[n18] === "\\" && n18 + 1 < t17.length) {
          if (t17[n18 + 1] === i22) {
            e11 += i22, n18 += 2;
            continue;
          }
          e11 += t17[n18] + t17[n18 + 1], n18 += 2;
          continue;
        }
        e11 += t17[n18], n18++;
      }
      if (t17[n18] !== i22) throw Error("unterminated `s' command");
      return n18++, e11;
    }, s30 = a20(), c37 = a20(), l38 = "", u37;
    for (; n18 < t17.length && t17[n18] !== ";" && t17[n18] !== "\n" && t17[n18] !== "}"; ) {
      if (t17[n18] === "w") {
        for (n18++; t17[n18] === " " || t17[n18] === "	"; ) n18++;
        let e11 = "";
        for (; n18 < t17.length && t17[n18] !== "\n"; ) e11 += t17[n18], n18++;
        u37 = e11;
        break;
      }
      l38 += t17[n18], n18++;
    }
    let d36 = /g/.test(l38), f32 = /[iI]/.test(l38), p31 = /[mM]/.test(l38), m24 = /p/.test(l38), h24 = l38.match(/(\d+)/), g18 = h24 ? Number(h24[1]) : 0, _21 = "g" + (f32 ? "i" : "") + this.#n(p31), v17;
    s30 !== "" && (v17 = o4(i5(s30, {
      syntax: this.#e,
      flags: _21
    })));
    let y18 = this.#n(p31) === "m";
    return {
      cmd: {
        ...r16,
        type: "s",
        re: v17,
        ignoreCase: f32,
        multiline: y18,
        replacement: c37,
        global: d36,
        nth: g18,
        print: m24,
        writeFile: u37
      },
      next: n18
    };
  }
  #d(e11, t17, n18) {
    let r16 = e11[t17];
    if (r16 === void 0) throw Error("unterminated `y' command");
    t17++;
    let i22 = () => {
      let n19 = "";
      for (; t17 < e11.length && e11[t17] !== r16; ) {
        if (e11[t17] === "\\" && t17 + 1 < e11.length) {
          let i23 = e11[t17 + 1];
          i23 === r16 ? n19 += r16 : i23 === "n" ? n19 += "\n" : i23 === "t" ? n19 += "	" : i23 === "\\" ? n19 += "\\" : n19 += i23, t17 += 2;
          continue;
        }
        n19 += e11[t17], t17++;
      }
      if (e11[t17] !== r16) throw Error("unterminated `y' command");
      return t17++, n19;
    }, a20 = i22(), o23 = i22();
    if (a20.length !== o23.length) throw Error("`y' strings have different lengths");
    return {
      cmd: {
        ...n18,
        type: "y",
        from: a20,
        to: o23
      },
      next: t17
    };
  }
};
function c6(e11, t17) {
  let n18 = "", r16 = "", i22 = "", a20 = (e12) => {
    for (let t18 of e12) {
      if (r16 === "u") {
        i22 += t18.toUpperCase(), r16 = "";
        continue;
      }
      if (r16 === "l") {
        i22 += t18.toLowerCase(), r16 = "";
        continue;
      }
      n18 === "U" ? i22 += t18.toUpperCase() : n18 === "L" ? i22 += t18.toLowerCase() : i22 += t18;
    }
  }, o23 = 0;
  for (; o23 < e11.length; ) {
    let i23 = e11[o23];
    if (i23 === "&") {
      a20(t17[0]), o23++;
      continue;
    }
    if (i23 === "\\" && o23 + 1 < e11.length) {
      let i24 = e11[o23 + 1];
      if (i24 >= "0" && i24 <= "9") {
        a20(t17[Number(i24)] ?? ""), o23 += 2;
        continue;
      }
      if (i24 === "n") {
        a20("\n"), o23 += 2;
        continue;
      }
      if (i24 === "t") {
        a20("	"), o23 += 2;
        continue;
      }
      if (i24 === "&") {
        a20("&"), o23 += 2;
        continue;
      }
      if (i24 === "\\") {
        a20("\\"), o23 += 2;
        continue;
      }
      if (i24 === "U") {
        n18 = "U", r16 = "", o23 += 2;
        continue;
      }
      if (i24 === "L") {
        n18 = "L", r16 = "", o23 += 2;
        continue;
      }
      if (i24 === "E") {
        n18 = "", r16 = "", o23 += 2;
        continue;
      }
      if (i24 === "u") {
        r16 = "u", o23 += 2;
        continue;
      }
      if (i24 === "l") {
        r16 = "l", o23 += 2;
        continue;
      }
      a20(i24), o23 += 2;
      continue;
    }
    a20(i23), o23++;
  }
  return i22;
}
function l5(e11, t17, n18) {
  let r16 = m5(t17.re, n18), i22;
  if (t17.re) i22 = r16;
  else {
    let e12 = r16.flags.includes("g") ? r16.flags : r16.flags + "g";
    t17.ignoreCase && !e12.includes("i") && (e12 += "i"), t17.multiline && !e12.includes("m") && (e12 += "m"), i22 = new RegExp(r16.source, e12);
  }
  i22.lastIndex = 0;
  let a20 = "", o23 = 0, s30 = 0, l38 = false, u37 = t17.nth > 0 ? t17.nth : 1, d36 = -1, f32;
  for (; (f32 = i22.exec(e11)) !== null; ) {
    let n19 = f32.index, r17 = f32.index + f32[0].length;
    if (f32[0].length === 0 && n19 === d36) {
      if (i22.lastIndex++, i22.lastIndex > e11.length) break;
      continue;
    }
    if (s30++, s30 >= u37 && (t17.global || s30 === u37) && (a20 += e11.slice(o23, n19) + c6(t17.replacement, f32), o23 = r17, l38 = true, d36 = r17, !t17.global)) break;
    f32[0].length === 0 && i22.lastIndex++;
  }
  return a20 += e11.slice(o23), {
    result: a20,
    changed: l38
  };
}
function u5(e11, t17, n18) {
  let r16 = "";
  for (let i22 of e11) {
    let e12 = t17.indexOf(i22);
    r16 += e12 >= 0 ? n18[e12] : i22;
  }
  return r16;
}
function d6(e11, t17, n18, r16, i22) {
  switch (e11.kind) {
    case "line":
      return t17 === e11.n;
    case "last":
      return t17 === r16;
    case "regex":
      return m5(e11.re, i22).test(n18);
    case "step":
      return e11.step <= 0 ? t17 === e11.first : t17 >= e11.first && (t17 - e11.first) % e11.step === 0;
  }
}
function f5(e11, t17, n18, r16, i22, a20) {
  let o23;
  return o23 = e11.start ? e11.end ? p5(e11, t17, n18, r16, i22, a20) : d6(e11.start, t17, n18, r16, a20) : true, e11.negate ? !o23 : o23;
}
function p5(e11, t17, n18, r16, i22, a20) {
  let o23 = e11.end, s30 = e11.start, c37 = s30.kind === "line" && s30.n === 0;
  if (!i22.active) {
    if (c37 && !i22.started) return i22.started = true, i22.active = true, i22.endLine = -1, o23.kind === "line" || o23.kind === "plus" || o23.kind === "multiple" ? o23.kind === "line" && (o23.n <= t17 ? i22.active = false : i22.endLine = o23.n) : d6(o23, t17, n18, r16, a20) && (i22.active = false), true;
    if (!d6(s30, t17, n18, r16, a20)) return false;
    if (i22.active = true, o23.kind === "line") o23.n <= t17 ? i22.active = false : i22.endLine = o23.n;
    else if (o23.kind === "plus") o23.n <= 0 ? i22.active = false : i22.endLine = t17 + o23.n;
    else if (o23.kind === "multiple") if (o23.n <= 0) i22.active = false;
    else {
      let e12 = t17 - t17 % o23.n + o23.n;
      e12 <= t17 && (e12 += o23.n), i22.endLine = e12;
    }
    else i22.endLine = -1;
    return true;
  }
  return o23.kind === "line" || o23.kind === "plus" || o23.kind === "multiple" ? i22.endLine >= 0 && t17 >= i22.endLine && (i22.active = false) : d6(o23, t17, n18, r16, a20) && (i22.active = false), true;
}
function m5(e11, t17) {
  let n18 = e11 ?? t17.lastRegex;
  if (n18 === void 0) throw Error("no previous regular expression");
  return t17.lastRegex = n18, n18;
}
function h5(e11, t17) {
  let n18 = new TextEncoder().encode(e11), r16 = {
    92: "\\\\",
    7: "\\a",
    8: "\\b",
    12: "\\f",
    10: "\\n",
    13: "\\r",
    9: "\\t",
    11: "\\v"
  }, i22 = [];
  for (let e12 of n18) r16[e12] === void 0 ? e12 >= 32 && e12 < 127 ? i22.push(String.fromCharCode(e12)) : i22.push("\\" + e12.toString(8).padStart(3, "0")) : i22.push(r16[e12]);
  if (t17 <= 1) return i22.join("") + "$";
  let a20 = "", o23 = 0;
  for (let e12 of i22) o23 + e12.length > t17 - 1 && (a20 += "\\\n", o23 = 0), a20 += e12, o23 += e12.length;
  return a20 + "$";
}
function g4(e11, t17, n18, r16) {
  let i22 = r16.sep, a20 = e11.endsWith(i22), o23 = e11 === "" ? [] : (a20 ? e11.slice(0, -1) : e11).split(i22), s30 = o23.length, c37 = t17.map(() => ({
    active: false,
    endLine: -1
  })), d36 = /* @__PURE__ */ new Map();
  for (let e12 = 0; e12 < t17.length; e12++) {
    let n19 = t17[e12];
    n19.type === ":" && d36.set(n19.label, e12);
  }
  let p31 = {
    hold: "",
    substMade: false
  }, m24 = [], g18 = false, _21 = 0, v17 = (e12, t18) => {
    t18 && !a20 ? m24.push(e12) : m24.push(e12 + i22);
  }, y18 = (e12) => {
    m24.push(e12 + i22);
  }, b17 = (e12) => {
    m24.push(e12 + "\n");
  }, x13 = 0, S11 = () => x13 < o23.length ? o23[x13++] : void 0, C12 = "", w9 = 0, T7 = null;
  for (; ; ) {
    if (T7 !== null) C12 = T7, T7 = null;
    else {
      let e13 = S11();
      if (e13 === void 0) break;
      C12 = e13, w9 = x13, p31.substMade = false;
    }
    let e12 = () => x13 >= o23.length && T7 === null, i23 = [], a21 = () => {
      for (let e13 of i23) e13.raw ? m24.push(e13.s) : b17(e13.s);
      i23.length = 0;
    }, E6 = false, D6 = 0, O6 = false;
    for (; D6 < t17.length; ) {
      let o24 = t17[D6];
      if (o24.type === "}") {
        D6++;
        continue;
      }
      if (o24.type === ":") {
        D6++;
        continue;
      }
      let m25 = f5(o24, w9, C12, s30, c37[D6], p31);
      if (o24.type === "{") {
        m25 ? D6++ : D6 = o24.close + 1;
        continue;
      }
      if (!m25) {
        D6++;
        continue;
      }
      switch (o24.type) {
        case "s": {
          let t18 = l5(C12, o24, p31);
          C12 = t18.result, t18.changed && (p31.substMade = true, o24.print && v17(C12, e12()), o24.writeFile !== void 0 && r16.writeFile(o24.writeFile, C12 + "\n"));
          break;
        }
        case "p":
          v17(C12, e12());
          break;
        case "P": {
          let t18 = C12.indexOf("\n");
          t18 >= 0 ? y18(C12.slice(0, t18)) : v17(C12, e12());
          break;
        }
        case "d":
          E6 = true;
          break;
        case "D": {
          let e13 = C12.indexOf("\n");
          if (e13 < 0) {
            E6 = true;
            break;
          }
          T7 = C12.slice(e13 + 1), O6 = true, E6 = true;
          break;
        }
        case "q":
          g18 = true, _21 = o24.code;
          break;
        case "Q":
          g18 = true, _21 = o24.code, E6 = true;
          break;
        case "=":
          y18(String(w9));
          break;
        case "y":
          C12 = u5(C12, o24.from, o24.to);
          break;
        case "a":
          o24.text !== void 0 && i23.push({
            raw: false,
            s: o24.text
          });
          break;
        case "i":
          o24.text !== void 0 && b17(o24.text);
          break;
        case "c":
          E6 = true, (o24.end === void 0 || !c37[D6].active) && o24.text !== void 0 && b17(o24.text), D6 = t17.length;
          continue;
        case "l":
          y18(h5(C12, o24.width ?? 70));
          break;
        case "z":
          C12 = "";
          break;
        case "F":
          y18(r16.filename);
          break;
        case "v":
          break;
        case "r": {
          let e13 = r16.fileCache.get(o24.file);
          e13 !== void 0 && e13 !== "" && i23.push({
            raw: true,
            s: e13
          });
          break;
        }
        case "R": {
          let e13 = r16.fileCache.get(o24.file);
          if (e13 !== void 0 && e13 !== "") {
            let t18 = e13.endsWith("\n") ? e13.slice(0, -1).split("\n") : e13.split("\n"), n19 = r16.rCursor.get(D6) ?? 0;
            n19 < t18.length && (i23.push({
              raw: false,
              s: t18[n19]
            }), r16.rCursor.set(D6, n19 + 1));
          }
          break;
        }
        case "w":
          r16.writeFile(o24.file, C12 + "\n");
          break;
        case "W": {
          let e13 = C12.indexOf("\n");
          r16.writeFile(o24.file, (e13 >= 0 ? C12.slice(0, e13) : C12) + "\n");
          break;
        }
        case "h":
          p31.hold = C12;
          break;
        case "H":
          p31.hold = p31.hold + "\n" + C12;
          break;
        case "g":
          C12 = p31.hold;
          break;
        case "G":
          C12 = C12 + "\n" + p31.hold;
          break;
        case "x": {
          let e13 = C12;
          C12 = p31.hold, p31.hold = e13;
          break;
        }
        case "n": {
          n18 || v17(C12, e12()), a21();
          let t18 = S11();
          if (t18 === void 0) {
            E6 = true, g18 = true;
            break;
          }
          C12 = t18, w9 = x13;
          break;
        }
        case "N": {
          let e13 = S11();
          if (e13 === void 0) break;
          C12 = C12 + "\n" + e13, w9 = x13;
          break;
        }
        case "b": {
          if (o24.label === "") {
            D6 = t17.length;
            continue;
          }
          let e13 = d36.get(o24.label);
          if (e13 === void 0) throw Error(`can't find label for jump to \`${o24.label}'`);
          D6 = e13;
          continue;
        }
        case "t":
          if (p31.substMade) {
            if (p31.substMade = false, o24.label === "") {
              D6 = t17.length;
              continue;
            }
            let e13 = d36.get(o24.label);
            if (e13 === void 0) throw Error(`can't find label for jump to \`${o24.label}'`);
            D6 = e13;
            continue;
          }
          break;
        case "T":
          if (!p31.substMade) {
            if (o24.label === "") {
              D6 = t17.length;
              continue;
            }
            let e13 = d36.get(o24.label);
            if (e13 === void 0) throw Error(`can't find label for jump to \`${o24.label}'`);
            D6 = e13;
            continue;
          }
          p31.substMade = false;
          break;
      }
      if (O6 || E6 && o24.type === "d" || g18) break;
      D6++;
    }
    if (O6) {
      a21();
      continue;
    }
    if (!E6 && !n18 && v17(C12, e12()), a21(), g18) break;
  }
  return {
    output: m24.join(""),
    quit: g18,
    code: _21
  };
}
async function _4(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    dirfd: -100,
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return new TextDecoder().decode(i22);
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
async function v3(e11, t17, n18) {
  let { fd: r16 } = await e11.syscall("fs/open", {
    dirfd: -100,
    path: t17,
    oflags: {
      write: true,
      create: true,
      truncate: true
    }
  });
  try {
    let t18 = new TextEncoder().encode(n18), i22 = 0;
    for (; i22 < t18.byteLength; ) {
      let n19 = await e11.syscall("fs/write", {
        fd: r16,
        data: t18.subarray(i22)
      });
      if (!n19 || n19.written <= 0) break;
      i22 += n19.written;
    }
  } finally {
    await e11.syscall("fs/close", { fd: r16 }).catch(() => {
    });
  }
}
var y3 = async (e11) => {
  let t17 = e11.args[0] ?? "sed", o23 = a4(e11.args.slice(1)), c37 = e11.stdout.getWriter(), l38 = e11.stderr.getWriter(), u37 = new TextEncoder();
  try {
    if (o23.expressions.length === 0) return await m2(l38, `${t17}: no script specified`), 1;
    let a20 = o23.expressions.join("\n"), d36;
    try {
      d36 = new s6(o23.syntax, o23.nulData).parse(a20);
    } catch (e12) {
      return await m2(l38, `${t17}: -e expression: ${e12.message}`), 1;
    }
    let f32 = o23.nulData ? "\0" : "\n", p31 = /* @__PURE__ */ new Map();
    for (let t18 of d36) if ((t18.type === "r" || t18.type === "R") && !p31.has(t18.file)) try {
      p31.set(t18.file, await _4(e11, t18.file));
    } catch {
      p31.set(t18.file, void 0);
    }
    let m24 = /* @__PURE__ */ new Map(), h24 = (e12, t18) => {
      m24.set(e12, (m24.get(e12) ?? "") + t18);
    }, y18 = async () => {
      for (let [n18, r16] of m24) try {
        await v3(e11, n18, r16);
      } catch (e12) {
        await m2(l38, `${t17}: couldn't write ${n18}: ${e12.message}`);
      }
    };
    if (o23.files.length === 0) {
      let a21 = await s5(e11.stdin), s30;
      try {
        s30 = g4(a21, d36, o23.suppress, {
          sep: f32,
          filename: "-",
          fileCache: p31,
          rCursor: /* @__PURE__ */ new Map(),
          writeFile: h24
        });
      } catch (e12) {
        return await m2(l38, `${t17}: ${e12.message}`), 1;
      }
      return await f2(c37, u37.encode(s30.output)), await y18(), s30.code;
    }
    let b17 = 0, x13 = /* @__PURE__ */ new Map();
    for (let n18 of o23.files) {
      let a21;
      try {
        a21 = await _4(e11, n18);
      } catch {
        await m2(l38, `${t17}: can't read ${n18}: No such file or directory`), b17 = 2;
        continue;
      }
      let s30;
      try {
        s30 = g4(a21, d36, o23.suppress, {
          sep: f32,
          filename: n18,
          fileCache: p31,
          rCursor: x13,
          writeFile: h24
        });
      } catch (e12) {
        return await m2(l38, `${t17}: ${e12.message}`), 1;
      }
      if (o23.inPlace) try {
        await v3(e11, n18, s30.output);
      } catch (e12) {
        await m2(l38, `${t17}: couldn't write ${n18}: ${e12.message}`), b17 = 2;
      }
      else await f2(c37, u37.encode(s30.output));
      if (s30.quit) {
        s30.code !== 0 && (b17 = s30.code);
        break;
      }
    }
    return await y18(), b17;
  } finally {
    await c37.close().catch(() => {
    }), await l38.close().catch(() => {
    });
  }
};
var b2 = _2(y3);

// mithic/packages/coreutils/dist/commands/awk/value.js
var e6 = /^[ \t]*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[ \t]*$/;
var t9 = /^[ \t]*([-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|[-+]?0[xX][0-9a-fA-F]+)/;
function n8(e11) {
  if (typeof e11 == "number") return e11;
  let n18 = t9.exec(e11);
  if (!n18) return 0;
  let r16 = Number(n18[1]);
  return Number.isNaN(r16) ? 0 : r16;
}
function r7(t17) {
  return typeof t17 == "number" ? true : t17 !== "" && e6.test(t17);
}
function i6(e11, t17 = "%.6g") {
  return Number.isFinite(e11) ? Number.isInteger(e11) ? Math.abs(e11) < 1e21 ? e11.toFixed(0) : String(e11) : s7(t17, [e11]) : e11 > 0 ? "inf" : e11 < 0 ? "-inf" : "nan";
}
function a5(e11, t17 = "%.6g") {
  return typeof e11 == "string" ? e11 : i6(e11, t17);
}
function o5(e11) {
  return typeof e11 == "number" ? e11 !== 0 : r7(e11) ? n8(e11) !== 0 : e11 !== "";
}
function s7(e11, t17) {
  let r16 = "", i22 = 0, a20 = () => i22 < t17.length ? t17[i22++] : "", o23 = 0;
  for (; o23 < e11.length; ) {
    let t18 = e11[o23];
    if (t18 !== "%") {
      r16 += t18, o23++;
      continue;
    }
    let i23 = o23;
    if (o23++, e11[o23] === "%") {
      r16 += "%", o23++;
      continue;
    }
    let s30 = "";
    for (; "-+ #0".includes(e11[o23]); ) s30 += e11[o23], o23++;
    let l38 = "";
    if (e11[o23] === "*") l38 = String(Math.trunc(n8(a20()))), o23++;
    else for (; e11[o23] >= "0" && e11[o23] <= "9"; ) l38 += e11[o23], o23++;
    let u37 = "", d36 = false;
    if (e11[o23] === ".") if (d36 = true, o23++, e11[o23] === "*") u37 = String(Math.trunc(n8(a20()))), o23++;
    else for (u37 = ""; e11[o23] >= "0" && e11[o23] <= "9"; ) u37 += e11[o23], o23++;
    let f32 = e11[o23];
    if (f32 === void 0) {
      r16 += e11.slice(i23);
      break;
    }
    o23++, r16 += c7(f32, s30, l38 === "" ? void 0 : Number(l38), d36 ? u37 === "" ? 0 : Number(u37) : void 0, a20);
  }
  return r16;
}
function c7(e11, t17, r16, a20, o23) {
  let s30 = t17.includes("-"), c37 = t17.includes("0") && !s30, d36 = t17.includes("+"), f32 = t17.includes(" "), p31 = t17.includes("#"), m24 = (e12, t18 = 0) => {
    if (r16 === void 0 || e12.length + t18 >= r16) return e12;
    let n18 = r16 - e12.length - t18;
    return s30 ? e12 + " ".repeat(n18) : c37 ? "0".repeat(n18) + e12 : " ".repeat(n18) + e12;
  }, h24 = (e12) => e12 ? "-" : d36 ? "+" : f32 ? " " : "", g18 = (e12, t18) => r16 !== void 0 && c37 && !s30 && e12.length + t18.length < r16 ? e12 + "0".repeat(r16 - e12.length - t18.length) + t18 : m24(e12 + t18, 0);
  switch (e11) {
    case "d":
    case "i": {
      let e12 = Math.trunc(n8(o23())), t18 = e12 < 0 || Object.is(e12, -0), r17 = Math.abs(e12).toFixed(0);
      return a20 !== void 0 && (r17 = r17.padStart(a20, "0")), a20 === 0 && Math.abs(e12) === 0 && (r17 = ""), g18(h24(t18), r17);
    }
    case "u": {
      let e12 = Math.trunc(n8(o23()));
      e12 < 0 && (e12 >>>= 0);
      let t18 = String(e12);
      return a20 !== void 0 && (t18 = t18.padStart(a20, "0")), g18("", t18);
    }
    case "o": {
      let e12 = Math.trunc(n8(o23()));
      e12 < 0 && (e12 >>>= 0);
      let t18 = e12.toString(8);
      return p31 && t18[0] !== "0" && (t18 = "0" + t18), a20 !== void 0 && (t18 = t18.padStart(a20, "0")), g18("", t18);
    }
    case "x":
    case "X": {
      let t18 = Math.trunc(n8(o23()));
      t18 < 0 && (t18 >>>= 0);
      let r17 = t18.toString(16);
      return e11 === "X" && (r17 = r17.toUpperCase()), a20 !== void 0 && (r17 = r17.padStart(a20, "0")), g18(p31 && t18 !== 0 ? e11 === "X" ? "0X" : "0x" : "", r17);
    }
    case "c": {
      let e12 = o23(), t18;
      return t18 = typeof e12 == "number" ? e12 === 0 ? "" : String.fromCharCode(Math.trunc(e12) & 255) : e12.length > 0 ? e12[0] : "", m24(t18);
    }
    case "s": {
      let e12 = o23(), t18 = typeof e12 == "number" ? i6(e12) : e12;
      return a20 !== void 0 && (t18 = t18.slice(0, a20)), m24(t18);
    }
    case "e":
    case "E": {
      let t18 = n8(o23()), r17 = a20 ?? 6, i22 = Math.abs(t18).toExponential(r17);
      return e11 === "E" && (i22 = i22.toUpperCase()), i22 = l6(i22, e11 === "E" ? "E" : "e"), g18(h24(t18 < 0), i22);
    }
    case "f":
    case "F": {
      let e12 = n8(o23()), t18 = a20 ?? 6, r17 = Math.abs(e12).toFixed(t18);
      return g18(h24(e12 < 0), r17);
    }
    case "g":
    case "G": {
      let t18 = n8(o23()), r17 = u6(Math.abs(t18), a20 ?? 6, e11 === "G", p31);
      return g18(h24(t18 < 0), r17);
    }
    default:
      return "%" + t17 + (r16 ?? "") + (a20 === void 0 ? "" : "." + a20) + e11;
  }
}
function l6(e11, t17) {
  return e11.replace(/[eE]([+-])(\d+)/, (e12, n18, r16) => t17 + n18 + (r16.length < 2 ? r16.padStart(2, "0") : r16));
}
function u6(e11, t17, n18, r16) {
  let i22 = t17 === 0 ? 1 : t17;
  if (e11 === 0) return "0";
  let a20 = Math.floor(Math.log10(e11)), o23;
  return a20 < -4 || a20 >= i22 ? (o23 = e11.toExponential(i22 - 1), r16 || (o23 = o23.replace(/\.?0+e/, "e")), o23 = l6(o23, n18 ? "E" : "e")) : (o23 = e11.toFixed(Math.max(0, i22 - 1 - a20)), !r16 && o23.includes(".") && (o23 = o23.replace(/\.?0+$/, ""))), n18 ? o23.toUpperCase() : o23;
}

// mithic/packages/coreutils/dist/commands/awk/interp.js
var o6 = /* @__PURE__ */ Symbol("break");
var s8 = /* @__PURE__ */ Symbol("continue");
var c8 = /* @__PURE__ */ Symbol("next");
var l7 = /* @__PURE__ */ Symbol("nextfile");
var u7 = class {
  code;
  constructor(e11) {
    this.code = e11;
  }
};
var d7 = class {
  value;
  constructor(e11) {
    this.value = e11;
  }
};
function f6(e11) {
  return e11 instanceof Map;
}
var p6 = class p7 {
  program;
  io;
  globals = /* @__PURE__ */ new Map();
  locals = [];
  fields = [""];
  record = "";
  nf = 0;
  exitCode = 0;
  rangeActive = [];
  rng;
  rngSeed = 0;
  openWrites = /* @__PURE__ */ new Set();
  constructor(e11, t17, n18 = {}) {
    this.program = e11, this.io = t17, this.globals.set("FS", n18.fs ?? " "), this.globals.set("OFS", " "), this.globals.set("ORS", "\n"), this.globals.set("RS", "\n"), this.globals.set("SUBSEP", ""), this.globals.set("NR", 0), this.globals.set("NF", 0), this.globals.set("FNR", 0), this.globals.set("RSTART", 0), this.globals.set("RLENGTH", -1), this.globals.set("CONVFMT", "%.6g"), this.globals.set("OFMT", "%.6g"), this.globals.set("FILENAME", ""), this.rng = h6(this.rngSeed);
    let r16 = n18.argv ?? [], i22 = /* @__PURE__ */ new Map();
    i22.set("0", "awk");
    for (let e12 = 0; e12 < r16.length; e12++) i22.set(String(e12 + 1), r16[e12]);
    this.globals.set("ARGV", i22), this.globals.set("ARGC", r16.length + 1);
    for (let [e12, t18] of Object.entries(n18.assigns ?? {})) this.globals.set(e12, v4(t18));
    this.program.rules.forEach((e12, t18) => {
      e12.pattern.type === "range" && (this.rangeActive[t18] = false);
    });
  }
  static programNeedsInput(e11) {
    return e11.rules.some((e12) => e12.pattern.type !== "begin");
  }
  run(e11) {
    try {
      this.runBegins(), p7.programNeedsInput(this.program) && this.runMain(e11), this.runEnds();
    } catch (e12) {
      if (e12 instanceof u7) {
        this.exitCode = e12.code;
        try {
          this.runEnds();
        } catch (e13) {
          if (e13 instanceof u7) this.exitCode = e13.code;
          else throw e13;
        }
      } else throw e12;
    }
    return this.exitCode;
  }
  endsRan = false;
  runBegins() {
    for (let e11 of this.program.rules) e11.pattern.type === "begin" && this.execStmts(e11.action ?? []);
  }
  runEnds() {
    if (!this.endsRan) {
      this.endsRan = true;
      for (let e11 of this.program.rules) e11.pattern.type === "end" && this.execStmts(e11.action ?? []);
    }
  }
  mainInputs = [];
  inputIndex = 0;
  lineQueue = [];
  lineQueuePos = 0;
  runMain(e11) {
    for (this.mainInputs = e11.length > 0 ? e11 : [], this.inputIndex = 0; this.inputIndex < this.mainInputs.length; this.inputIndex++) {
      let e12 = this.mainInputs[this.inputIndex];
      this.globals.set("FILENAME", e12.name), this.globals.set("FNR", 0), this.lineQueue = g5(e12.text, this.str("RS")), this.lineQueuePos = 0;
      let t17 = false;
      for (; !t17 && this.lineQueuePos < this.lineQueue.length; ) {
        let e13 = this.lineQueue[this.lineQueuePos++];
        this.globals.set("NR", this.num("NR") + 1), this.globals.set("FNR", this.num("FNR") + 1), this.setRecord(e13);
        try {
          this.runRules();
        } catch (e14) {
          if (e14 === c8) continue;
          if (e14 === l7) {
            t17 = true;
            continue;
          }
          throw e14;
        }
      }
    }
  }
  runRules() {
    this.program.rules.forEach((e11, t17) => {
      e11.pattern.type === "begin" || e11.pattern.type === "end" || this.matches(e11, t17) && (e11.action === void 0 ? this.io.write(this.fields[0] + this.str("ORS")) : this.execStmts(e11.action));
    });
  }
  matches(e11, t17) {
    let n18 = e11.pattern;
    switch (n18.type) {
      case "always":
        return true;
      case "expr":
        return this.matchExprPattern(n18.expr);
      case "range":
        return this.rangeActive[t17] ? (this.matchExprPattern(n18.end) && (this.rangeActive[t17] = false), true) : this.matchExprPattern(n18.start) ? (this.rangeActive[t17] = true, this.matchExprPattern(n18.end) && (this.rangeActive[t17] = false), true) : false;
      default:
        return false;
    }
  }
  matchExprPattern(e11) {
    return e11.type === "regex" ? this.compileRegex(e11.source).test(this.fields[0]) : o5(this.eval(e11));
  }
  setRecord(e11) {
    this.record = e11, this.fields = [e11], this.splitFields();
  }
  splitFields() {
    let e11 = this.str("FS"), t17 = this.record, n18;
    if (e11 === " ") {
      let e12 = t17.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "");
      n18 = e12 === "" ? [] : e12.split(/[ \t\n]+/);
    } else n18 = e11 === "	" ? t17 === "" ? [] : t17.split("	") : e11.length === 1 ? t17 === "" ? [] : t17.split(e11 === "]" || "\\^$.|?*+(){}[".includes(e11) ? new RegExp(y4(e11)) : e11) : t17 === "" ? [] : t17.split(this.compileRegex(e11));
    this.fields = [t17, ...n18], this.nf = n18.length, this.globals.set("NF", this.nf);
  }
  rebuildRecord() {
    let e11 = this.str("OFS");
    this.fields[0] = this.fields.slice(1, this.nf + 1).map((e12) => e12 ?? "").join(e11), this.record = this.fields[0];
  }
  getField(e11) {
    if (e11 === 0) return this.fields[0];
    if (e11 < 0) throw Error("awk: field index negative");
    let t17 = this.fields[e11];
    return t17 === void 0 ? "" : t17;
  }
  setField(e11, t17) {
    let n18 = this.valToStr(t17);
    if (e11 === 0) {
      this.setRecord(n18);
      return;
    }
    if (e11 < 0) throw Error("awk: field index negative");
    if (e11 > this.nf) {
      for (let t18 = this.nf + 1; t18 < e11; t18++) this.fields[t18] === void 0 && (this.fields[t18] = "");
      this.nf = e11, this.globals.set("NF", this.nf);
    }
    this.fields[e11] = n18, this.rebuildRecord();
  }
  setNF(e11) {
    if (e11 = Math.max(0, Math.trunc(e11)), e11 < this.nf) this.fields.length = e11 + 1;
    else for (let t17 = this.nf + 1; t17 <= e11; t17++) this.fields[t17] === void 0 && (this.fields[t17] = "");
    this.nf = e11, this.globals.set("NF", e11), this.rebuildRecord();
  }
  scopeFor(e11) {
    let t17 = this.locals[this.locals.length - 1];
    return t17 && t17.has(e11) ? t17 : this.globals;
  }
  getVar(e11) {
    let t17 = this.scopeFor(e11).get(e11);
    if (f6(t17)) {
      if (t17.size === 0) return "";
      throw Error(`awk: can't read array ${e11} as scalar`);
    }
    return t17 ?? "";
  }
  setVar(e11, t17) {
    let n18 = this.scopeFor(e11);
    n18.set(e11, t17), n18 === this.globals && e11 === "NF" && this.setNF(n8(t17));
  }
  getArray(e11) {
    let t17 = this.scopeFor(e11), n18 = t17.get(e11);
    if ((n18 === void 0 || n18 === "") && (n18 = /* @__PURE__ */ new Map(), t17.set(e11, n18)), !f6(n18)) throw Error(`awk: can't use scalar ${e11} as array`);
    return n18;
  }
  str(e11) {
    return this.valToStr(this.getVar(e11));
  }
  num(e11) {
    return n8(this.getVar(e11));
  }
  valToStr(e11) {
    return a5(e11, this.convfmt());
  }
  convfmt() {
    let e11 = this.globals.get("CONVFMT");
    return typeof e11 == "string" ? e11 : "%.6g";
  }
  execStmts(e11) {
    for (let t17 of e11) this.exec(t17);
  }
  exec(e11) {
    switch (e11.type) {
      case "expr":
        this.eval(e11.expr);
        return;
      case "block":
        this.execStmts(e11.body);
        return;
      case "empty":
        return;
      case "print":
        this.doPrint(e11.args, e11.redirect);
        return;
      case "printf":
        this.doPrintf(e11.args, e11.redirect);
        return;
      case "if":
        o5(this.eval(e11.cond)) ? this.exec(e11.then) : e11.else && this.exec(e11.else);
        return;
      case "while":
        for (; o5(this.eval(e11.cond)); ) try {
          this.exec(e11.body);
        } catch (e12) {
          if (e12 === o6) break;
          if (e12 === s8) continue;
          throw e12;
        }
        return;
      case "dowhile":
        do
          try {
            this.exec(e11.body);
          } catch (e12) {
            if (e12 === o6) break;
            if (e12 === s8) continue;
            throw e12;
          }
        while (o5(this.eval(e11.cond)));
        return;
      case "for":
        for (e11.init && this.exec(e11.init); e11.cond === void 0 || o5(this.eval(e11.cond)); ) {
          try {
            this.exec(e11.body);
          } catch (e12) {
            if (e12 === o6) break;
            if (e12 !== s8) throw e12;
          }
          e11.update && this.exec(e11.update);
        }
        return;
      case "forin": {
        let t17 = this.getArray(e11.array);
        for (let n18 of [...t17.keys()]) {
          this.setVar(e11.var, n18);
          try {
            this.exec(e11.body);
          } catch (e12) {
            if (e12 === o6) break;
            if (e12 === s8) continue;
            throw e12;
          }
        }
        return;
      }
      case "next":
        throw c8;
      case "nextfile":
        throw l7;
      case "break":
        throw o6;
      case "continue":
        throw s8;
      case "exit":
        throw new u7(e11.code ? Math.trunc(n8(this.eval(e11.code))) : this.exitCode);
      case "return":
        throw new d7(e11.value ? this.eval(e11.value) : "");
      case "delete": {
        let t17 = this.getArray(e11.name);
        e11.indices ? t17.delete(this.subscript(e11.indices)) : t17.clear();
        return;
      }
    }
  }
  doPrint(e11, t17) {
    let n18 = this.str("OFS"), r16 = this.str("ORS"), i22;
    i22 = e11.length === 0 ? this.fields[0] : e11.map((e12) => this.outputStr(this.eval(e12))).join(n18), this.emit(i22 + r16, t17);
  }
  doPrintf(e11, t17) {
    if (e11.length === 0) return;
    let r16 = this.valToStr(this.eval(e11[0])), i22 = e11.slice(1).map((e12) => this.eval(e12));
    this.emit(s7(r16, i22), t17);
  }
  outputStr(e11) {
    if (typeof e11 == "number") {
      let n18 = this.globals.get("OFMT");
      return i6(e11, typeof n18 == "string" ? n18 : "%.6g");
    }
    return e11;
  }
  emit(e11, t17) {
    if (!t17) {
      this.io.write(e11);
      return;
    }
    let n18 = this.valToStr(this.eval(t17.target));
    if (t17.mode === "|") {
      if (!this.io.pipeToCommand) {
        this.io.writeErr(`awk: print | "${n18}" not supported
`);
        return;
      }
      this.io.pipeToCommand(n18, e11);
      return;
    }
    if (n18 === "/dev/stdout") {
      this.io.write(e11);
      return;
    }
    if (n18 === "/dev/stderr") {
      this.io.writeErr(e11);
      return;
    }
    if (!this.io.writeFile) {
      this.io.writeErr(`awk: print > "${n18}" not supported
`);
      return;
    }
    let r16 = t17.mode === ">>" || this.openWrites.has(n18);
    this.openWrites.add(n18), this.io.writeFile(n18, e11, r16);
  }
  eval(e11) {
    switch (e11.type) {
      case "num":
        return e11.value;
      case "str":
        return e11.value;
      case "regex":
        return +!!this.compileRegex(e11.source).test(this.fields[0]);
      case "group":
        return this.eval(e11.expr);
      case "var":
        return this.getVar(e11.name);
      case "field":
        return this.getField(Math.trunc(n8(this.eval(e11.index))));
      case "index": {
        let t17 = this.getArray(e11.name), n18 = this.subscript(e11.indices);
        return t17.has(n18) || t17.set(n18, ""), t17.get(n18) ?? "";
      }
      case "assign":
        return this.evalAssign(e11.op, e11.target, e11.value);
      case "update":
        return this.evalUpdate(e11.op, e11.prefix, e11.target);
      case "unary": {
        if (e11.op === "!") return +!o5(this.eval(e11.expr));
        let t17 = n8(this.eval(e11.expr));
        return e11.op === "-" ? -t17 : +t17;
      }
      case "concat":
        return e11.parts.map((e12) => this.valToStr(this.eval(e12))).join("");
      case "ternary":
        return o5(this.eval(e11.cond)) ? this.eval(e11.then) : this.eval(e11.else);
      case "binary":
        return this.evalBinary(e11.op, e11.left, e11.right);
      case "in":
        return +!!this.getArray(e11.array).has(this.subscript(e11.indices));
      case "builtin":
        return this.evalBuiltin(e11.name, e11.args);
      case "call":
        return this.evalCall(e11.name, e11.args);
      case "getline":
        return this.evalGetline(e11);
    }
  }
  subscript(e11) {
    if (e11.length === 1) return this.valToStr(this.eval(e11[0]));
    let t17 = this.str("SUBSEP");
    return e11.map((e12) => this.valToStr(this.eval(e12))).join(t17);
  }
  evalBinary(e11, t17, n18) {
    if (e11 === "&&") return o5(this.eval(t17)) && o5(this.eval(n18)) ? 1 : 0;
    if (e11 === "||") return o5(this.eval(t17)) || o5(this.eval(n18)) ? 1 : 0;
    if (e11 === "~" || e11 === "!~") {
      let r16 = this.valToStr(this.eval(t17)), i22 = (n18.type === "regex" ? this.compileRegex(n18.source) : this.compileRegex(this.valToStr(this.eval(n18)))).test(r16);
      return (e11 === "~" ? i22 : !i22) ? 1 : 0;
    }
    let a20 = this.eval(t17), o23 = this.eval(n18);
    switch (e11) {
      case "+":
        return n8(a20) + n8(o23);
      case "-":
        return n8(a20) - n8(o23);
      case "*":
        return n8(a20) * n8(o23);
      case "/": {
        let e12 = n8(o23);
        return e12 === 0 ? (this.io.writeErr("awk: division by zero\n"), 0) : n8(a20) / e12;
      }
      case "%": {
        let e12 = n8(o23);
        return e12 === 0 ? (this.io.writeErr("awk: division by zero\n"), 0) : m6(n8(a20), e12);
      }
      case "^":
        return n8(a20) ** +n8(o23);
      default:
        return +!!this.compare(e11, a20, o23, t17, n18);
    }
  }
  numericOperand(t17, n18) {
    return typeof n18 == "number" ? true : r7(n18) ? !this.isStringContext(t17) : false;
  }
  isStringContext(e11) {
    switch (e11.type) {
      case "str":
      case "concat":
        return true;
      case "group":
        return this.isStringContext(e11.expr);
      case "ternary":
        return this.isStringContext(e11.then) && this.isStringContext(e11.else);
      case "builtin":
        return e11.name === "substr" || e11.name === "sprintf" || e11.name === "tolower" || e11.name === "toupper";
      default:
        return false;
    }
  }
  compare(t17, n18, r16, a20, o23) {
    let s30;
    if (a20 && o23 ? this.numericOperand(a20, n18) && this.numericOperand(o23, r16) : r7(n18) && r7(r16)) {
      let e11 = n8(n18), t18 = n8(r16);
      s30 = e11 < t18 ? -1 : +(e11 > t18);
    } else {
      let e11 = this.valToStr(n18), t18 = this.valToStr(r16);
      s30 = e11 < t18 ? -1 : +(e11 > t18);
    }
    switch (t17) {
      case "<":
        return s30 < 0;
      case "<=":
        return s30 <= 0;
      case ">":
        return s30 > 0;
      case ">=":
        return s30 >= 0;
      case "==":
        return s30 === 0;
      case "!=":
        return s30 !== 0;
      default:
        return false;
    }
  }
  evalAssign(e11, t17, n18) {
    let r16;
    if (e11 === "=") r16 = this.eval(n18);
    else {
      let a20 = n8(this.readLValue(t17)), o23 = n8(this.eval(n18));
      switch (e11) {
        case "+=":
          r16 = a20 + o23;
          break;
        case "-=":
          r16 = a20 - o23;
          break;
        case "*=":
          r16 = a20 * o23;
          break;
        case "/=":
          if (o23 === 0) throw Error("awk: division by zero in /=");
          r16 = a20 / o23;
          break;
        case "%=":
          if (o23 === 0) throw Error("awk: division by zero in %=");
          r16 = m6(a20, o23);
          break;
        case "^=":
          r16 = a20 ** +o23;
          break;
        default:
          r16 = o23;
      }
    }
    return this.writeLValue(t17, r16), r16;
  }
  evalUpdate(e11, t17, n18) {
    let r16 = n8(this.readLValue(n18)), a20 = e11 === "++" ? r16 + 1 : r16 - 1;
    return this.writeLValue(n18, a20), t17 ? a20 : r16;
  }
  readLValue(e11) {
    switch (e11.type) {
      case "var":
        return this.getVar(e11.name);
      case "field":
        return this.getField(Math.trunc(n8(this.eval(e11.index))));
      case "index": {
        let t17 = this.getArray(e11.name), n18 = this.subscript(e11.indices);
        return t17.get(n18) ?? "";
      }
    }
  }
  writeLValue(e11, t17) {
    switch (e11.type) {
      case "var":
        this.setVar(e11.name, t17);
        return;
      case "field":
        this.setField(Math.trunc(n8(this.eval(e11.index))), t17);
        return;
      case "index":
        this.getArray(e11.name).set(this.subscript(e11.indices), t17);
        return;
    }
  }
  evalBuiltin(e11, t17) {
    switch (e11) {
      case "length": {
        if (t17.length === 0) return this.fields[0].length;
        let e12 = t17[0];
        if (e12.type === "var") {
          let t18 = this.scopeFor(e12.name).get(e12.name);
          if (f6(t18)) return t18.size;
        }
        return this.valToStr(this.eval(e12)).length;
      }
      case "substr": {
        let e12 = this.valToStr(this.eval(t17[0])), n18 = Math.trunc(n8(this.eval(t17[1]))), r16 = t17.length >= 3 ? Math.trunc(n8(this.eval(t17[2]))) : Infinity, a20 = n18 - 1 < 0 ? 0 : n18 - 1;
        return r16 < 0 && (r16 = 0), r16 === Infinity ? e12.slice(a20) : e12.slice(a20, a20 + r16);
      }
      case "index": {
        let e12 = this.valToStr(this.eval(t17[0])), n18 = this.valToStr(this.eval(t17[1]));
        return e12.indexOf(n18) + 1;
      }
      case "split":
        return this.doSplit(t17);
      case "sub":
        return this.doSub(t17, false);
      case "gsub":
        return this.doSub(t17, true);
      case "match":
        return this.doMatch(t17);
      case "sprintf":
        return s7(this.valToStr(this.eval(t17[0])), t17.slice(1).map((e12) => this.eval(e12)));
      case "sin":
        return Math.sin(n8(this.eval(t17[0])));
      case "cos":
        return Math.cos(n8(this.eval(t17[0])));
      case "atan2":
        return Math.atan2(n8(this.eval(t17[0])), n8(this.eval(t17[1])));
      case "exp":
        return Math.exp(n8(this.eval(t17[0])));
      case "log":
        return Math.log(n8(this.eval(t17[0])));
      case "sqrt":
        return Math.sqrt(n8(this.eval(t17[0])));
      case "int":
        return Math.trunc(n8(this.eval(t17[0])));
      case "rand":
        return this.rng();
      case "srand": {
        let e12 = this.rngSeed;
        return this.rngSeed = t17.length > 0 ? Math.trunc(n8(this.eval(t17[0]))) : 0, this.rng = h6(this.rngSeed), e12;
      }
      case "tolower":
        return this.valToStr(this.eval(t17[0])).toLowerCase();
      case "toupper":
        return this.valToStr(this.eval(t17[0])).toUpperCase();
      case "system":
        return 0;
      case "close":
        return 0;
      case "fflush":
        return 0;
      default:
        throw Error(`awk: unknown builtin ${e11}`);
    }
  }
  doSplit(e11) {
    let t17 = this.valToStr(this.eval(e11[0])), n18 = e11[1];
    if (n18.type !== "var") throw Error("awk: split() needs an array");
    let r16 = this.getArray(n18.name);
    r16.clear();
    let i22, a20, o23 = e11.length >= 3 && e11[2].type === "regex";
    if (a20 = e11.length >= 3 ? e11[2].type === "regex" ? e11[2].source : this.valToStr(this.eval(e11[2])) : this.str("FS"), a20 === " " && !o23) {
      let e12 = t17.replace(/^[ \t\n]+/, "").replace(/[ \t\n]+$/, "");
      i22 = e12 === "" ? [] : e12.split(/[ \t\n]+/);
    } else i22 = a20 === "" ? t17 === "" ? [] : t17.split("") : t17 === "" ? [] : a20.length === 1 && !o23 ? t17.split(a20 === "]" || "\\^$.|?*+(){}[".includes(a20) ? new RegExp(y4(a20)) : a20) : t17.split(this.compileRegex(a20));
    return i22.forEach((e12, t18) => r16.set(String(t18 + 1), e12)), i22.length;
  }
  doSub(e11, t17) {
    let n18 = e11[0].type === "regex" ? this.compileRegex(e11[0].source, t17 ? "g" : "") : this.compileRegex(this.valToStr(this.eval(e11[0])), t17 ? "g" : ""), r16 = this.valToStr(this.eval(e11[1])), i22 = e11.length >= 3 ? e11[2] : {
      type: "field",
      index: {
        type: "num",
        value: 0
      }
    }, a20 = this.valToStr(this.readLValue(i22)), o23 = 0, s30 = a20.replace(n18, (e12) => (o23++, _5(r16, e12)));
    return o23 > 0 && this.writeLValue(i22, s30), o23;
  }
  doMatch(e11) {
    let t17 = this.valToStr(this.eval(e11[0])), n18 = (e11[1].type === "regex" ? this.compileRegex(e11[1].source) : this.compileRegex(this.valToStr(this.eval(e11[1])))).exec(t17);
    return n18 ? (this.globals.set("RSTART", n18.index + 1), this.globals.set("RLENGTH", n18[0].length), n18.index + 1) : (this.globals.set("RSTART", 0), this.globals.set("RLENGTH", -1), 0);
  }
  evalCall(e11, t17) {
    let n18 = this.program.functions.get(e11);
    if (!n18) throw Error(`awk: calling undefined function ${e11}`);
    let r16 = /* @__PURE__ */ new Map();
    for (let e12 = 0; e12 < n18.params.length; e12++) {
      let i22 = n18.params[e12], a20 = t17[e12];
      a20 === void 0 ? r16.set(i22, "") : a20.type === "var" && this.canBeArrayArg(a20.name) ? r16.set(i22, this.getArray(a20.name)) : r16.set(i22, this.eval(a20));
    }
    this.locals.push(r16);
    try {
      return this.execStmts(n18.body), "";
    } catch (e12) {
      if (e12 instanceof d7) return e12.value;
      throw e12;
    } finally {
      this.locals.pop();
    }
  }
  canBeArrayArg(e11) {
    let t17 = this.scopeFor(e11).get(e11);
    return f6(t17) || t17 === void 0;
  }
  fileReaders = /* @__PURE__ */ new Map();
  evalGetline(e11) {
    if (e11.source === "main") {
      if (this.lineQueuePos >= this.lineQueue.length) return 0;
      let t18 = this.lineQueue[this.lineQueuePos++];
      return this.globals.set("NR", this.num("NR") + 1), this.globals.set("FNR", this.num("FNR") + 1), e11.into ? this.writeLValue(e11.into, t18) : this.setRecord(t18), 1;
    }
    if (e11.source === "file") {
      let t18 = this.valToStr(this.eval(e11.arg)), n19 = this.fileReaders.get(t18);
      if (!n19) {
        if (!this.io.readFile) return -1;
        let e12 = this.io.readFile(t18);
        if (e12 === void 0) return -1;
        n19 = {
          lines: g5(e12, this.str("RS")),
          pos: 0
        }, this.fileReaders.set(t18, n19);
      }
      if (n19.pos >= n19.lines.length) return 0;
      let r17 = n19.lines[n19.pos++];
      return e11.into ? this.writeLValue(e11.into, r17) : this.setRecord(r17), 1;
    }
    let t17 = this.valToStr(this.eval(e11.arg)), n18 = this.fileReaders.get("cmd:" + t17);
    if (!n18) {
      if (!this.io.runCommand) return -1;
      let e12 = this.io.runCommand(t17);
      if (e12 === void 0) return -1;
      n18 = {
        lines: g5(e12, this.str("RS")),
        pos: 0
      }, this.fileReaders.set("cmd:" + t17, n18);
    }
    if (n18.pos >= n18.lines.length) return 0;
    let r16 = n18.lines[n18.pos++];
    return this.globals.set("NR", this.num("NR") + 1), e11.into ? this.writeLValue(e11.into, r16) : this.setRecord(r16), 1;
  }
  regexCache = /* @__PURE__ */ new Map();
  compileRegex(e11, t17 = "") {
    let n18 = t17 + "\0" + e11, r16 = this.regexCache.get(n18);
    return r16 || (r16 = new RegExp(b3(e11), t17), this.regexCache.set(n18, r16)), r16.lastIndex = 0, r16;
  }
};
function m6(e11, t17) {
  return e11 % t17;
}
function h6(e11) {
  let t17 = e11 >>> 0;
  return function() {
    t17 |= 0, t17 = t17 + 1831565813 | 0;
    let e12 = Math.imul(t17 ^ t17 >>> 15, 1 | t17);
    return e12 = e12 + Math.imul(e12 ^ e12 >>> 7, 61 | e12) ^ e12, ((e12 ^ e12 >>> 14) >>> 0) / 4294967296;
  };
}
function g5(e11, t17) {
  if (e11 === "") return [];
  if (t17 === "\n") {
    let t18 = e11.endsWith("\n") ? e11.slice(0, -1) : e11;
    return t18 === "" ? [""] : t18.split("\n");
  }
  if (t17 === "") {
    let t18 = e11.replace(/^\n+/, "").replace(/\n+$/, "");
    return t18 === "" ? [] : t18.split(/\n{2,}/);
  }
  if (t17.length === 1) return (e11.endsWith(t17) ? e11.slice(0, -1) : e11).split(t17);
  let n18 = new RegExp(b3(t17));
  return e11.replace(RegExp(b3(t17) + "$"), "").split(n18);
}
function _5(e11, t17) {
  let n18 = "";
  for (let r16 = 0; r16 < e11.length; r16++) {
    let i22 = e11[r16];
    if (i22 === "\\") {
      let t18 = e11[r16 + 1];
      if (t18 === "&") {
        n18 += "&", r16++;
        continue;
      }
      if (t18 === "\\") {
        n18 += "\\", r16++;
        continue;
      }
      n18 += "\\";
      continue;
    }
    if (i22 === "&") {
      n18 += t17;
      continue;
    }
    n18 += i22;
  }
  return n18;
}
function v4(e11) {
  if (!e11.includes("\\")) return e11;
  let t17 = "";
  for (let n18 = 0; n18 < e11.length; n18++) {
    if (e11[n18] !== "\\") {
      t17 += e11[n18];
      continue;
    }
    let r16 = e11[++n18];
    switch (r16) {
      case "n":
        t17 += "\n";
        break;
      case "t":
        t17 += "	";
        break;
      case "r":
        t17 += "\r";
        break;
      case "\\":
        t17 += "\\";
        break;
      case '"':
        t17 += '"';
        break;
      case "/":
        t17 += "/";
        break;
      case "a":
        t17 += "\x07";
        break;
      case "b":
        t17 += "\b";
        break;
      case "f":
        t17 += "\f";
        break;
      case "v":
        t17 += "\v";
        break;
      default:
        t17 += "\\" + (r16 ?? "");
        break;
    }
  }
  return t17;
}
function y4(e11) {
  return e11.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function b3(e11) {
  let t17 = {
    alpha: "A-Za-z",
    digit: "0-9",
    alnum: "A-Za-z0-9",
    upper: "A-Z",
    lower: "a-z",
    space: " \\t\\r\\n\\v\\f",
    blank: " \\t",
    punct: "!-/:-@\\[-`{-~",
    xdigit: "0-9A-Fa-f",
    cntrl: "\\x00-\\x1f\\x7f",
    print: "\\x20-\\x7e",
    graph: "\\x21-\\x7e"
  };
  return e11.replace(/\[:([a-z]+):\]/g, (e12, n18) => t17[n18] ?? e12);
}

// mithic/packages/coreutils/dist/commands/awk/lexer.js
var e7 = /* @__PURE__ */ new Set([
  "BEGIN",
  "END",
  "function",
  "func",
  "if",
  "else",
  "while",
  "for",
  "do",
  "break",
  "continue",
  "next",
  "nextfile",
  "exit",
  "return",
  "delete",
  "in",
  "getline",
  "print",
  "printf"
]);
var t10 = /* @__PURE__ */ new Set([
  "length",
  "substr",
  "index",
  "split",
  "sub",
  "gsub",
  "match",
  "sprintf",
  "sin",
  "cos",
  "atan2",
  "exp",
  "log",
  "sqrt",
  "int",
  "rand",
  "srand",
  "tolower",
  "toupper",
  "system",
  "close",
  "fflush"
]);
var n9 = /* @__PURE__ */ "+=.-=.*=./=.%=.^=.**=.==.!=.<=.>=.&&.||.++.--.!~.>>.**.+.-.*./.%.^.<.>.=.!.~.?.:.;.,.(.).{.}.[.].$.|".split(".");
function r8(e11) {
  return e11 >= "0" && e11 <= "9";
}
function i7(e11) {
  return e11 >= "a" && e11 <= "z" || e11 >= "A" && e11 <= "Z" || e11 === "_";
}
function a6(e11) {
  return i7(e11) || r8(e11);
}
function o7(e11) {
  let t17 = "";
  for (let n18 = 0; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 !== "\\") {
      t17 += r16;
      continue;
    }
    let i22 = e11[++n18];
    switch (i22) {
      case "n":
        t17 += "\n";
        break;
      case "t":
        t17 += "	";
        break;
      case "r":
        t17 += "\r";
        break;
      case "\\":
        t17 += "\\";
        break;
      case '"':
        t17 += '"';
        break;
      case "/":
        t17 += "/";
        break;
      case "a":
        t17 += "\x07";
        break;
      case "b":
        t17 += "\b";
        break;
      case "f":
        t17 += "\f";
        break;
      case "v":
        t17 += "\v";
        break;
      default:
        if (i22 >= "0" && i22 <= "7") {
          let r17 = i22;
          for (; r17.length < 3 && e11[n18 + 1] >= "0" && e11[n18 + 1] <= "7"; ) r17 += e11[++n18];
          t17 += String.fromCharCode(parseInt(r17, 8));
        } else t17 += "\\" + (i22 ?? "");
    }
  }
  return t17;
}
function s9(e11) {
  return e11 ? e11.type === "num" || e11.type === "str" || e11.type === "name" || e11.type === "regex" || e11.type === "builtin" ? false : e11.type === "keyword" ? true : e11.type === "op" ? !(e11.value === ")" || e11.value === "]" || e11.value === "++" || e11.value === "--") : true : true;
}
function c9(c37) {
  let l38 = [], u37 = 0, d36 = 1, f32 = c37.length, p31 = () => l38[l38.length - 1], m24 = (e11) => {
    l38.push({
      ...e11,
      line: d36
    });
  };
  for (; u37 < f32; ) {
    let l39 = c37[u37];
    if (l39 === "\\" && c37[u37 + 1] === "\n") {
      u37 += 2, d36++;
      continue;
    }
    if (l39 === "\n") {
      m24({
        type: "newline",
        value: "\n",
        pos: u37
      }), u37++, d36++;
      continue;
    }
    if (l39 === " " || l39 === "	" || l39 === "\r") {
      u37++;
      continue;
    }
    if (l39 === "#") {
      for (; u37 < f32 && c37[u37] !== "\n"; ) u37++;
      continue;
    }
    if (l39 === '"') {
      let e11 = u37;
      u37++;
      let t17 = "";
      for (; u37 < f32 && c37[u37] !== '"'; ) {
        if (c37[u37] === "\\") {
          t17 += c37[u37] + (c37[u37 + 1] ?? ""), u37 += 2;
          continue;
        }
        if (c37[u37] === "\n") throw Error("newline in string");
        t17 += c37[u37++];
      }
      if (u37 >= f32) throw Error("unterminated string");
      u37++, m24({
        type: "str",
        value: o7(t17),
        pos: e11
      });
      continue;
    }
    if (l39 === "/" && s9(p31())) {
      let e11 = u37;
      u37++;
      let t17 = "", n18 = false;
      for (; u37 < f32; ) {
        let e12 = c37[u37];
        if (e12 === "\\") {
          t17 += e12 + (c37[u37 + 1] ?? ""), u37 += 2;
          continue;
        }
        if (e12 === "\n") throw Error("newline in regex");
        if (e12 === "[") n18 = true;
        else if (e12 === "]") n18 = false;
        else if (e12 === "/" && !n18) break;
        t17 += e12, u37++;
      }
      if (u37 >= f32 || c37[u37] !== "/") throw Error("unterminated regex");
      u37++, m24({
        type: "regex",
        value: t17,
        pos: e11
      });
      continue;
    }
    if (r8(l39) || l39 === "." && r8(c37[u37 + 1])) {
      let e11 = u37;
      if (l39 === "0" && (c37[u37 + 1] === "x" || c37[u37 + 1] === "X")) for (u37 += 2; u37 < f32 && /[0-9a-fA-F]/.test(c37[u37]); ) u37++;
      else {
        for (; u37 < f32 && r8(c37[u37]); ) u37++;
        if (c37[u37] === ".") for (u37++; u37 < f32 && r8(c37[u37]); ) u37++;
        if (c37[u37] === "e" || c37[u37] === "E") {
          let e12 = u37 + 1;
          if ((c37[e12] === "+" || c37[e12] === "-") && e12++, r8(c37[e12])) for (u37 = e12 + 1; u37 < f32 && r8(c37[u37]); ) u37++;
        }
      }
      let t17 = c37.slice(e11, u37);
      m24({
        type: "num",
        value: t17,
        num: Number(t17),
        pos: e11
      });
      continue;
    }
    if (i7(l39)) {
      let n18 = u37;
      for (; u37 < f32 && a6(c37[u37]); ) u37++;
      let r16 = c37.slice(n18, u37);
      e7.has(r16) ? m24({
        type: "keyword",
        value: r16 === "func" ? "function" : r16,
        pos: n18
      }) : t10.has(r16) ? m24({
        type: "builtin",
        value: r16,
        pos: n18
      }) : c37[u37] === "(" ? m24({
        type: "func_name",
        value: r16,
        pos: n18
      }) : m24({
        type: "name",
        value: r16,
        pos: n18
      });
      continue;
    }
    let h24;
    for (let e11 of n9) if (c37.startsWith(e11, u37)) {
      h24 = e11;
      break;
    }
    if (h24 === void 0) throw Error(`unexpected character ${JSON.stringify(l39)}`);
    let g18 = h24;
    g18 === "**" ? g18 = "^" : g18 === "**=" && (g18 = "^="), m24({
      type: "op",
      value: g18,
      pos: u37
    }), u37 += h24.length;
  }
  return m24({
    type: "eof",
    value: "",
    pos: u37
  }), l38;
}

// mithic/packages/coreutils/dist/commands/awk/parser.js
var t11 = /* @__PURE__ */ new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "^="
]);
var n10 = class extends Error {
  exitCode;
  constructor(e11, t17 = 1) {
    super(e11), this.name = "AwkFatalError", this.exitCode = t17;
  }
};
var r9 = { substr: {
  min: 2,
  max: 3
} };
var i8 = class {
  toks;
  pos = 0;
  constructor(t17) {
    this.toks = c9(t17);
  }
  peek(e11 = 0) {
    return this.toks[Math.min(this.pos + e11, this.toks.length - 1)];
  }
  next() {
    return this.toks[this.pos++];
  }
  atEof() {
    return this.peek().type === "eof";
  }
  is(e11, t17) {
    let n18 = this.peek();
    return n18.type === e11 && (t17 === void 0 || n18.value === t17);
  }
  isOp(e11) {
    return this.is("op", e11);
  }
  isKw(e11) {
    return this.is("keyword", e11);
  }
  eat(e11, t17) {
    if (!this.is(e11, t17)) {
      let n18 = this.peek();
      throw Error(`awk: syntax error: expected ${t17 ?? e11}, got ${n18.value || n18.type} (line ${n18.line})`);
    }
    return this.next();
  }
  accept(e11, t17) {
    return this.is(e11, t17) ? (this.next(), true) : false;
  }
  skipNewlines() {
    for (; this.is("newline") || this.isOp(";"); ) this.next();
  }
  optNewlines() {
    for (; this.is("newline"); ) this.next();
  }
  parse() {
    let e11 = [], t17 = /* @__PURE__ */ new Map();
    for (this.skipNewlines(); !this.atEof(); ) {
      if (this.isKw("function")) {
        let e12 = this.parseFunction();
        t17.set(e12.name, e12);
      } else e11.push(this.parseRule());
      this.skipNewlines();
    }
    return {
      rules: e11,
      functions: t17
    };
  }
  parseFunction() {
    this.eat("keyword", "function");
    let e11 = this.peek();
    if (e11.type !== "name" && e11.type !== "func_name") throw Error(`awk: syntax error: function name expected (line ${e11.line})`);
    this.next(), this.eat("op", "(");
    let t17 = [];
    if (!this.isOp(")")) do
      this.optNewlines(), t17.push(this.eat("name").value), this.optNewlines();
    while (this.accept("op", ","));
    this.eat("op", ")"), this.optNewlines();
    let n18 = this.parseBlock();
    return {
      name: e11.value,
      params: t17,
      body: n18
    };
  }
  parseRule() {
    if (this.isKw("BEGIN")) return this.next(), this.optNewlines(), {
      pattern: { type: "begin" },
      action: this.parseBlock()
    };
    if (this.isKw("END")) return this.next(), this.optNewlines(), {
      pattern: { type: "end" },
      action: this.parseBlock()
    };
    if (this.isOp("{")) return {
      pattern: { type: "always" },
      action: this.parseBlock()
    };
    let e11 = this.parseExpr({
      noIn: false,
      noGt: false
    }), t17;
    return this.accept("op", ",") ? (this.optNewlines(), t17 = {
      type: "range",
      start: e11,
      end: this.parseExpr({
        noIn: false,
        noGt: false
      })
    }) : t17 = {
      type: "expr",
      expr: e11
    }, this.isOp("{") ? {
      pattern: t17,
      action: this.parseBlock()
    } : { pattern: t17 };
  }
  parseBlock() {
    this.eat("op", "{");
    let e11 = [];
    for (this.skipNewlines(); !this.isOp("}") && !this.atEof(); ) e11.push(this.parseStmt()), this.skipNewlines();
    return this.eat("op", "}"), e11;
  }
  parseStmt() {
    let e11 = this.peek();
    if (this.isOp("{")) return {
      type: "block",
      body: this.parseBlock()
    };
    if (this.isOp(";")) return this.next(), { type: "empty" };
    if (e11.type === "keyword") switch (e11.value) {
      case "if":
        return this.parseIf();
      case "while":
        return this.parseWhile();
      case "do":
        return this.parseDoWhile();
      case "for":
        return this.parseFor();
      case "print":
      case "printf":
        return this.parsePrint();
      case "next":
        return this.next(), this.endSimple(), { type: "next" };
      case "nextfile":
        return this.next(), this.endSimple(), { type: "nextfile" };
      case "break":
        return this.next(), this.endSimple(), { type: "break" };
      case "continue":
        return this.next(), this.endSimple(), { type: "continue" };
      case "exit": {
        this.next();
        let e12 = this.startsExpr() ? this.parseExpr({
          noIn: false,
          noGt: false
        }) : void 0;
        return this.endSimple(), {
          type: "exit",
          code: e12
        };
      }
      case "return": {
        this.next();
        let e12 = this.startsExpr() ? this.parseExpr({
          noIn: false,
          noGt: false
        }) : void 0;
        return this.endSimple(), {
          type: "return",
          value: e12
        };
      }
      case "delete":
        return this.parseDelete();
      default:
        break;
    }
    let t17 = this.parseExpr({
      noIn: false,
      noGt: false
    });
    return this.endSimple(), {
      type: "expr",
      expr: t17
    };
  }
  endSimple() {
    (this.is("newline") || this.isOp(";")) && this.next();
  }
  startsExpr() {
    let e11 = this.peek();
    return e11.type === "num" || e11.type === "str" || e11.type === "regex" || e11.type === "name" || e11.type === "func_name" || e11.type === "builtin" ? true : e11.type === "keyword" ? e11.value === "getline" : e11.type === "op" ? [
      "(",
      "$",
      "!",
      "-",
      "+",
      "++",
      "--"
    ].includes(e11.value) : false;
  }
  parseIf() {
    this.eat("keyword", "if"), this.eat("op", "(");
    let e11 = this.parseExpr({
      noIn: false,
      noGt: false
    });
    this.eat("op", ")"), this.optNewlines();
    let t17 = this.parseStmt(), n18 = this.pos;
    return this.skipNewlines(), this.isKw("else") ? (this.next(), this.optNewlines(), {
      type: "if",
      cond: e11,
      then: t17,
      else: this.parseStmt()
    }) : (this.pos = n18, {
      type: "if",
      cond: e11,
      then: t17
    });
  }
  parseWhile() {
    this.eat("keyword", "while"), this.eat("op", "(");
    let e11 = this.parseExpr({
      noIn: false,
      noGt: false
    });
    return this.eat("op", ")"), this.optNewlines(), {
      type: "while",
      cond: e11,
      body: this.parseStmt()
    };
  }
  parseDoWhile() {
    this.eat("keyword", "do"), this.optNewlines();
    let e11 = this.parseStmt();
    this.skipNewlines(), this.eat("keyword", "while"), this.eat("op", "(");
    let t17 = this.parseExpr({
      noIn: false,
      noGt: false
    });
    return this.eat("op", ")"), this.endSimple(), {
      type: "dowhile",
      body: e11,
      cond: t17
    };
  }
  parseFor() {
    if (this.eat("keyword", "for"), this.eat("op", "("), this.peek().type === "name" && this.peek(1).type === "keyword" && this.peek(1).value === "in") {
      let e12 = this.next().value;
      this.eat("keyword", "in");
      let t18 = this.eat("name").value;
      return this.eat("op", ")"), this.optNewlines(), {
        type: "forin",
        var: e12,
        array: t18,
        body: this.parseStmt()
      };
    }
    let e11;
    this.isOp(";") || (e11 = {
      type: "expr",
      expr: this.parseExpr({
        noIn: false,
        noGt: false
      })
    }), this.eat("op", ";");
    let t17;
    this.isOp(";") || (t17 = this.parseExpr({
      noIn: false,
      noGt: false
    })), this.eat("op", ";");
    let n18;
    return this.isOp(")") || (n18 = {
      type: "expr",
      expr: this.parseExpr({
        noIn: false,
        noGt: false
      })
    }), this.eat("op", ")"), this.optNewlines(), {
      type: "for",
      init: e11,
      cond: t17,
      update: n18,
      body: this.parseStmt()
    };
  }
  parseDelete() {
    this.eat("keyword", "delete");
    let e11 = this.eat("name").value;
    if (this.accept("op", "[")) {
      let t17 = [this.parseExpr({
        noIn: false,
        noGt: false
      })];
      for (; this.accept("op", ","); ) t17.push(this.parseExpr({
        noIn: false,
        noGt: false
      }));
      return this.eat("op", "]"), this.endSimple(), {
        type: "delete",
        name: e11,
        indices: t17
      };
    }
    return this.endSimple(), {
      type: "delete",
      name: e11
    };
  }
  parsePrint() {
    let e11 = this.next().value, t17 = [];
    if (this.startsExpr() && !this.isRedirect()) {
      let e12 = this.tryParenArgList();
      if (e12) t17 = e12;
      else for (t17.push(this.parseExpr({
        noIn: false,
        noGt: true
      })); this.accept("op", ","); ) this.optNewlines(), t17.push(this.parseExpr({
        noIn: false,
        noGt: true
      }));
    }
    let n18;
    return this.isRedirect() && (n18 = {
      mode: this.next().value,
      target: this.parseExpr({
        noIn: false,
        noGt: false
      })
    }), this.endSimple(), e11 === "print" ? {
      type: "print",
      args: t17,
      redirect: n18
    } : {
      type: "printf",
      args: t17,
      redirect: n18
    };
  }
  isRedirect() {
    return this.isOp(">") || this.isOp(">>") || this.isOp("|");
  }
  tryParenArgList() {
    if (!this.isOp("(")) return;
    let e11 = this.pos;
    this.next();
    let t17 = [this.parseExpr({
      noIn: false,
      noGt: false
    })];
    for (; this.accept("op", ","); ) this.optNewlines(), t17.push(this.parseExpr({
      noIn: false,
      noGt: false
    }));
    if (t17.length < 2 || !this.isOp(")")) {
      this.pos = e11;
      return;
    }
    if (this.next(), this.isKw("in")) {
      this.pos = e11;
      return;
    }
    if (this.is("newline") || this.isOp(";") || this.isOp("}") || this.atEof() || this.isRedirect()) return t17;
    this.pos = e11;
  }
  parseExpr(e11) {
    return this.parseAssignment(e11);
  }
  parseAssignment(e11) {
    let n18 = this.parseTernary(e11);
    if (this.peek().type === "op" && t11.has(this.peek().value)) {
      let t17 = this.asLValue(n18);
      if (t17) return {
        type: "assign",
        op: this.next().value,
        target: t17,
        value: this.parseAssignment(e11)
      };
    }
    return n18;
  }
  parseTernary(e11) {
    let t17 = this.parseOr(e11);
    if (this.accept("op", "?")) {
      this.optNewlines();
      let n18 = this.parseAssignment(e11);
      return this.eat("op", ":"), this.optNewlines(), {
        type: "ternary",
        cond: t17,
        then: n18,
        else: this.parseAssignment(e11)
      };
    }
    return t17;
  }
  parseOr(e11) {
    let t17 = this.parseAnd(e11);
    for (; this.isOp("||"); ) this.next(), this.optNewlines(), t17 = {
      type: "binary",
      op: "||",
      left: t17,
      right: this.parseAnd(e11)
    };
    return t17;
  }
  parseAnd(e11) {
    let t17 = this.parseIn(e11);
    for (; this.isOp("&&"); ) this.next(), this.optNewlines(), t17 = {
      type: "binary",
      op: "&&",
      left: t17,
      right: this.parseIn(e11)
    };
    return t17;
  }
  parseIn(e11) {
    let t17 = this.parseMatch(e11);
    for (; !e11.noIn && this.isKw("in"); ) {
      this.next();
      let e12 = this.eat("name").value;
      t17 = {
        type: "in",
        indices: t17.type === "group" ? [t17.expr] : [t17],
        array: e12
      };
    }
    return t17;
  }
  parseMatch(e11) {
    let t17 = this.parseComparison(e11);
    for (; this.isOp("~") || this.isOp("!~"); ) t17 = {
      type: "binary",
      op: this.next().value,
      left: t17,
      right: this.parseComparison(e11)
    };
    return t17;
  }
  parseComparison(e11) {
    let t17 = this.parseConcat(e11), n18 = this.peek();
    if (n18.type === "op") {
      let r16 = n18.value;
      if (r16 === "<" || r16 === "<=" || r16 === "==" || r16 === "!=" || r16 === ">=" || r16 === ">" && !e11.noGt) return this.next(), {
        type: "binary",
        op: r16,
        left: t17,
        right: this.parseConcat(e11)
      };
    }
    return t17;
  }
  parseConcat(e11) {
    let t17 = [this.parsePipeGetline(e11)];
    for (; this.startsConcatOperand(); ) t17.push(this.parsePipeGetline(e11));
    return t17.length === 1 ? t17[0] : {
      type: "concat",
      parts: t17
    };
  }
  parsePipeGetline(e11) {
    let t17 = this.parseAdditive(e11);
    for (; this.isOp("|") && this.peek(1).type === "keyword" && this.peek(1).value === "getline"; ) {
      this.next(), this.eat("keyword", "getline");
      let n18, r16 = this.peek();
      if (r16.type === "name" || r16.type === "op" && r16.value === "$") {
        let t18 = this.parseField(e11), r17 = this.asLValue(t18);
        r17 && (n18 = r17);
      }
      t17 = {
        type: "getline",
        source: "cmd",
        into: n18,
        arg: t17
      };
    }
    return t17;
  }
  startsConcatOperand() {
    let e11 = this.peek();
    return e11.type === "num" || e11.type === "str" || e11.type === "regex" || e11.type === "name" || e11.type === "func_name" || e11.type === "builtin" ? true : e11.type === "keyword" ? e11.value === "getline" : e11.type === "op" ? e11.value === "(" || e11.value === "$" || e11.value === "!" || e11.value === "++" || e11.value === "--" : false;
  }
  parseAdditive(e11) {
    let t17 = this.parseMultiplicative(e11);
    for (; this.isOp("+") || this.isOp("-"); ) t17 = {
      type: "binary",
      op: this.next().value,
      left: t17,
      right: this.parseMultiplicative(e11)
    };
    return t17;
  }
  parseMultiplicative(e11) {
    let t17 = this.parseUnary(e11);
    for (; this.isOp("*") || this.isOp("/") || this.isOp("%"); ) t17 = {
      type: "binary",
      op: this.next().value,
      left: t17,
      right: this.parseUnary(e11)
    };
    return t17;
  }
  parseUnary(e11) {
    return this.isOp("!") || this.isOp("-") || this.isOp("+") ? {
      type: "unary",
      op: this.next().value,
      expr: this.parseUnary(e11)
    } : this.parsePower(e11);
  }
  parsePower(e11) {
    let t17 = this.parsePreUpdate(e11);
    return this.isOp("^") ? (this.next(), {
      type: "binary",
      op: "^",
      left: t17,
      right: this.parseUnary(e11)
    }) : t17;
  }
  parsePreUpdate(e11) {
    if (this.isOp("++") || this.isOp("--")) {
      let t17 = this.next().value, n18 = this.parsePreUpdate(e11), r16 = this.asLValue(n18);
      if (!r16) throw Error("awk: syntax error: ++/-- needs an lvalue");
      return {
        type: "update",
        op: t17,
        prefix: true,
        target: r16
      };
    }
    return this.parsePostfix(e11);
  }
  parsePostfix(e11) {
    let t17 = this.parseField(e11);
    for (; this.isOp("++") || this.isOp("--"); ) {
      let e12 = this.asLValue(t17);
      if (!e12) break;
      t17 = {
        type: "update",
        op: this.next().value,
        prefix: false,
        target: e12
      };
    }
    return t17;
  }
  parseField(e11) {
    return this.isOp("$") ? (this.next(), {
      type: "field",
      index: this.parseField(e11)
    }) : this.parsePrimary(e11);
  }
  parsePrimary(e11) {
    let t17 = this.peek();
    if (t17.type === "num") return this.next(), {
      type: "num",
      value: t17.num ?? Number(t17.value)
    };
    if (t17.type === "str") return this.next(), {
      type: "str",
      value: t17.value
    };
    if (t17.type === "regex") return this.next(), {
      type: "regex",
      source: t17.value
    };
    if (t17.type === "keyword" && t17.value === "getline") return this.parseGetline(e11);
    if (t17.type === "builtin") return this.parseBuiltin(e11);
    if (t17.type === "func_name") {
      this.next(), this.eat("op", "(");
      let n18 = this.parseArgList(e11);
      return this.eat("op", ")"), {
        type: "call",
        name: t17.value,
        args: n18
      };
    }
    if (t17.type === "name") {
      if (this.next(), this.accept("op", "[")) {
        let e12 = [this.parseExpr({
          noIn: false,
          noGt: false
        })];
        for (; this.accept("op", ","); ) e12.push(this.parseExpr({
          noIn: false,
          noGt: false
        }));
        return this.eat("op", "]"), {
          type: "index",
          name: t17.value,
          indices: e12
        };
      }
      return {
        type: "var",
        name: t17.value
      };
    }
    if (this.isOp("(")) {
      this.next();
      let e12 = this.parseExpr({
        noIn: false,
        noGt: false
      });
      if (this.isOp(",")) {
        let t18 = [e12];
        for (; this.accept("op", ","); ) t18.push(this.parseExpr({
          noIn: false,
          noGt: false
        }));
        return this.eat("op", ")"), this.eat("keyword", "in"), {
          type: "in",
          indices: t18,
          array: this.eat("name").value
        };
      }
      return this.eat("op", ")"), {
        type: "group",
        expr: e12
      };
    }
    throw Error(`awk: syntax error: unexpected ${t17.value || t17.type} (line ${t17.line})`);
  }
  parseGetline(e11) {
    this.eat("keyword", "getline");
    let t17, n18 = this.peek();
    if (n18.type === "name" || n18.type === "op" && n18.value === "$") {
      let n19 = this.parseField(e11), r16 = this.asLValue(n19);
      r16 && (t17 = r16);
    }
    if (this.isOp("<")) {
      this.next();
      let n19 = this.parseConcat(e11);
      return {
        type: "getline",
        source: "file",
        into: t17,
        arg: n19
      };
    }
    return {
      type: "getline",
      source: "main",
      into: t17
    };
  }
  parseBuiltin(e11) {
    let t17 = this.next().value, i22 = [];
    this.accept("op", "(") && (i22.push(...this.parseArgList(e11)), this.eat("op", ")"));
    let a20 = r9[t17];
    if (a20 && (i22.length < a20.min || i22.length > a20.max)) throw new n10(`awk: ${i22.length} is invalid as number of arguments for ${t17}`);
    return {
      type: "builtin",
      name: t17,
      args: i22
    };
  }
  parseArgList(e11) {
    let t17 = [];
    if (this.optNewlines(), this.isOp(")")) return t17;
    for (t17.push(this.parseExpr({
      noIn: e11.noIn,
      noGt: false
    })); this.accept("op", ","); ) this.optNewlines(), t17.push(this.parseExpr({
      noIn: e11.noIn,
      noGt: false
    }));
    return t17;
  }
  asLValue(e11) {
    if (e11.type === "var" || e11.type === "field" || e11.type === "index") return e11;
    if (e11.type === "group") return this.asLValue(e11.expr);
  }
};
function a7(e11) {
  return new i8(e11).parse();
}

// mithic/packages/coreutils/dist/commands/awk.js
function o8(e11) {
  let t17 = {
    assigns: {},
    progFiles: [],
    files: []
  }, n18 = 0;
  for (; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 === "-" || !r16.startsWith("-")) break;
    if (r16 === "--") {
      n18++;
      break;
    }
    let i22 = r16[1], a20 = r16.slice(2);
    if (i22 === "F") {
      t17.fs = a20 === "" ? e11[++n18] ?? "" : a20;
      continue;
    }
    if (i22 === "v") {
      let r17 = a20 === "" ? e11[++n18] ?? "" : a20, i23 = r17.indexOf("=");
      i23 >= 0 && (t17.assigns[r17.slice(0, i23)] = r17.slice(i23 + 1));
      continue;
    }
    if (i22 === "f") {
      t17.progFiles.push(a20 === "" ? e11[++n18] ?? "" : a20);
      continue;
    }
    break;
  }
  for (t17.progFiles.length === 0 && (t17.programText = e11[n18++]); n18 < e11.length; n18++) t17.files.push(e11[n18]);
  return t17;
}
function s10(e11) {
  return e11 === "\\t" ? "	" : e11.includes("\\") ? e11.replace(/\\t/g, "	").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\\/g, "\\") : e11;
}
async function c10(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    dirfd: -100,
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return new TextDecoder().decode(i22);
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
async function l8(e11, t17, n18, r16) {
  let i22 = r16 ? {
    write: true,
    create: true,
    append: true
  } : {
    write: true,
    create: true,
    truncate: true
  }, { fd: a20 } = await e11.syscall("fs/open", {
    dirfd: -100,
    path: t17,
    oflags: i22
  });
  try {
    let t18 = new TextEncoder().encode(n18), r17 = 0;
    for (; r17 < t18.byteLength; ) {
      let n19 = await e11.syscall("fs/write", {
        fd: a20,
        data: t18.subarray(r17)
      });
      if (!n19 || n19.written <= 0) break;
      r17 += n19.written;
    }
  } finally {
    await e11.syscall("fs/close", { fd: a20 }).catch(() => {
    });
  }
}
function u8(e11, t17) {
  let n18 = t17.message ?? String(t17), r16 = e11 + ":";
  return n18.startsWith(r16) && (n18 = n18.slice(r16.length).replace(/^\s+/, "")), `${e11}: ${n18}`;
}
var d8 = async (e11) => {
  let d36 = e11.args[0] ?? "awk", f32 = e11.stdout.getWriter(), p31 = e11.stderr.getWriter(), m24 = [], h24 = [], g18 = /* @__PURE__ */ new Map(), _21 = /* @__PURE__ */ new Map();
  try {
    let v17 = o8(e11.args.slice(1)), y18;
    if (v17.progFiles.length > 0) {
      let t17 = [];
      for (let r16 of v17.progFiles) try {
        t17.push(await c10(e11, r16));
      } catch {
        return await m2(p31, `${d36}: can't open file ${r16}`), 2;
      }
      y18 = t17.join("\n");
    } else if (v17.programText !== void 0) y18 = v17.programText;
    else return await m2(p31, `usage: ${d36} [-F fs][-v var=val][-f progfile | 'prog'] [file ...]`), 2;
    let b17;
    try {
      b17 = a7(y18);
    } catch (e12) {
      return await m2(p31, u8(d36, e12)), e12 instanceof n10 ? e12.exitCode : 2;
    }
    let x13 = [], S11 = v17.files;
    if (p6.programNeedsInput(b17)) if (S11.length === 0) x13.push({
      name: "",
      text: await s5(e11.stdin)
    });
    else for (let r16 of S11) {
      if (r16 === "-") {
        x13.push({
          name: "",
          text: await s5(e11.stdin)
        });
        continue;
      }
      try {
        x13.push({
          name: r16,
          text: await c10(e11, r16)
        });
      } catch {
        await m2(p31, `${d36}: can't open file ${r16}`), x13.push({
          name: r16,
          text: ""
        });
      }
    }
    for (let t17 of y18.matchAll(/getline[^<]*<\s*"((?:\\.|[^"\\])*)"/g)) {
      let n18 = t17[1].replace(/\\"/g, '"');
      if (!_21.has(n18)) try {
        _21.set(n18, await c10(e11, n18));
      } catch {
        _21.set(n18, void 0);
      }
    }
    let C12 = new p6(b17, {
      write: (e12) => {
        m24.push(e12);
      },
      writeErr: (e12) => {
        h24.push(e12);
      },
      writeFile: (e12, t17, n18) => {
        let r16 = g18.get(e12);
        r16 && (n18 || r16.append) ? g18.set(e12, {
          text: r16.text + t17,
          append: r16.append
        }) : g18.set(e12, {
          text: t17,
          append: n18
        });
      },
      readFile: (e12) => _21.get(e12)
    }, {
      fs: v17.fs === void 0 ? void 0 : s10(v17.fs),
      assigns: v17.assigns,
      argv: S11
    }), w9;
    try {
      w9 = C12.run(x13);
    } catch (e12) {
      return await m2(p31, u8(d36, e12)), 2;
    }
    m24.length > 0 && await f32.write(new TextEncoder().encode(m24.join("")));
    for (let e12 of h24) await p31.write(new TextEncoder().encode(e12));
    for (let [t17, r16] of g18) try {
      await l8(e11, t17, r16.text, r16.append);
    } catch (e12) {
      await m2(p31, `${d36}: can't write ${t17}: ${e12.message}`);
    }
    return w9;
  } finally {
    await f32.close().catch(() => {
    }), await p31.close().catch(() => {
    });
  }
};
var f7 = _2(d8);

// mithic/packages/coreutils/dist/commands/wc.js
async function a8(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return i22;
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
function o9(e11) {
  return e11 === 0 || e11 >= 768 && e11 <= 879 || e11 >= 6832 && e11 <= 6911 || e11 >= 7616 && e11 <= 7679 || e11 >= 8400 && e11 <= 8447 || e11 >= 65056 && e11 <= 65071 || e11 === 8203 || e11 === 8204 || e11 === 8205 || e11 >= 65024 && e11 <= 65039 ? 0 : e11 >= 4352 && e11 <= 4447 || e11 >= 11904 && e11 <= 12350 || e11 >= 12353 && e11 <= 13311 || e11 >= 13312 && e11 <= 19903 || e11 >= 19968 && e11 <= 40959 || e11 >= 40960 && e11 <= 42191 || e11 >= 44032 && e11 <= 55203 || e11 >= 63744 && e11 <= 64255 || e11 >= 65072 && e11 <= 65103 || e11 >= 65280 && e11 <= 65376 || e11 >= 65504 && e11 <= 65510 || e11 >= 127744 && e11 <= 129791 || e11 >= 131072 && e11 <= 262141 ? 2 : 1;
}
function s11(e11) {
  let t17 = 0, n18 = 0;
  for (let r16 of e11) {
    let e12 = r16.codePointAt(0);
    if (e12 === 10 || e12 === 12 || e12 === 11) {
      n18 > t17 && (t17 = n18), n18 = 0;
      continue;
    }
    if (e12 === 13) {
      n18 > t17 && (t17 = n18), n18 = 0;
      continue;
    }
    if (e12 === 9) {
      n18 = Math.floor(n18 / 8) * 8 + 8;
      continue;
    }
    n18 += o9(e12);
  }
  return n18 > t17 && (t17 = n18), t17;
}
function c11(e11) {
  let t17 = new TextDecoder().decode(e11), n18 = 0;
  for (let t18 = 0; t18 < e11.length; t18++) e11[t18] === 10 && n18++;
  let r16 = t17.split(/\s+/).filter((e12) => e12.length > 0).length, i22 = [...t17].length;
  return {
    lines: n18,
    words: r16,
    chars: i22,
    bytes: e11.byteLength,
    maxLine: s11(t17)
  };
}
var l9 = /\s/;
async function u9(e11) {
  let t17 = e11.getReader(), n18 = new TextDecoder(), r16 = {
    lines: 0,
    words: 0,
    chars: 0,
    bytes: 0,
    maxLine: 0
  }, i22 = false, a20 = 0;
  try {
    for (; ; ) {
      let { value: e12, done: s30 } = await t17.read();
      if (s30) break;
      if (!e12 || e12.byteLength === 0) continue;
      r16.bytes += e12.byteLength;
      for (let t18 = 0; t18 < e12.byteLength; t18++) e12[t18] === 10 && r16.lines++;
      let c37 = n18.decode(e12, { stream: true });
      for (let e13 of c37) {
        r16.chars++;
        let t18 = e13.codePointAt(0);
        t18 === 10 || t18 === 12 || t18 === 11 || t18 === 13 ? (a20 > r16.maxLine && (r16.maxLine = a20), a20 = 0) : t18 === 9 ? a20 = Math.floor(a20 / 8) * 8 + 8 : a20 += o9(t18), l9.test(e13) ? i22 = false : i22 || (i22 = true, r16.words++);
      }
    }
    for (let e12 of n18.decode()) r16.chars++;
    a20 > r16.maxLine && (r16.maxLine = a20);
  } finally {
    t17.releaseLock();
  }
  return r16;
}
var d9 = async (e11) => {
  let o23 = t7(e11.args.slice(1), {
    boolean: [
      "l",
      "w",
      "c",
      "m",
      "L",
      "lines",
      "words",
      "bytes",
      "chars",
      "max-line-length"
    ],
    alias: {
      lines: "l",
      words: "w",
      bytes: "c",
      chars: "m",
      "max-line-length": "L"
    },
    unknown: "error"
  }), s30 = e11.args[0] ?? "wc", l38 = e11.stdout.getWriter(), d36 = e11.stderr.getWriter();
  if (o23.unknown.length) try {
    return await g2(d36, 1, h2(s30, o23.unknown[0]));
  } finally {
    await l38.close().catch(() => {
    }), await d36.close().catch(() => {
    });
  }
  let { positionals: f32, flags: p31 } = o23, m24 = !!p31.l, h24 = !!p31.w, g18 = !!p31.c, _21 = !!p31.m, v17 = !!p31.L, y18 = m24 || h24 || g18 || _21 || v17 ? {
    l: m24,
    w: h24,
    c: g18,
    m: _21,
    L: v17
  } : {
    l: true,
    w: true,
    c: true,
    m: false,
    L: false
  }, b17 = [];
  y18.l && b17.push("lines"), y18.w && b17.push("words"), y18.m && b17.push("chars"), y18.c && b17.push("bytes"), y18.L && b17.push("maxLine");
  let x13 = f32.length > 0, S11 = x13 ? f32 : ["-"], C12 = S11.includes("-"), w9 = 0, T7 = {
    lines: 0,
    words: 0,
    chars: 0,
    bytes: 0,
    maxLine: 0
  }, E6 = [];
  try {
    for (let t18 of S11) {
      let n19;
      if (t18 === "-") n19 = await u9(e11.stdin);
      else try {
        n19 = c11(await a8(e11, t18));
      } catch (e12) {
        await p2(d36, `${s30}: ${t18}: ${e12.message ?? "No such file or directory"}
`), w9 = 1;
        continue;
      }
      T7.lines += n19.lines, T7.words += n19.words, T7.chars += n19.chars, T7.bytes += n19.bytes, n19.maxLine > T7.maxLine && (T7.maxLine = n19.maxLine), E6.push({
        counts: n19,
        label: !x13 && t18 === "-" ? "" : t18
      });
    }
    let t17 = S11.length > 1 ? [...E6, {
      counts: T7,
      label: "total"
    }] : E6, n18 = 0;
    (b17.length > 1 || S11.length > 1) && (n18 = C12 ? 7 : String(T7.bytes).length);
    for (let { counts: e12, label: r16 } of t17) {
      let t18 = b17.map((t19) => String(e12[t19]).padStart(n18, " ")).join(" ");
      await p2(l38, r16 ? `${t18} ${r16}
` : `${t18}
`);
    }
  } finally {
    await l38.close().catch(() => {
    }), await d36.close().catch(() => {
    });
  }
  return w9;
};
var f8 = _2(d9);

// mithic/packages/coreutils/dist/commands/head.js
var c12 = -1;
var l10 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EXDEV: "Invalid cross-device link",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
  EIO: "Input/output error"
};
function u10(e11) {
  let t17 = e11?.code;
  return (t17 && l10[t17]) ?? r5(e11);
}
function d10(e11) {
  let t17 = 1e3, n18 = 1024;
  switch (e11) {
    case "":
      return 1;
    case "b":
      return 512;
    case "k":
    case "K":
      return n18;
    case "KB":
      return t17;
    case "m":
    case "M":
      return n18 * n18;
    case "MB":
      return t17 * t17;
    case "G":
      return n18 ** 3;
    case "GB":
      return t17 ** 3;
    case "T":
      return n18 ** 4;
    case "TB":
      return t17 ** 4;
    case "P":
      return n18 ** 5;
    case "PB":
      return t17 ** 5;
    case "E":
      return n18 ** 6;
    case "EB":
      return t17 ** 6;
    case "Z":
      return n18 ** 7;
    case "ZB":
      return t17 ** 7;
    case "Y":
      return n18 ** 8;
    case "YB":
      return t17 ** 8;
    default:
      return;
  }
}
function f9(e11) {
  let t17 = e11, n18 = false;
  t17.startsWith("-") && (n18 = true, t17 = t17.slice(1));
  let r16 = /^([0-9]+)([a-zA-Z]*)$/.exec(t17);
  if (!r16) return;
  let i22 = d10(r16[2]);
  if (i22 !== void 0) return {
    n: Number(r16[1]) * i22,
    fromEnd: n18
  };
}
async function p8(e11, t17, n18, r16) {
  let i22 = n18;
  for (; i22 > 0; ) {
    let n19 = Math.min(i22, 65536), a20 = await e11.syscall("fs/read", {
      fd: t17,
      len: n19
    });
    if (!a20 || a20.byteLength === 0) break;
    let s30 = a20.byteLength > i22 ? a20.subarray(0, i22) : a20;
    await f2(r16, s30), i22 -= s30.byteLength;
  }
}
async function m7(e11, t17, n18, r16) {
  if (n18 <= 0) return;
  let i22 = 0;
  for (; ; ) {
    let a20 = await e11.syscall("fs/read", {
      fd: t17,
      len: 65536
    });
    if (!a20 || a20.byteLength === 0) break;
    let s30 = a20.byteLength;
    for (let e12 = 0; e12 < a20.byteLength; e12++) if (a20[e12] === 10 && (i22++, i22 === n18)) {
      s30 = e12 + 1;
      break;
    }
    if (await f2(r16, s30 === a20.byteLength ? a20 : a20.subarray(0, s30)), i22 >= n18) return;
  }
}
async function h7(e11, t17, n18) {
  if (t17 <= 0) return c12;
  let r16 = e11.getReader(), i22 = t17;
  try {
    for (; i22 > 0; ) {
      let { value: e12, done: t18 } = await r16.read();
      if (t18) return 0;
      if (!e12 || e12.byteLength === 0) continue;
      let a20 = e12.byteLength > i22 ? e12.subarray(0, i22) : e12;
      await f2(n18, a20), i22 -= a20.byteLength;
    }
    return c12;
  } finally {
    r16.releaseLock();
  }
}
async function g6(e11, t17, n18) {
  if (t17 <= 0) return c12;
  let r16 = e11.getReader(), i22 = 0;
  try {
    for (; ; ) {
      let { value: e12, done: a20 } = await r16.read();
      if (a20) return 0;
      if (!e12 || e12.byteLength === 0) continue;
      let s30 = e12.byteLength;
      for (let n19 = 0; n19 < e12.byteLength; n19++) if (e12[n19] === 10 && (i22++, i22 === t17)) {
        s30 = n19 + 1;
        break;
      }
      if (await f2(n18, s30 === e12.byteLength ? e12 : e12.subarray(0, s30)), i22 >= t17) return c12;
    }
  } finally {
    r16.releaseLock();
  }
}
function _6(e11, t17) {
  if (t17 <= 0) return e11;
  let n18 = Math.max(0, e11.byteLength - t17);
  return e11.subarray(0, n18);
}
function v5(e11, t17) {
  if (t17 <= 0) return e11;
  let n18 = [0];
  for (let t18 = 0; t18 < e11.byteLength; t18++) e11[t18] === 10 && t18 + 1 < e11.byteLength && n18.push(t18 + 1);
  let r16 = n18.length - t17;
  return r16 <= 0 ? new Uint8Array() : e11.subarray(0, n18[r16]);
}
function y5(e11) {
  let t17, n18 = [];
  for (let r16 = 0; r16 < e11.length; r16++) {
    let i22 = e11[r16];
    if (i22 === "--") {
      n18.push(...e11.slice(r16));
      break;
    }
    if (i22 === "-n" || i22 === "-c" || i22 === "--lines" || i22 === "--bytes") {
      n18.push(i22), e11[r16 + 1] !== void 0 && n18.push(e11[++r16]);
      continue;
    }
    let a20 = /^-([0-9]+)$/.exec(i22);
    if (a20) {
      t17 = Number(a20[1]);
      continue;
    }
    n18.push(i22);
  }
  return {
    filtered: n18,
    legacyN: t17
  };
}
function b4(e11) {
  let t17;
  for (let n18 = 0; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 === "--") break;
    if (r16 === "-c" || r16 === "--bytes" || r16.startsWith("--bytes=") || r16.startsWith("-c") && !r16.startsWith("--")) {
      t17 = "c", (r16 === "-c" || r16 === "--bytes") && e11[n18 + 1] !== void 0 && n18++;
      continue;
    }
    if (r16 === "-n" || r16 === "--lines" || r16.startsWith("--lines=") || r16.startsWith("-n") && !r16.startsWith("--")) {
      t17 = "n", (r16 === "-n" || r16 === "--lines") && e11[n18 + 1] !== void 0 && n18++;
      continue;
    }
  }
  return t17;
}
var x2 = async (e11) => {
  let n18 = e11.args.slice(1), l38 = e11.args[0] ?? "head", { filtered: d36, legacyN: x13 } = y5(n18), C12 = t7(d36, {
    string: [
      "n",
      "c",
      "lines",
      "bytes"
    ],
    boolean: [
      "q",
      "v",
      "z",
      "quiet",
      "silent",
      "verbose",
      "zero-terminated"
    ],
    alias: {
      lines: "n",
      bytes: "c",
      quiet: "q",
      silent: "q",
      verbose: "v",
      "zero-terminated": "z"
    },
    unknown: "error"
  }), { positionals: w9, flags: T7 } = C12, E6 = e11.stdout.getWriter(), D6 = e11.stderr.getWriter(), O6 = 0, k5 = 0, A4 = false;
  try {
    if (C12.unknown.length) return await g2(D6, 1, h2(l38, C12.unknown[0]));
    let n19 = b4(d36), i22 = T7.c !== void 0 && (T7.n === void 0 || n19 === "c"), y18;
    if (i22) {
      let e12 = f9(String(T7.c));
      if (e12 === void 0) return await g2(D6, 1, `${l38}: invalid number of bytes: \u2018${T7.c}\u2019`);
      y18 = e12;
    } else if (T7.n !== void 0) {
      let e12 = f9(String(T7.n));
      if (e12 === void 0) return await g2(D6, 1, `${l38}: invalid number of lines: \u2018${T7.n}\u2019`);
      y18 = e12;
    } else y18 = {
      n: x13 === void 0 ? 10 : x13,
      fromEnd: false
    };
    let j4 = w9.length > 0 ? w9 : ["-"], M4 = !!T7.v || j4.length > 1 && !T7.q;
    for (let t17 of j4) if (t17 === "-") if (M4 && await p2(E6, `${k5 > 0 ? "\n" : ""}==> standard input <==
`), k5++, y18.fromEnd) {
      let t18 = await o3(e11.stdin);
      await f2(E6, i22 ? _6(t18, y18.n) : v5(t18, y18.n));
    } else (i22 ? await h7(e11.stdin, Math.max(0, y18.n), E6) : await g6(e11.stdin, y18.n, E6)) === c12 && (A4 = true);
    else {
      let n20;
      try {
        ({ fd: n20 } = await e11.syscall("fs/open", {
          path: t17,
          oflags: {}
        }));
      } catch (e12) {
        await p2(D6, `${l38}: cannot open '${t17}' for reading: ${u10(e12)}
`), O6 = 1;
        continue;
      }
      M4 && await p2(E6, `${k5 > 0 ? "\n" : ""}==> ${t17} <==
`), k5++;
      try {
        if (y18.fromEnd) {
          let t18 = await S2(e11, n20);
          await f2(E6, i22 ? _6(t18, y18.n) : v5(t18, y18.n));
        } else i22 ? await p8(e11, n20, Math.max(0, y18.n), E6) : await m7(e11, n20, y18.n, E6);
      } finally {
        await e11.syscall("fs/close", { fd: n20 }).catch(() => {
        });
      }
    }
  } finally {
    await E6.close().catch(() => {
    }), await D6.close().catch(() => {
    }), A4 && await e11.stdin.cancel().catch(() => {
    });
  }
  return O6;
};
async function S2(e11, t17) {
  let n18 = [], r16 = 0;
  for (; ; ) {
    let i23 = await e11.syscall("fs/read", {
      fd: t17,
      len: 65536
    });
    if (!i23 || i23.byteLength === 0) break;
    n18.push(i23), r16 += i23.byteLength;
  }
  let i22 = new Uint8Array(r16), a20 = 0;
  for (let e12 of n18) i22.set(e12, a20), a20 += e12.byteLength;
  return i22;
}
var C2 = _2(x2);

// mithic/packages/coreutils/dist/commands/tail.js
var s12 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EXDEV: "Invalid cross-device link",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
  EIO: "Input/output error"
};
function c13(e11) {
  let t17 = e11?.code;
  return (t17 && s12[t17]) ?? r5(e11);
}
function l11(e11) {
  let t17 = 1e3, n18 = 1024;
  switch (e11) {
    case "":
      return 1;
    case "b":
      return 512;
    case "k":
    case "K":
      return n18;
    case "KB":
      return t17;
    case "m":
    case "M":
      return n18 * n18;
    case "MB":
      return t17 * t17;
    case "G":
      return n18 ** 3;
    case "GB":
      return t17 ** 3;
    case "T":
      return n18 ** 4;
    case "TB":
      return t17 ** 4;
    case "P":
      return n18 ** 5;
    case "PB":
      return t17 ** 5;
    case "E":
      return n18 ** 6;
    case "EB":
      return t17 ** 6;
    case "Z":
      return n18 ** 7;
    case "ZB":
      return t17 ** 7;
    case "Y":
      return n18 ** 8;
    case "YB":
      return t17 ** 8;
    default:
      return;
  }
}
async function u11(e11, t17, n18, r16) {
  let i22 = e11.getReader();
  try {
    if (t17.fromStart) {
      await d11(i22, t17, n18, r16);
      return;
    }
    if (n18) {
      let e13 = t17.n;
      if (e13 <= 0) return;
      let n19 = new Uint8Array(e13), o24 = 0, s31 = 0;
      for (; ; ) {
        let { value: t18, done: r17 } = await i22.read();
        if (r17) break;
        if (!(!t18 || t18.byteLength === 0)) for (let r18 = 0; r18 < t18.byteLength; r18++) n19[(s31 + o24) % e13] = t18[r18], o24 < e13 ? o24++ : s31 = (s31 + 1) % e13;
      }
      let c37 = new Uint8Array(o24);
      for (let t18 = 0; t18 < o24; t18++) c37[t18] = n19[(s31 + t18) % e13];
      await f2(r16, c37);
      return;
    }
    let e12 = t17.n;
    if (e12 <= 0) return;
    let o23 = [], s30 = [];
    for (; ; ) {
      let { value: t18, done: n19 } = await i22.read();
      if (n19) break;
      if (!(!t18 || t18.byteLength === 0)) for (let n20 = 0; n20 < t18.byteLength; n20++) s30.push(t18[n20]), t18[n20] === 10 && (o23.push(new Uint8Array(s30)), o23.length > e12 && o23.shift(), s30 = []);
    }
    s30.length > 0 && (o23.push(new Uint8Array(s30)), o23.length > e12 && o23.shift());
    for (let e13 of o23) await f2(r16, e13);
  } finally {
    i22.releaseLock();
  }
}
async function d11(e11, t17, n18, r16) {
  if (n18) {
    let n19 = Math.max(0, Math.max(1, t17.n) - 1);
    for (; ; ) {
      let { value: t18, done: i23 } = await e11.read();
      if (i23) break;
      if (!t18 || t18.byteLength === 0) continue;
      if (n19 >= t18.byteLength) {
        n19 -= t18.byteLength;
        continue;
      }
      let o24 = n19 > 0 ? t18.subarray(n19) : t18;
      n19 = 0, await f2(r16, o24);
    }
    return;
  }
  let i22 = Math.max(1, t17.n), o23 = 1, s30 = i22 <= 1;
  for (; ; ) {
    let { value: t18, done: n19 } = await e11.read();
    if (n19) break;
    if (!t18 || t18.byteLength === 0) continue;
    if (s30) {
      await f2(r16, t18);
      continue;
    }
    let c37 = 0;
    for (; c37 < t18.byteLength; c37++) if (t18[c37] === 10 && (o23++, o23 === i22)) {
      c37++;
      break;
    }
    o23 === i22 && (s30 = true, c37 < t18.byteLength && await f2(r16, t18.subarray(c37)));
  }
}
async function f10(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return i22;
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
function p9(e11) {
  let t17 = e11, n18 = false;
  t17.startsWith("+") ? (n18 = true, t17 = t17.slice(1)) : t17.startsWith("-") && (t17 = t17.slice(1));
  let r16 = /^([0-9]+)([a-zA-Z]*)$/.exec(t17);
  if (!r16) return;
  let i22 = l11(r16[2]);
  if (i22 !== void 0) return {
    n: Number(r16[1]) * i22,
    fromStart: n18
  };
}
function m8(e11) {
  let t17, n18 = [];
  for (let r16 = 0; r16 < e11.length; r16++) {
    let i22 = e11[r16];
    if (i22 === "--") {
      n18.push(...e11.slice(r16));
      break;
    }
    if (i22 === "-n" || i22 === "-c" || i22 === "--lines" || i22 === "--bytes") {
      n18.push(i22), e11[r16 + 1] !== void 0 && n18.push(e11[++r16]);
      continue;
    }
    let a20 = /^-([0-9]+[a-zA-Z]*)$/.exec(i22);
    if (a20) {
      t17 = a20[1];
      continue;
    }
    n18.push(i22);
  }
  return {
    filtered: n18,
    legacy: t17
  };
}
function h8(e11) {
  let t17;
  for (let n18 = 0; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 === "--") break;
    if (r16 === "-c" || r16 === "--bytes" || r16.startsWith("--bytes=") || r16.startsWith("-c") && !r16.startsWith("--")) {
      t17 = "c", (r16 === "-c" || r16 === "--bytes") && e11[n18 + 1] !== void 0 && n18++;
      continue;
    }
    if (r16 === "-n" || r16 === "--lines" || r16.startsWith("--lines=") || r16.startsWith("-n") && !r16.startsWith("--")) {
      t17 = "n", (r16 === "-n" || r16 === "--lines") && e11[n18 + 1] !== void 0 && n18++;
      continue;
    }
  }
  return t17;
}
function g7(e11) {
  let t17 = (e12) => e12 !== void 0 && e12.trimStart().startsWith("+");
  for (let n18 = 0; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 === "--") break;
    if (r16 === "-c" || r16 === "-n" || r16 === "--bytes" || r16 === "--lines") {
      if (t17(e11[n18 + 1])) return true;
      e11[n18 + 1] !== void 0 && n18++;
      continue;
    }
    if (r16.startsWith("--bytes=")) {
      if (t17(r16.slice(8))) return true;
      continue;
    }
    if (r16.startsWith("--lines=")) {
      if (t17(r16.slice(8))) return true;
      continue;
    }
    if ((r16.startsWith("-c") || r16.startsWith("-n")) && !r16.startsWith("--") && r16.length > 2 && t17(r16.slice(2))) return true;
  }
  return false;
}
function _7(e11, t17) {
  let n18 = [0];
  for (let t18 = 0; t18 < e11.length; t18++) e11[t18] === 10 && t18 + 1 < e11.length && n18.push(t18 + 1);
  if (t17.fromStart) {
    let r17 = Math.max(1, t17.n) - 1;
    return r17 >= n18.length ? new Uint8Array() : e11.subarray(n18[r17]);
  }
  if (t17.n <= 0) return new Uint8Array();
  let r16 = n18, i22 = Math.max(0, r16.length - t17.n);
  return e11.subarray(r16[i22]);
}
function v6(e11, t17) {
  if (t17.fromStart) {
    let n18 = Math.max(1, t17.n) - 1;
    return n18 >= e11.length ? new Uint8Array() : e11.subarray(n18);
  }
  return t17.n <= 0 ? new Uint8Array() : e11.subarray(Math.max(0, e11.length - t17.n));
}
var y6 = async (e11) => {
  let n18 = e11.args[0] ?? "tail", { filtered: s30, legacy: l38 } = m8(e11.args.slice(1)), d36 = t7(s30, {
    string: [
      "n",
      "c",
      "lines",
      "bytes"
    ],
    boolean: [
      "q",
      "v",
      "z",
      "quiet",
      "silent",
      "verbose",
      "zero-terminated",
      "f",
      "follow"
    ],
    alias: {
      lines: "n",
      bytes: "c",
      quiet: "q",
      silent: "q",
      verbose: "v",
      "zero-terminated": "z",
      follow: "f"
    },
    unknown: "error"
  }), { positionals: y18, flags: b17 } = d36, x13 = e11.stdout.getWriter(), S11 = e11.stderr.getWriter(), C12 = 0, w9 = 0;
  try {
    if (d36.unknown.length) return await g2(S11, 1, h2(n18, d36.unknown[0]));
    let i22 = h8(s30), m24 = b17.c !== void 0 && (b17.n === void 0 || i22 === "c"), T7;
    if (m24) {
      let e12 = p9(String(b17.c));
      if (e12 === void 0) return await g2(S11, 1, `${n18}: invalid number of bytes: \u2018${b17.c}\u2019`);
      T7 = e12;
    } else if (b17.n !== void 0) {
      let e12 = p9(String(b17.n));
      if (e12 === void 0) return await g2(S11, 1, `${n18}: invalid number of lines: \u2018${b17.n}\u2019`);
      T7 = e12;
    } else if (l38 !== void 0) {
      let e12 = p9("-" + l38);
      if (e12 === void 0) return await g2(S11, 1, `${n18}: invalid number of lines: \u2018${l38}\u2019`);
      T7 = e12;
    } else T7 = {
      n: 10,
      fromStart: false
    };
    !T7.fromStart && g7(s30) && (T7 = {
      n: T7.n,
      fromStart: true
    });
    let E6 = y18.length > 0 ? y18 : ["-"], D6 = !!b17.v || E6.length > 1 && !b17.q;
    b17.f && await p2(S11, `${n18}: -f (follow) is not supported; reading to EOF
`);
    for (let t17 of E6) {
      if (t17 === "-") {
        D6 && await p2(x13, `${w9 > 0 ? "\n" : ""}==> standard input <==
`), w9++, await u11(e11.stdin, T7, m24, x13);
        continue;
      }
      let r16;
      try {
        r16 = await f10(e11, t17);
      } catch (e12) {
        await p2(S11, `${n18}: cannot open '${t17}' for reading: ${c13(e12)}
`), C12 = 1;
        continue;
      }
      D6 && await p2(x13, `${w9 > 0 ? "\n" : ""}==> ${t17} <==
`), w9++, await f2(x13, m24 ? v6(r16, T7) : _7(r16, T7));
    }
  } finally {
    await x13.close().catch(() => {
    }), await S11.close().catch(() => {
    });
  }
  return C12;
};
var b5 = _2(y6);

// mithic/packages/coreutils/dist/commands/sort.js
var o10 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EXDEV: "Invalid cross-device link",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
  EIO: "Input/output error"
};
function s13(e11) {
  let n18 = e11?.code;
  return (n18 && o10[n18]) ?? r5(e11);
}
function c14(e11) {
  if (e11.includes("n")) return "numeric";
  if (e11.includes("h")) return "human";
  if (e11.includes("g")) return "general";
  if (e11.includes("V")) return "version";
  if (e11.includes("M")) return "month";
}
var l12 = class extends Error {
};
function u12(e11) {
  let [t17, n18] = e11.split(","), r16 = (e12) => {
    let t18 = /^([0-9]+)(?:\.([0-9]+))?([a-zA-Z]*)$/.exec(e12);
    return t18 ? {
      field: Number(t18[1]),
      char: t18[2] ? Number(t18[2]) : 0,
      charGiven: t18[2] !== void 0,
      flags: t18[3] ?? ""
    } : {
      field: 1,
      char: 0,
      charGiven: false,
      flags: ""
    };
  }, i22 = r16(t17);
  if (i22.field === 0) throw new l12(`field number is zero: invalid field specification \u2018${e11}\u2019`);
  if (i22.charGiven && i22.char === 0) throw new l12(`character offset is zero: invalid field specification \u2018${e11}\u2019`);
  let a20 = i22.flags + (n18 === void 0 ? "" : r16(n18).flags), o23 = {
    startField: i22.field,
    startChar: i22.char > 0 ? i22.char : 1
  };
  if (n18 !== void 0) {
    let t18 = r16(n18);
    if (t18.field === 0) throw new l12(`field number is zero: invalid field specification \u2018${e11}\u2019`);
    o23.endField = t18.field, t18.char > 0 && (o23.endChar = t18.char);
  }
  let s30 = c14(a20);
  return s30 !== void 0 && (o23.kind = s30), a20.includes("r") && (o23.reverse = true), a20.includes("f") && (o23.fold = true), a20.includes("b") && (o23.ignoreBlanks = true), o23;
}
var d12 = /* @__PURE__ */ new Set([
  "t",
  "o",
  "k"
]);
function f11(e11) {
  let t17 = [];
  for (let n18 = 0; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 === "--") break;
    if (r16 === "-k" || r16 === "--key") {
      e11[n18 + 1] !== void 0 && t17.push(e11[++n18]);
      continue;
    }
    if (r16.startsWith("--key=")) {
      t17.push(r16.slice(6));
      continue;
    }
    if (r16.startsWith("--") || !r16.startsWith("-") || r16.length < 2) continue;
    let i22 = r16.slice(1);
    for (let r17 = 0; r17 < i22.length; r17++) {
      let a20 = i22[r17];
      if (d12.has(a20)) {
        let o23 = i22.slice(r17 + 1), s30 = o23.length > 0 ? o23 : e11[n18 + 1] === void 0 ? void 0 : e11[++n18];
        a20 === "k" && s30 !== void 0 && t17.push(s30);
        break;
      }
    }
  }
  return t17;
}
function p10(e11, t17, n18) {
  let r16 = n18 === void 0 ? m9(e11) : e11.split(n18), i22 = t17.startField - 1, a20 = t17.endField === void 0 ? r16.length : t17.endField;
  if (i22 >= r16.length) return "";
  let o23 = n18 === void 0 ? " " : n18, s30 = r16.slice(i22, Math.max(i22, a20)).join(o23);
  return t17.endChar !== void 0 && t17.endField !== void 0 && t17.startField === t17.endField && (s30 = s30.slice(0, t17.endChar)), t17.startChar > 1 && (s30 = s30.slice(t17.startChar - 1)), s30;
}
function m9(e11) {
  return e11.replace(/^\s+/, "").split(/\s+/);
}
function h9(e11) {
  let t17 = /^\s*([+-]?[0-9]*\.?[0-9]+)\s*([kKMGTPEZY]?)/.exec(e11);
  return t17 ? parseFloat(t17[1]) * 1024 ** ({
    "": 0,
    K: 1,
    M: 2,
    G: 3,
    T: 4,
    P: 5,
    E: 6,
    Z: 7,
    Y: 8
  }[t17[2].toUpperCase()] ?? 0) : 0;
}
function g8(e11) {
  let t17 = e11.trim(), n18 = /^([+-]?)(inf(?:inity)?|nan)/i.exec(t17);
  if (n18) return /nan/i.test(n18[2]) ? NaN : n18[1] === "-" ? -Infinity : Infinity;
  let r16 = parseFloat(t17);
  return Number.isNaN(r16) ? NaN : r16;
}
function _8(e11, t17) {
  let n18 = g8(e11), r16 = g8(t17), i22 = Number.isNaN(n18), a20 = Number.isNaN(r16);
  return i22 && a20 ? 0 : i22 ? -1 : a20 ? 1 : n18 < r16 ? -1 : +(n18 > r16);
}
var v7 = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC"
];
function y7(e11) {
  let t17 = e11.replace(/^\s+/, "").slice(0, 3).toUpperCase(), n18 = v7.indexOf(t17);
  return n18 < 0 ? 0 : n18 + 1;
}
function b6(e11, t17) {
  let n18 = 0, r16 = 0, i22 = (e12) => e12 >= "0" && e12 <= "9", a20 = (e12) => e12 === void 0 ? 0 : e12 === "~" ? -1 : i22(e12) ? 0 : /[a-zA-Z]/.test(e12) ? e12.charCodeAt(0) : e12.charCodeAt(0) + 256;
  for (; n18 < e11.length || r16 < t17.length; ) {
    for (; n18 < e11.length && !i22(e11[n18]) || r16 < t17.length && !i22(t17[r16]); ) {
      let o24 = n18 < e11.length && !i22(e11[n18]) ? e11[n18] : void 0, s30 = r16 < t17.length && !i22(t17[r16]) ? t17[r16] : void 0, c37 = a20(o24) - a20(s30);
      if (c37 !== 0) return c37 < 0 ? -1 : 1;
      o24 !== void 0 && n18++, s30 !== void 0 && r16++;
    }
    for (; e11[n18] === "0"; ) n18++;
    for (; t17[r16] === "0"; ) r16++;
    let o23 = 0;
    for (; i22(e11[n18]) && i22(t17[r16]); ) o23 === 0 && (o23 = e11.charCodeAt(n18) - t17.charCodeAt(r16)), n18++, r16++;
    if (i22(e11[n18])) return 1;
    if (i22(t17[r16])) return -1;
    if (o23 !== 0) return o23 < 0 ? -1 : 1;
  }
  return 0;
}
function x3(e11, t17, n18, r16) {
  switch (n18) {
    case "numeric": {
      let n19 = parseFloat(e11), r17 = parseFloat(t17), i22 = Number.isNaN(n19) ? 0 : n19, a20 = Number.isNaN(r17) ? 0 : r17;
      return i22 < a20 ? -1 : +(i22 > a20);
    }
    case "human": {
      let n19 = h9(e11), r17 = h9(t17);
      return n19 < r17 ? -1 : +(n19 > r17);
    }
    case "general":
      return _8(e11, t17);
    case "version":
      return b6(e11, t17);
    case "month": {
      let n19 = y7(e11), r17 = y7(t17);
      return n19 < r17 ? -1 : +(n19 > r17);
    }
    default: {
      let n19 = e11, i22 = t17;
      return r16 && (n19 = n19.toUpperCase(), i22 = i22.toUpperCase()), n19 < i22 ? -1 : +(n19 > i22);
    }
  }
}
async function S3(e11, t17, n18) {
  let r16 = await C3(e11, t17);
  return w2(new TextDecoder().decode(r16), n18);
}
async function C3(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return i22;
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
function w2(e11, t17) {
  let n18 = t17 ? "\0" : "\n";
  return e11 === "" ? [] : (e11.endsWith(n18) ? e11.slice(0, -1) : e11).split(n18);
}
function T2(e11) {
  let t17, n18 = [];
  for (let r16 = 0; r16 < e11.length; r16++) {
    let i22 = e11[r16];
    if (i22 === "--") {
      n18.push(...e11.slice(r16));
      break;
    }
    if (i22 === "-o" || i22 === "--output") {
      e11[r16 + 1] !== void 0 && (t17 = e11[++r16]);
      continue;
    }
    if (i22.startsWith("--output=")) {
      t17 = i22.slice(9);
      continue;
    }
    if (i22.startsWith("-o") && i22.length > 2 && !i22.startsWith("--")) {
      t17 = i22.slice(2);
      continue;
    }
    n18.push(i22);
  }
  return {
    output: t17,
    filtered: n18
  };
}
var E2 = async (e11) => {
  let t17 = e11.args[0] ?? "sort", { output: o23, filtered: c37 } = T2(e11.args.slice(1)), d36 = t7(c37, {
    boolean: /* @__PURE__ */ "n.r.u.f.b.h.g.V.M.c.C.z.s.d.i.m.R.numeric-sort.human-numeric-sort.general-numeric-sort.version-sort.month-sort.reverse.unique.ignore-case.ignore-leading-blanks.check.zero-terminated.stable.dictionary-order.ignore-nonprinting.merge.random-sort".split("."),
    string: [
      "t",
      "k",
      "field-separator",
      "key",
      "S",
      "T",
      "buffer-size",
      "temporary-directory",
      "parallel",
      "compress-program",
      "batch-size"
    ],
    alias: {
      "numeric-sort": "n",
      "human-numeric-sort": "h",
      "general-numeric-sort": "g",
      "version-sort": "V",
      "month-sort": "M",
      reverse: "r",
      unique: "u",
      "ignore-case": "f",
      "ignore-leading-blanks": "b",
      "field-separator": "t",
      key: "k",
      "zero-terminated": "z",
      stable: "s",
      "dictionary-order": "d",
      "ignore-nonprinting": "i",
      merge: "m",
      "random-sort": "R",
      "buffer-size": "S",
      "temporary-directory": "T"
    },
    unknown: "error"
  }), { positionals: m24, flags: h24 } = d36, g18 = !!h24.r, _21 = !!h24.u, v17 = !!h24.f, y18 = !!h24.b, b17 = !!h24.z, C12 = !!h24.d, E6 = !!h24.i, O6 = !!h24.R, k5 = !!h24.m, A4 = !!h24.s, j4 = h24.t === void 0 ? void 0 : String(h24.t), M4 = !!h24.C, N4 = !!h24.c || M4, P4 = h24.n ? "numeric" : h24.h ? "human" : h24.g ? "general" : h24.V ? "version" : h24.M ? "month" : "lex", F4 = e11.stdout.getWriter(), I4 = e11.stderr.getWriter(), L3 = 0;
  try {
    if (d36.unknown.length) return await p2(I4, `${h2(t17, d36.unknown[0])}
`), 2;
    if (h24.t !== void 0 && String(h24.t) === "") return await p2(I4, `${t17}: empty tab
`), 2;
    if (C12 || E6) {
      let e12 = h24.n ? "n" : h24.g ? "g" : h24.M ? "M" : h24.h ? "h" : void 0;
      if (e12 !== void 0) {
        let n18 = C12 ? "d" : "i", r17 = [
          "d",
          "g",
          "h",
          "i",
          "M",
          "n"
        ];
        return await p2(I4, `${t17}: options '-${[n18, e12].sort((e13, t18) => r17.indexOf(e13) - r17.indexOf(t18)).join("")}' are incompatible
`), 2;
      }
    }
    let r16;
    try {
      r16 = f11(c37).map(u12);
    } catch (e12) {
      if (e12 instanceof l12) return await p2(I4, `${t17}: ${e12.message}
`), 2;
      throw e12;
    }
    let T7 = m24.length > 0 ? m24 : ["-"], R3 = [], z3 = [];
    for (let n18 of T7) if (n18 === "-") {
      let t18 = w2(new TextDecoder().decode(await o3(e11.stdin)), b17);
      R3 = R3.concat(t18), z3.push(t18);
    } else try {
      let t18 = await S3(e11, n18, b17);
      R3 = R3.concat(t18), z3.push(t18);
    } catch (e12) {
      await p2(I4, `${t17}: cannot read: ${n18}: ${s13(e12)}
`), L3 = 1;
    }
    let B3 = (e12) => {
      let t18 = e12;
      return C12 && (t18 = t18.replace(/[^0-9A-Za-z \t]/g, "")), E6 && (t18 = t18.replace(/[^\x20-\x7e]/g, "")), t18;
    }, V = (e12, t18) => {
      let n18 = p10(e12, t18, j4);
      return (t18.ignoreBlanks || y18) && (n18 = n18.replace(/^\s+/, "")), B3(n18);
    }, H = (e12) => B3(y18 ? e12.replace(/^\s+/, "") : e12), U = (e12, t18) => {
      for (let n18 of r16) {
        let r17 = n18.kind ?? P4, i22 = v17 || !!n18.fold, a20 = x3(V(e12, n18), V(t18, n18), r17, i22);
        if (n18.reverse && (a20 = -a20), a20 !== 0) return a20;
      }
      return 0;
    }, W = (e12, t18) => {
      if (r16.length === 0) {
        let n19 = x3(H(e12), H(t18), P4, v17);
        if (n19 !== 0) return g18 ? -n19 : n19;
        if (P4 === "lex" && !(C12 || E6 || v17) || A4 || _21) return 0;
        let r17 = x3(e12, t18, "lex", false);
        return g18 ? -r17 : r17;
      }
      let n18 = U(e12, t18);
      if (n18 !== 0) return g18 ? -n18 : n18;
      if (A4 || _21) return 0;
      let i22 = x3(e12, t18, "lex", false);
      return g18 ? -i22 : i22;
    }, G = (e12, t18) => r16.length === 0 ? x3(H(e12), H(t18), P4, v17) === 0 : U(e12, t18) === 0, K = b17 ? "\0" : "\n";
    if (N4) {
      for (let e12 = 1; e12 < R3.length; e12++) {
        let n18 = W(R3[e12 - 1], R3[e12]);
        if (_21 ? n18 >= 0 : n18 > 0) return M4 || await p2(I4, `${t17}: ${T7.length === 1 && T7[0] !== "-" ? T7[0] : "-"}:${e12 + 1}: disorder: ${R3[e12]}
`), 1;
      }
      return L3;
    }
    let q;
    if (k5) {
      let e12 = z3.map(() => 0);
      for (q = []; ; ) {
        let t18 = -1;
        for (let n18 = 0; n18 < z3.length; n18++) e12[n18] >= z3[n18].length || (t18 === -1 || W(z3[n18][e12[n18]], z3[t18][e12[t18]]) < 0) && (t18 = n18);
        if (t18 === -1) break;
        q.push(z3[t18][e12[t18]++]);
      }
    } else if (O6) {
      q = R3.slice();
      for (let e12 = q.length - 1; e12 > 0; e12--) {
        let t18 = Math.floor(Math.random() * (e12 + 1));
        [q[e12], q[t18]] = [q[t18], q[e12]];
      }
    } else {
      let e12 = R3.map((e13, t18) => ({
        line: e13,
        idx: t18
      }));
      e12.sort((e13, t18) => {
        let n18 = W(e13.line, t18.line);
        return n18 === 0 ? e13.idx - t18.idx : n18;
      }), q = e12.map((e13) => e13.line);
    }
    if (_21) {
      let e12 = [], t18;
      for (let n18 of q) (t18 === void 0 || !G(t18, n18)) && e12.push(n18), t18 = n18;
      q = e12;
    }
    let J = q.length > 0 ? q.join(K) + K : "";
    return o23 === void 0 ? J !== "" && await p2(F4, J) : await D2(e11, o23, J), L3;
  } finally {
    await F4.close().catch(() => {
    }), await I4.close().catch(() => {
    });
  }
};
async function D2(e11, t17, n18) {
  let r16 = new TextEncoder().encode(n18), { fd: i22 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {
      write: true,
      create: true,
      truncate: true
    }
  });
  try {
    let t18 = 0;
    for (; t18 < r16.byteLength; ) {
      let n19 = r16.subarray(t18, t18 + 65536), { written: a20 } = await e11.syscall("fs/write", {
        fd: i22,
        data: n19
      });
      if (a20 <= 0) break;
      t18 += a20;
    }
  } finally {
    await e11.syscall("fs/close", { fd: i22 }).catch(() => {
    });
  }
}
var O2 = _2(E2);

// mithic/packages/coreutils/dist/commands/seq.js
var a9 = /^[+-]?0[xX][0-9a-fA-F]*\.?[0-9a-fA-F]*[pP][+-]?\d+$/;
var o11 = /^[+-]?(0[xX][0-9a-fA-F]*\.?[0-9a-fA-F]*[pP][+-]?\d+|0[xX][0-9a-fA-F]+|\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
var s14 = /^[+-]?\d+$/;
function c15(e11) {
  if (a9.test(e11)) {
    let t18 = e11[0] === "-", n18 = e11.replace(/^[+-]/, "");
    n18 = n18.slice(2);
    let [r16, i22] = n18.split(/[pP]/), [a20, o23 = ""] = r16.split("."), s30 = parseInt(a20 || "0", 16);
    for (let e12 = 0; e12 < o23.length; e12++) s30 += parseInt(o23[e12], 16) / 16 ** (e12 + 1);
    return s30 *= 2 ** parseInt(i22, 10), t18 ? -s30 : s30;
  }
  let t17 = /^([+-])(0[xX][0-9a-fA-F]+)$/.exec(e11);
  if (t17) {
    let e12 = Number(t17[2]);
    return t17[1] === "-" ? -e12 : e12;
  }
  return Number(e11);
}
function l13(e11, t17) {
  let n18 = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
  n18.setFloat64(0, e11);
  let r16 = n18.getUint32(0), i22 = n18.getUint32(4), a20 = r16 >>> 20 & 2047, o23 = BigInt(r16 & 1048575) << 32n | BigInt(i22 >>> 0), s30;
  if (a20 === 0 ? s30 = -1074 : (o23 |= 1n << 52n, s30 = a20 - 1075), o23 === 0n) return 0n;
  let c37 = o23, l38 = 1n;
  t17 >= 0 ? c37 *= 10n ** BigInt(t17) : l38 *= 10n ** BigInt(-t17), s30 >= 0 ? c37 <<= BigInt(s30) : l38 <<= BigInt(-s30);
  let u37 = c37 / l38, d36 = (c37 - u37 * l38) * 2n;
  return (d36 > l38 || d36 === l38 && u37 % 2n == 1n) && (u37 += 1n), u37;
}
function u13(e11, t17) {
  if (!Number.isFinite(e11)) return Math.abs(e11).toFixed(Math.min(t17, 100));
  let n18 = l13(e11, t17).toString();
  if (t17 === 0) return n18;
  let r16 = n18.padStart(t17 + 1, "0");
  return r16.slice(0, r16.length - t17) + "." + r16.slice(r16.length - t17);
}
function d13(e11, t17, n18) {
  let r16 = n18 ? "E" : "e";
  if (!Number.isFinite(e11)) return m10(Math.abs(e11).toExponential(t17));
  if (e11 === 0) return (t17 > 0 ? "0." + "0".repeat(t17) : "0") + r16 + "+00";
  let i22 = t17 + 1, a20 = Math.floor(Math.log10(e11)), o23 = l13(e11, t17 - a20);
  for (; o23.toString().length > i22; ) a20 += 1, o23 = l13(e11, t17 - a20);
  for (; o23 !== 0n && o23.toString().length < i22; ) --a20, o23 = l13(e11, t17 - a20);
  let s30 = o23.toString().padStart(i22, "0"), c37 = t17 > 0 ? s30[0] + "." + s30.slice(1) : s30, u37 = a20 < 0 ? "-" : "+";
  return c37 + r16 + u37 + String(Math.abs(a20)).padStart(2, "0");
}
function f12(e11, t17, n18) {
  if (t17 < 1 && (t17 = 1), e11 === 0) return "0";
  if (!Number.isFinite(e11)) return d13(e11, t17 - 1, n18);
  let r16 = Math.floor(Math.log10(e11)), i22 = l13(e11, t17 - 1 - r16);
  for (; i22.toString().length > t17; ) r16 += 1, i22 = l13(e11, t17 - 1 - r16);
  for (; i22 !== 0n && i22.toString().length < t17; ) --r16, i22 = l13(e11, t17 - 1 - r16);
  let a20;
  return r16 < -4 || r16 >= t17 ? (a20 = d13(e11, t17 - 1, n18), a20 = a20.replace(/\.?0+([eE])/, "$1")) : (a20 = u13(e11, Math.max(0, t17 - 1 - r16)), a20.includes(".") && (a20 = a20.replace(/\.?0+$/, ""))), a20;
}
function p11(e11, t17) {
  let n18 = "", r16 = 0;
  for (; r16 < e11.length; ) if (e11[r16] === "%" && r16 + 1 < e11.length) {
    r16++;
    let i22 = "";
    for (; r16 < e11.length && "-+0 #".includes(e11[r16]); ) i22 += e11[r16++];
    let a20 = "";
    for (; r16 < e11.length && e11[r16] >= "0" && e11[r16] <= "9"; ) a20 += e11[r16++];
    let o23 = "";
    if (e11[r16] === ".") for (r16++; r16 < e11.length && e11[r16] >= "0" && e11[r16] <= "9"; ) o23 += e11[r16++];
    let s30 = e11[r16++];
    if (s30 === "%") {
      n18 += "%";
      continue;
    }
    let c37 = a20 ? parseInt(a20, 10) : 0, l38 = o23 === "" ? void 0 : parseInt(o23, 10), p31 = i22.includes("-"), m24 = i22.includes("0") && !p31, h24 = i22.includes("+"), g18 = i22.includes(" "), _21 = t17 < 0 || Object.is(t17, -0), v17 = Math.abs(t17), y18;
    y18 = s30 === "f" ? (_21 ? "-" : "") + u13(v17, l38 ?? 6) : s30 === "e" ? (_21 ? "-" : "") + d13(v17, l38 ?? 6, false) : s30 === "E" ? (_21 ? "-" : "") + d13(v17, l38 ?? 6, true) : s30 === "g" || s30 === "G" ? (_21 ? "-" : "") + f12(v17, l38 ?? 6, s30 === "G") : t17.toString();
    let b17 = "";
    if (y18[0] !== "-" && (h24 ? b17 = "+" : g18 && (b17 = " ")), c37 > y18.length + b17.length) {
      let e12 = c37 - y18.length - b17.length;
      y18 = p31 ? b17 + y18 + " ".repeat(e12) : m24 ? y18[0] === "-" ? "-" + "0".repeat(e12) + y18.slice(1) : b17 + "0".repeat(e12) + y18 : " ".repeat(e12) + b17 + y18;
    } else y18 = b17 + y18;
    n18 += y18;
  } else if (e11[r16] === "\\" && r16 + 1 < e11.length) {
    let t18 = e11[r16 + 1];
    t18 === "n" ? (n18 += "\n", r16 += 2) : t18 === "t" ? (n18 += "	", r16 += 2) : t18 === "\\" ? (n18 += "\\", r16 += 2) : n18 += e11[r16++];
  } else n18 += e11[r16++];
  return n18;
}
function m10(e11) {
  return e11.replace(/[eE]([+-])(\d+)/, (e12, t17, n18) => "e" + t17 + (n18.length < 2 ? n18.padStart(2, "0") : n18));
}
function h10(e11) {
  let t17 = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(e11);
  if (!t17) return 0;
  let n18 = t17[2] ?? "", r16 = t17[3] ? parseInt(t17[3], 10) : 0;
  return Math.max(0, n18.length - r16);
}
var g9 = async (t17) => {
  let a20 = t17.args[0] ?? "seq", l38 = t17.args.slice(1), u37 = [], d36 = [];
  for (let e11 = 0; e11 < l38.length; e11++) {
    let t18 = l38[e11];
    if (o11.test(t18)) d36.push(t18);
    else if (t18 === "--") {
      for (let t19 = e11 + 1; t19 < l38.length; t19++) d36.push(l38[t19]);
      break;
    } else t18.startsWith("-") && t18 !== "-" ? (u37.push(t18), (t18 === "-s" || t18 === "--separator" || t18 === "-f" || t18 === "--format") && e11 + 1 < l38.length && u37.push(l38[++e11])) : d36.push(t18);
  }
  let { flags: f32 } = t7(u37, {
    boolean: ["w", "equal-width"],
    string: [
      "s",
      "separator",
      "f",
      "format"
    ],
    alias: {
      "equal-width": "w",
      separator: "s",
      format: "f"
    }
  }), p31 = d36, m24 = t17.stdout.getWriter(), h24 = t17.stderr.getWriter();
  try {
    if (p31.length < 1) return await g2(h24, 1, `${a20}: missing operand
Try '${a20} --help' for more information.`);
    if (p31.length > 3) return await g2(h24, 1, `${a20}: extra operand \u2018${p31[3]}\u2019
Try '${a20} --help' for more information.`);
    for (let e11 of p31) if (!o11.test(e11)) return await g2(h24, 1, `${a20}: invalid floating point argument: \u2018${e11}\u2019
Try '${a20} --help' for more information.`);
    let t18 = f32.s === void 0 ? "\n" : String(f32.s), i22 = f32.f === void 0 ? null : String(f32.f), l39 = !!f32.w;
    if (i22 !== null && l39) return await g2(h24, 1, `${a20}: format string may not be specified when printing equal width strings
Try '${a20} --help' for more information.`);
    let u38, d37, g18;
    if (p31.length === 1 ? (u38 = "1", d37 = "1", g18 = p31[0]) : p31.length === 2 ? (u38 = p31[0], d37 = "1", g18 = p31[1]) : (u38 = p31[0], d37 = p31[1], g18 = p31[2]), c15(d37) === 0) return await g2(h24, 1, `${a20}: invalid Zero increment value: \u2018${d37}\u2019
Try '${a20} --help' for more information.`);
    let y18 = s14.test(u38) && s14.test(d37) && s14.test(g18), b17 = new d3(m24), x13 = false;
    try {
      x13 = i22 === null && y18 ? await _9(b17, t18, u38, d37, g18, l39) : await v8(b17, t18, u38, d37, g18, i22, l39), x13 && await b17.push("\n"), await b17.flush();
    } catch (e11) {
      if (!u2(e11)) throw e11;
    }
    return 0;
  } finally {
    await m24.close().catch(() => {
    }), await h24.close().catch(() => {
    });
  }
};
async function _9(e11, t17, n18, r16, i22, a20) {
  let o23 = BigInt(n18), s30 = BigInt(r16), c37 = BigInt(i22), l38 = 0;
  a20 && (l38 = Math.max(o23.toString().length, c37.toString().length));
  let u37 = false, d36 = o23, f32 = s30 > 0n;
  for (; f32 ? d36 <= c37 : d36 >= c37; ) {
    u37 && await e11.push(t17);
    let n19 = d36.toString();
    a20 && (n19 = b7(n19, l38)), await e11.push(n19), d36 += s30, u37 = true;
  }
  return u37;
}
async function v8(e11, t17, n18, r16, i22, a20, o23) {
  let s30 = Math.max(h10(n18), h10(r16)), l38 = 10 ** s30, u37 = (e12) => Math.round(c15(e12) * l38), d36 = u37(n18), f32 = u37(r16), m24 = Math.max(s30, h10(i22)), g18 = 10 ** (m24 - s30), _21 = 10 ** m24, v17 = Math.round(c15(i22) * _21), x13 = f32 * g18, S11 = 0;
  o23 && (S11 = Math.max(y8(d36, s30).length, y8(u37(i22), s30).length));
  let C12 = false, w9 = d36, T7 = d36 * g18, E6 = f32 > 0;
  for (; E6 ? T7 <= v17 : T7 >= v17; ) {
    C12 && await e11.push(t17);
    let n19;
    a20 ? n19 = p11(a20, w9 / l38) : (n19 = y8(w9, s30), o23 && (n19 = b7(n19, S11))), await e11.push(n19), w9 += f32, T7 += x13, C12 = true;
  }
  return C12;
}
function y8(e11, t17) {
  if (t17 === 0) return String(e11);
  let n18 = e11 < 0, r16 = String(Math.abs(e11)).padStart(t17 + 1, "0"), i22 = r16.slice(0, r16.length - t17), a20 = r16.slice(r16.length - t17);
  return (n18 ? "-" : "") + i22 + "." + a20;
}
function b7(e11, t17) {
  return e11.length >= t17 ? e11 : e11[0] === "-" || e11[0] === "+" ? e11[0] + e11.slice(1).padStart(t17 - 1, "0") : e11.padStart(t17, "0");
}
var x4 = _2(g9);

// mithic/packages/coreutils/dist/fs.js
function e8(e11) {
  if (e11 && typeof e11 == "object" && "code" in e11 && typeof e11.code == "string") return e11.code;
}
function t12(t17) {
  return e8(t17) === "ENOENT";
}
async function n11(e11, t17, n18 = true) {
  return await e11.syscall("fs/stat", {
    dirfd: b8,
    path: t17,
    followSymlinks: n18
  });
}
async function r10(e11, t17) {
  return await e11.syscall("fs/readdir", {
    dirfd: b8,
    path: t17
  });
}
async function i9(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    dirfd: b8,
    path: t17,
    oflags: { read: true }
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return i22;
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
async function a10(e11, t17, n18, r16) {
  let { fd: i22 } = await e11.syscall("fs/open", {
    dirfd: b8,
    path: t17,
    oflags: {
      write: true,
      create: true,
      truncate: true
    }
  });
  try {
    let t18 = 0;
    for (; t18 < n18.byteLength; ) {
      let r17 = n18.subarray(t18, t18 + 65536), { written: a20 } = await e11.syscall("fs/write", {
        fd: i22,
        data: r17
      });
      if (a20 <= 0) break;
      t18 += a20;
    }
  } finally {
    await e11.syscall("fs/close", { fd: i22 }).catch(() => {
    });
  }
  r16 !== void 0 && await e11.syscall("fs/chmod", {
    dirfd: b8,
    path: t17,
    mode: r16
  });
}
async function o12(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    dirfd: b8,
    path: t17,
    oflags: {
      write: true,
      create: true
    }
  });
  await e11.syscall("fs/close", { fd: n18 }).catch(() => {
  });
}
var s15 = (e11, t17) => e11.syscall("fs/mkdir", {
  dirfd: b8,
  path: t17
});
var c16 = (e11, t17) => e11.syscall("fs/rmdir", {
  dirfd: b8,
  path: t17
});
var l14 = (e11, t17) => e11.syscall("fs/unlink", {
  dirfd: b8,
  path: t17
});
var u14 = (e11, t17, n18) => e11.syscall("fs/rename", {
  dirfd: b8,
  path: t17,
  newPath: n18
});
var d14 = (e11, t17, n18) => e11.syscall("fs/symlink", {
  dirfd: b8,
  target: t17,
  path: n18
});
var f13 = (e11, t17, n18) => e11.syscall("fs/link", {
  dirfd: b8,
  target: t17,
  path: n18
});
var p12 = (e11, t17, n18) => e11.syscall("fs/chmod", {
  dirfd: b8,
  path: t17,
  mode: n18
});
async function h11(e11, t17) {
  let { target: n18 } = await e11.syscall("fs/readlink", {
    dirfd: b8,
    path: t17
  });
  return n18;
}
async function _10(e11, r16, i22 = true) {
  try {
    return (await n11(e11, r16, i22)).type;
  } catch (e12) {
    if (t12(e12)) return;
    throw e12;
  }
}
var b8 = -100;
function x5(e11) {
  return e11.length > 1 && e11.endsWith("/") ? e11.replace(/\/+$/, "") : e11;
}
function S4(e11) {
  let t17 = x5(e11);
  if (t17 === "/" || t17 === "") return t17 === "" ? "" : "/";
  let n18 = t17.lastIndexOf("/");
  return n18 < 0 ? t17 : t17.slice(n18 + 1);
}
function C4(e11) {
  let t17 = x5(e11), n18 = t17.lastIndexOf("/");
  return n18 < 0 ? "." : n18 === 0 ? "/" : t17.slice(0, n18);
}
function w3(e11, t17) {
  return e11 === "" || e11 === "." ? t17 : e11.endsWith("/") ? e11 + t17 : e11 + "/" + t17;
}
function T3(e11) {
  let t17 = e11.startsWith("/"), n18 = e11.split("/"), r16 = [];
  for (let e12 of n18) e12 === "" || e12 === "." || (e12 === ".." ? r16.length > 0 && r16[r16.length - 1] !== ".." ? r16.pop() : t17 || r16.push("..") : r16.push(e12));
  let i22 = r16.join("/");
  return t17 ? "/" + i22 : i22 === "" ? "." : i22;
}

// mithic/packages/coreutils/dist/commands/ls.js
var u15 = "root";
var d15 = "root";
var f14 = {
  file: "-",
  directory: "d",
  symlink: "l",
  "block-device": "b",
  "character-device": "c",
  fifo: "p",
  socket: "s",
  unknown: "?"
};
function p13(e11) {
  return (e11 & 4 ? "r" : "-") + (e11 & 2 ? "w" : "-") + (e11 & 1 ? "x" : "-");
}
function m11(e11, t17) {
  return f14[e11] + p13(t17 >> 6 & 7) + p13(t17 >> 3 & 7) + p13(t17 & 7);
}
function h12(e11) {
  let t17 = [
    "",
    "K",
    "M",
    "G",
    "T"
  ], n18 = 0, r16 = e11;
  for (; r16 >= 1024 && n18 < t17.length - 1; ) r16 /= 1024, n18++;
  return n18 === 0 ? String(e11) : (r16 < 10 ? r16.toFixed(1) : Math.round(r16).toString()) + t17[n18];
}
function g10(e11) {
  return e11.type === "directory" ? "/" : e11.type === "symlink" ? "@" : e11.type === "file" && e11.st && e11.st.mode & 73 ? "*" : "";
}
var _11 = async (e11) => {
  let o23 = t7(e11.args.slice(1), {
    boolean: /* @__PURE__ */ "laA1RdtrShFimxCBDGHLNQUXZbcfgknopqsuv".split(""),
    string: [
      "w",
      "I",
      "T",
      "block-size",
      "format",
      "color",
      "sort",
      "time",
      "time-style",
      "quoting-style",
      "indicator-style",
      "hide",
      "width",
      "tabsize"
    ],
    alias: {
      all: "a",
      "almost-all": "A",
      reverse: "r",
      recursive: "R",
      human: "h",
      "human-readable": "h",
      classify: "F",
      directory: "d",
      inode: "i",
      size: "s",
      dereference: "L",
      escape: "b"
    },
    unknown: "error"
  }), c37 = e11.stdout.getWriter(), u37 = e11.stderr.getWriter(), d36 = e11.args[0] ?? "ls";
  if (o23.unknown.length) {
    let e12 = await g2(u37, 2, h2(d36, o23.unknown[0]));
    return await c37.close().catch(() => {
    }), await u37.close().catch(() => {
    }), e12;
  }
  let { positionals: f32, flags: p31 } = o23, m24 = 0, h24 = e11.isatty?.(1) ?? false, g18;
  g18 = p31.m ? "commas" : p31.x ? "horizontal" : p31.C ? "vertical" : p31[1] ? "one" : h24 ? "vertical" : "one";
  let _21 = {
    long: !!(p31.l || p31.g || p31.o || p31.n),
    all: !!p31.a,
    almost: !!p31.A,
    one: !!p31[1],
    recurse: !!p31.R,
    dirSelf: !!p31.d,
    timeSort: !!p31.t,
    reverse: !!p31.r,
    sizeSort: !!p31.S,
    human: !!p31.h,
    classify: !!(p31.F || p31.p),
    inode: !!p31.i,
    columnMode: g18
  };
  try {
    let t17 = f32.length > 0 ? f32 : ["."], n18 = t17.length > 1, r16 = [], o24 = [];
    for (let n19 of t17) try {
      let t18 = await n11(e11, T3(n19), false);
      t18.type === "directory" && !_21.dirSelf ? r16.push(n19) : o24.push({
        name: n19,
        type: t18.type,
        st: t18
      });
    } catch {
      await m2(u37, `${d36}: cannot access '${n19}': No such file or directory`), m24 = 2;
    }
    o24.length > 0 && await y9(o24, _21, c37);
    for (let t18 = 0; t18 < r16.length; t18++) {
      let l38 = r16[t18];
      (n18 || _21.recurse || o24.length > 0) && ((t18 > 0 || o24.length > 0) && await p2(c37, "\n"), await m2(c37, `${l38}:`)), await v9(e11, T3(l38), _21, c37, u37);
    }
    return m24;
  } finally {
    await c37.close().catch(() => {
    }), await u37.close().catch(() => {
    });
  }
};
async function v9(e11, t17, n18, r16, s30) {
  let u37;
  try {
    u37 = await r10(e11, t17);
  } catch (e12) {
    await m2(s30, `ls: cannot open directory '${t17}': ${e12.message}`);
    return;
  }
  let d36 = [];
  n18.all && d36.push({
    name: ".",
    type: "directory"
  }, {
    name: "..",
    type: "directory"
  });
  for (let e12 of u37) !n18.all && !n18.almost && e12.name.startsWith(".") || d36.push({
    name: e12.name,
    type: e12.type
  });
  if (n18.long || n18.timeSort || n18.sizeSort || n18.classify || n18.inode) for (let n19 of d36) {
    let r17 = n19.name === "." ? t17 : n19.name === ".." ? w3(t17, "..") : w3(t17, n19.name);
    try {
      n19.st = await n11(e11, r17, false);
    } catch {
    }
  }
  if (await y9(d36, n18, r16), n18.recurse) {
    for (let c37 of d36) if (c37.type === "directory" && c37.name !== "." && c37.name !== "..") {
      await p2(r16, "\n");
      let l38 = w3(t17, c37.name);
      await m2(r16, `${l38}:`), await v9(e11, l38, n18, r16, s30);
    }
  }
}
async function y9(e11, t17, n18) {
  let r16 = [...e11];
  t17.timeSort ? r16.sort((e12, t18) => b9(t18) - b9(e12)) : t17.sizeSort ? r16.sort((e12, t18) => (t18.st?.size ?? 0) - (e12.st?.size ?? 0)) : r16.sort((e12, t18) => e12.name.localeCompare(t18.name)), t17.reverse && r16.reverse();
  let o23 = (e12) => String(C5(e12.name)), s30 = (e12) => (t17.inode ? o23(e12) + " " : "") + e12.name + (t17.classify ? g10(e12) : "");
  if (t17.long) {
    await m2(n18, `total ${r16.reduce((e13, t18) => e13 + (t18.st ? Math.ceil(t18.st.size / 1024) * 2 : 0), 0)}`);
    let e12 = Math.max(1, ...r16.map((e13) => String(e13.st ? e13.st.linkCount : 1).length)), a20 = Math.max(1, ...r16.map((e13) => {
      let n19 = e13.st;
      return (n19 ? t17.human ? h12(n19.size) : String(n19.size) : "0").length;
    }));
    for (let s31 of r16) {
      let r17 = s31.st, c38 = r17 ? m11(s31.type, r17.mode) : m11(s31.type, 0), l38 = String(r17 ? r17.linkCount : 1).padStart(e12), f32 = (r17 ? t17.human ? h12(r17.size) : String(r17.size) : "0").padStart(a20), p31 = S5(r17 ? r17.mtime : 0);
      await m2(n18, `${t17.inode ? o23(s31) + " " : ""}${c38} ${l38} ${u15} ${d15} ${f32} ${p31} ${s31.name + (t17.classify ? g10(s31) : "")}`);
    }
    return;
  }
  let c37 = r16.map(s30);
  if (t17.columnMode === "one") {
    for (let e12 of c37) await m2(n18, e12);
    return;
  }
  if (t17.columnMode === "commas") {
    await p2(n18, O3(c37));
    return;
  }
  await p2(n18, D3(c37, t17.columnMode === "horizontal"));
}
var b9 = (e11) => e11.st ? new Date(e11.st.mtime).getTime() : 0;
var x6 = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
function S5(e11) {
  let t17 = new Date(e11);
  return `${x6[t17.getUTCMonth()]} ${String(t17.getUTCDate()).padStart(2, " ")} ${String(t17.getUTCHours()).padStart(2, "0")}:${String(t17.getUTCMinutes()).padStart(2, "0")}`;
}
function C5(e11) {
  let t17 = 2166136261;
  for (let n18 = 0; n18 < e11.length; n18++) t17 ^= e11.charCodeAt(n18), t17 = Math.imul(t17, 16777619);
  return (t17 >>> 0) % 9e7 + 1e7;
}
var w4 = 80;
var T4 = 8;
function E3(e11, t17) {
  let n18 = "", r16 = e11;
  for (; r16 < t17; ) Math.floor(t17 / T4) > Math.floor((r16 + 1) / T4) ? (n18 += "	", r16 += T4 - r16 % T4) : (n18 += " ", r16++);
  return n18;
}
function D3(e11, t17) {
  let n18 = e11.length;
  if (n18 === 0) return "";
  let r16 = e11.map((e12) => e12.length), i22 = Math.max(1, Math.min(n18, Math.floor(w4 / 3))), a20 = 1, o23 = [Math.max(...r16)];
  for (let e12 = i22; e12 >= 1; e12--) {
    let i23 = Math.ceil(n18 / e12), s31 = Array(e12).fill(0);
    for (let a21 = 0; a21 < n18; a21++) {
      let n19 = t17 ? a21 % e12 : Math.floor(a21 / i23), o24 = r16[a21] + 2;
      o24 > s31[n19] && (s31[n19] = o24);
    }
    let c38 = 0;
    for (let e13 of s31) c38 += e13;
    if (c38 -= 2, c38 <= w4 || e12 === 1) {
      a20 = e12, o23 = s31;
      break;
    }
  }
  let s30 = Math.ceil(n18 / a20), c37 = "";
  if (t17) for (let t18 = 0; t18 < s30; t18++) {
    let i23 = 0;
    for (let s31 = 0; s31 < a20; s31++) {
      let l38 = t18 * a20 + s31;
      if (l38 >= n18) break;
      if (c37 += e11[l38], i23 += r16[l38], !(s31 === a20 - 1 || l38 === n18 - 1)) {
        let e12 = i23 + (o23[s31] - r16[l38]);
        c37 += E3(i23, e12), i23 = e12;
      }
    }
    c37 += "\n";
  }
  else for (let t18 = 0; t18 < s30; t18++) {
    let i23 = 0;
    for (let l38 = 0; l38 < a20; l38++) {
      let u37 = l38 * s30 + t18;
      if (u37 >= n18) break;
      if (c37 += e11[u37], i23 += r16[u37], !((l38 + 1) * s30 + t18 >= n18 || l38 === a20 - 1)) {
        let e12 = i23 + (o23[l38] - r16[u37]);
        c37 += E3(i23, e12), i23 = e12;
      }
    }
    c37 += "\n";
  }
  return c37;
}
function O3(e11) {
  let t17 = "", n18 = 0;
  for (let r16 = 0; r16 < e11.length; r16++) {
    let i22 = e11[r16];
    if (r16 === 0) {
      t17 += i22, n18 = i22.length;
      continue;
    }
    n18 + 2 + i22.length > w4 ? (t17 += ",\n" + i22, n18 = i22.length) : (t17 += ", " + i22, n18 += 2 + i22.length);
  }
  return t17 + "\n";
}
var k2 = _2(_11);

// mithic/packages/coreutils/dist/commands/echo.js
function n12(e11, t17 = {}) {
  let n18 = "", r16 = 0;
  for (; r16 < e11.length; ) if (e11[r16] === "\\" && r16 + 1 < e11.length) {
    let i22 = e11[r16 + 1];
    switch (i22) {
      case "\\":
        n18 += "\\", r16 += 2;
        break;
      case "a":
        n18 += "\x07", r16 += 2;
        break;
      case "b":
        n18 += "\b", r16 += 2;
        break;
      case "c":
        return {
          text: n18,
          truncated: true
        };
      case "e":
        n18 += "\x1B", r16 += 2;
        break;
      case "f":
        n18 += "\f", r16 += 2;
        break;
      case "n":
        n18 += "\n", r16 += 2;
        break;
      case "r":
        n18 += "\r", r16 += 2;
        break;
      case "t":
        n18 += "	", r16 += 2;
        break;
      case "v":
        n18 += "\v", r16 += 2;
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        let t18 = r16 + 1;
        e11[t18] === "0" && t18++;
        let i23 = t18, a20 = "";
        for (; t18 < e11.length && t18 < i23 + 3 && e11[t18] >= "0" && e11[t18] <= "7"; ) a20 += e11[t18++];
        n18 += String.fromCharCode(parseInt(a20 || "0", 8) & 255), r16 = t18;
        break;
      }
      case "x": {
        let i23 = e11.slice(r16 + 2, r16 + 4).match(/^[0-9a-fA-F]{1,2}/)?.[0];
        if (i23) n18 += String.fromCharCode(parseInt(i23, 16)), r16 += 2 + i23.length;
        else if (t17.errorOnMissingHex) return {
          text: n18,
          truncated: true,
          missingHex: true
        };
        else n18 += "\\x", r16 += 2;
        break;
      }
      default:
        n18 += "\\" + i22, r16 += 2;
        break;
    }
  } else n18 += e11[r16++];
  return {
    text: n18,
    truncated: false
  };
}
var i10 = async (e11) => {
  let r16 = e11.args.slice(1), i22 = false, a20 = false, o23 = 0;
  for (; o23 < r16.length; o23++) {
    let e12 = r16[o23];
    if (/^-[neE]+$/.test(e12)) e12.includes("n") && (i22 = true), e12.includes("e") && (a20 = true), e12.includes("E") && (a20 = false);
    else break;
  }
  let s30 = r16.slice(o23).join(" ");
  if (a20) {
    let { text: e12, truncated: t17 } = n12(s30);
    s30 = e12, t17 && (i22 = true);
  }
  i22 || (s30 += "\n");
  let c37 = e11.stdout.getWriter();
  try {
    return await p2(c37, s30), 0;
  } finally {
    await c37.close().catch(() => {
    });
  }
};
var a11 = _2(i10);

// mithic/packages/coreutils/dist/commands/printf.js
var i11 = 9223372036854775807n;
var a12 = -9223372036854775808n;
var o13 = 18446744073709551616n;
var s16 = 18446744073709551615n;
var c17 = -18446744073709551615n;
function l15(e11, t17) {
  let n18 = t17, r16 = "";
  for (; n18 < e11.length && "-+ 0#".includes(e11[n18]); ) r16 += e11[n18++];
  let i22 = null;
  if (e11[n18] === "*") i22 = -1, n18++;
  else {
    let t18 = "";
    for (; n18 < e11.length && e11[n18] >= "0" && e11[n18] <= "9"; ) t18 += e11[n18++];
    t18 && (i22 = parseInt(t18, 10));
  }
  let a20 = null;
  if (e11[n18] === ".") if (n18++, e11[n18] === "*") a20 = -1, n18++;
  else {
    let t18 = "";
    for (; n18 < e11.length && e11[n18] >= "0" && e11[n18] <= "9"; ) t18 += e11[n18++];
    a20 = t18 ? parseInt(t18, 10) : 0;
  }
  if (n18 >= e11.length) return null;
  let o23 = e11[n18++];
  return [{
    flags: r16,
    width: i22,
    precision: a20,
    spec: o23
  }, n18];
}
function u16(e11, t17 = false) {
  let n18 = e11.trim();
  if (n18 === "") return { value: 0n };
  if (n18[0] === "'" || n18[0] === '"') return { value: n18.length > 1 ? BigInt(n18.codePointAt(1)) : 0n };
  let r16 = 1n, o23 = n18;
  (o23[0] === "+" || o23[0] === "-") && (o23[0] === "-" && (r16 = -1n), o23 = o23.slice(1));
  let l38;
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(o23)) l38 = BigInt(o23);
    else if (/^0[0-7]+$/.test(o23)) l38 = BigInt("0o" + o23.slice(1));
    else if (/^[0-9]+$/.test(o23)) l38 = BigInt(o23);
    else return {
      value: 0n,
      diag: { message: `\u2018${e11}\u2019: expected a numeric value` }
    };
  } catch {
    return {
      value: 0n,
      diag: { message: `\u2018${e11}\u2019: expected a numeric value` }
    };
  }
  let u37 = r16 * l38;
  return t17 ? u37 > s16 || u37 < c17 ? {
    value: s16,
    diag: { message: `\u2018${e11}\u2019: Result too large` }
  } : { value: u37 } : u37 > i11 ? {
    value: i11,
    diag: { message: `\u2018${e11}\u2019: Result too large` }
  } : u37 < a12 ? {
    value: a12,
    diag: { message: `\u2018${e11}\u2019: Result too large` }
  } : { value: u37 };
}
function d16(e11, t17, n18, r16 = " ") {
  if (t17 <= 0 || e11.length >= t17) return e11;
  let i22 = r16.repeat(t17 - e11.length);
  return n18.includes("-") ? e11 + i22 : i22 + e11;
}
function f15(e11, t17) {
  let n18 = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
  n18.setFloat64(0, e11);
  let r16 = n18.getUint32(0), i22 = n18.getUint32(4), a20 = r16 >>> 20 & 2047, o23 = BigInt(r16 & 1048575) << 32n | BigInt(i22 >>> 0), s30;
  if (a20 === 0 ? s30 = -1074 : (o23 |= 1n << 52n, s30 = a20 - 1075), o23 === 0n) return 0n;
  let c37 = o23, l38 = 1n;
  t17 >= 0 ? c37 *= 10n ** BigInt(t17) : l38 *= 10n ** BigInt(-t17), s30 >= 0 ? c37 <<= BigInt(s30) : l38 <<= BigInt(-s30);
  let u37 = c37 / l38, d36 = (c37 - u37 * l38) * 2n;
  return (d36 > l38 || d36 === l38 && u37 % 2n == 1n) && (u37 += 1n), u37;
}
function p14(e11, t17) {
  if (!Number.isFinite(e11)) return Math.abs(e11).toFixed(Math.min(t17, 100));
  let n18 = f15(e11, t17).toString();
  if (t17 === 0) return n18;
  let r16 = n18.padStart(t17 + 1, "0");
  return r16.slice(0, r16.length - t17) + "." + r16.slice(r16.length - t17);
}
function m12(e11, t17, n18) {
  let r16 = n18 ? "E" : "e";
  if (!Number.isFinite(e11)) {
    let r17 = Math.abs(e11).toExponential(t17).replace(/e([+-])(\d)$/, "e$10$2");
    return n18 ? r17.toUpperCase() : r17;
  }
  if (e11 === 0) return (t17 > 0 ? "0." + "0".repeat(t17) : "0") + r16 + "+00";
  let i22 = t17 + 1, a20 = Math.floor(Math.log10(e11)), o23 = f15(e11, t17 - a20);
  for (; o23.toString().length > i22; ) a20 += 1, o23 = f15(e11, t17 - a20);
  for (; o23 !== 0n && o23.toString().length < i22; ) --a20, o23 = f15(e11, t17 - a20);
  let s30 = o23.toString().padStart(i22, "0"), c37 = t17 > 0 ? s30[0] + "." + s30.slice(1) : s30, l38 = a20 < 0 ? "-" : "+";
  return c37 + r16 + l38 + String(Math.abs(a20)).padStart(2, "0");
}
function h13(e11, t17, n18, r16) {
  if (t17 < 1 && (t17 = 1), e11 === 0) return r16 ? "0." + "0".repeat(Math.max(0, t17 - 1)) : "0";
  if (!Number.isFinite(e11)) return m12(e11, t17 - 1, n18);
  let i22 = Math.floor(Math.log10(e11)), a20 = f15(e11, t17 - 1 - i22);
  for (; a20.toString().length > t17; ) i22 += 1, a20 = f15(e11, t17 - 1 - i22);
  for (; a20 !== 0n && a20.toString().length < t17; ) --i22, a20 = f15(e11, t17 - 1 - i22);
  let o23;
  return i22 < -4 || i22 >= t17 ? (o23 = m12(e11, t17 - 1, n18), r16 ? o23.includes(".") || (o23 = o23.replace(/([eE])/, ".$1")) : o23 = o23.replace(/\.?0+([eE])/, "$1")) : (o23 = p14(e11, Math.max(0, t17 - 1 - i22)), !r16 && o23.includes(".") ? o23 = o23.replace(/\.?0+$/, "") : r16 && !o23.includes(".") && (o23 += ".")), o23;
}
function g11(e11, t17, n18) {
  return e11.length + t17.length >= n18 ? e11 + t17 : e11 + t17.padStart(n18 - e11.length, "0");
}
var _12 = {
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r"
};
function v10(e11) {
  if (e11 === "") return "''";
  let t17 = (t18, n19) => !!(" 	\n!\"$&'()*;<>?[\\^`|=".includes(t18) || (t18 === "#" || t18 === "~") && n19 === 0 || (t18 === "{" || t18 === "}") && e11.length === 1), n18 = false, r16 = false, i22 = true;
  for (let a20 = 0; a20 < e11.length; a20++) {
    let o23 = e11.charCodeAt(a20);
    if (o23 < 32 || o23 === 127 || o23 > 127) {
      n18 = true, r16 = true, i22 = false;
      continue;
    }
    let s30 = e11[a20];
    t17(s30, a20) && (r16 = true, s30 !== "'" && (i22 = false)), '"$`\\'.includes(s30) && (i22 = false);
  }
  if (!r16) return e11;
  if (n18) {
    let t18 = new TextEncoder().encode(e11), n19 = "", r17 = "", i23 = "", a20 = () => {
      r17 !== "" && (n19 += `'${r17}'`, r17 = "");
    }, o23 = () => {
      i23 !== "" && (n19 === "" && (n19 += "''"), n19 += `$'${i23}'`, i23 = "");
    };
    for (let e12 of t18) e12 < 32 || e12 >= 127 ? (a20(), i23 += _12[e12] ?? "\\" + e12.toString(8).padStart(3, "0")) : (o23(), r17 += String.fromCharCode(e12));
    return o23(), a20(), n19;
  }
  return i22 && e11.includes("'") ? '"' + e11 + '"' : "'" + e11.replace(/'/g, "'\\''") + "'";
}
function y10(e11, t17, n18, i22) {
  let a20 = n18, { width: s30, precision: c37 } = e11;
  s30 === -1 && (s30 = parseInt(t17[a20++] ?? "0", 10)), c37 === -1 && (c37 = parseInt(t17[a20++] ?? "0", 10));
  let l38 = t17[a20++] ?? "", { flags: f32, spec: _21 } = e11, y18 = f32.includes("-"), b17 = f32.includes("0") && !y18, x13 = f32.includes("+"), S11 = f32.includes(" "), C12 = f32.includes("#"), w9 = i22.diags, T7 = (e12 = false) => {
    let t18 = u16(l38, e12);
    return t18.diag && w9.push(t18.diag), t18.value;
  }, E6 = "";
  switch (_21) {
    case "%":
      E6 = "%", a20--;
      break;
    case "s": {
      let e12 = l38;
      c37 !== null && c37 >= 0 && (e12 = e12.slice(0, c37)), E6 = d16(e12, s30 ?? 0, f32);
      break;
    }
    case "b": {
      let e12 = n12(l38, { errorOnMissingHex: true });
      e12.missingHex && i22.diags.push({ message: "missing hexadecimal number in escape" }), e12.truncated && (i22.truncated = true);
      let t18 = e12.text;
      c37 !== null && c37 >= 0 && (t18 = t18.slice(0, c37)), E6 = d16(t18, s30 ?? 0, f32);
      break;
    }
    case "c":
      E6 = d16(l38[0] ?? "\0", s30 ?? 0, f32);
      break;
    case "q":
      E6 = d16(v10(l38), s30 ?? 0, f32);
      break;
    case "d":
    case "i": {
      let e12 = T7(), t18 = e12 < 0n, n19 = (t18 ? -e12 : e12).toString();
      c37 !== null && (n19 = n19.padStart(c37, "0"));
      let r16 = t18 ? "-" : x13 ? "+" : S11 ? " " : "";
      E6 = b17 && c37 === null && s30 !== null && r16.length + n19.length < s30 ? g11(r16, n19, s30) : d16(r16 + n19, s30 ?? 0, f32);
      break;
    }
    case "u": {
      let e12 = T7(true);
      e12 < 0n && (e12 = (e12 % o13 + o13) % o13);
      let t18 = e12.toString();
      c37 !== null && (t18 = t18.padStart(c37, "0")), b17 && c37 === null && s30 !== null && t18.length < s30 && (t18 = t18.padStart(s30, "0")), E6 = d16(t18, s30 ?? 0, f32);
      break;
    }
    case "o": {
      let e12 = T7(true);
      e12 < 0n && (e12 = (e12 % o13 + o13) % o13);
      let t18 = e12.toString(8);
      C12 && !t18.startsWith("0") && (t18 = "0" + t18), c37 !== null && (t18 = t18.padStart(c37, "0")), b17 && c37 === null && s30 !== null && t18.length < s30 && (t18 = t18.padStart(s30, "0")), E6 = d16(t18, s30 ?? 0, f32);
      break;
    }
    case "x":
    case "X": {
      let e12 = T7(true);
      e12 < 0n && (e12 = (e12 % o13 + o13) % o13);
      let t18 = e12.toString(16);
      _21 === "X" && (t18 = t18.toUpperCase());
      let n19 = C12 && e12 !== 0n ? _21 === "X" ? "0X" : "0x" : "";
      c37 !== null && (t18 = t18.padStart(c37, "0")), b17 && c37 === null && s30 !== null && n19.length + t18.length < s30 && (t18 = t18.padStart(s30 - n19.length, "0")), E6 = d16(n19 + t18, s30 ?? 0, f32);
      break;
    }
    case "f": {
      let e12 = parseFloat(l38);
      isNaN(e12) && (e12 = 0, l38.trim() !== "" && w9.push({ message: `\u2018${l38}\u2019: expected a numeric value` }));
      let t18 = e12 < 0 || Object.is(e12, -0), n19 = p14(Math.abs(e12), c37 ?? 6), r16 = t18 ? "-" : x13 ? "+" : S11 ? " " : "";
      E6 = b17 && s30 !== null && r16.length + n19.length < s30 ? g11(r16, n19, s30) : d16(r16 + n19, s30 ?? 0, f32);
      break;
    }
    case "e":
    case "E": {
      let e12 = parseFloat(l38);
      isNaN(e12) && (e12 = 0, l38.trim() !== "" && w9.push({ message: `\u2018${l38}\u2019: expected a numeric value` }));
      let t18 = e12 < 0 || Object.is(e12, -0), n19 = m12(Math.abs(e12), c37 ?? 6, _21 === "E"), r16 = t18 ? "-" : x13 ? "+" : S11 ? " " : "";
      E6 = b17 && s30 !== null && r16.length + n19.length < s30 ? g11(r16, n19, s30) : d16(r16 + n19, s30 ?? 0, f32);
      break;
    }
    case "g":
    case "G": {
      let e12 = parseFloat(l38);
      isNaN(e12) && (e12 = 0, l38.trim() !== "" && w9.push({ message: `\u2018${l38}\u2019: expected a numeric value` }));
      let t18 = h13(Math.abs(e12), c37 === null ? 6 : c37, _21 === "G", C12), n19 = e12 < 0 ? "-" : x13 ? "+" : S11 ? " " : "";
      E6 = b17 && s30 !== null && n19.length + t18.length < s30 ? g11(n19, t18, s30) : d16(n19 + t18, s30 ?? 0, f32);
      break;
    }
    default:
      E6 = "%" + _21, a20--;
      break;
  }
  return [E6, a20];
}
function b10(e11, t17) {
  let n18 = "", r16 = 0, i22 = {
    diags: [],
    truncated: false
  }, a20 = () => {
    let n19 = "", a21 = 0;
    for (; a21 < e11.length; ) if (e11[a21] === "%" && a21 + 1 < e11.length) {
      let o23 = l15(e11, a21 + 1);
      if (!o23) {
        n19 += "%", a21++;
        continue;
      }
      let [s30, c37] = o23;
      if (s30.spec === "%") {
        n19 += "%", a21 = c37;
        continue;
      }
      let [u37, d36] = y10(s30, t17, r16, i22);
      if (n19 += u37, r16 = d36, a21 = c37, i22.truncated) return n19;
    } else if (e11[a21] === "\\" && a21 + 1 < e11.length) {
      let t18 = e11[a21 + 1];
      if (t18 === "n") n19 += "\n", a21 += 2;
      else if (t18 === "t") n19 += "	", a21 += 2;
      else if (t18 === "r") n19 += "\r", a21 += 2;
      else if (t18 === "\\") n19 += "\\", a21 += 2;
      else if (t18 === "a") n19 += "\x07", a21 += 2;
      else if (t18 === "b") n19 += "\b", a21 += 2;
      else if (t18 === "e") n19 += "\x1B", a21 += 2;
      else if (t18 === "f") n19 += "\f", a21 += 2;
      else if (t18 === "v") n19 += "\v", a21 += 2;
      else if (t18 === "c") return i22.truncated = true, n19;
      else if (t18 >= "0" && t18 <= "7") {
        let t19 = "", r17 = a21 + 1;
        for (; r17 < e11.length && r17 < a21 + 4 && e11[r17] >= "0" && e11[r17] <= "7"; ) t19 += e11[r17++];
        n19 += String.fromCharCode(parseInt(t19, 8) & 255), a21 = r17;
      } else if (t18 === "x") {
        let t19 = e11.slice(a21 + 2, a21 + 4).match(/^[0-9a-fA-F]{1,2}/)?.[0];
        if (t19) n19 += String.fromCharCode(parseInt(t19, 16)), a21 += 2 + t19.length;
        else return i22.diags.push({ message: "missing hexadecimal number in escape" }), i22.truncated = true, n19;
      } else n19 += "\\" + t18, a21 += 2;
    } else n19 += e11[a21++];
    return n19;
  };
  for (n18 += a20(); !i22.truncated && r16 < t17.length; ) {
    let e12 = r16;
    if (n18 += a20(), r16 === e12) break;
  }
  return {
    text: n18,
    diags: i22.diags,
    truncated: i22.truncated
  };
}
var S6 = async (e11) => {
  let r16 = e11.args[0] ?? "printf", i22 = e11.args.slice(1);
  if (i22.length === 0) return 0;
  let a20 = i22[0], o23 = i22.slice(1), s30 = e11.stdout.getWriter(), c37 = e11.stderr.getWriter();
  try {
    let { text: e12, diags: i23 } = b10(a20, o23);
    await p2(s30, e12);
    for (let e13 of i23) await m2(c37, `${r16}: ${e13.message}`);
    return +(i23.length > 0);
  } finally {
    await s30.close().catch(() => {
    }), await c37.close().catch(() => {
    });
  }
};
var C6 = _2(S6);

// mithic/packages/coreutils/dist/commands/uniq.js
var c18 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EXDEV: "Invalid cross-device link",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
  EIO: "Input/output error"
};
function l16(e11) {
  let t17 = e11?.code;
  return (t17 && c18[t17]) ?? r5(e11);
}
async function* u17(e11, t17) {
  let n18 = e11.getReader(), r16 = new TextDecoder(), i22 = t17 ? "\0" : "\n", a20 = "";
  try {
    for (; ; ) {
      let { value: e12, done: t18 } = await n18.read();
      if (t18) break;
      if (!e12 || e12.byteLength === 0) continue;
      a20 += r16.decode(e12, { stream: true });
      let o23 = a20.indexOf(i22);
      for (; o23 !== -1; ) yield a20.slice(0, o23), a20 = a20.slice(o23 + 1), o23 = a20.indexOf(i22);
    }
    a20 += r16.decode(), a20 !== "" && (yield a20);
  } finally {
    n18.releaseLock();
  }
}
async function d17(e11, t17, n18) {
  let { fd: r16 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], i22 = 0;
    for (; ; ) {
      let n19 = await e11.syscall("fs/read", {
        fd: r16,
        len: 65536
      });
      if (!n19 || n19.byteLength === 0) break;
      t18.push(n19), i22 += n19.byteLength;
    }
    let a20 = new Uint8Array(i22), o23 = 0;
    for (let e12 of t18) a20.set(e12, o23), o23 += e12.byteLength;
    let s30 = new TextDecoder().decode(a20), c37 = n18 ? "\0" : "\n";
    return s30 === "" ? [] : (s30.endsWith(c37) ? s30.slice(0, -1) : s30).split(c37);
  } finally {
    await e11.syscall("fs/close", { fd: r16 }).catch(() => {
    });
  }
}
function f16(e11) {
  let t17 = /^\s*\+?(\d+)$/.exec(e11);
  if (t17) return Number(t17[1]);
}
function p15(e11, t17, n18, r16, i22) {
  let a20 = e11;
  if (t17 > 0) {
    let e12 = 0, n19 = 0;
    for (; n19 < t17 && e12 < a20.length; ) {
      for (; e12 < a20.length && /\s/.test(a20[e12]); ) e12++;
      for (; e12 < a20.length && !/\s/.test(a20[e12]); ) e12++;
      n19++;
    }
    a20 = a20.slice(e12);
  }
  return n18 > 0 && (a20 = a20.slice(n18)), r16 >= 0 && (a20 = a20.slice(0, r16)), i22 ? a20.toLowerCase() : a20;
}
var m13 = async (t17) => {
  let r16 = t17.args.slice(1), c37, m24, h24 = [];
  for (let e11 = 0; e11 < r16.length; e11++) {
    let t18 = r16[e11];
    if (t18 === "--") {
      h24.push(...r16.slice(e11));
      break;
    }
    if (t18 === "--all-repeated") {
      c37 = "PRESENT";
      continue;
    }
    if (t18.startsWith("--all-repeated=")) {
      c37 = t18.slice(15);
      continue;
    }
    if (t18 === "--group") {
      m24 = "PRESENT";
      continue;
    }
    if (t18.startsWith("--group=")) {
      m24 = t18.slice(8);
      continue;
    }
    h24.push(t18);
  }
  let g18 = t7(h24, {
    boolean: [
      "c",
      "d",
      "u",
      "i",
      "z",
      "D",
      "count",
      "repeated",
      "unique",
      "ignore-case",
      "zero-terminated"
    ],
    string: [
      "f",
      "s",
      "w",
      "skip-fields",
      "skip-chars",
      "check-chars"
    ],
    alias: {
      count: "c",
      repeated: "d",
      unique: "u",
      "ignore-case": "i",
      "skip-fields": "f",
      "skip-chars": "s",
      "check-chars": "w",
      "zero-terminated": "z"
    },
    unknown: "error"
  }), { positionals: _21, flags: v17 } = g18, y18 = t17.args[0] ?? "uniq", b17 = !!v17.c, x13 = !!v17.d, S11 = !!v17.u, C12 = !!v17.i, w9 = !!v17.z, T7 = t17.stdout.getWriter(), E6 = t17.stderr.getWriter(), D6 = false;
  try {
    if (g18.unknown.length) return await g2(E6, 1, h2(y18, g18.unknown[0]));
    let r17 = 0, o23 = 0, h25 = -1;
    if (v17.f !== void 0) {
      let e11 = f16(String(v17.f));
      if (e11 === void 0) return await g2(E6, 1, `${y18}: ${v17.f}: invalid number of fields to skip`);
      r17 = e11;
    }
    if (v17.s !== void 0) {
      let e11 = f16(String(v17.s));
      if (e11 === void 0) return await g2(E6, 1, `${y18}: ${v17.s}: invalid number of bytes to skip`);
      o23 = e11;
    }
    if (v17.w !== void 0) {
      let e11 = f16(String(v17.w));
      if (e11 === void 0) return await g2(E6, 1, `${y18}: ${v17.w}: invalid number of bytes to compare`);
      h25 = e11;
    }
    let O6 = !!v17.D || c37 !== void 0, k5 = "none";
    if (c37 !== void 0 && c37 !== "PRESENT") {
      let e11 = c37;
      if (e11 === "none") k5 = "none";
      else if (e11 === "prepend") k5 = "prepend";
      else if (e11 === "separate") k5 = "separate";
      else return await g2(E6, 1, `${y18}: invalid argument \u2018${e11}\u2019 for \u2018--all-repeated\u2019
Valid arguments are:
  - \u2018none\u2019
  - \u2018prepend\u2019
  - \u2018separate\u2019
Try '${y18} --help' for more information.`);
    }
    let A4 = m24 !== void 0, j4 = "separate";
    if (m24 !== void 0 && m24 !== "PRESENT") {
      let e11 = m24;
      if (e11 === "separate") j4 = "separate";
      else if (e11 === "prepend") j4 = "prepend";
      else if (e11 === "append") j4 = "append";
      else if (e11 === "both") j4 = "both";
      else return await g2(E6, 1, `${y18}: invalid argument \u2018${e11}\u2019 for \u2018--group\u2019
Valid arguments are:
  - \u2018prepend\u2019
  - \u2018append\u2019
  - \u2018separate\u2019
  - \u2018both\u2019
Try '${y18} --help' for more information.`);
    }
    if (O6 && b17) return await g2(E6, 1, `${y18}: printing all duplicated lines and repeat counts is meaningless
Try '${y18} --help' for more information.`);
    if (A4 && (b17 || x13 || S11 || O6)) return await g2(E6, 1, `${y18}: --group is mutually exclusive with -c/-d/-D/-u
Try '${y18} --help' for more information.`);
    let M4 = w9 ? "\0" : "\n", N4 = (e11, t18, n18) => {
      let r18 = t18 > 1;
      return O6 ? r18 ? n18.map((e12) => e12 + M4).join("") : null : !(x13 && S11) && (x13 ? r18 : !S11 || !r18) ? (b17 ? `${String(t18).padStart(7, " ")} ${e11}` : e11) + M4 : null;
    }, P4 = new d3(T7), F4 = async (e11) => {
      let t18 = null, n18 = "", i22 = 0, a20 = [], s30 = 0, c38 = async () => {
        if (i22 === 0) return;
        if (A4) {
          (j4 === "prepend" || j4 === "both" || s30 > 0 && j4 === "separate") && await P4.push(M4), await P4.push(a20.map((e13) => e13 + M4).join("")), j4 === "append" && await P4.push(M4), s30++;
          return;
        }
        let e12 = N4(t18, i22, a20);
        e12 !== null && (O6 && (k5 === "prepend" || s30 > 0 && k5 === "separate") && await P4.push(M4), await P4.push(e12), s30++);
      };
      for await (let s31 of e11) {
        let e12 = p15(s31, r17, o23, h25, C12);
        if (i22 > 0 && e12 === n18) {
          i22++, a20.push(s31);
          continue;
        }
        await c38(), t18 = s31, n18 = e12, i22 = 1, a20 = [s31];
      }
      await c38(), A4 && j4 === "both" && s30 > 0 && await P4.push(M4), await P4.flush();
    }, I4 = _21[0];
    if (I4 === void 0 || I4 === "-") {
      try {
        await F4(u17(t17.stdin, w9));
      } catch (e11) {
        if (u2(e11)) return D6 = true, 0;
        throw e11;
      }
      return 0;
    }
    let L3;
    try {
      L3 = await d17(t17, I4, w9);
    } catch (e11) {
      return await p2(E6, `${y18}: ${I4}: ${l16(e11)}
`), 1;
    }
    return await F4(L3), 0;
  } finally {
    await T7.close().catch(() => {
    }), await E6.close().catch(() => {
    }), D6 && await t17.stdin.cancel().catch(() => {
    });
  }
};
var h14 = _2(m13);

// mithic/packages/coreutils/dist/commands/cut.js
var c19 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EXDEV: "Invalid cross-device link",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
  EIO: "Input/output error"
};
function l17(e11) {
  let t17 = e11?.code;
  return (t17 && c19[t17]) ?? r5(e11);
}
var u18 = {
  b: "bytes",
  c: "characters",
  f: "fields",
  d: "delimiter"
};
var d18 = /* @__PURE__ */ new Set([
  "bytes",
  "characters",
  "fields",
  "delimiter",
  "output-delimiter"
]);
function f17(e11, t17) {
  for (let n18 = 0; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 === "--") break;
    if (r16.startsWith("--")) {
      let i23 = r16.slice(2);
      if (i23.includes("=")) continue;
      if (d18.has(i23) && e11[n18 + 1] === void 0) return `${t17}: option '--${i23}' requires an argument`;
      d18.has(i23) && n18++;
      continue;
    }
    if (!r16.startsWith("-") || r16 === "-") continue;
    let i22 = r16.slice(1);
    for (let r17 = 0; r17 < i22.length; r17++) {
      let a20 = i22[r17];
      if (u18[a20] !== void 0) {
        if (i22.slice(r17 + 1).length > 0) break;
        if (e11[n18 + 1] === void 0) return `${t17}: option requires an argument -- '${a20}'`;
        n18++;
        break;
      }
    }
  }
}
var p16 = class extends Error {
};
function m14(e11) {
  return `\u2018${e11}\u2019`;
}
function h15(e11, t17) {
  let n18 = t17 ? "invalid field value" : "invalid byte/character position", r16 = t17 ? "fields are numbered from 1" : "byte/character positions are numbered from 1", i22 = t17 ? "invalid field range" : "invalid byte or character range", a20 = e11.split(/[,\s]/), o23 = [];
  for (let e12 of a20) {
    if (e12 === "") throw new p16(r16);
    if (e12.includes("-")) {
      let t18 = e12.indexOf("-"), a21 = e12.slice(0, t18), s30 = e12.slice(t18 + 1);
      if (s30.includes("-")) throw new p16(i22);
      if (a21 === "" && s30 === "") throw new p16("invalid range with no endpoint: -");
      let c37 = a21 === "" ? 1 : g12(a21, n18, r16), l38 = s30 === "" ? Infinity : _13(s30, n18);
      if (l38 < c37) throw new p16("invalid decreasing range");
      o23.push({
        from: c37,
        to: l38
      });
    } else {
      let t18 = g12(e12, n18, r16);
      o23.push({
        from: t18,
        to: t18
      });
    }
  }
  return o23.sort((e12, t18) => e12.from - t18.from), o23;
}
function g12(e11, t17, n18) {
  if (!/^\d+$/.test(e11)) throw new p16(`${t17} ${m14(e11)}`);
  let r16 = Number(e11);
  if (r16 === 0) throw new p16(n18);
  return r16;
}
function _13(e11, t17) {
  if (!/^\d+$/.test(e11)) throw new p16(`${t17} ${m14(e11)}`);
  return Number(e11);
}
function v11(e11, t17, n18) {
  let r16 = [];
  for (let t18 of e11) {
    let e12 = t18.from, i23 = Math.min(t18.to, n18);
    if (e12 > n18 || i23 < e12) continue;
    let a21 = r16[r16.length - 1];
    a21 && e12 <= a21[1] ? a21[1] = Math.max(a21[1], i23) : r16.push([e12, i23]);
  }
  if (!t17) return r16;
  let i22 = [], a20 = 1;
  for (let [e12, t18] of r16) e12 > a20 && i22.push([a20, e12 - 1]), a20 = t18 + 1;
  return a20 <= n18 && i22.push([a20, n18]), i22;
}
async function y11(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return new TextDecoder().decode(i22);
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
function b11(e11, t17, n18) {
  let r16 = t17.some((t18) => e11 >= t18.from && e11 <= t18.to);
  return n18 ? !r16 : r16;
}
function x7(e11, t17) {
  if (t17.kind === "fields") {
    if (!e11.includes(t17.delim)) return t17.onlyDelim ? null : e11;
    let n19 = e11.split(t17.delim), r17 = [];
    for (let e12 = 0; e12 < n19.length; e12++) b11(e12 + 1, t17.ranges, t17.complement) && r17.push(n19[e12]);
    return r17.join(t17.outDelim);
  }
  let n18 = t17.kind === "chars" ? [...e11] : Array.from(new TextEncoder().encode(e11), (e12) => e12), r16 = v11(t17.ranges, t17.complement, n18.length);
  if (t17.kind === "chars") {
    let e12 = n18;
    return r16.map(([t18, n19]) => e12.slice(t18 - 1, n19).join("")).join(t17.outDelim ?? "");
  }
  let i22 = n18, a20 = new TextDecoder();
  return r16.map(([e12, t18]) => a20.decode(new Uint8Array(i22.slice(e12 - 1, t18)))).join(t17.outDelim ?? "");
}
var S7 = async (t17) => {
  let n18 = t7(t17.args.slice(1), {
    string: [
      "f",
      "c",
      "b",
      "d",
      "output-delimiter"
    ],
    boolean: [
      "s",
      "only-delimited",
      "complement",
      "n"
    ],
    alias: { "only-delimited": "s" },
    unknown: "error"
  }), { positionals: c37, flags: u37 } = n18, d36 = t17.args[0] ?? "cut", m24 = t17.stdout.getWriter(), g18 = t17.stderr.getWriter(), _21 = false, v17 = async (e11) => (await p2(g18, `${e11}
Try '${d36} --help' for more information.
`), 1);
  try {
    if (n18.unknown.length) return await p2(g18, h2(d36, n18.unknown[0]) + "\n"), 1;
    let a20 = f17(t17.args.slice(1), d36);
    if (a20 !== void 0) return await v17(a20);
    let b17 = u37.d === void 0 ? "	" : String(u37.d) === "" ? "\0" : String(u37.d), S11 = u37["output-delimiter"] === void 0 ? null : String(u37["output-delimiter"]) === "" ? "\0" : String(u37["output-delimiter"]), C12 = !!u37.s, w9 = !!u37.complement;
    if ((u37.b === void 0 ? 0 : 1) + (u37.c === void 0 ? 0 : 1) + (u37.f === void 0 ? 0 : 1) > 1) return await v17(`${d36}: only one list may be specified`);
    let T7;
    try {
      if (u37.b !== void 0) {
        if (u37.d !== void 0) return await v17(`${d36}: an input delimiter makes sense
	only when operating on fields`);
        if (C12) return await v17(`${d36}: suppressing non-delimited lines makes sense
	only when operating on fields`);
        T7 = {
          kind: "bytes",
          ranges: h15(String(u37.b), false),
          complement: w9,
          outDelim: S11
        };
      } else if (u37.c !== void 0) {
        if (u37.d !== void 0) return await v17(`${d36}: an input delimiter makes sense
	only when operating on fields`);
        if (C12) return await v17(`${d36}: suppressing non-delimited lines makes sense
	only when operating on fields`);
        T7 = {
          kind: "chars",
          ranges: h15(String(u37.c), false),
          complement: w9,
          outDelim: S11
        };
      } else if (u37.f !== void 0) {
        if (b17.length > 1) return await v17(`${d36}: the delimiter must be a single character`);
        let e11 = S11 === null ? b17 : S11;
        T7 = {
          kind: "fields",
          ranges: h15(String(u37.f), true),
          complement: w9,
          delim: b17,
          outDelim: e11,
          onlyDelim: C12
        };
      } else return await v17(`${d36}: you must specify a list of bytes, characters, or fields`);
    } catch (e11) {
      if (e11 instanceof p16) return await v17(`${d36}: ${e11.message}`);
      throw e11;
    }
    let E6 = c37.length > 0 ? c37 : ["-"], D6 = 0;
    for (let n19 of E6) {
      if (n19 === "-") {
        let n20 = new d3(m24);
        try {
          for await (let { line: e11 } of l3(t17.stdin)) {
            let t18 = x7(e11, T7);
            t18 !== null && await n20.push(t18 + "\n");
          }
          await n20.flush();
        } catch (e11) {
          if (u2(e11)) {
            _21 = true;
            break;
          }
          throw e11;
        }
        continue;
      }
      let i22;
      try {
        i22 = await y11(t17, n19);
      } catch (e11) {
        await p2(g18, `${d36}: ${n19}: ${l17(e11)}
`), D6 = 1;
        continue;
      }
      if (i22 === "") continue;
      let a21 = (i22.endsWith("\n") ? i22.slice(0, -1) : i22).split("\n"), c38 = [];
      for (let e11 of a21) {
        let t18 = x7(e11, T7);
        t18 !== null && c38.push(t18);
      }
      c38.length > 0 && await p2(m24, c38.join("\n") + "\n");
    }
    return D6;
  } finally {
    await m24.close().catch(() => {
    }), await g18.close().catch(() => {
    }), _21 && await t17.stdin.cancel().catch(() => {
    });
  }
};
var C7 = _2(S7);

// mithic/packages/coreutils/dist/commands/tr.js
var o14 = {
  alpha: () => [...s17("a", "z"), ...s17("A", "Z")],
  digit: () => s17("0", "9"),
  alnum: () => [
    ...s17("a", "z"),
    ...s17("A", "Z"),
    ...s17("0", "9")
  ],
  upper: () => s17("A", "Z"),
  lower: () => s17("a", "z"),
  space: () => [
    " ",
    "	",
    "\n",
    "\r",
    "\v",
    "\f"
  ],
  blank: () => [" ", "	"],
  punct: () => [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"],
  xdigit: () => [
    ...s17("0", "9"),
    ...s17("A", "F"),
    ...s17("a", "f")
  ],
  cntrl: () => [...s17("\0", ""), "\x7F"],
  print: () => s17(" ", "~"),
  graph: () => s17("!", "~")
};
function s17(e11, t17) {
  let n18 = [];
  for (let r16 = e11.charCodeAt(0); r16 <= t17.charCodeAt(0); r16++) n18.push(String.fromCharCode(r16));
  return n18;
}
function c20(e11) {
  let t17 = [], n18 = (e12) => {
    let n19 = t17[t17.length - 1];
    n19 && n19.kind === "chars" ? n19.chars.push(...e12) : t17.push({
      kind: "chars",
      chars: e12
    });
  }, r16 = 0;
  for (; r16 < e11.length; ) {
    if (e11[r16] === "[" && e11[r16 + 1] === ":") {
      let t18 = e11.indexOf(":]", r16 + 2);
      if (t18 >= 0) {
        let i22 = e11.slice(r16 + 2, t18);
        if (o14[i22]) {
          n18(o14[i22]()), r16 = t18 + 2;
          continue;
        }
      }
    }
    if (e11[r16] === "[" && e11[r16 + 1] === "=") {
      let t18 = e11.indexOf("=]", r16 + 2);
      if (t18 >= 0) {
        n18(u19(e11.slice(r16 + 2, t18))), r16 = t18 + 2;
        continue;
      }
    }
    if (e11[r16] === "[") {
      let n19 = e11.indexOf("]", r16 + 1);
      if (n19 > r16) {
        let i22 = e11.slice(r16 + 1, n19), a20 = i22.indexOf("*");
        if (a20 >= 0) {
          let e12 = u19(i22.slice(0, a20)), o23 = i22.slice(a20 + 1);
          if (e12.length === 1) {
            let i23 = null;
            o23 !== "" && o23 !== "0" && (i23 = o23[0] === "0" ? parseInt(o23, 8) : parseInt(o23, 10), Number.isNaN(i23) && (i23 = null)), t17.push({
              kind: "repeat",
              char: e12[0],
              count: i23
            }), r16 = n19 + 1;
            continue;
          }
        }
      }
    }
    if (e11[r16] === "\\" && r16 + 1 < e11.length) {
      let [t18, i22] = l18(e11, r16);
      n18([t18]), r16 += i22;
      continue;
    }
    if (e11[r16 + 1] === "-" && r16 + 2 < e11.length && e11[r16 + 2] !== void 0 && e11[r16 + 2] !== "-") {
      let t18 = e11[r16] === "\\" ? l18(e11, r16) : [e11[r16], 1], i22 = r16 + t18[1], a20;
      a20 = e11[i22 + 1] === "\\" ? l18(e11, i22 + 1) : [e11[i22 + 1], 1], n18(s17(t18[0], a20[0])), r16 = i22 + 1 + a20[1];
      continue;
    }
    n18([e11[r16]]), r16++;
  }
  return t17;
}
function l18(e11, t17) {
  let n18 = e11[t17 + 1];
  if (n18 >= "0" && n18 <= "7") {
    let n19 = "", r16 = t17 + 1;
    for (; r16 < e11.length && r16 < t17 + 4 && e11[r16] >= "0" && e11[r16] <= "7"; ) n19 += e11[r16], r16++;
    return [String.fromCharCode(parseInt(n19, 8) & 255), r16 - t17];
  }
  return [{
    n: "\n",
    t: "	",
    r: "\r",
    "\\": "\\",
    f: "\f",
    v: "\v",
    a: "\x07",
    b: "\b"
  }[n18] ?? n18, 2];
}
function u19(e11) {
  let t17 = [], n18 = 0;
  for (; n18 < e11.length; ) if (e11[n18] === "\\" && n18 + 1 < e11.length) {
    let [r16, i22] = l18(e11, n18);
    t17.push(r16), n18 += i22;
  } else t17.push(e11[n18]), n18++;
  return t17;
}
function f18(e11) {
  let t17 = [];
  for (let n18 of e11) n18.kind === "chars" ? t17.push(...n18.chars) : t17.push(...Array(n18.count ?? 1).fill(n18.char));
  return t17;
}
function p17(e11, t17) {
  let n18 = [], r16 = -1, i22 = "";
  for (let t18 of e11) t18.kind === "chars" ? n18.push(...t18.chars) : t18.count === null ? (r16 = n18.length, i22 = t18.char, n18.push("\0PLACEHOLDER")) : n18.push(...Array(t18.count).fill(t18.char));
  if (r16 < 0) return n18;
  n18.splice(r16, 1);
  let a20 = Math.max(0, t17 - n18.length);
  return n18.splice(r16, 0, ...Array(a20).fill(i22)), n18;
}
var m15 = async (t17) => {
  let o23 = t17.args[0] ?? "tr", s30 = t7(t17.args.slice(1), {
    boolean: [
      "d",
      "s",
      "c",
      "C",
      "t",
      "complement",
      "delete",
      "squeeze-repeats",
      "truncate-set1"
    ],
    alias: {
      complement: "c",
      C: "c",
      delete: "d",
      "squeeze-repeats": "s",
      "truncate-set1": "t"
    },
    unknown: "error"
  }), { positionals: l38, flags: u37 } = s30, d36 = !!u37.d, m24 = !!u37.s, h24 = !!u37.c, g18 = !!u37.t, _21 = t17.stdout.getWriter(), v17 = t17.stderr.getWriter(), y18 = false, b17 = async (e11) => (await p2(v17, e11), await _21.close().catch(() => {
  }), await v17.close().catch(() => {
  }), 1);
  try {
    if (s30.unknown.length) return b17(`${h2(o23, s30.unknown[0])}
`);
    let i22 = (e11) => `\u2018${e11}\u2019`, a20 = `Try '${o23} --help' for more information.
`, u38 = l38.length;
    if (u38 === 0) return b17(`${o23}: missing operand
${a20}`);
    if (d36 && m24) {
      if (u38 < 2) return b17(`${o23}: missing operand after ${i22(l38[0])}
Two strings must be given when both deleting and squeezing repeats.
${a20}`);
      if (u38 > 2) return b17(`${o23}: extra operand ${i22(l38[2])}
${a20}`);
    } else if (d36) {
      if (u38 === 2) return b17(`${o23}: extra operand ${i22(l38[1])}
Only one string may be given when deleting without squeezing repeats.
${a20}`);
      if (u38 > 2) return b17(`${o23}: extra operand ${i22(l38[1])}
${a20}`);
    } else if (m24) {
      if (u38 > 2) return b17(`${o23}: extra operand ${i22(l38[2])}
${a20}`);
    } else {
      if (u38 === 1) return b17(`${o23}: missing operand after ${i22(l38[0])}
Two strings must be given when translating.
${a20}`);
      if (u38 > 2) return b17(`${o23}: extra operand ${i22(l38[2])}
${a20}`);
      if (l38[1] === "" && !g18) return b17(`${o23}: when not truncating set1, string2 must be non-empty
`);
    }
    let v18 = f18(c20(l38[0])), x13 = l38[1] === void 0 ? [] : c20(l38[1]), S11 = l38[1] === void 0 ? [] : p17(x13, v18.length);
    g18 && !d36 && v18.length > S11.length && (v18 = v18.slice(0, S11.length));
    let C12 = new Set(v18), w9 = (e11) => h24 ? !C12.has(e11) : C12.has(e11), T7, E6 = null;
    if (d36) {
      if (T7 = (e11) => w9(e11) ? "" : e11, m24 && S11.length > 0) {
        let e11 = new Set(S11);
        E6 = (t18) => e11.has(t18);
      }
    } else if (S11.length > 0) {
      let e11 = S11[S11.length - 1];
      if (h24) T7 = (t18) => w9(t18) ? e11 : t18;
      else {
        let t18 = /* @__PURE__ */ new Map();
        for (let n18 = 0; n18 < v18.length; n18++) t18.set(v18[n18], S11[n18] ?? e11);
        T7 = (e12) => t18.get(e12) ?? e12;
      }
      if (m24) {
        let e12 = new Set(S11);
        E6 = (t18) => e12.has(t18);
      }
    } else if (T7 = (e11) => e11, h24) E6 = (e11) => !C12.has(e11);
    else {
      let e11 = new Set(v18);
      E6 = (t18) => e11.has(t18);
    }
    let D6 = new d3(_21), O6 = new TextDecoder(), k5, A4 = t17.stdin.getReader(), j4 = (e11) => {
      let t18 = "";
      for (let n18 of e11) {
        let e12 = T7(n18);
        e12 !== "" && (E6 !== null && E6(e12) && e12 === k5 || (t18 += e12, k5 = e12));
      }
      return t18;
    };
    try {
      for (; ; ) {
        let { value: e12, done: t18 } = await A4.read();
        if (t18) break;
        if (!e12 || e12.byteLength === 0) continue;
        let n18 = j4(O6.decode(e12, { stream: true }));
        n18 !== "" && await D6.push(n18);
      }
      let e11 = j4(O6.decode());
      e11 !== "" && await D6.push(e11), await D6.flush();
    } catch (e11) {
      if (u2(e11)) y18 = true;
      else throw e11;
    } finally {
      A4.releaseLock();
    }
  } finally {
    await _21.close().catch(() => {
    }), await v17.close().catch(() => {
    }), y18 && await t17.stdin.cancel().catch(() => {
    });
  }
  return 0;
};
var h16 = _2(m15);

// mithic/packages/coreutils/dist/commands/tee.js
var i12 = async (e11) => {
  let { positionals: i22, flags: a20 } = t7(e11.args.slice(1), {
    boolean: ["a", "append"],
    alias: { append: "a" }
  }), o23 = e11.args[0] ?? "tee", s30 = !!a20.a, c37 = e11.stdout.getWriter(), l38 = e11.stderr.getWriter(), u37 = 0, d36 = [];
  for (let t17 of i22) try {
    let n18 = s30 ? {
      create: true,
      write: true,
      append: true
    } : {
      create: true,
      write: true,
      truncate: true
    }, { fd: r16 } = await e11.syscall("fs/open", {
      path: t17,
      oflags: n18
    });
    d36.push({
      path: t17,
      fd: r16,
      offset: 0,
      append: s30
    });
  } catch (e12) {
    await p2(l38, `${o23}: ${t17}: ${e12.message ?? "cannot write"}
`), u37 = 1;
  }
  let f32 = e11.stdin.getReader();
  try {
    for (; ; ) {
      let { value: t17, done: i23 } = await f32.read();
      if (i23) break;
      if (!(!t17 || t17.byteLength === 0)) {
        await f2(c37, t17);
        for (let n18 of d36) try {
          n18.append ? await e11.syscall("fs/write", {
            fd: n18.fd,
            data: t17
          }) : await e11.syscall("fs/write", {
            fd: n18.fd,
            data: t17,
            offset: n18.offset
          }), n18.offset += t17.byteLength;
        } catch (e12) {
          let t18 = e12.message ?? "cannot write";
          await p2(l38, `${o23}: ${n18.path}: ${t18}
`), u37 = 1;
        }
      }
    }
    return u37;
  } finally {
    f32.releaseLock();
    for (let t17 of d36) await e11.syscall("fs/close", { fd: t17.fd }).catch(() => {
    });
    await c37.close().catch(() => {
    }), await l38.close().catch(() => {
    });
  }
};
var a13 = _2(i12);

// mithic/packages/coreutils/dist/commands/diff.js
async function a14(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return i22;
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
function o15(e11, t17) {
  let n18 = e11.length, r16 = t17.length, i22 = Array.from({ length: n18 + 1 }, () => Array(r16 + 1).fill(0));
  for (let a20 = n18 - 1; a20 >= 0; a20--) for (let n19 = r16 - 1; n19 >= 0; n19--) i22[a20][n19] = e11[a20] === t17[n19] ? i22[a20 + 1][n19 + 1] + 1 : Math.max(i22[a20 + 1][n19], i22[a20][n19 + 1]);
  return i22;
}
function s18(e11, t17) {
  let n18 = o15(e11, t17), r16 = [], i22 = 0, a20 = 0;
  for (; i22 < e11.length || a20 < t17.length; ) i22 < e11.length && a20 < t17.length && e11[i22] === t17[a20] ? (r16.push([" ", e11[i22]]), i22++, a20++) : i22 < e11.length && (a20 >= t17.length || n18[i22 + 1][a20] >= n18[i22][a20 + 1]) ? (r16.push(["-", e11[i22]]), i22++) : (r16.push(["+", t17[a20]]), a20++);
  return r16;
}
function c21(e11, t17) {
  let n18 = s18(e11, t17), r16 = [], i22 = 1, a20 = 1, o23 = 0;
  for (; o23 < n18.length; ) {
    if (n18[o23][0] === " ") {
      i22++, a20++, o23++;
      continue;
    }
    let e12 = i22, t18 = a20, s30 = [], c37 = [];
    for (; o23 < n18.length && n18[o23][0] !== " "; ) n18[o23][0] === "-" ? (s30.push(n18[o23][1]), i22++) : (c37.push(n18[o23][1]), a20++), o23++;
    let u37 = i22 - 1, d36 = a20 - 1;
    if (s30.length > 0 && c37.length > 0) {
      r16.push(`${l19(e12, u37)}c${l19(t18, d36)}`);
      for (let e13 of s30) r16.push("< " + e13);
      r16.push("---");
      for (let e13 of c37) r16.push("> " + e13);
    } else if (s30.length > 0) {
      r16.push(`${l19(e12, u37)}d${t18 - 1}`);
      for (let e13 of s30) r16.push("< " + e13);
    } else {
      r16.push(`${e12 - 1}a${l19(t18, d36)}`);
      for (let e13 of c37) r16.push("> " + e13);
    }
  }
  return r16;
}
function l19(e11, t17) {
  return e11 === t17 ? String(e11) : `${e11},${t17}`;
}
function u20(e11, t17) {
  return t17 === 1 ? `${e11}` : t17 === 0 ? `${e11 - 1},0` : `${e11},${t17}`;
}
function d19(e11, t17, n18, r16, i22 = 3) {
  let a20 = s18(e11, t17);
  if (a20.every(([e12]) => e12 === " ")) return "";
  let o23 = i22, c37 = [], l38 = 0;
  for (; l38 < a20.length; ) if (a20[l38][0] !== " ") {
    let e12 = Math.max(0, l38 - o23), t18 = l38 + 1;
    for (; t18 < a20.length && a20[t18][0] !== " "; ) t18++;
    t18 = Math.min(a20.length, t18 + o23), c37.length > 0 && e12 <= c37[c37.length - 1][1] ? c37[c37.length - 1][1] = t18 : c37.push([e12, t18]), l38 = t18;
  } else l38++;
  let d36 = `--- ${n18}
+++ ${r16}
`;
  for (let [e12, t18] of c37) {
    let n19 = 1, r17 = 1, i23 = 0, o24 = 0;
    for (let t19 = 0; t19 < a20.length; t19++) t19 === e12 && (n19 = i23 + 1, r17 = o24 + 1), a20[t19][0] !== "+" && i23++, a20[t19][0] !== "-" && o24++;
    let s30 = 0, c38 = 0, l39 = "";
    for (let n20 = e12; n20 < t18; n20++) {
      let [e13, t19] = a20[n20];
      e13 !== "+" && s30++, e13 !== "-" && c38++, l39 += e13 + t19 + "\n";
    }
    d36 += `@@ -${u20(n19, s30)} +${u20(r17, c38)} @@
` + l39;
  }
  return d36;
}
var f19 = async (e11) => {
  let o23 = e11.args[0] ?? "diff", { positionals: s30, flags: l38 } = t7(e11.args.slice(1), {
    boolean: [
      "u",
      "unified",
      "q",
      "brief"
    ],
    alias: {
      unified: "u",
      brief: "q"
    }
  }), u37 = e11.stdout.getWriter(), f32 = e11.stderr.getWriter();
  try {
    if (s30.length < 2) return await g2(f32, 2, `${o23}: missing operand`);
    let [n18, p31] = s30, m24, h24;
    try {
      m24 = await a14(e11, n18);
    } catch {
      return await g2(f32, 2, `${o23}: ${n18}: No such file or directory`);
    }
    try {
      h24 = await a14(e11, p31);
    } catch {
      return await g2(f32, 2, `${o23}: ${p31}: No such file or directory`);
    }
    let g18 = new TextDecoder(), _21 = (e12) => e12 === "" ? [] : (e12.endsWith("\n") ? e12.slice(0, -1) : e12).split("\n"), v17 = _21(g18.decode(m24)), y18 = _21(g18.decode(h24)), b17 = !!l38.q, x13 = !!l38.u;
    if (b17) return v17.join("\n") === y18.join("\n") ? 0 : (await m2(u37, `Files ${n18} and ${p31} differ`), 1);
    if (x13) {
      let e12 = d19(v17, y18, n18, p31);
      return e12 === "" ? 0 : (await p2(u37, e12), 1);
    }
    let S11 = c21(v17, y18);
    if (S11.length === 0) return 0;
    for (let e12 of S11) await m2(u37, e12);
    return 1;
  } finally {
    await u37.close().catch(() => {
    }), await f32.close().catch(() => {
    });
  }
};
var p18 = _2(f19);

// mithic/packages/coreutils/dist/commands/mkdir.js
function c22(e11) {
  if (/^[0-7]+$/.test(e11)) return parseInt(e11, 8);
}
var l20 = async (e11) => {
  let { positionals: i22, flags: s30 } = t7(e11.args.slice(1), {
    boolean: ["p", "v"],
    string: ["m"],
    alias: {
      parents: "p",
      mode: "m",
      verbose: "v"
    }
  }), l38 = e11.stdout.getWriter(), d36 = e11.stderr.getWriter(), f32 = 0, p31 = typeof s30.m == "string" ? c22(s30.m) : void 0;
  if (typeof s30.m == "string" && p31 === void 0) return await m2(d36, `mkdir: invalid mode: '${s30.m}'`), await l38.close().catch(() => {
  }), await d36.close().catch(() => {
  }), 1;
  try {
    if (i22.length === 0) return await m2(d36, "mkdir: missing operand"), 1;
    for (let t17 of i22) {
      let i23 = T3(t17);
      try {
        s30.p ? await u21(e11, i23, p31, !!s30.v, l38) : (await s15(e11, i23), p31 !== void 0 && await p12(e11, i23, p31), s30.v && await m2(l38, `mkdir: created directory '${t17}'`));
      } catch (e12) {
        await m2(d36, `mkdir: cannot create directory '${t17}': ${e12.message}`), f32 = 1;
      }
    }
    return f32;
  } finally {
    await l38.close().catch(() => {
    }), await d36.close().catch(() => {
    });
  }
};
async function u21(e11, t17, o23, c37, l38) {
  if (await _10(e11, t17) === "directory") return;
  let d36 = C4(t17);
  d36 !== t17 && d36 !== "/" && d36 !== "." && await u21(e11, d36, o23, c37, l38), await s15(e11, t17), o23 !== void 0 && await p12(e11, t17, o23), c37 && await m2(l38, `mkdir: created directory '${t17}'`);
}
var d20 = _2(l20);

// mithic/packages/coreutils/dist/commands/rm.js
var l21 = async (e11) => {
  let { positionals: r16, flags: a20 } = t7(e11.args.slice(1), {
    boolean: [
      "r",
      "R",
      "f",
      "d",
      "v"
    ],
    alias: {
      recursive: "r",
      force: "f",
      dir: "d",
      verbose: "v"
    }
  }), l38 = !!a20.r || !!a20.R, d36 = !!a20.f, f32 = e11.stdout.getWriter(), p31 = e11.stderr.getWriter(), m24 = 0;
  try {
    if (r16.length === 0) return d36 ? 0 : (await m2(p31, "rm: missing operand"), 1);
    for (let t17 of r16) {
      let r17 = T3(t17);
      try {
        let i22 = await _10(e11, r17, false);
        if (i22 === void 0) {
          d36 || (await m2(p31, `rm: cannot remove '${t17}': No such file or directory`), m24 = 1);
          continue;
        }
        i22 === "directory" ? l38 ? await u22(e11, r17, !!a20.v, f32) : a20.d ? (await c16(e11, r17), a20.v && await m2(f32, `removed directory '${t17}'`)) : (await m2(p31, `rm: cannot remove '${t17}': Is a directory`), m24 = 1) : (await l14(e11, r17), a20.v && await m2(f32, `removed '${t17}'`));
      } catch (e12) {
        d36 || (await m2(p31, `rm: cannot remove '${t17}': ${e12.message}`), m24 = 1);
      }
    }
    return m24;
  } finally {
    await f32.close().catch(() => {
    }), await p31.close().catch(() => {
    });
  }
};
async function u22(e11, t17, i22, s30) {
  let l38 = await r10(e11, t17);
  for (let a20 of l38) {
    let o23 = w3(t17, a20.name);
    a20.type === "directory" ? await u22(e11, o23, i22, s30) : (await l14(e11, o23), i22 && await m2(s30, `removed '${o23}'`));
  }
  await c16(e11, t17), i22 && await m2(s30, `removed directory '${t17}'`);
}
var d21 = _2(l21);

// mithic/packages/coreutils/dist/commands/cp.js
var p19 = async (e11) => {
  let { positionals: i22, flags: o23 } = t7(e11.args.slice(1), {
    boolean: [
      "r",
      "R",
      "f",
      "p",
      "v"
    ],
    alias: {
      recursive: "r",
      force: "f",
      preserve: "p",
      verbose: "v"
    }
  }), c37 = !!o23.r || !!o23.R, l38 = !!o23.p, u37 = e11.stdout.getWriter(), f32 = e11.stderr.getWriter(), p31 = 0;
  try {
    if (i22.length < 2) return await m2(f32, i22.length === 0 ? "cp: missing file operand" : "cp: missing destination file operand"), 1;
    let t17 = i22[i22.length - 1], h24 = i22.slice(0, -1), g18 = await _10(e11, t17) === "directory";
    if (h24.length > 1 && !g18) return await m2(f32, `cp: target '${t17}' is not a directory`), 1;
    for (let i23 of h24) {
      let d36 = g18 ? w3(T3(t17), S4(i23)) : T3(t17);
      try {
        await m16(e11, T3(i23), d36, c37, l38, !!o23.v, u37);
      } catch (e12) {
        await m2(f32, `cp: cannot copy '${i23}': ${e12.message}`), p31 = 1;
      }
    }
    return p31;
  } finally {
    await u37.close().catch(() => {
    }), await f32.close().catch(() => {
    });
  }
};
async function m16(e11, t17, r16, s30, p31, h24, g18) {
  let _21 = await n11(e11, t17);
  if (_21.type === "directory") {
    if (!s30) throw Error("Is a directory (use -r)");
    await _10(e11, r16) === void 0 && await s15(e11, r16), p31 && await p12(e11, r16, _21.mode).catch(() => {
    });
    let n18 = await r10(e11, t17);
    for (let i22 of n18) await m16(e11, w3(t17, i22.name), w3(r16, i22.name), s30, p31, h24, g18);
  } else await a10(e11, r16, await i9(e11, t17), p31 ? _21.mode : void 0);
  h24 && await m2(g18, `'${t17}' -> '${r16}'`);
}
var h17 = _2(p19);

// mithic/packages/coreutils/dist/commands/mv.js
var _14 = async (e11) => {
  let { positionals: i22, flags: a20 } = t7(e11.args.slice(1), {
    boolean: [
      "f",
      "n",
      "v"
    ],
    alias: {
      force: "f",
      "no-clobber": "n",
      verbose: "v"
    }
  }), s30 = e11.stdout.getWriter(), l38 = e11.stderr.getWriter(), u37 = 0;
  try {
    if (i22.length < 2) return await m2(l38, i22.length === 0 ? "mv: missing file operand" : "mv: missing destination file operand"), 1;
    let t17 = i22[i22.length - 1], d36 = i22.slice(0, -1), f32 = await _10(e11, t17) === "directory";
    if (d36.length > 1 && !f32) return await m2(l38, `mv: target '${t17}' is not a directory`), 1;
    for (let i23 of d36) {
      let d37 = f32 ? w3(T3(t17), S4(i23)) : T3(t17);
      try {
        if (a20.n && await _10(e11, d37) !== void 0) continue;
        await v12(e11, T3(i23), d37), a20.v && await m2(s30, `'${i23}' -> '${d37}'`);
      } catch (e12) {
        await m2(l38, `mv: cannot move '${i23}' to '${d37}': ${e12.message}`), u37 = 1;
      }
    }
    return u37;
  } finally {
    await s30.close().catch(() => {
    }), await l38.close().catch(() => {
    });
  }
};
async function v12(e11, t17, n18) {
  try {
    await u14(e11, t17, n18);
    return;
  } catch (e12) {
    if (e8(e12) !== "EXDEV") throw e12;
  }
  await y12(e11, t17, n18), await b12(e11, t17);
}
async function y12(e11, t17, n18) {
  let r16 = await n11(e11, t17);
  if (r16.type === "directory") {
    await _10(e11, n18) === void 0 && await s15(e11, n18), await p12(e11, n18, r16.mode).catch(() => {
    });
    for (let r17 of await r10(e11, t17)) await y12(e11, w3(t17, r17.name), w3(n18, r17.name));
  } else await a10(e11, n18, await i9(e11, t17), r16.mode);
}
async function b12(e11, t17) {
  if (await _10(e11, t17, false) === "directory") {
    for (let n18 of await r10(e11, t17)) await b12(e11, w3(t17, n18.name));
    await c16(e11, t17);
  } else await l14(e11, t17);
}
var x8 = _2(_14);

// mithic/packages/coreutils/dist/commands/touch.js
var c23 = async (e11) => {
  let { positionals: c37, flags: l38 } = t7(e11.args.slice(1), {
    boolean: [
      "c",
      "a",
      "m"
    ],
    alias: { "no-create": "c" }
  }), u37 = e11.stderr.getWriter(), d36 = 0;
  try {
    if (c37.length === 0) return await m2(u37, "touch: missing file operand"), 1;
    for (let t17 of c37) try {
      if (await _10(e11, t17) === void 0) {
        if (l38.c) continue;
        await o12(e11, t17);
      }
      let n18 = !!l38.a && !l38.m, a20 = !!l38.m && !l38.a, c38 = {
        dirfd: b8,
        path: t17
      };
      if (n18 || a20) try {
        let r16 = await n11(e11, t17, false);
        n18 && (c38.mtime = new Date(r16.mtime).getTime()), a20 && (c38.atime = new Date(r16.atime).getTime());
      } catch {
      }
      await e11.syscall("fs/utimes", c38);
    } catch (e12) {
      if (t12(e12) && l38.c) continue;
      await m2(u37, `touch: cannot touch '${t17}': ${e12.message}`), d36 = 1;
    }
    return d36;
  } finally {
    await u37.close().catch(() => {
    });
  }
};
var l22 = _2(c23);

// mithic/packages/coreutils/dist/commands/chmod.js
var c24 = {
  r: 4,
  w: 2,
  x: 1
};
function l23(e11) {
  return /^[0-7]{1,4}$/.test(e11) ? parseInt(e11, 8) : void 0;
}
function u23(e11, t17) {
  let n18 = t17 & 4095;
  for (let t18 of e11.split(",")) {
    let e12 = /^([ugoa]*)([+\-=])([rwx]*)$/.exec(t18);
    if (!e12) return;
    let r16 = e12[1] || "a", i22 = e12[2], a20 = e12[3], o23 = 0;
    for (let e13 of a20) o23 |= c24[e13];
    let s30 = 0;
    if ((r16.includes("u") || r16.includes("a")) && (s30 |= o23 << 6), (r16.includes("g") || r16.includes("a")) && (s30 |= o23 << 3), (r16.includes("o") || r16.includes("a")) && (s30 |= o23), i22 === "+") n18 |= s30;
    else if (i22 === "-") n18 &= ~s30;
    else {
      let e13 = 0;
      (r16.includes("u") || r16.includes("a")) && (e13 |= 448), (r16.includes("g") || r16.includes("a")) && (e13 |= 56), (r16.includes("o") || r16.includes("a")) && (e13 |= 7), n18 = n18 & ~e13 | s30;
    }
  }
  return n18;
}
var d22 = async (e11) => {
  let { positionals: r16, flags: i22 } = t7(e11.args.slice(1), {
    boolean: ["R", "v"],
    alias: {
      recursive: "R",
      verbose: "v"
    }
  }), o23 = e11.stdout.getWriter(), s30 = e11.stderr.getWriter(), c37 = 0;
  try {
    if (r16.length < 2) return await m2(s30, "chmod: missing operand"), 1;
    let t17 = r16[0], u37 = r16.slice(1), d36 = l23(t17);
    for (let r17 of u37) try {
      await f20(e11, T3(r17), t17, d36, !!i22.R, !!i22.v, o23, s30);
    } catch (e12) {
      await m2(s30, `chmod: cannot access '${r17}': ${e12.message}`), c37 = 1;
    }
    return c37;
  } finally {
    await o23.close().catch(() => {
    }), await s30.close().catch(() => {
    });
  }
};
async function f20(e11, t17, a20, c37, l38, d36, p31, m24) {
  let h24 = await n11(e11, t17), g18;
  if (c37 !== void 0) g18 = c37;
  else if (g18 = u23(a20, h24.mode), g18 === void 0) {
    await m2(m24, `chmod: invalid mode: '${a20}'`);
    return;
  }
  if (await p12(e11, t17, g18), d36 && await m2(p31, `mode of '${t17}' changed to ${(g18 & 4095).toString(8).padStart(4, "0")}`), l38 && h24.type === "directory") for (let n18 of await r10(e11, t17)) await f20(e11, w3(t17, n18.name), a20, c37, l38, d36, p31, m24);
}
var p20 = _2(d22);

// mithic/packages/coreutils/dist/commands/pwd.js
var r11 = async (e11) => {
  t7(e11.args.slice(1), { boolean: ["L", "P"] });
  let r16 = e11.stdout.getWriter();
  try {
    return await m2(r16, e11.cwd || "/"), 0;
  } finally {
    await r16.close().catch(() => {
    });
  }
};
var i13 = _2(r11);

// mithic/packages/coreutils/dist/commands/basename.js
function i14(e11) {
  if (e11 === "") return "";
  let t17 = e11.length;
  for (; t17 > 0 && e11[t17 - 1] === "/"; ) t17--;
  if (t17 === 0) return "/";
  let n18 = t17;
  for (; n18 > 0 && e11[n18 - 1] !== "/"; ) n18--;
  return e11.slice(n18, t17);
}
function a15(e11, t17) {
  return t17 && e11 !== t17 && e11.endsWith(t17) ? e11.slice(0, -t17.length) : e11;
}
var o16 = async (e11) => {
  let o23 = e11.args[0] ?? "basename", s30 = t7(e11.args.slice(1), {
    boolean: ["a", "z"],
    string: ["s"],
    alias: {
      multiple: "a",
      suffix: "s",
      zero: "z"
    },
    unknown: "error"
  }), { positionals: c37, flags: l38 } = s30, u37 = e11.stdout.getWriter(), d36 = e11.stderr.getWriter(), f32 = l38.z ? "\0" : "\n", p31 = (e12) => u37.write(new TextEncoder().encode(e12 + f32));
  try {
    if (s30.unknown.length) return await g2(d36, 1, h2(o23, s30.unknown[0]));
    if (c37.length === 0) return await g2(d36, 1, "basename: missing operand");
    if (l38.a || typeof l38.s == "string") {
      let e12 = typeof l38.s == "string" ? l38.s : "";
      for (let t17 of c37) await p31(a15(i14(t17), e12));
    } else {
      if (c37.length > 2) return await g2(d36, 1, `basename: extra operand '${c37[2]}'`);
      let e12 = c37[1] ?? "";
      await p31(a15(i14(c37[0]), e12));
    }
    return 0;
  } finally {
    await u37.close().catch(() => {
    }), await d36.close().catch(() => {
    });
  }
};
var s19 = _2(o16);

// mithic/packages/coreutils/dist/commands/dirname.js
function i15(e11) {
  let t17 = e11.length;
  for (; t17 > 0 && e11[t17 - 1] === "/"; ) t17--;
  if (t17 === 0) return e11.length > 0 ? "/" : ".";
  let n18 = t17;
  for (; n18 > 0 && e11[n18 - 1] !== "/"; ) n18--;
  if (n18 === 0) return ".";
  let r16 = n18;
  for (; r16 > 0 && e11[r16 - 1] === "/"; ) r16--;
  return r16 === 0 ? "/" : e11.slice(0, r16);
}
var a16 = async (e11) => {
  let a20 = e11.args[0] ?? "dirname", o23 = t7(e11.args.slice(1), {
    boolean: ["z"],
    alias: { zero: "z" },
    unknown: "error"
  }), { positionals: s30, flags: c37 } = o23, l38 = e11.stdout.getWriter(), u37 = e11.stderr.getWriter(), d36 = c37.z ? "\0" : "\n";
  try {
    if (o23.unknown.length) return await g2(u37, 1, h2(a20, o23.unknown[0]));
    if (s30.length === 0) return await g2(u37, 1, "dirname: missing operand");
    for (let e12 of s30) await l38.write(new TextEncoder().encode(i15(e12) + d36));
    return 0;
  } finally {
    await l38.close().catch(() => {
    }), await u37.close().catch(() => {
    });
  }
};
var o17 = _2(a16);

// mithic/packages/coreutils/dist/commands/tac.js
async function o18(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return i22;
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
function s20(e11) {
  return e11.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function c25(e11, t17, n18) {
  if (e11 === "") return "";
  let r16 = [], i22 = new RegExp(t17.source, t17.flags.includes("g") ? t17.flags : t17.flags + "g"), a20, o23 = -1;
  for (; (a20 = i22.exec(e11)) !== null; ) a20.index === i22.lastIndex && i22.lastIndex++, a20[0] !== "" && (a20.index < o23 || (r16.push({
    start: a20.index,
    end: a20.index + a20[0].length
  }), o23 = a20.index + a20[0].length));
  if (r16.length === 0) return e11;
  let s30 = [];
  if (n18) {
    s30.push(e11.slice(0, r16[0].start));
    for (let t18 = 0; t18 < r16.length; t18++) {
      let n19 = t18 + 1 < r16.length ? r16[t18 + 1].start : e11.length;
      s30.push(e11.slice(r16[t18].start, n19));
    }
  } else {
    let t18 = 0;
    for (let n19 of r16) s30.push(e11.slice(t18, n19.end)), t18 = n19.end;
    t18 < e11.length && s30.push(e11.slice(t18));
  }
  return s30.reverse().join("");
}
var l24 = async (e11) => {
  let l38 = e11.args[0] ?? "tac", u37 = t7(e11.args.slice(1), {
    string: [
      "s",
      "separator",
      "regex"
    ],
    boolean: [
      "b",
      "before",
      "r"
    ],
    alias: {
      separator: "s",
      before: "b"
    },
    unknown: "error"
  }), d36 = e11.stdout.getWriter(), f32 = e11.stderr.getWriter(), p31 = async (e12, n18) => {
    try {
      return await g2(f32, e12, n18);
    } finally {
      await d36.close().catch(() => {
      }), await f32.close().catch(() => {
      });
    }
  };
  if (u37.unknown.length) return p31(1, h2(l38, u37.unknown[0]));
  let { positionals: m24, flags: h24 } = u37, g18 = !!h24.b, _21 = !!h24.r || h24.regex !== void 0, v17 = h24.regex === void 0 ? h24.s === void 0 ? "\n" : String(h24.s) : String(h24.regex), y18;
  try {
    y18 = new RegExp(_21 ? v17 : s20(v17));
  } catch {
    return p31(1, `${l38}: Invalid regular expression`);
  }
  let b17 = m24.length > 0 ? m24 : ["-"], x13 = 0;
  try {
    for (let t17 of b17) {
      let n18;
      if (t17 === "-") n18 = await o3(e11.stdin);
      else try {
        n18 = await o18(e11, t17);
      } catch (e12) {
        await p2(f32, `${l38}: ${t17}: ${e12.message ?? "No such file or directory"}
`), x13 = 1;
        continue;
      }
      let r16 = new TextDecoder().decode(n18);
      r16 !== "" && await p2(d36, c25(r16, y18, g18));
    }
    return x13;
  } finally {
    await d36.close().catch(() => {
    }), await f32.close().catch(() => {
    });
  }
};
var u24 = _2(l24);

// mithic/packages/coreutils/dist/commands/nl.js
async function c26(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return new TextDecoder().decode(i22);
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
function l25(e11) {
  let t17 = "";
  for (let n18 = 0; n18 < e11.length; n18++) {
    let r16 = e11[n18];
    if (r16 === "\\" && n18 + 1 < e11.length) {
      let r17 = e11[n18 + 1];
      if ("(){}+?|".includes(r17)) {
        t17 += r17, n18++;
        continue;
      }
      t17 += "\\" + r17, n18++;
      continue;
    }
    if ("(){}+?|".includes(r16)) {
      t17 += "\\" + r16;
      continue;
    }
    t17 += r16;
  }
  return new RegExp(t17);
}
var u25 = async (t17) => {
  let u37 = t7(t17.args.slice(1), {
    string: [
      "b",
      "w",
      "s",
      "v",
      "i",
      "n",
      "l",
      "body-numbering",
      "number-width",
      "number-separator",
      "starting-line-number",
      "line-increment",
      "number-format",
      "join-blank-lines"
    ],
    alias: {
      "body-numbering": "b",
      "number-width": "w",
      "number-separator": "s",
      "starting-line-number": "v",
      "line-increment": "i",
      "number-format": "n",
      "join-blank-lines": "l"
    },
    unknown: "error"
  }), d36 = t17.args[0] ?? "nl", f32 = t17.stdout.getWriter(), p31 = t17.stderr.getWriter(), m24 = async (e11, t18) => {
    try {
      return await g2(p31, e11, t18);
    } finally {
      await f32.close().catch(() => {
      }), await p31.close().catch(() => {
      });
    }
  };
  if (u37.unknown.length) return m24(1, h2(d36, u37.unknown[0]));
  let { positionals: h24, flags: g18 } = u37, _21 = g18.b === void 0 ? "t" : String(g18.b), v17 = g18.w === void 0 ? 6 : Number(g18.w), y18 = g18.s === void 0 ? "	" : String(g18.s), b17 = g18.v === void 0 ? 1 : Number(g18.v), x13 = g18.i === void 0 ? 1 : Number(g18.i), S11 = g18.n === void 0 ? "rn" : String(g18.n), C12 = g18.l === void 0 ? 1 : Math.max(1, Number(g18.l));
  if (S11 !== "ln" && S11 !== "rn" && S11 !== "rz") return m24(1, `${d36}: invalid line numbering format: '${g18.n}'`);
  let w9;
  if (_21[0] === "p") w9 = l25(_21.slice(1));
  else if (_21 !== "a" && _21 !== "t" && _21 !== "n") return m24(1, `${d36}: invalid body numbering style: '${_21}'`);
  let T7 = " ".repeat(v17 + y18.length), E6 = (e11) => {
    let t18 = String(e11);
    return S11 === "ln" ? t18.padEnd(v17, " ") : S11 === "rz" ? t18.padStart(v17, "0") : t18.padStart(v17, " ");
  }, D6 = b17, O6 = 0, k5 = (e11) => {
    let t18;
    if (e11 === "") {
      O6++;
      let n18 = O6 >= C12;
      n18 && (O6 = 0), t18 = n18 && (_21 === "a" || w9 !== void 0 && w9.test(e11));
    } else O6 = 0, t18 = _21 === "a" || _21 === "t" && e11 !== "" || w9 !== void 0 && w9.test(e11);
    if (t18) {
      let t19 = E6(D6) + y18;
      return D6 += x13, t19 + e11;
    }
    return T7 + e11;
  }, A4 = 0, j4 = false;
  try {
    let n18 = h24.length > 0 ? h24 : ["-"];
    for (let i22 of n18) {
      if (i22 === "-") {
        let n20 = new d3(f32);
        try {
          for await (let { line: e11 } of l3(t17.stdin)) await n20.push(k5(e11) + "\n");
          await n20.flush();
        } catch (e11) {
          if (u2(e11)) {
            j4 = true;
            break;
          }
          throw e11;
        }
        continue;
      }
      let n19;
      try {
        n19 = await c26(t17, i22);
      } catch (e11) {
        await p2(p31, `${d36}: ${i22}: ${e11.message ?? "No such file or directory"}
`), A4 = 1;
        continue;
      }
      if (n19 === "") continue;
      let a20 = (n19.endsWith("\n") ? n19.slice(0, -1) : n19).split("\n"), l38 = [];
      for (let e11 of a20) l38.push(k5(e11) + "\n");
      await p2(f32, l38.join(""));
    }
    return A4;
  } finally {
    await f32.close().catch(() => {
    }), await p31.close().catch(() => {
    }), j4 && await t17.stdin.cancel().catch(() => {
    });
  }
};
var d23 = _2(u25);

// mithic/packages/coreutils/dist/commands/od.js
var a17 = {
  0: "\\0",
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r"
};
var o19 = /* @__PURE__ */ "nul.soh.stx.etx.eot.enq.ack.bel.bs.ht.nl.vt.ff.cr.so.si.dle.dc1.dc2.dc3.dc4.nak.syn.etb.can.em.sub.esc.fs.gs.rs.us.sp".split(".");
function s21(e11, t17) {
  return t17 === "n" ? "" : t17 === "x" ? e11.toString(16).padStart(6, "0") : t17 === "d" ? e11.toString(10).padStart(7, "0") : e11.toString(8).padStart(7, "0");
}
function c27(e11, t17) {
  return e11 === "x" ? 1 + t17 * 2 : e11 === "o" ? 1 + {
    1: 3,
    2: 6,
    4: 11,
    8: 22
  }[t17] : e11 === "u" ? 1 + {
    1: 3,
    2: 5,
    4: 10,
    8: 20
  }[t17] : 1 + {
    1: 4,
    2: 6,
    4: 11,
    8: 20
  }[t17];
}
function l26(e11, t17, n18, r16) {
  let i22 = 0n;
  for (let a20 = r16 - 1; a20 >= 0; a20--) {
    let r17 = t17 + a20, o23 = r17 < n18 ? e11[r17] : 0;
    i22 = i22 << 8n | BigInt(o23);
  }
  return i22;
}
function u26(e11, t17, n18, r16) {
  let { kind: i22, size: a20 } = r16, o23 = l26(e11, t17, n18, a20);
  if (i22 === "x") return o23.toString(16).padStart(a20 * 2, "0");
  if (i22 === "o") return o23.toString(8).padStart({
    1: 3,
    2: 6,
    4: 11,
    8: 22
  }[a20], "0");
  if (i22 === "u") return o23.toString(10);
  let s30 = BigInt(a20) * 8n;
  return (o23 >= 1n << s30 - 1n ? o23 - (1n << s30) : o23).toString(10);
}
function d24(e11, t17, n18, r16) {
  let i22 = new ArrayBuffer(r16), a20 = new DataView(i22);
  for (let i23 = 0; i23 < r16; i23++) a20.setUint8(i23, t17 + i23 < n18 ? e11[t17 + i23] : 0);
  let o23 = r16 === 4 ? a20.getFloat32(0, true) : a20.getFloat64(0, true);
  return Number.isNaN(o23) ? "nan" : o23 === Infinity ? "inf" : o23 === -Infinity ? "-inf" : p21(f21(o23, r16));
}
function f21(e11, t17) {
  let n18 = (n19) => {
    let r16 = parseFloat(n19);
    return t17 === 4 ? Math.fround(r16) === Math.fround(e11) : r16 === e11;
  };
  if (e11 === 0) return Object.is(e11, -0) ? "-0" : "0";
  for (let t18 = 1; t18 <= 17; t18++) {
    let r16 = e11.toPrecision(t18);
    if (n18(r16)) return r16;
  }
  return e11.toString();
}
function p21(e11) {
  let t17 = /^(-?)(\d+(?:\.\d+)?)e([+-])(\d+)$/i.exec(e11);
  if (!t17) return e11.includes(".") ? e11.replace(/0+$/, "").replace(/\.$/, "") : e11;
  let [, n18, r16, i22, a20] = t17;
  return `${n18}${r16.includes(".") ? r16.replace(/0+$/, "").replace(/\.$/, "") : r16}e${i22}${a20.padStart(2, "0")}`;
}
function m17(e11) {
  return e11 in a17 ? a17[e11] : e11 >= 32 && e11 <= 126 ? String.fromCharCode(e11) : e11.toString(8).padStart(3, "0");
}
function h18(e11) {
  return e11 < o19.length ? o19[e11] : e11 === 127 ? "del" : e11 >= 33 && e11 <= 126 ? String.fromCharCode(e11) : h18(e11 & 127);
}
function g13(e11) {
  return e11.kind === "a" || e11.kind === "c" ? 1 : e11.size;
}
function _15(e11) {
  return e11.kind === "a" || e11.kind === "c" ? 4 : e11.kind === "f" ? e11.size === 4 ? 16 : 25 : c27(e11.kind, e11.size);
}
function v13(e11, t17, n18, r16) {
  return r16.kind === "c" ? m17(e11[t17]) : r16.kind === "a" ? h18(e11[t17]) : r16.kind === "f" ? d24(e11, t17, n18, r16.size) : u26(e11, t17, n18, r16);
}
function y13(e11, t17, n18, r16, i22, a20) {
  let o23 = g13(r16), s30 = i22 / o23, c37 = "", l38 = 0;
  for (let i23 = t17; i23 < n18; i23 += o23, l38++) {
    l38 === s30 && (l38 = 0);
    let t18 = Math.ceil((l38 + 1) * a20 / s30) - Math.ceil(l38 * a20 / s30);
    c37 += v13(e11, i23, n18, r16).padStart(t18, " ");
  }
  return c37;
}
function b13(e11) {
  let t17 = [], n18 = () => {
    e11[r16] === "z" && t17.length > 0 && (t17[t17.length - 1].z = true, r16++);
  }, r16 = 0;
  for (; r16 < e11.length; ) {
    let i22 = e11[r16++];
    if (i22 === "a" || i22 === "c") {
      t17.push({
        kind: i22,
        size: 1
      }), n18();
      continue;
    }
    if (i22 === "d" || i22 === "o" || i22 === "u" || i22 === "x" || i22 === "f") {
      let a20, o23 = e11[r16];
      if (o23 !== void 0 && o23 >= "0" && o23 <= "9") {
        let t18 = "";
        for (; r16 < e11.length && e11[r16] >= "0" && e11[r16] <= "9"; ) t18 += e11[r16++];
        a20 = parseInt(t18, 10);
      } else i22 === "f" ? o23 === "F" ? (a20 = 4, r16++) : o23 === "D" || o23 === "L" ? (a20 = 8, r16++) : a20 = 8 : o23 === "C" ? (a20 = 1, r16++) : o23 === "S" ? (a20 = 2, r16++) : o23 === "I" ? (a20 = 4, r16++) : o23 === "L" ? (a20 = 8, r16++) : a20 = 4;
      if (i22 === "f") {
        if (a20 !== 4 && a20 !== 8) return null;
      } else if (a20 !== 1 && a20 !== 2 && a20 !== 4 && a20 !== 8) return null;
      t17.push({
        kind: i22,
        size: a20
      }), n18();
      continue;
    }
    return null;
  }
  return t17.length > 0 ? t17 : null;
}
var x9 = {
  a: {
    kind: "a",
    size: 1
  },
  b: {
    kind: "o",
    size: 1
  },
  c: {
    kind: "c",
    size: 1
  },
  d: {
    kind: "u",
    size: 2
  },
  e: {
    kind: "f",
    size: 8
  },
  f: {
    kind: "f",
    size: 4
  },
  F: {
    kind: "f",
    size: 8
  },
  h: {
    kind: "x",
    size: 2
  },
  i: {
    kind: "d",
    size: 4
  },
  l: {
    kind: "d",
    size: 8
  },
  o: {
    kind: "o",
    size: 2
  },
  s: {
    kind: "d",
    size: 2
  },
  x: {
    kind: "x",
    size: 2
  }
};
function S8(e11) {
  if (!/^0[xX][0-9a-fA-F]+$|^0[0-7]*$|^[0-9]+$/.test(e11)) return null;
  let t17 = /^0[xX]/.test(e11) ? parseInt(e11, 16) : /^0[0-7]/.test(e11) ? parseInt(e11, 8) : parseInt(e11, 10);
  return Number.isFinite(t17) && t17 >= 0 ? t17 : null;
}
var C8 = async (e11) => {
  let a20 = e11.args[0] ?? "od", o23 = e11.stdout.getWriter(), c37 = e11.stderr.getWriter();
  try {
    let l38 = e11.args.slice(1), u37 = [], d36 = [], f32 = "o", p31 = 16, m24, h24 = 0, v17 = false;
    for (let e12 = 0; e12 < l38.length; e12++) {
      let n18 = l38[e12];
      if (n18 === "--") {
        for (e12++; e12 < l38.length; e12++) d36.push(l38[e12]);
        break;
      }
      if (n18 === "-" || !n18.startsWith("-")) {
        d36.push(n18);
        continue;
      }
      if (n18.startsWith("--")) {
        let r17 = n18.slice(2), i22 = r17.indexOf("="), o24 = i22 >= 0 ? r17.slice(0, i22) : r17, s30 = i22 >= 0 ? r17.slice(i22 + 1) : void 0, d37 = () => s30 ?? l38[++e12];
        if (o24 === "address-radix") {
          let e13 = d37()?.[0];
          if (e13 === void 0 || !"xdon".includes(e13)) return await g2(c37, 1, `${a20}: invalid output address radix '${e13 ?? ""}'; it must be one character from [doxn]`);
          f32 = e13;
          continue;
        }
        if (o24 === "format" || o24 === "type") {
          let e13 = d37();
          if (e13 === void 0) return await g2(c37, 1, `${a20}: option '--${o24}' requires an argument`);
          let n19 = b13(e13);
          if (!n19) return await g2(c37, 1, `${a20}: invalid type string '${e13}'`);
          u37.push(...n19);
          continue;
        }
        if (o24 === "read-bytes") {
          let e13 = d37(), n19 = e13 === void 0 ? null : S8(e13);
          if (n19 === null) return await g2(c37, 1, `${a20}: invalid -N argument '${e13 ?? ""}'`);
          m24 = n19;
          continue;
        }
        if (o24 === "skip-bytes") {
          let e13 = d37(), n19 = e13 === void 0 ? null : S8(e13);
          if (n19 === null) return await g2(c37, 1, `${a20}: invalid -j argument '${e13 ?? ""}'`);
          h24 = n19;
          continue;
        }
        if (o24 === "output-duplicates") {
          v17 = true;
          continue;
        }
        if (o24 === "width") {
          if (s30 !== void 0) {
            let e13 = S8(s30);
            if (e13 === null || e13 === 0) return await g2(c37, 1, `${a20}: invalid -w argument '${s30}'`);
            p31 = e13;
          } else p31 = 32;
          continue;
        }
        return await g2(c37, 1, `${a20}: unrecognized option '--${o24}'
Try '${a20} --help' for more information.`);
      }
      let r16 = n18.slice(1);
      for (let n19 = 0; n19 < r16.length; n19++) {
        let i22 = r16[n19];
        if (i22 === "A") {
          let i23 = r16.slice(n19 + 1), o24 = (i23.length > 0 ? i23 : l38[++e12])?.[0];
          if (o24 === void 0 || !"xdon".includes(o24)) return await g2(c37, 1, `${a20}: invalid output address radix '${o24 ?? ""}'; it must be one character from [doxn]`);
          f32 = o24;
          break;
        }
        if (i22 === "t") {
          let i23 = r16.slice(n19 + 1), o24 = i23.length > 0 ? i23 : l38[++e12];
          if (o24 === void 0) return await g2(c37, 1, `${a20}: option requires an argument -- 't'
Try '${a20} --help' for more information.`);
          let s30 = b13(o24);
          if (!s30) return await g2(c37, 1, `${a20}: invalid type string '${o24}'`);
          u37.push(...s30);
          break;
        }
        if (i22 === "N") {
          let i23 = r16.slice(n19 + 1), o24 = i23.length > 0 ? i23 : l38[++e12], s30 = o24 === void 0 ? null : S8(o24);
          if (s30 === null) return await g2(c37, 1, `${a20}: invalid -N argument '${o24 ?? ""}'`);
          m24 = s30;
          break;
        }
        if (i22 === "j") {
          let i23 = r16.slice(n19 + 1), o24 = i23.length > 0 ? i23 : l38[++e12], s30 = o24 === void 0 ? null : S8(o24);
          if (s30 === null) return await g2(c37, 1, `${a20}: invalid -j argument '${o24 ?? ""}'`);
          h24 = s30;
          break;
        }
        if (i22 === "w") {
          let e13 = r16.slice(n19 + 1);
          if (e13.length > 0) {
            let n20 = S8(e13);
            if (n20 === null || n20 === 0) return await g2(c37, 1, `${a20}: invalid -w argument '${e13}'`);
            p31 = n20;
            break;
          }
          p31 = 32;
          continue;
        }
        if (i22 === "v") {
          v17 = true;
          continue;
        }
        if (i22 in x9) {
          u37.push({ ...x9[i22] });
          continue;
        }
        return await g2(c37, 1, `${a20}: invalid option -- '${i22}'
Try '${a20} --help' for more information.`);
      }
    }
    u37.length === 0 && u37.push({
      kind: "o",
      size: 2
    });
    let C12 = d36[0], w9;
    if (C12 === void 0 || C12 === "-") w9 = await o3(e11.stdin);
    else try {
      w9 = await i9(e11, C12);
    } catch {
      return await g2(c37, 1, `${a20}: ${C12}: No such file or directory`);
    }
    if (h24 > 0) {
      if (h24 > w9.byteLength) return await g2(c37, 1, `${a20}: cannot skip past end of combined input`);
      w9 = w9.subarray(h24);
    }
    m24 !== void 0 && (w9 = w9.subarray(0, m24));
    let T7 = (e12, t17) => t17 === 0 ? e12 : T7(t17, e12 % t17), E6 = u37.reduce((e12, t17) => {
      let n18 = g13(t17);
      return e12 / T7(e12, n18) * n18;
    }, 1);
    if (p31 % E6 !== 0) {
      let e12 = Math.max(E6, p31 - p31 % E6);
      await p2(c37, `${a20}: warning: invalid width ${p31}; using ${e12} instead
`), p31 = e12;
    }
    let D6 = u37.reduce((e12, t17) => Math.max(e12, _15(t17) * (p31 / g13(t17))), 0), O6 = (e12, t17) => {
      let n18 = "";
      for (let r16 = e12; r16 < t17; r16++) {
        let e13 = w9[r16];
        n18 += e13 >= 32 && e13 <= 126 ? String.fromCharCode(e13) : ".";
      }
      return `  >${n18}<`;
    }, k5 = (e12, t17, n18) => {
      let r16 = y13(w9, e12, t17, n18, p31, D6);
      return n18.z ? r16.padEnd(D6, " ") + O6(e12, t17) : r16;
    }, A4 = s21(0, f32).length, j4 = " ".repeat(A4), M4, N4 = false;
    for (let e12 = 0; e12 < w9.byteLength; e12 += p31) {
      let t17 = Math.min(e12 + p31, w9.byteLength), n18 = u37.map((n19) => k5(e12, t17, n19)), i22 = n18.join("\0");
      if (!v17 && M4 !== void 0 && i22 === M4 && t17 - e12 === p31) {
        N4 ||= (await p2(o23, "*\n"), true);
        continue;
      }
      N4 = false, M4 = i22;
      for (let t18 = 0; t18 < n18.length; t18++) await p2(o23, (t18 === 0 ? s21(e12 + h24, f32) : j4) + n18[t18] + "\n");
    }
    return f32 !== "n" && await p2(o23, s21(w9.byteLength + h24, f32) + "\n"), 0;
  } finally {
    await o23.close().catch(() => {
    }), await c37.close().catch(() => {
    });
  }
};
var w5 = _2(C8);

// mithic/packages/coreutils/dist/commands/_md5.js
var e9 = [
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21
];
var t13 = (() => {
  let e11 = new Uint32Array(64);
  for (let t17 = 0; t17 < 64; t17++) e11[t17] = Math.floor(Math.abs(Math.sin(t17 + 1)) * 2 ** 32) >>> 0;
  return e11;
})();
var n13 = (e11, t17) => (e11 << t17 | e11 >>> 32 - t17) >>> 0;
function r12(r16) {
  let i22 = r16.length, a20 = (i22 + 8 >> 6) * 64 + 64, o23 = new Uint8Array(a20);
  o23.set(r16), o23[i22] = 128;
  let s30 = i22 * 8;
  for (let e11 = 0; e11 < 8; e11++) o23[a20 - 8 + e11] = (Math.floor(s30 / 2 ** (8 * e11)) & 255) >>> 0;
  let c37 = 1732584193, l38 = 4023233417, u37 = 2562383102, d36 = 271733878, f32 = new Uint32Array(16);
  for (let r17 = 0; r17 < a20; r17 += 64) {
    for (let e11 = 0; e11 < 16; e11++) {
      let t17 = r17 + e11 * 4;
      f32[e11] = (o23[t17] | o23[t17 + 1] << 8 | o23[t17 + 2] << 16 | o23[t17 + 3] << 24) >>> 0;
    }
    let i23 = c37, a21 = l38, s31 = u37, p32 = d36;
    for (let r18 = 0; r18 < 64; r18++) {
      let o24, c38;
      r18 < 16 ? (o24 = a21 & s31 | ~a21 & p32, c38 = r18) : r18 < 32 ? (o24 = p32 & a21 | ~p32 & s31, c38 = (5 * r18 + 1) % 16) : r18 < 48 ? (o24 = a21 ^ s31 ^ p32, c38 = (3 * r18 + 5) % 16) : (o24 = s31 ^ (a21 | ~p32), c38 = 7 * r18 % 16), o24 = o24 + i23 + t13[r18] + f32[c38] >>> 0, i23 = p32, p32 = s31, s31 = a21, a21 = a21 + n13(o24, e9[r18]) >>> 0;
    }
    c37 = c37 + i23 >>> 0, l38 = l38 + a21 >>> 0, u37 = u37 + s31 >>> 0, d36 = d36 + p32 >>> 0;
  }
  let p31 = new Uint8Array(16), m24 = [
    c37,
    l38,
    u37,
    d36
  ];
  for (let e11 = 0; e11 < 4; e11++) p31[e11 * 4] = m24[e11] & 255, p31[e11 * 4 + 1] = m24[e11] >>> 8 & 255, p31[e11 * 4 + 2] = m24[e11] >>> 16 & 255, p31[e11 * 4 + 3] = m24[e11] >>> 24 & 255;
  return p31;
}
function i16(e11) {
  let t17 = r12(e11), n18 = "";
  for (let e12 of t17) n18 += e12.toString(16).padStart(2, "0");
  return n18;
}

// mithic/packages/coreutils/dist/commands/_sha224.js
var e10 = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var t14 = new Uint32Array([
  3238371032,
  914150663,
  812702999,
  4144912697,
  4290775857,
  1750603025,
  1694076839,
  3204075428
]);
var n14 = (e11, t17) => (e11 >>> t17 | e11 << 32 - t17) >>> 0;
function r13(r16) {
  let i22 = r16.length, a20 = (i22 + 8 >> 6) * 64 + 64, o23 = new Uint8Array(a20);
  o23.set(r16), o23[i22] = 128;
  let s30 = i22 * 8;
  for (let e11 = 0; e11 < 8; e11++) o23[a20 - 1 - e11] = (Math.floor(s30 / 2 ** (8 * e11)) & 255) >>> 0;
  let c37 = new Uint32Array(t14), l38 = new Uint32Array(64);
  for (let t17 = 0; t17 < a20; t17 += 64) {
    for (let e11 = 0; e11 < 16; e11++) {
      let n18 = t17 + e11 * 4;
      l38[e11] = (o23[n18] << 24 | o23[n18 + 1] << 16 | o23[n18 + 2] << 8 | o23[n18 + 3]) >>> 0;
    }
    for (let e11 = 16; e11 < 64; e11++) {
      let t18 = n14(l38[e11 - 15], 7) ^ n14(l38[e11 - 15], 18) ^ l38[e11 - 15] >>> 3, r18 = n14(l38[e11 - 2], 17) ^ n14(l38[e11 - 2], 19) ^ l38[e11 - 2] >>> 10;
      l38[e11] = l38[e11 - 16] + t18 + l38[e11 - 7] + r18 >>> 0;
    }
    let r17 = c37[0], i23 = c37[1], a21 = c37[2], s31 = c37[3], u38 = c37[4], d36 = c37[5], f32 = c37[6], p31 = c37[7];
    for (let t18 = 0; t18 < 64; t18++) {
      let o24 = n14(u38, 6) ^ n14(u38, 11) ^ n14(u38, 25), c38 = u38 & d36 ^ ~u38 & f32, m24 = p31 + o24 + c38 + e10[t18] + l38[t18] >>> 0, h24 = (n14(r17, 2) ^ n14(r17, 13) ^ n14(r17, 22)) + (r17 & i23 ^ r17 & a21 ^ i23 & a21) >>> 0;
      p31 = f32, f32 = d36, d36 = u38, u38 = s31 + m24 >>> 0, s31 = a21, a21 = i23, i23 = r17, r17 = m24 + h24 >>> 0;
    }
    c37[0] = c37[0] + r17 >>> 0, c37[1] = c37[1] + i23 >>> 0, c37[2] = c37[2] + a21 >>> 0, c37[3] = c37[3] + s31 >>> 0, c37[4] = c37[4] + u38 >>> 0, c37[5] = c37[5] + d36 >>> 0, c37[6] = c37[6] + f32 >>> 0, c37[7] = c37[7] + p31 >>> 0;
  }
  let u37 = new Uint8Array(28);
  for (let e11 = 0; e11 < 7; e11++) u37[e11 * 4] = c37[e11] >>> 24 & 255, u37[e11 * 4 + 1] = c37[e11] >>> 16 & 255, u37[e11 * 4 + 2] = c37[e11] >>> 8 & 255, u37[e11 * 4 + 3] = c37[e11] & 255;
  return u37;
}
function i17(e11) {
  let t17 = "";
  for (let n18 of r13(e11)) t17 += n18.toString(16).padStart(2, "0");
  return t17;
}

// mithic/packages/coreutils/dist/commands/cksum.js
function l27() {
  let e11 = new Uint32Array(256);
  for (let t17 = 0; t17 < 256; t17++) {
    let n18 = t17;
    for (let e12 = 0; e12 < 8; e12++) n18 = n18 & 1 ? 3988292384 ^ n18 >>> 1 : n18 >>> 1;
    e11[t17] = n18;
  }
  return e11;
}
var u27 = l27();
function f22() {
  let e11 = new Uint32Array(256);
  for (let t17 = 0; t17 < 256; t17++) {
    let n18 = t17 << 24;
    for (let e12 = 0; e12 < 8; e12++) n18 = n18 & 2147483648 ? n18 << 1 ^ 79764919 : n18 << 1;
    e11[t17] = n18 >>> 0;
  }
  return e11;
}
var p22 = f22();
function m18(e11, t17) {
  for (let n18 of t17) e11 = (e11 << 8 ^ p22[(e11 >>> 24 ^ n18) & 255]) >>> 0;
  return e11;
}
function h19(e11, t17) {
  for (let n18 = t17; n18 !== 0; n18 = Math.floor(n18 / 256)) e11 = (e11 << 8 ^ p22[(e11 >>> 24 ^ n18 & 255) & 255]) >>> 0;
  return ~e11 >>> 0;
}
function _16(e11, t17) {
  for (let n18 of t17) e11 = (e11 >> 1) + ((e11 & 1) << 15) + n18 & 65535;
  return e11;
}
function y14(e11) {
  let t17 = (e11 & 65535) + (Math.floor(e11 / 65536) & 65535);
  return (t17 & 65535) + (t17 >> 16);
}
function b14(e11, t17) {
  for (let n18 of t17) e11 = u27[(e11 ^ n18) & 255] ^ e11 >>> 8;
  return e11 >>> 0;
}
async function x10(e11, t17, n18) {
  let r16 = n18 === "crc32b" ? 4294967295 : 0, i22 = 0, a20 = t17 === "-" ? e11.stdin.getReader() : null, o23 = -1;
  a20 === null && ({ fd: o23 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  }));
  try {
    for (; ; ) {
      let t18;
      if (a20) {
        let { value: e12, done: n19 } = await a20.read();
        if (n19) break;
        t18 = e12;
      } else if (t18 = await e11.syscall("fs/read", {
        fd: o23,
        len: 65536
      }), !t18 || t18.byteLength === 0) break;
      if (!(!t18 || t18.byteLength === 0)) if (i22 += t18.byteLength, n18 === "crc") r16 = m18(r16, t18);
      else if (n18 === "crc32b") r16 = b14(r16, t18);
      else if (n18 === "bsd") r16 = _16(r16, t18);
      else for (let e12 of t18) r16 += e12;
    }
  } finally {
    a20 ? a20.releaseLock() : await e11.syscall("fs/close", { fd: o23 }).catch(() => {
    });
  }
  return n18 === "crc" ? {
    value: h19(r16, i22),
    length: i22,
    blocks: 0
  } : n18 === "crc32b" ? {
    value: ~r16 >>> 0,
    length: i22,
    blocks: 0
  } : n18 === "bsd" ? {
    value: r16,
    length: i22,
    blocks: Math.ceil(i22 / 1024)
  } : {
    value: y14(r16),
    length: i22,
    blocks: Math.ceil(i22 / 512)
  };
}
var C9 = [
  "bsd",
  "sysv",
  "crc",
  "crc32b",
  "md5",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha2",
  "sha3",
  "blake2b",
  "sm3"
];
var w6 = {
  md5: "MD5",
  sha1: "SHA1",
  sha224: "SHA224",
  sha256: "SHA256",
  sha384: "SHA384",
  sha512: "SHA512",
  sm3: "SM3"
};
var T5 = [
  7640891576956012808n,
  13503953896175478587n,
  4354685564936845355n,
  11912009170470909681n,
  5840696475078001361n,
  11170449401992604703n,
  2270897969802886507n,
  6620516959819538809n
];
var E4 = [
  [
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15
  ],
  [
    14,
    10,
    4,
    8,
    9,
    15,
    13,
    6,
    1,
    12,
    0,
    2,
    11,
    7,
    5,
    3
  ],
  [
    11,
    8,
    12,
    0,
    5,
    2,
    15,
    13,
    10,
    14,
    3,
    6,
    7,
    1,
    9,
    4
  ],
  [
    7,
    9,
    3,
    1,
    13,
    12,
    11,
    14,
    2,
    6,
    5,
    10,
    4,
    0,
    15,
    8
  ],
  [
    9,
    0,
    5,
    7,
    2,
    4,
    10,
    15,
    14,
    1,
    11,
    12,
    6,
    8,
    3,
    13
  ],
  [
    2,
    12,
    6,
    10,
    0,
    11,
    8,
    3,
    4,
    13,
    7,
    5,
    15,
    14,
    1,
    9
  ],
  [
    12,
    5,
    1,
    15,
    14,
    13,
    4,
    10,
    0,
    7,
    6,
    3,
    9,
    2,
    8,
    11
  ],
  [
    13,
    11,
    7,
    14,
    12,
    1,
    3,
    9,
    5,
    0,
    15,
    4,
    8,
    6,
    2,
    10
  ],
  [
    6,
    15,
    14,
    9,
    11,
    3,
    0,
    8,
    12,
    2,
    13,
    7,
    1,
    4,
    10,
    5
  ],
  [
    10,
    2,
    8,
    4,
    7,
    6,
    1,
    5,
    15,
    11,
    9,
    14,
    3,
    12,
    13,
    0
  ],
  [
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15
  ],
  [
    14,
    10,
    4,
    8,
    9,
    15,
    13,
    6,
    1,
    12,
    0,
    2,
    11,
    7,
    5,
    3
  ]
];
var D4 = 18446744073709551615n;
var O4 = (e11, t17) => (e11 >> t17 | e11 << 64n - t17) & D4;
function k3(e11, t17 = 64) {
  let n18 = T5.slice();
  n18[0] ^= 16842752n ^ BigInt(t17);
  let r16 = 0n, i22 = (e12, t18, r17) => {
    let i23 = [];
    for (let t19 = 0; t19 < 16; t19++) {
      let n19 = 0n;
      for (let r18 = 7; r18 >= 0; r18--) n19 = n19 << 8n | BigInt(e12[t19 * 8 + r18]);
      i23.push(n19);
    }
    let a21 = [...n18, ...T5];
    a21[12] ^= t18 & D4, a21[13] ^= t18 >> 64n & D4, r17 && (a21[14] ^= D4);
    let o24 = (e13, t19, n19, r18, i24, o25) => {
      a21[e13] = a21[e13] + a21[t19] + i24 & D4, a21[r18] = O4(a21[r18] ^ a21[e13], 32n), a21[n19] = a21[n19] + a21[r18] & D4, a21[t19] = O4(a21[t19] ^ a21[n19], 24n), a21[e13] = a21[e13] + a21[t19] + o25 & D4, a21[r18] = O4(a21[r18] ^ a21[e13], 16n), a21[n19] = a21[n19] + a21[r18] & D4, a21[t19] = O4(a21[t19] ^ a21[n19], 63n);
    };
    for (let e13 = 0; e13 < 12; e13++) {
      let t19 = E4[e13];
      o24(0, 4, 8, 12, i23[t19[0]], i23[t19[1]]), o24(1, 5, 9, 13, i23[t19[2]], i23[t19[3]]), o24(2, 6, 10, 14, i23[t19[4]], i23[t19[5]]), o24(3, 7, 11, 15, i23[t19[6]], i23[t19[7]]), o24(0, 5, 10, 15, i23[t19[8]], i23[t19[9]]), o24(1, 6, 11, 12, i23[t19[10]], i23[t19[11]]), o24(2, 7, 8, 13, i23[t19[12]], i23[t19[13]]), o24(3, 4, 9, 14, i23[t19[14]], i23[t19[15]]);
    }
    for (let e13 = 0; e13 < 8; e13++) n18[e13] ^= a21[e13] ^ a21[e13 + 8];
  }, a20 = 0;
  for (; e11.length - a20 > 128; ) r16 += 128n, i22(e11.subarray(a20, a20 + 128), r16, false), a20 += 128;
  let o23 = new Uint8Array(128);
  o23.set(e11.subarray(a20)), r16 += BigInt(e11.length - a20), i22(o23, r16, true);
  let s30 = new Uint8Array(t17);
  for (let e12 = 0; e12 < t17; e12++) s30[e12] = Number(n18[e12 >> 3] >> BigInt((e12 & 7) * 8) & 255n);
  return s30;
}
var A2 = new Uint32Array([
  1937774191,
  1226093241,
  388252375,
  3666478592,
  2842636476,
  372324522,
  3817729613,
  2969243214
]);
var j2 = (e11, t17) => (e11 << t17 | e11 >>> 32 - t17) >>> 0;
function M2(e11) {
  let t17 = e11.length, n18 = (t17 + 8 >> 6) * 64 + 64, r16 = new Uint8Array(n18);
  r16.set(e11), r16[t17] = 128;
  let i22 = t17 * 8;
  for (let e12 = 0; e12 < 8; e12++) r16[n18 - 1 - e12] = (Math.floor(i22 / 2 ** (8 * e12)) & 255) >>> 0;
  let a20 = new Uint32Array(A2), o23 = new Uint32Array(68), s30 = new Uint32Array(64), c37 = (e12, t18, n19, r17) => r17 < 16 ? e12 ^ t18 ^ n19 : (e12 & t18 | e12 & n19 | t18 & n19) >>> 0, l38 = (e12, t18, n19, r17) => r17 < 16 ? e12 ^ t18 ^ n19 : (e12 & t18 | ~e12 & n19) >>> 0, u37 = (e12) => (e12 ^ j2(e12, 9) ^ j2(e12, 17)) >>> 0, d36 = (e12) => (e12 ^ j2(e12, 15) ^ j2(e12, 23)) >>> 0;
  for (let e12 = 0; e12 < n18; e12 += 64) {
    for (let t19 = 0; t19 < 16; t19++) {
      let n20 = e12 + t19 * 4;
      o23[t19] = (r16[n20] << 24 | r16[n20 + 1] << 16 | r16[n20 + 2] << 8 | r16[n20 + 3]) >>> 0;
    }
    for (let e13 = 16; e13 < 68; e13++) o23[e13] = (d36((o23[e13 - 16] ^ o23[e13 - 9] ^ j2(o23[e13 - 3], 15)) >>> 0) ^ j2(o23[e13 - 13], 7) ^ o23[e13 - 6]) >>> 0;
    for (let e13 = 0; e13 < 64; e13++) s30[e13] = (o23[e13] ^ o23[e13 + 4]) >>> 0;
    let t18 = a20[0], n19 = a20[1], i23 = a20[2], f33 = a20[3], p31 = a20[4], m24 = a20[5], h24 = a20[6], g18 = a20[7];
    for (let e13 = 0; e13 < 64; e13++) {
      let r17 = e13 < 16 ? 2043430169 : 2055708042, a21 = j2(j2(t18, 12) + p31 + j2(r17, e13 % 32) >>> 0, 7), d37 = (a21 ^ j2(t18, 12)) >>> 0, _21 = c37(t18, n19, i23, e13) + f33 + d37 + s30[e13] >>> 0, v17 = l38(p31, m24, h24, e13) + g18 + a21 + o23[e13] >>> 0;
      f33 = i23, i23 = j2(n19, 9), n19 = t18, t18 = _21, g18 = h24, h24 = j2(m24, 19), m24 = p31, p31 = u37(v17);
    }
    a20[0] = (a20[0] ^ t18) >>> 0, a20[1] = (a20[1] ^ n19) >>> 0, a20[2] = (a20[2] ^ i23) >>> 0, a20[3] = (a20[3] ^ f33) >>> 0, a20[4] = (a20[4] ^ p31) >>> 0, a20[5] = (a20[5] ^ m24) >>> 0, a20[6] = (a20[6] ^ h24) >>> 0, a20[7] = (a20[7] ^ g18) >>> 0;
  }
  let f32 = new Uint8Array(32);
  for (let e12 = 0; e12 < 8; e12++) f32[e12 * 4] = a20[e12] >>> 24 & 255, f32[e12 * 4 + 1] = a20[e12] >>> 16 & 255, f32[e12 * 4 + 2] = a20[e12] >>> 8 & 255, f32[e12 * 4 + 3] = a20[e12] & 255;
  return f32;
}
function N2(e11) {
  let t17 = "";
  for (let n18 of e11) t17 += n18.toString(16).padStart(2, "0");
  return t17;
}
async function P2(t17, n18, r16 = 512) {
  if (t17 === "md5") return i16(n18);
  if (t17 === "blake2b") return N2(k3(n18, r16 / 8));
  if (t17 === "sm3") return N2(M2(n18));
  if (t17 === "sha224") return i17(n18);
  let i22 = await crypto.subtle.digest({
    sha1: "SHA-1",
    sha256: "SHA-256",
    sha384: "SHA-384",
    sha512: "SHA-512"
  }[t17], n18), a20 = "";
  for (let e11 of new Uint8Array(i22)) a20 += e11.toString(16).padStart(2, "0");
  return a20;
}
var F2 = async (e11) => {
  let t17 = e11.args[0] ?? "cksum", { positionals: c37, flags: l38 } = t7(e11.args.slice(1), {
    string: [
      "a",
      "algorithm",
      "length"
    ],
    boolean: [
      "tag",
      "untagged",
      "z",
      "zero"
    ],
    alias: {
      algorithm: "a",
      zero: "z"
    }
  }), u37 = l38.a === void 0 ? "crc" : String(l38.a), d36 = l38.z ? "\0" : "\n", f32 = e11.stdout.getWriter(), p31 = e11.stderr.getWriter();
  try {
    if (!C9.includes(u37)) return await g2(p31, 1, `${t17}: invalid argument \u2018${u37}\u2019 for \u2018--algorithm\u2019
Valid arguments are:
${C9.map((e12) => `  - \u2018${e12}\u2019`).join("\n")}
Try '${t17} --help' for more information.`);
    if (u37 === "sha2" || u37 === "sha3") return await g2(p31, 1, `${t17}: --algorithm=${u37} is not supported in this build`);
    if (l38.length !== void 0 && u37 !== "blake2b") return await g2(p31, 1, `${t17}: --length is only supported with --algorithm blake2b, sha2, or sha3`);
    let r16 = 512;
    if (u37 === "blake2b" && typeof l38.length == "string") {
      if (!/^\s*\+?\d+$/.test(l38.length)) return await g2(p31, 1, `${t17}: invalid length: \u2018${l38.length}\u2019`);
      let e12 = Number(l38.length.replace(/^\s*\+?/, ""));
      if (e12 > 512) return await g2(p31, 1, `${t17}: invalid length: \u2018${l38.length}\u2019
${t17}: maximum digest length for \u2018BLAKE2b\u2019 is 512 bits`);
      if (e12 % 8 != 0) return await g2(p31, 1, `${t17}: invalid length: \u2018${l38.length}\u2019
${t17}: length is not a multiple of 8`);
      e12 !== 0 && (r16 = e12);
    }
    let m24 = u37 === "md5" || u37.startsWith("sha") || u37 === "blake2b" || u37 === "sm3", h24 = !!l38.untagged, g18 = c37.length > 0 ? c37 : ["-"], _21 = 0;
    for (let n18 of g18) {
      let c38 = n18 === "-" ? "" : " " + n18;
      if (u37 === "crc" || u37 === "crc32b") {
        let r17;
        try {
          r17 = await x10(e11, n18, u37);
        } catch {
          await m2(p31, `${t17}: ${n18}: No such file or directory`), _21 = 1;
          continue;
        }
        await p2(f32, `${r17.value} ${r17.length}${c38}${d36}`);
        continue;
      }
      if (u37 === "bsd") {
        let r17;
        try {
          r17 = await x10(e11, n18, "bsd");
        } catch {
          await m2(p31, `${t17}: ${n18}: No such file or directory`), _21 = 1;
          continue;
        }
        await p2(f32, `${String(r17.value).padStart(5, "0")} ${String(r17.blocks).padStart(5)}${c38}${d36}`);
        continue;
      }
      if (u37 === "sysv") {
        let r17;
        try {
          r17 = await x10(e11, n18, "sysv");
        } catch {
          await m2(p31, `${t17}: ${n18}: No such file or directory`), _21 = 1;
          continue;
        }
        await p2(f32, `${r17.value} ${r17.blocks}${c38}${d36}`);
        continue;
      }
      if (m24) {
        let c39;
        try {
          c39 = n18 === "-" ? await o3(e11.stdin) : await i9(e11, n18);
        } catch {
          await m2(p31, `${t17}: ${n18}: No such file or directory`), _21 = 1;
          continue;
        }
        let l39 = await P2(u37, c39, r16), m25 = n18 === "-" ? "-" : n18, g19 = u37 === "blake2b" ? r16 === 512 ? "BLAKE2b" : `BLAKE2b-${r16}` : w6[u37];
        h24 ? await p2(f32, `${l39}  ${m25}${d36}`) : await p2(f32, `${g19} (${m25}) = ${l39}${d36}`);
      }
    }
    return _21;
  } finally {
    await f32.close().catch(() => {
    }), await p31.close().catch(() => {
    });
  }
};
var I2 = _2(F2);

// mithic/packages/coreutils/dist/commands/shuf.js
var c28 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EXDEV: "Invalid cross-device link",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
  EIO: "Input/output error"
};
function l28(e11) {
  let t17 = e11?.code;
  return (t17 && c28[t17]) ?? r5(e11);
}
function u28(e11) {
  let t17 = e11 >>> 0;
  return () => {
    t17 |= 0, t17 = t17 + 1831565813 | 0;
    let e12 = Math.imul(t17 ^ t17 >>> 15, 1 | t17);
    return e12 ^= e12 + Math.imul(e12 ^ e12 >>> 7, 61 | e12), ((e12 ^ e12 >>> 14) >>> 0) / 4294967296;
  };
}
function d25(e11, t17) {
  for (let n18 = e11.length - 1; n18 > 0; n18--) {
    let r16 = Math.floor(t17() * (n18 + 1));
    [e11[n18], e11[r16]] = [e11[r16], e11[n18]];
  }
  return e11;
}
function f23(e11, t17) {
  let n18 = new TextDecoder().decode(e11), r16 = t17 ? "\0" : "\n";
  return n18 === "" ? [] : (n18.endsWith(r16) ? n18.slice(0, -1) : n18).split(r16);
}
var p23 = async (e11) => {
  let n18 = e11.args[0] ?? "shuf", c37 = t7(e11.args.slice(1), {
    boolean: [
      "e",
      "echo",
      "r",
      "repeat",
      "z",
      "zero-terminated"
    ],
    string: [
      "n",
      "head-count",
      "i",
      "input-range",
      "o",
      "output",
      "random-source"
    ],
    alias: {
      echo: "e",
      "head-count": "n",
      "input-range": "i",
      "zero-terminated": "z",
      repeat: "r",
      output: "o"
    },
    unknown: "error"
  }), { positionals: p31, flags: m24 } = c37, h24 = e11.stdout.getWriter(), g18 = e11.stderr.getWriter();
  try {
    if (c37.unknown.length) return await g2(g18, 1, h2(n18, c37.unknown[0]));
    let i22 = 0, _21 = e11.args.slice(1);
    for (let e12 = 0; e12 < _21.length; e12++) {
      let t17 = _21[e12];
      if (t17 === "--") break;
      t17 === "-i" || t17 === "--input-range" ? (i22++, _21[e12 + 1] !== void 0 && e12++) : (t17.startsWith("--input-range=") || t17.startsWith("-i") && !t17.startsWith("--")) && i22++;
    }
    if (i22 > 1) return await g2(g18, 1, `${n18}: multiple -i options specified`);
    let v17 = !!m24.e, y18 = !!m24.r, b17 = !!m24.z, x13 = b17 ? "\0" : "\n";
    if (v17 && m24.i !== void 0) return await g2(g18, 1, `${n18}: cannot combine -e and -i options
Try '${n18} --help' for more information.`);
    let S11 = Infinity;
    if (m24.n !== void 0) {
      let e12 = String(m24.n), r16 = /^[0-9]+$/.test(e12) ? Number(e12) : NaN;
      if (Number.isNaN(r16)) return await g2(g18, 1, `${n18}: invalid line count: \u2018${e12}\u2019`);
      S11 = r16;
    }
    let C12 = m24["random-source"] === void 0 ? e11.env.SHUF_SEED ?? "42" : String(m24["random-source"]), w9 = parseInt(C12, 10);
    isNaN(w9) && (w9 = 42);
    let T7 = u28(w9), E6;
    if (v17) E6 = p31.slice();
    else if (m24.i !== void 0) {
      if (p31.length > 0) return await g2(g18, 1, `${n18}: extra operand \u2018${p31[0]}\u2019
Try '${n18} --help' for more information.`);
      let e12 = /^(\d+)-(\d+)$/.exec(String(m24.i));
      if (!e12) return await g2(g18, 1, `${n18}: invalid input range: \u2018${m24.i}\u2019`);
      let r16 = parseInt(e12[1], 10), i23 = parseInt(e12[2], 10);
      if (r16 > i23 + 1) return await g2(g18, 1, `${n18}: invalid input range: \u2018${m24.i}\u2019`);
      E6 = [];
      for (let e13 = r16; e13 <= i23; e13++) E6.push(String(e13));
    } else {
      if (p31.length > 1) return await g2(g18, 1, `${n18}: extra operand \u2018${p31[1]}\u2019
Try '${n18} --help' for more information.`);
      let r16 = p31[0];
      if (r16 === void 0 || r16 === "-") E6 = f23(await o3(e11.stdin), b17);
      else try {
        E6 = f23(await i9(e11, r16), b17);
      } catch (e12) {
        return await g2(g18, 1, `${n18}: ${r16}: ${l28(e12)}`);
      }
    }
    let D6;
    if (y18) {
      if (E6.length === 0 && (S11 === Infinity || S11 > 0)) return await g2(g18, 1, `${n18}: no lines to repeat`);
      let e12 = S11 === Infinity ? E6.length : S11;
      D6 = [];
      for (let t17 = 0; t17 < e12; t17++) D6.push(E6[Math.floor(T7() * E6.length)]);
    } else {
      d25(E6, T7);
      let e12 = Math.min(S11, E6.length);
      D6 = E6.slice(0, e12);
    }
    let O6 = D6.length > 0 ? D6.map((e12) => e12 + x13).join("") : "";
    return m24.o === void 0 ? O6 !== "" && await h24.write(new TextEncoder().encode(O6)) : await a10(e11, String(m24.o), new TextEncoder().encode(O6)), 0;
  } finally {
    await h24.close().catch(() => {
    }), await g18.close().catch(() => {
    });
  }
};
var m19 = _2(p23);

// mithic/packages/coreutils/dist/commands/rev.js
var s22 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory"
};
function c29(e11) {
  let t17 = e11?.code;
  return (t17 && s22[t17]) ?? r5(e11);
}
async function l29(e11, t17) {
  let { fd: n18 } = await e11.syscall("fs/open", {
    path: t17,
    oflags: {}
  });
  try {
    let t18 = [], r16 = 0;
    for (; ; ) {
      let i23 = await e11.syscall("fs/read", {
        fd: n18,
        len: 65536
      });
      if (!i23 || i23.byteLength === 0) break;
      t18.push(i23), r16 += i23.byteLength;
    }
    let i22 = new Uint8Array(r16), a20 = 0;
    for (let e12 of t18) i22.set(e12, a20), a20 += e12.byteLength;
    return new TextDecoder().decode(i22);
  } finally {
    await e11.syscall("fs/close", { fd: n18 }).catch(() => {
    });
  }
}
function u29(e11) {
  return [...e11].reverse().join("");
}
function d26(e11) {
  return e11 === "" ? "" : (e11.endsWith("\n") ? e11.slice(0, -1) : e11).split("\n").map((e12) => u29(e12) + "\n").join("");
}
var f24 = async (t17) => {
  let { positionals: n18 } = t7(t17.args.slice(1), {}), s30 = t17.args[0] ?? "rev", f32 = n18.length > 0 ? n18 : ["-"], p31 = t17.stdout.getWriter(), m24 = t17.stderr.getWriter(), h24 = 0, g18 = false;
  try {
    for (let n19 of f32) if (n19 === "-") {
      let n20 = new d3(p31);
      try {
        for await (let { line: e11 } of l3(t17.stdin)) await n20.push(u29(e11) + "\n");
        await n20.flush();
      } catch (e11) {
        if (u2(e11)) {
          g18 = true;
          break;
        }
        throw e11;
      }
    } else {
      let e11;
      try {
        e11 = await l29(t17, n19);
      } catch (e12) {
        await p2(m24, `${s30}: ${n19}: ${c29(e12)}
`), h24 = 1;
        continue;
      }
      await p2(p31, d26(e11));
    }
  } finally {
    await p31.close().catch(() => {
    }), await m24.close().catch(() => {
    }), g18 && await t17.stdin.cancel().catch(() => {
    });
  }
  return h24;
};
var p24 = _2(f24);

// mithic/packages/coreutils/dist/commands/base64.js
var s23 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function l30(e11) {
  let t17 = new Uint8Array(Math.ceil(e11.length / 4) * 3), n18 = 0, r16 = () => ({
    bytes: t17.subarray(0, n18),
    ok: false
  });
  for (let i22 = 0; i22 < e11.length; i22 += 4) {
    let a20 = Math.min(4, e11.length - i22), o23 = [
      d27(e11.charCodeAt(i22)),
      a20 > 1 ? d27(e11.charCodeAt(i22 + 1)) : -3,
      a20 > 2 ? d27(e11.charCodeAt(i22 + 2)) : -3,
      a20 > 3 ? d27(e11.charCodeAt(i22 + 3)) : -3
    ];
    if (o23.some((e12) => e12 === -1)) return r16();
    let s30 = o23.filter((e12) => e12 === -2).length, c37 = o23.filter((e12) => e12 >= 0).length, [l38, u37, f32, p31] = o23;
    if (l38 < 0 || u37 < 0 || c37 === 2 && f32 >= 0 || c37 === 3 && p31 >= 0) return r16();
    if (t17[n18++] = l38 << 2 | u37 >> 4, c37 >= 3 && (t17[n18++] = (u37 & 15) << 4 | f32 >> 2), c37 === 4) {
      t17[n18++] = (f32 & 3) << 6 | p31;
      continue;
    }
    if (c37 === 3 && f32 & 3 || c37 === 2 && u37 & 15 || s30 > 0 && s30 !== 4 - c37) return r16();
    if (i22 + 4 < e11.length) {
      if (s30 === 4 - c37) continue;
      return r16();
    }
  }
  return {
    bytes: t17.subarray(0, n18),
    ok: true
  };
}
function d27(e11) {
  return e11 >= 65 && e11 <= 90 ? e11 - 65 : e11 >= 97 && e11 <= 122 ? e11 - 71 : e11 >= 48 && e11 <= 57 ? e11 + 4 : e11 === 43 ? 62 : e11 === 47 ? 63 : e11 === 61 ? -2 : -1;
}
var f25 = class {
  #e;
  #t = 0;
  #n = [];
  constructor(e11) {
    this.#e = e11;
  }
  #r(e11, t17) {
    t17.push(e11), this.#e > 0 && (this.#t++, this.#t >= this.#e && (t17.push("\n"), this.#t = 0));
  }
  update(e11) {
    let t17 = [], n18 = this.#n, r16 = 0;
    for (; n18.length > 0 && n18.length < 3 && r16 < e11.length; ) n18.push(e11[r16++]);
    if (n18.length === 3) {
      let [e12, r17, i23] = n18;
      this.#r(s23[e12 >> 2], t17), this.#r(s23[(e12 & 3) << 4 | r17 >> 4], t17), this.#r(s23[(r17 & 15) << 2 | i23 >> 6], t17), this.#r(s23[i23 & 63], t17), n18 = [];
    }
    let i22 = r16;
    for (; i22 + 2 < e11.length; i22 += 3) {
      let n19 = e11[i22], r17 = e11[i22 + 1], a21 = e11[i22 + 2];
      this.#r(s23[n19 >> 2], t17), this.#r(s23[(n19 & 3) << 4 | r17 >> 4], t17), this.#r(s23[(r17 & 15) << 2 | a21 >> 6], t17), this.#r(s23[a21 & 63], t17);
    }
    let a20 = [];
    for (; i22 < e11.length; i22++) a20.push(e11[i22]);
    return this.#n = n18.length > 0 ? n18 : a20, t17.join("");
  }
  final() {
    let e11 = [], t17 = this.#n;
    if (t17.length === 1) {
      let n18 = t17[0];
      this.#r(s23[n18 >> 2], e11), this.#r(s23[(n18 & 3) << 4], e11), this.#r("=", e11), this.#r("=", e11);
    } else if (t17.length === 2) {
      let n18 = t17[0], r16 = t17[1];
      this.#r(s23[n18 >> 2], e11), this.#r(s23[(n18 & 3) << 4 | r16 >> 4], e11), this.#r(s23[(r16 & 15) << 2], e11), this.#r("=", e11);
    }
    return this.#n = [], this.#e > 0 && this.#t > 0 && (e11.push("\n"), this.#t = 0), e11.join("");
  }
};
var p25 = class {
  #e = "";
  #t;
  constructor(e11 = false) {
    this.#t = e11;
  }
  #n(e11) {
    let t17 = e11.replace(/\s/g, "");
    return this.#t ? t17.replace(/[^A-Za-z0-9+/=]/g, "") : t17;
  }
  update(e11) {
    let t17 = this.#e + this.#n(e11), n18 = t17.length - t17.length % 4;
    return this.#e = t17.slice(n18), n18 === 0 ? {
      bytes: new Uint8Array(),
      ok: true
    } : l30(t17.slice(0, n18));
  }
  final() {
    if (this.#e.length === 0) return {
      bytes: new Uint8Array(),
      ok: true
    };
    let e11 = l30(this.#e);
    return this.#e = "", e11;
  }
};
async function m20(e11, t17) {
  let n18 = 32 * 1024;
  for (let r16 = 0; r16 < t17.byteLength; r16 += n18) await e11.write(t17.subarray(r16, Math.min(r16 + n18, t17.byteLength)));
}
function h20(t17) {
  return async (s30) => {
    let c37 = t7(s30.args.slice(1), {
      boolean: [
        "d",
        "decode",
        "i",
        "ignore-garbage"
      ],
      string: ["w", "wrap"],
      alias: {
        decode: "d",
        wrap: "w",
        "ignore-garbage": "i"
      },
      unknown: "error"
    }), l38 = () => s30.stderr.getWriter();
    if (c37.unknown.length) {
      let e11 = l38();
      try {
        return await g2(e11, 1, h2(t17, c37.unknown[0]));
      } finally {
        await e11.close().catch(() => {
        });
      }
    }
    let u37 = !!c37.flags.d, d36 = !!c37.flags.i, h24 = c37.flags.w === void 0 ? "76" : String(c37.flags.w), g18 = parseInt(h24, 10);
    if (isNaN(g18) || g18 < 0) {
      let e11 = l38();
      try {
        return await g2(e11, 1, `${t17}: invalid wrap size: ${h24}`);
      } finally {
        await e11.close().catch(() => {
        });
      }
    }
    let _21 = c37.positionals;
    if (_21.length > 1) {
      let e11 = l38();
      try {
        return await g2(e11, 1, `${t17}: extra operand \u2018${_21[1]}\u2019
Try '${t17} --help' for more information.`);
      } finally {
        await e11.close().catch(() => {
        });
      }
    }
    let v17 = _21[0], y18 = s30.stdout.getWriter(), b17 = s30.stderr.getWriter(), x13 = false, S11 = -1, C12 = null;
    if (v17 !== void 0 && v17 !== "-") try {
      ({ fd: S11 } = await s30.syscall("fs/open", {
        dirfd: b8,
        path: v17,
        oflags: { read: true }
      }));
    } catch {
      try {
        return await g2(b17, 1, `${t17}: ${v17}: No such file or directory`);
      } finally {
        await y18.close().catch(() => {
        }), await b17.close().catch(() => {
        });
      }
    }
    else C12 = s30.stdin.getReader();
    let w9 = async () => {
      if (C12) {
        let { value: e12, done: t18 } = await C12.read();
        return t18 ? void 0 : e12;
      }
      let e11 = await s30.syscall("fs/read", {
        fd: S11,
        len: 65536
      });
      return e11 && e11.byteLength > 0 ? e11 : void 0;
    };
    try {
      let i22 = new d3(y18), a20 = new TextDecoder(), o23 = u37 ? null : new f25(g18), s31 = u37 ? new p25(d36) : null;
      try {
        for (; ; ) {
          let e11 = await w9();
          if (e11 === void 0) break;
          if (e11.byteLength !== 0) if (o23) await i22.push(o23.update(e11));
          else {
            let { bytes: r16, ok: o24 } = s31.update(a20.decode(e11, { stream: true }));
            if (r16.byteLength > 0 && (await i22.flush(), await m20(y18, r16)), !o24) return C12 && C12.releaseLock(), await g2(b17, 1, `${t17}: invalid input`);
          }
        }
        if (C12 && C12.releaseLock(), o23) await i22.push(o23.final()), await i22.flush();
        else {
          let { bytes: e11, ok: r16 } = s31.final();
          if (await i22.flush(), e11.byteLength > 0 && await m20(y18, e11), !r16) return await g2(b17, 1, `${t17}: invalid input`);
        }
      } catch (e11) {
        try {
          C12 && C12.releaseLock();
        } catch {
        }
        if (u2(e11)) return x13 = true, 0;
        throw e11;
      }
      return 0;
    } finally {
      S11 >= 0 && await s30.syscall("fs/close", { fd: S11 }).catch(() => {
      }), await y18.close().catch(() => {
      }), await b17.close().catch(() => {
      }), x13 && await s30.stdin.cancel().catch(() => {
      });
    }
  };
}
var g14 = h20("base64");
var _17 = _2(g14);

// mithic/packages/coreutils/dist/commands/base32.js
var s24 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function c30(e11, t17, n18) {
  let r16 = e11[t17], i22 = e11[t17 + 1], a20 = e11[t17 + 2], o23 = e11[t17 + 3], c37 = e11[t17 + 4];
  n18(s24[r16 >> 3]), n18(s24[(r16 & 7) << 2 | i22 >> 6]), n18(s24[i22 >> 1 & 31]), n18(s24[(i22 & 1) << 4 | a20 >> 4]), n18(s24[(a20 & 15) << 1 | o23 >> 7]), n18(s24[o23 >> 2 & 31]), n18(s24[(o23 & 3) << 3 | c37 >> 5]), n18(s24[c37 & 31]);
}
function l31(e11, t17, n18, r16) {
  if (n18 === 1) {
    let n19 = e11[t17];
    r16(s24[n19 >> 3]), r16(s24[(n19 & 7) << 2]), r16("="), r16("="), r16("="), r16("="), r16("="), r16("=");
  } else if (n18 === 2) {
    let n19 = e11[t17], i22 = e11[t17 + 1];
    r16(s24[n19 >> 3]), r16(s24[(n19 & 7) << 2 | i22 >> 6]), r16(s24[i22 >> 1 & 31]), r16(s24[(i22 & 1) << 4]), r16("="), r16("="), r16("="), r16("=");
  } else if (n18 === 3) {
    let n19 = e11[t17], i22 = e11[t17 + 1], a20 = e11[t17 + 2];
    r16(s24[n19 >> 3]), r16(s24[(n19 & 7) << 2 | i22 >> 6]), r16(s24[i22 >> 1 & 31]), r16(s24[(i22 & 1) << 4 | a20 >> 4]), r16(s24[(a20 & 15) << 1]), r16("="), r16("="), r16("=");
  } else if (n18 === 4) {
    let n19 = e11[t17], i22 = e11[t17 + 1], a20 = e11[t17 + 2], o23 = e11[t17 + 3];
    r16(s24[n19 >> 3]), r16(s24[(n19 & 7) << 2 | i22 >> 6]), r16(s24[i22 >> 1 & 31]), r16(s24[(i22 & 1) << 4 | a20 >> 4]), r16(s24[(a20 & 15) << 1 | o23 >> 7]), r16(s24[o23 >> 2 & 31]), r16(s24[(o23 & 3) << 3]), r16("=");
  }
}
function d28(e11) {
  return e11 >= 65 && e11 <= 90 ? e11 - 65 : e11 >= 97 && e11 <= 122 ? e11 - 97 : e11 === 50 ? 26 : e11 === 51 ? 27 : e11 === 52 ? 28 : e11 === 53 ? 29 : e11 === 54 ? 30 : e11 === 55 ? 31 : e11 === 61 ? -2 : -1;
}
var f26 = /* @__PURE__ */ new Set([
  0,
  2,
  4,
  5,
  7
]);
function p26(e11) {
  let t17 = new Uint8Array(Math.ceil(e11.length / 8) * 5), n18 = 0, r16 = () => ({
    bytes: t17.subarray(0, n18),
    ok: false
  });
  for (let i22 = 0; i22 < e11.length; i22 += 8) {
    let a20 = Math.min(8, e11.length - i22), o23 = 0;
    for (; o23 < a20 && d28(e11.charCodeAt(i22 + o23)) !== -2; ) o23++;
    let s30 = 0;
    for (let t18 = o23; t18 < a20; t18++) {
      if (d28(e11.charCodeAt(i22 + t18)) !== -2) return r16();
      s30++;
    }
    let c37 = 0, l38 = 0, u37 = [];
    for (let t18 = 0; t18 < o23; t18++) {
      let n19 = d28(e11.charCodeAt(i22 + t18));
      if (n19 < 0) return r16();
      c37 = c37 << 5 | n19, l38 += 5, l38 >= 8 && (l38 -= 8, u37.push(c37 >> l38 & 255));
    }
    let p31 = (c37 & (1 << l38) - 1) == 0;
    if (s30 > 0) {
      if (a20 !== 8 || !f26.has(o23) || o23 === 0 || s30 !== 8 - o23 || !p31) return r16();
      for (let e12 of u37) t17[n18++] = e12;
      continue;
    } else if (o23 < 8) {
      for (let e12 of u37) t17[n18++] = e12;
      if (!f26.has(o23) || !p31 || i22 + 8 < e11.length) return r16();
      continue;
    }
    for (let e12 of u37) t17[n18++] = e12;
  }
  return {
    bytes: t17.subarray(0, n18),
    ok: true
  };
}
var h21 = class {
  #e;
  #t = 0;
  #n = [];
  constructor(e11) {
    this.#e = e11;
  }
  #r(e11, t17) {
    t17.push(e11), this.#e > 0 && (this.#t++, this.#t >= this.#e && (t17.push("\n"), this.#t = 0));
  }
  update(e11) {
    let t17 = [], n18 = (e12) => this.#r(e12, t17), r16 = this.#n, i22 = 0;
    for (; r16.length > 0 && r16.length < 5 && i22 < e11.length; ) r16.push(e11[i22++]);
    r16.length === 5 && (c30(r16, 0, n18), r16 = []);
    let a20 = i22;
    for (; a20 + 4 < e11.length; a20 += 5) c30(e11, a20, n18);
    let o23 = [];
    for (; a20 < e11.length; a20++) o23.push(e11[a20]);
    return this.#n = r16.length > 0 ? r16 : o23, t17.join("");
  }
  final() {
    let e11 = [];
    return this.#n.length > 0 && l31(this.#n, 0, this.#n.length, (t17) => this.#r(t17, e11)), this.#n = [], this.#e > 0 && this.#t > 0 && (e11.push("\n"), this.#t = 0), e11.join("");
  }
};
var g15 = class {
  #e = "";
  #t;
  constructor(e11 = false) {
    this.#t = e11;
  }
  #n(e11) {
    let t17 = e11.replace(/\s/g, "");
    return this.#t ? t17.replace(/[^A-Za-z2-7=]/g, "") : t17;
  }
  update(e11) {
    return this.#e += this.#n(e11), {
      bytes: new Uint8Array(),
      ok: true
    };
  }
  final() {
    if (this.#e.length === 0) return {
      bytes: new Uint8Array(),
      ok: true
    };
    let e11 = p26(this.#e.toUpperCase());
    return this.#e = "", e11;
  }
};
async function _18(e11, t17) {
  let n18 = 32 * 1024;
  for (let r16 = 0; r16 < t17.byteLength; r16 += n18) await e11.write(t17.subarray(r16, Math.min(r16 + n18, t17.byteLength)));
}
var v14 = async (t17) => {
  let s30 = t17.args[0] ?? "base32", c37 = t7(t17.args.slice(1), {
    boolean: [
      "d",
      "decode",
      "i",
      "ignore-garbage"
    ],
    string: ["w", "wrap"],
    alias: {
      decode: "d",
      wrap: "w",
      "ignore-garbage": "i"
    },
    unknown: "error"
  }), l38 = () => t17.stderr.getWriter();
  if (c37.unknown.length) {
    let e11 = l38();
    try {
      return await g2(e11, 1, h2(s30, c37.unknown[0]));
    } finally {
      await e11.close().catch(() => {
      });
    }
  }
  let u37 = !!c37.flags.d, d36 = !!c37.flags.i, f32 = c37.flags.w === void 0 ? "76" : String(c37.flags.w), p31 = parseInt(f32, 10);
  if (isNaN(p31) || p31 < 0) {
    let e11 = l38();
    try {
      return await g2(e11, 1, `${s30}: invalid wrap size: ${f32}`);
    } finally {
      await e11.close().catch(() => {
      });
    }
  }
  let m24 = c37.positionals;
  if (m24.length > 1) {
    let e11 = l38();
    try {
      return await g2(e11, 1, `${s30}: extra operand \u2018${m24[1]}\u2019
Try '${s30} --help' for more information.`);
    } finally {
      await e11.close().catch(() => {
      });
    }
  }
  let v17 = m24[0], y18 = t17.stdout.getWriter(), b17 = t17.stderr.getWriter(), x13 = false, S11 = -1, C12 = null;
  if (v17 !== void 0 && v17 !== "-") try {
    ({ fd: S11 } = await t17.syscall("fs/open", {
      dirfd: b8,
      path: v17,
      oflags: { read: true }
    }));
  } catch {
    try {
      return await g2(b17, 1, `${s30}: ${v17}: No such file or directory`);
    } finally {
      await y18.close().catch(() => {
      }), await b17.close().catch(() => {
      });
    }
  }
  else C12 = t17.stdin.getReader();
  let w9 = async () => {
    if (C12) {
      let { value: e12, done: t18 } = await C12.read();
      return t18 ? void 0 : e12;
    }
    let e11 = await t17.syscall("fs/read", {
      fd: S11,
      len: 65536
    });
    return e11 && e11.byteLength > 0 ? e11 : void 0;
  };
  try {
    let t18 = new d3(y18), i22 = new TextDecoder(), a20 = u37 ? null : new h21(p31), o23 = u37 ? new g15(d36) : null;
    try {
      for (; ; ) {
        let e11 = await w9();
        if (e11 === void 0) break;
        if (e11.byteLength !== 0) if (a20) await t18.push(a20.update(e11));
        else {
          let { bytes: r16, ok: a21 } = o23.update(i22.decode(e11, { stream: true }));
          if (r16.byteLength > 0 && (await t18.flush(), await _18(y18, r16)), !a21) return C12 && C12.releaseLock(), await g2(b17, 1, `${s30}: invalid input`);
        }
      }
      if (C12 && C12.releaseLock(), a20) await t18.push(a20.final()), await t18.flush();
      else {
        let { bytes: e11, ok: r16 } = o23.final();
        if (await t18.flush(), e11.byteLength > 0 && await _18(y18, e11), !r16) return await g2(b17, 1, `${s30}: invalid input`);
      }
    } catch (e11) {
      try {
        C12 && C12.releaseLock();
      } catch {
      }
      if (u2(e11)) return x13 = true, 0;
      throw e11;
    }
    return 0;
  } finally {
    S11 >= 0 && await t17.syscall("fs/close", { fd: S11 }).catch(() => {
    }), await y18.close().catch(() => {
    }), await b17.close().catch(() => {
    }), x13 && await t17.stdin.cancel().catch(() => {
    });
  }
};
var y15 = _2(v14);

// mithic/packages/coreutils/dist/commands/true.js
var t15 = async () => 0;
var n15 = _2(t15);

// mithic/packages/coreutils/dist/commands/false.js
var t16 = async () => 1;
var n16 = _2(t16);

// mithic/packages/coreutils/dist/commands/which.js
async function o20(e11, t17) {
  try {
    let n18 = await n11(e11, t17);
    return n18.type === "file" && (n18.mode & 73) != 0;
  } catch {
    return false;
  }
}
var s25 = async (e11) => {
  let { positionals: a20, flags: s30 } = t7(e11.args.slice(1), {
    boolean: ["a"],
    alias: { all: "a" }
  }), c37 = e11.stdout.getWriter(), l38 = e11.stderr.getWriter(), u37 = !!s30.a, d36 = (e11.env.PATH ?? "").split(":").filter((e12) => e12 !== "");
  try {
    let t17 = 0;
    for (let s31 of a20) {
      if (s31.includes("/")) {
        let a22 = s31.startsWith("/") ? T3(s31) : T3(w3(e11.cwd, s31));
        await o20(e11, a22) ? await m2(c37, a22) : t17 = 1;
        continue;
      }
      let a21 = false;
      for (let t18 of d36) {
        let i22 = w3(t18, s31);
        if (await o20(e11, i22) && (await m2(c37, i22), a21 = true, !u37)) break;
      }
      a21 || (t17 = 1);
    }
    return t17;
  } finally {
    await c37.close().catch(() => {
    }), await l38.close().catch(() => {
    });
  }
};
var c31 = _2(s25);

// mithic/packages/coreutils/dist/commands/env.js
var i18 = async (e11) => {
  let i22 = e11.args[0] ?? "env", a20 = e11.stdout.getWriter(), o23 = e11.stderr.getWriter();
  try {
    let s30 = e11.args.slice(1), c37 = [], l38 = false, u37 = 0, d36;
    outer: for (; u37 < s30.length; u37++) {
      let e12 = s30[u37];
      if (e12 === "--") {
        u37++;
        break;
      }
      if (e12 === "-" || !e12.startsWith("-")) break;
      if (e12.startsWith("--")) {
        let t18 = e12.slice(2), n18 = t18.indexOf("="), r16 = n18 >= 0 ? t18.slice(0, n18) : t18;
        if (r16 === "ignore-environment") {
          l38 = true;
          continue;
        }
        if (r16 === "unset") {
          if (n18 >= 0) {
            c37.push(t18.slice(n18 + 1));
            continue;
          }
          let e13 = s30[u37 + 1];
          if (e13 === void 0) {
            d36 = `${i22}: option '--unset' requires an argument`;
            break outer;
          }
          c37.push(e13), u37++;
          continue;
        }
        d36 = `${i22}: unrecognized option '--${r16}'`;
        break outer;
      }
      let t17 = e12.slice(1);
      for (let e13 = 0; e13 < t17.length; e13++) {
        let n18 = t17[e13];
        if (n18 === "i") {
          l38 = true;
          continue;
        }
        if (n18 === "u") {
          let n19 = t17.slice(e13 + 1);
          if (n19.length > 0) {
            c37.push(n19);
            break;
          }
          let r16 = s30[u37 + 1];
          if (r16 === void 0) {
            d36 = `${i22}: option requires an argument -- 'u'`;
            break outer;
          }
          c37.push(r16), u37++;
          break;
        }
        d36 = `${i22}: invalid option -- '${n18}'`;
        break outer;
      }
    }
    if (d36 !== void 0) return await g2(o23, 125, `${d36}
Try '${i22} --help' for more information.`);
    let f32 = s30.slice(u37);
    for (let e12 of c37) if (e12 === "" || e12.includes("=")) return await g2(o23, 125, `${i22}: cannot unset \u2018${e12}\u2019: Invalid argument`);
    let p31 = l38 ? {} : { ...e11.env };
    for (let e12 of c37) delete p31[e12];
    let m24 = f32.length;
    for (let e12 = 0; e12 < f32.length; e12++) if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(f32[e12])) {
      let t17 = f32[e12].indexOf("=");
      p31[f32[e12].slice(0, t17)] = f32[e12].slice(t17 + 1);
    } else {
      m24 = e12;
      break;
    }
    if (m24 >= f32.length) {
      for (let [e12, t17] of Object.entries(p31)) await m2(a20, `${e12}=${t17}`);
      return 0;
    }
    let h24 = f32.slice(m24);
    try {
      let t17 = await e11.syscall("process/pipeline", { stages: [{
        path: h24[0],
        argv: h24,
        env: p31
      }] });
      return t17.stdout && t17.stdout.byteLength > 0 && await f2(a20, t17.stdout), t17.exitCodes[0] ?? 0;
    } catch (e12) {
      return e12?.code === "ENOENT" ? await g2(o23, 127, `${i22}: \u2018${h24[0]}\u2019: No such file or directory`) : await g2(o23, 126, `${i22}: \u2018${h24[0]}\u2019: ${e12.message}`);
    }
  } finally {
    await a20.close().catch(() => {
    }), await o23.close().catch(() => {
    });
  }
};
var a18 = _2(i18);

// mithic/packages/coreutils/dist/commands/xargs.js
function i19(e11) {
  let t17, n18, r16, i22 = false, a20, o23 = false, s30, c37 = false, l38 = 0;
  for (; l38 < e11.length; l38++) {
    let u37 = e11[l38];
    if (u37 === "--") {
      l38++;
      break;
    }
    if (u37 === "--null") {
      i22 = true;
      continue;
    }
    if (u37 === "--no-run-if-empty") {
      o23 = true;
      continue;
    }
    if (u37.startsWith("--")) break;
    if (u37.startsWith("-") && u37.length > 1) {
      let d36 = 1, f32 = false;
      for (; d36 < u37.length; ) switch (u37[d36]) {
        case "0":
          i22 = true, d36++;
          break;
        case "r":
          o23 = true, d36++;
          break;
        case "t":
          c37 = true, d36++;
          break;
        case "n": {
          let n19 = u37.slice(d36 + 1);
          n19.length > 0 ? (t17 = parseInt(n19, 10), d36 = u37.length) : (t17 = parseInt(e11[++l38] ?? "1", 10), d36 = u37.length), f32 = true;
          break;
        }
        case "L": {
          let t18 = u37.slice(d36 + 1);
          t18.length > 0 ? (n18 = parseInt(t18, 10), d36 = u37.length) : (n18 = parseInt(e11[++l38] ?? "1", 10), d36 = u37.length), f32 = true;
          break;
        }
        case "I": {
          let t18 = u37.slice(d36 + 1);
          t18.length > 0 ? (r16 = t18, d36 = u37.length) : (r16 = e11[++l38] ?? "{}", d36 = u37.length), f32 = true;
          break;
        }
        case "d": {
          let t18 = u37.slice(d36 + 1);
          t18.length > 0 ? (a20 = t18[0], d36 = u37.length) : (a20 = (e11[++l38] ?? ":")?.[0], d36 = u37.length), f32 = true;
          break;
        }
        case "E": {
          let t18 = u37.slice(d36 + 1);
          t18.length > 0 ? (s30 = t18, d36 = u37.length) : (s30 = e11[++l38] ?? "", d36 = u37.length), f32 = true;
          break;
        }
        case "e": {
          let t18 = u37.slice(d36 + 1);
          if (t18.length > 0) s30 = t18, d36 = u37.length;
          else {
            let t19 = e11[l38 + 1];
            t19 !== void 0 && !t19.startsWith("-") ? (s30 = t19, l38++) : s30 = "", d36 = u37.length;
          }
          f32 = true;
          break;
        }
        default:
          f32 = true, l38--, d36 = u37.length;
      }
      if (!f32 || l38 >= 0 && l38 < e11.length && e11[l38] === u37) continue;
      continue;
    }
    break;
  }
  return {
    maxArgs: t17,
    maxLines: n18,
    replStr: r16,
    useNull: i22,
    customDelim: a20,
    noRunIfEmpty: o23,
    eofString: s30,
    trace: c37,
    cmd: e11.slice(l38)
  };
}
function a19(e11, t17) {
  return t17 === "nul" ? e11.split("\0").filter((e12) => e12.length > 0) : t17 === "whitespace" ? e11.split(/\s+/).filter((e12) => e12.length > 0) : (e11.endsWith("\n") ? e11.slice(0, -1) : e11).split(t17).map((e12) => e12.replace(/\n$/, "")).filter((e12) => e12.length > 0);
}
function o21(e11) {
  return e11 === "" ? [] : (e11.endsWith("\n") ? e11.slice(0, -1) : e11).split("\n");
}
function s26(e11, t17, n18) {
  return e11.map((e12) => e12.split(t17).join(n18));
}
async function c32(e11, t17, i22, a20, o23) {
  a20 && await m2(o23, t17.join(" "));
  let s30 = await e11.syscall("process/pipeline", { stages: [{
    path: t17[0],
    argv: t17
  }] });
  return s30.stdout && s30.stdout.byteLength > 0 && await f2(i22, s30.stdout), s30.exitCodes[0] ?? 0;
}
function l32(e11) {
  return e11 === 0 ? null : e11 === 255 ? 124 : 123;
}
var u30 = async (e11) => {
  let n18 = i19(e11.args.slice(1)), r16 = n18.cmd.length > 0 ? n18.cmd : ["echo"], u37 = r16[0], d36 = r16.slice(1), f32 = await s5(e11.stdin), p31 = e11.stdout.getWriter(), m24 = e11.stderr.getWriter();
  try {
    let t17 = "whitespace";
    if (n18.useNull ? t17 = "nul" : n18.customDelim && (t17 = n18.customDelim), n18.replStr !== void 0) {
      let t18 = o21(f32);
      if (t18.length === 0 && n18.noRunIfEmpty) return 0;
      let r18 = 0;
      for (let i23 of t18) {
        if (n18.eofString && n18.eofString.length > 0 && i23 === n18.eofString) break;
        let t19 = l32(await c32(e11, [u37, ...s26(d36, n18.replStr, i23)], p31, n18.trace, m24));
        if (t19 === 124) return 124;
        t19 !== null && r18 !== 124 && (r18 = t19);
      }
      return r18;
    }
    if (n18.maxLines !== void 0) {
      let t18 = o21(f32);
      if (t18.length === 0 && n18.noRunIfEmpty) return 0;
      let r18 = 0, i23 = false;
      for (let a20 = 0; a20 < t18.length && !i23; a20 += n18.maxLines) {
        let o23 = t18.slice(a20, a20 + n18.maxLines), s30 = [];
        for (let e12 of o23) {
          if (n18.eofString && n18.eofString.length > 0 && e12 === n18.eofString) {
            i23 = true;
            break;
          }
          s30.push(...e12.split(/\s+/).filter((e13) => e13.length > 0));
        }
        if (s30.length === 0) continue;
        let f33 = l32(await c32(e11, [
          u37,
          ...d36,
          ...s30
        ], p31, n18.trace, m24));
        if (f33 === 124) return 124;
        f33 !== null && r18 !== 124 && (r18 = f33);
      }
      return r18;
    }
    let r17 = a19(f32, t17);
    if (n18.eofString && n18.eofString.length > 0) {
      let e12 = r17.indexOf(n18.eofString);
      e12 >= 0 && (r17 = r17.slice(0, e12));
    }
    if (r17.length === 0 && n18.noRunIfEmpty) return 0;
    let i22 = n18.maxArgs !== void 0 && n18.maxArgs > 0 ? n18.maxArgs : void 0, h24 = 0;
    if (i22 === void 0) {
      let t18 = l32(await c32(e11, [
        u37,
        ...d36,
        ...r17
      ], p31, n18.trace, m24));
      if (t18 === 124) return 124;
      t18 !== null && (h24 = t18);
    } else if (r17.length === 0) {
      let t18 = l32(await c32(e11, [u37, ...d36], p31, n18.trace, m24));
      if (t18 === 124) return 124;
      t18 !== null && (h24 = t18);
    } else for (let t18 = 0; t18 < r17.length; t18 += i22) {
      let a20 = r17.slice(t18, t18 + i22), o23 = l32(await c32(e11, [
        u37,
        ...d36,
        ...a20
      ], p31, n18.trace, m24));
      if (o23 === 124) return 124;
      o23 !== null && h24 !== 124 && (h24 = o23);
    }
    return h24;
  } finally {
    await p31.close().catch(() => {
    }), await m24.close().catch(() => {
    });
  }
};
var d29 = _2(u30);

// mithic/packages/coreutils/dist/commands/find.js
function s27(e11) {
  let t17 = /^([+-]?)(\d+)([bckMG]?)$/.exec(e11);
  if (!t17) return;
  let n18 = t17[1] === "+" ? "+" : t17[1] === "-" ? "-" : "=", r16 = Number(t17[2]), i22 = t17[3];
  return {
    cmp: n18,
    n: r16,
    unit: i22 === "c" ? 1 : i22 === "k" ? 1024 : i22 === "M" ? 1024 * 1024 : i22 === "G" ? 1024 * 1024 * 1024 : 512,
    rounded: i22 !== "c"
  };
}
function c33(e11, t17) {
  let n18 = t17.rounded ? Math.ceil(e11 / t17.unit) : Math.floor(e11 / t17.unit);
  return t17.cmp === "+" ? n18 > t17.n : t17.cmp === "-" ? n18 < t17.n : n18 === t17.n;
}
function l33(e11, t17, n18) {
  let r16 = n18 ? ".*" : "[^/]*", i22 = n18 ? "." : "[^/]", a20 = "";
  for (let t18 = 0; t18 < e11.length; t18++) {
    let n19 = e11[t18];
    if (n19 === "*") a20 += r16;
    else if (n19 === "?") a20 += i22;
    else if (n19 === "[") {
      let n20 = t18 + 1, r17 = "[";
      for (e11[n20] === "!" && (r17 += "^", n20++); n20 < e11.length && e11[n20] !== "]"; ) r17 += e11[n20], n20++;
      r17 += "]", a20 += r17, t18 = n20;
    } else ".+^${}()|\\".includes(n19) ? a20 += "\\" + n19 : a20 += n19;
  }
  return RegExp("^" + a20 + "$", t17);
}
function u31(e11, t17 = "") {
  return l33(e11, t17, false);
}
function d30(e11, t17 = "") {
  return l33(e11, t17, true);
}
var f27 = {
  f: "file",
  d: "directory",
  l: "symlink"
};
function p27(e11) {
  let t17 = e11.lastIndexOf("/");
  return t17 < 0 ? "." : t17 === 0 ? "/" : e11.slice(0, t17);
}
var m21 = class {
};
var h22 = new TextEncoder();
var g16 = (e11) => ({ evaluate: async (t17) => e11(t17) });
var _19 = (e11) => ({ evaluate: async (t17, n18) => !await e11.evaluate(t17, n18) });
var v15 = (e11, t17) => ({ evaluate: async (n18, r16) => await e11.evaluate(n18, r16) && t17.evaluate(n18, r16) });
var y16 = (e11, t17) => ({ evaluate: async (n18, r16) => await e11.evaluate(n18, r16) || t17.evaluate(n18, r16) });
var b15 = (e11, t17) => ({ evaluate: async (n18, r16) => (await e11.evaluate(n18, r16), t17.evaluate(n18, r16)) });
var x11 = (e11) => ({ evaluate: async (t17, r16) => (await f2(r16.out, h22.encode(t17.path + e11)), true) });
var S9 = (e11) => ({ evaluate: async (t17, r16) => (await f2(r16.out, h22.encode(E5(e11, t17))), true) });
var C10 = () => ({ evaluate: async (e11, t17) => {
  throw t17.quit = true, new m21();
} });
var w7 = () => ({ evaluate: async (e11) => (e11.st.type === "directory" && (e11.prune = true), true) });
function T6(e11, t17) {
  let n18 = {
    argv: e11,
    batch: t17,
    evaluate: async (r16, i22) => {
      if (t17) {
        let e12 = i22.execBatch.get(n18) ?? [];
        return e12.push(r16.path), i22.execBatch.set(n18, e12), true;
      }
      return await M3(i22.io, e11, [r16.path], i22.out, i22.err) === 0;
    }
  };
  return n18;
}
function E5(e11, t17) {
  let { path: n18, st: r16, depth: a20, start: o23 } = t17, s30 = "";
  for (let t18 = 0; t18 < e11.length; t18++) {
    let c37 = e11[t18];
    if (c37 === "\\" && t18 + 1 < e11.length) {
      let n19 = e11[++t18];
      s30 += n19 === "n" ? "\n" : n19 === "t" ? "	" : n19 === "r" ? "\r" : n19 === "\\" ? "\\" : n19 === "0" ? "\0" : n19;
    } else if (c37 === "%" && t18 + 1 < e11.length) {
      let c38 = e11[++t18];
      c38 === "p" ? s30 += n18 : c38 === "f" ? s30 += S4(n18) : c38 === "h" ? s30 += p27(n18) : c38 === "P" ? s30 += D5(n18, o23) : c38 === "d" ? s30 += String(a20) : c38 === "s" ? s30 += String(r16.size) : c38 === "y" ? s30 += O5(r16.type) : c38 === "m" ? s30 += (r16.mode & 4095).toString(8) : c38 === "%" ? s30 += "%" : s30 += "%" + c38;
    } else s30 += c37;
  }
  return s30;
}
function D5(e11, t17) {
  if (e11 === t17) return "";
  let n18 = t17.endsWith("/") ? t17 : t17 + "/";
  return e11.startsWith(n18) ? e11.slice(n18.length) : e11;
}
function O5(e11) {
  return e11 === "directory" ? "d" : e11 === "symlink" ? "l" : e11 === "block-device" ? "b" : e11 === "character-device" ? "c" : e11 === "fifo" ? "p" : e11 === "socket" ? "s" : "f";
}
var k4 = class extends Error {
};
var A3 = class {
  tokens;
  io;
  pos = 0;
  hasAction = false;
  maxdepth;
  mindepth;
  depthFirst = false;
  newerCache = /* @__PURE__ */ new Map();
  constructor(e11, t17) {
    this.tokens = e11, this.io = t17;
  }
  async parse() {
    if (this.tokens.length === 0) return {
      node: g16(() => true),
      hasAction: false,
      maxdepth: this.maxdepth,
      mindepth: this.mindepth,
      depthFirst: this.depthFirst
    };
    let e11 = await this.parseComma();
    if (this.pos < this.tokens.length) {
      let e12 = this.tokens[this.pos];
      throw e12 === ")" ? new k4("you have too many ')'") : new k4(`paths must precede expression: \`${e12}'`);
    }
    return {
      node: e11,
      hasAction: this.hasAction,
      maxdepth: this.maxdepth,
      mindepth: this.mindepth,
      depthFirst: this.depthFirst
    };
  }
  peek() {
    return this.tokens[this.pos];
  }
  async parseComma() {
    let e11 = await this.parseOr();
    for (; this.peek() === ","; ) this.pos++, this.requireOperand(","), e11 = b15(e11, await this.parseOr());
    return e11;
  }
  async parseOr() {
    let e11 = await this.parseAnd();
    for (; this.peek() === "-o" || this.peek() === "-or"; ) {
      let t17 = this.tokens[this.pos++];
      this.requireOperand(t17), e11 = y16(e11, await this.parseAnd());
    }
    return e11;
  }
  async parseAnd() {
    let e11 = await this.parseNot();
    for (; ; ) {
      let t17 = this.peek();
      if (t17 === "-a" || t17 === "-and") this.pos++, this.requireOperand(t17), e11 = v15(e11, await this.parseNot());
      else if (t17 !== void 0 && t17 !== ")" && t17 !== "-o" && t17 !== "-or" && t17 !== ",") e11 = v15(e11, await this.parseNot());
      else break;
    }
    return e11;
  }
  async parseNot() {
    let e11 = this.peek();
    return e11 === "!" || e11 === "-not" ? (this.pos++, this.requireOperand(e11), _19(await this.parseNot())) : this.parsePrimary();
  }
  async parsePrimary() {
    let e11 = this.peek();
    if (e11 === void 0) throw new k4("invalid expression; empty parentheses are not allowed.");
    if (e11 === "(") {
      if (this.pos++, this.peek() === ")") throw new k4("invalid expression; empty parentheses are not allowed.");
      let e12 = await this.parseComma();
      if (this.peek() !== ")") throw new k4("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
      return this.pos++, e12;
    }
    if (e11 === ")") throw new k4("you have too many ')'");
    if (e11 === "-o" || e11 === "-or" || e11 === "-a" || e11 === "-and" || e11 === ",") throw new k4(`invalid expression; you have used a binary operator '${e11}' with nothing before it.`);
    return this.parseTestOrAction();
  }
  requireOperand(e11) {
    let t17 = this.peek();
    if (t17 === void 0) throw new k4(`expected an expression after '${e11}'`);
    if (t17 === ")") throw new k4(`expected an expression between '${e11}' and ')'`);
  }
  next() {
    return this.tokens[this.pos++];
  }
  requireValue(e11) {
    if (this.pos >= this.tokens.length) throw new k4(`missing argument to \`${e11}'`);
    return this.next();
  }
  async parseTestOrAction() {
    let e11 = this.next();
    switch (e11) {
      case "-name": {
        let t17 = u31(this.requireValue(e11));
        return g16((e12) => t17.test(S4(e12.path)));
      }
      case "-iname": {
        let t17 = u31(this.requireValue(e11), "i");
        return g16((e12) => t17.test(S4(e12.path)));
      }
      case "-path":
      case "-wholename": {
        let t17 = d30(this.requireValue(e11));
        return g16((e12) => t17.test(e12.path));
      }
      case "-ipath":
      case "-iwholename": {
        let t17 = d30(this.requireValue(e11), "i");
        return g16((e12) => t17.test(e12.path));
      }
      case "-type": {
        let t17 = this.requireValue(e11), n18 = this.parseTypeList(t17);
        return g16((e12) => n18.has(e12.st.type));
      }
      case "-maxdepth":
        return this.maxdepth = this.parseDepth(e11, this.requireValue(e11)), g16(() => true);
      case "-mindepth":
        return this.mindepth = this.parseDepth(e11, this.requireValue(e11)), g16(() => true);
      case "-depth":
        return this.depthFirst = true, g16(() => true);
      case "-size": {
        let t17 = s27(this.requireValue(e11));
        if (!t17) throw new k4("invalid -size argument");
        return g16((e12) => e12.st.type === "file" && c33(e12.st.size, t17));
      }
      case "-empty":
        return g16((e12) => e12.st.type === "file" && e12.st.size === 0 || e12.st.type === "directory" && e12.isEmptyDir);
      case "-newer": {
        let t17 = this.requireValue(e11), n18 = await this.statNewer(t17);
        return g16((e12) => new Date(e12.st.mtime).getTime() > n18);
      }
      case "-true":
        return g16(() => true);
      case "-false":
        return g16(() => false);
      case "-prune":
        return w7();
      case "-print":
        return this.hasAction = true, x11("\n");
      case "-print0":
        return this.hasAction = true, x11("\0");
      case "-printf":
        return this.hasAction = true, S9(this.requireValue(e11));
      case "-quit":
        return this.hasAction = true, C10();
      case "-exec":
        return this.parseExec();
      default:
        throw new k4(`unknown predicate \`${e11}'`);
    }
  }
  parseTypeList(e11) {
    let t17 = /* @__PURE__ */ new Set();
    for (let n18 of e11.split(",")) {
      let r16 = f27[n18];
      if (n18.length !== 1 || !r16) throw new k4(`Unknown argument to -type: ${n18 === "" ? e11 : n18}`);
      t17.add(r16);
    }
    return t17;
  }
  parseDepth(e11, t17) {
    if (!/^\d+$/.test(t17)) throw new k4(`Expected a positive decimal integer argument to ${e11}, but got \u2018${t17}\u2019`);
    return parseInt(t17, 10);
  }
  async statNewer(e11) {
    let t17 = this.newerCache.get(e11);
    if (t17 !== void 0) return t17;
    let n18;
    try {
      n18 = new Date((await n11(this.io, e11, false)).mtime).getTime();
    } catch {
      throw new k4(`\u2018${e11}\u2019: No such file or directory`);
    }
    return this.newerCache.set(e11, n18), n18;
  }
  parseExec() {
    let e11 = [], t17 = false, n18 = false;
    for (; this.pos < this.tokens.length; ) {
      let r16 = this.next();
      if (r16 === ";" || r16 === "\\;") {
        n18 = true;
        break;
      }
      if (r16 === "+") {
        t17 = true, n18 = true;
        break;
      }
      e11.push(r16);
    }
    if (!n18 || e11.length === 0) throw new k4("missing argument to `-exec'");
    return this.hasAction = true, T6(e11, t17);
  }
};
var j3 = -1;
async function M3(e11, t17, i22, a20, o23) {
  let s30 = [], c37 = false;
  for (let e12 of t17) e12 === "{}" ? (s30.push(...i22), c37 = true) : s30.push(e12);
  c37 || s30.push(...i22);
  let l38;
  try {
    l38 = await e11.syscall("process/pipeline", { stages: [{
      path: s30[0],
      argv: s30
    }] });
  } catch {
    return await m2(o23, `find: \u2018${t17[0]}\u2019: No such file or directory`), j3;
  }
  return l38.stdout && l38.stdout.byteLength > 0 && await f2(a20, l38.stdout), l38.exitCodes?.[0] ?? 0;
}
function N3(e11) {
  return e11 === "" ? "." : e11;
}
function P3(e11, t17) {
  return e11.endsWith("/") ? e11 + t17 : e11 + "/" + t17;
}
var F3 = async (e11) => {
  let n18 = e11.args.slice(1), i22 = e11.stderr.getWriter(), a20 = e11.stdout.getWriter();
  try {
    if (n18.includes("--help")) return await I3(a20, z2), 0;
    if (n18.includes("--version")) return await I3(a20, R2), 0;
    let o23 = 0;
    for (; o23 < n18.length && (n18[o23] === "-L" || n18[o23] === "-H" || n18[o23] === "-P"); ) o23++;
    let s30 = [];
    for (; o23 < n18.length && !n18[o23].startsWith("-") && n18[o23] !== "(" && n18[o23] !== "!"; ) s30.push(n18[o23]), o23++;
    s30.length === 0 && s30.push(".");
    let c37;
    try {
      c37 = await new A3(n18.slice(o23), e11).parse();
    } catch (e12) {
      if (e12 instanceof k4) return g2(i22, 1, `find: ${e12.message}`);
      throw e12;
    }
    let l38 = c37.hasAction ? c37.node : v15(c37.node, x11("\n")), u37 = {
      io: e11,
      out: a20,
      err: i22,
      execBatch: /* @__PURE__ */ new Map(),
      quit: false
    }, d36 = 0;
    for (let t17 of s30) {
      if (u37.quit) break;
      let n19 = N3(t17);
      try {
        await L2(e11, n19, 0, n19, l38, c37, u37);
      } catch (e12) {
        if (e12 instanceof m21) break;
        await m2(i22, `find: \u2018${t17}\u2019: No such file or directory`), d36 = 1;
      }
    }
    for (let [t17, n19] of u37.execBatch) n19.length !== 0 && await M3(e11, t17.argv, n19, a20, i22) !== 0 && (d36 = 1);
    return d36;
  } finally {
    await a20.close().catch(() => {
    }), await i22.close().catch(() => {
    });
  }
};
async function I3(e11, t17) {
  await e11.write(h22.encode(t17));
}
async function L2(e11, t17, n18, r16, i22, s30, c37) {
  let l38;
  try {
    l38 = await n11(e11, t17, false);
  } catch {
    throw Error("No such file or directory");
  }
  let u37 = l38.type, d36;
  if (u37 === "directory") try {
    d36 = await r10(e11, t17);
  } catch {
    d36 = [];
  }
  let f32 = {
    path: t17,
    st: l38,
    depth: n18,
    start: r16,
    isEmptyDir: u37 === "directory" && (d36?.length ?? 0) === 0,
    prune: false
  }, p31 = s30.mindepth === void 0 || n18 >= s30.mindepth;
  if (p31 && !s30.depthFirst && await i22.evaluate(f32, c37), !f32.prune && u37 === "directory" && d36 && !(s30.maxdepth !== void 0 && n18 >= s30.maxdepth)) {
    let a20 = [...d36].sort((e12, t18) => e12.name.localeCompare(t18.name));
    for (let o23 of a20) await L2(e11, P3(t17, o23.name), n18 + 1, r16, i22, s30, c37);
  }
  p31 && s30.depthFirst && await i22.evaluate(f32, c37);
}
var R2 = "find (mithic coreutils) 2.0.0\n";
var z2 = "Usage: find [starting-point...] [expression]\n\nDefault path is the current directory; default expression is -print.\n\nOperators (decreasing precedence):\n      ( EXPR )   ! EXPR   -not EXPR   EXPR1 -a EXPR2   EXPR1 -and EXPR2\n      EXPR1 -o EXPR2   EXPR1 -or EXPR2   EXPR1 , EXPR2\n\nTests:  -name PATTERN -iname PATTERN -path PATTERN -type [bcdpfls]\n        -size N[bckMG] -empty -newer FILE -true -false -prune\n\nGlobal options (before paths): -L -H -P\nOptions: -maxdepth LEVELS -mindepth LEVELS -depth\n\nActions: -print -print0 -printf FORMAT -exec COMMAND ; -quit\n";
var B2 = _2(F3);

// mithic/packages/coreutils/dist/commands/mktemp.js
var s28 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
var c34 = 0;
function l34(e11, t17, n18, r16) {
  let i22 = e11 * 2654435761 + t17 * 40503 + n18 * 2246822519 + 2654435769 >>> 0;
  i22 === 0 && (i22 = 439041101);
  let a20 = "";
  for (let e12 = 0; e12 < r16; e12++) i22 ^= i22 << 13, i22 >>>= 0, i22 ^= i22 >> 17, i22 ^= i22 << 5, i22 >>>= 0, a20 += s28[i22 % 62];
  return a20;
}
function u32(e11, t17) {
  let n18 = /X+$/.exec(e11);
  return n18 ? e11.slice(0, n18.index) + t17.slice(0, n18[0].length) : e11;
}
function d31(e11) {
  let t17 = /X+$/.exec(e11);
  return t17 ? t17[0].length : 0;
}
async function f28(e11) {
  try {
    let { pid: t17 } = await e11.syscall("process/getpid", {});
    return t17;
  } catch {
    return 0;
  }
}
var p28 = async (e11) => {
  let { positionals: s30, flags: p31 } = t7(e11.args.slice(1), {
    boolean: [
      "d",
      "u",
      "q"
    ],
    string: [
      "p",
      "tmpdir",
      "suffix"
    ],
    alias: {
      directory: "d",
      "dry-run": "u",
      quiet: "q"
    }
  }), m24 = e11.stdout.getWriter(), h24 = e11.stderr.getWriter(), g18 = !!p31.q;
  try {
    let t17 = s30[0] ?? "tmp.XXXXXXXXXX", _21 = d31(t17);
    if (_21 < 3) return g18 || await m2(h24, `mktemp: too few X's in template '${t17}'`), 1;
    let v17 = typeof p31.p == "string" ? p31.p : typeof p31.tmpdir == "string" && p31.tmpdir !== "" ? p31.tmpdir : e11.env.TMPDIR || "/tmp", y18 = t17.startsWith("/") ? t17 : w3(v17, t17), b17 = await f28(e11), x13 = parseInt(e11.env.MKTEMP_SEED ?? "", 10) || 0, S11 = typeof p31.suffix == "string" ? p31.suffix : "";
    for (let t18 = 0; t18 < 1e3; t18++) {
      let t19 = u32(y18, l34(b17, ++c34, x13, _21)) + S11;
      if (p31.u) return await m2(m24, t19), 0;
      if (await _10(e11, t19) === void 0) try {
        return p31.d ? await s15(e11, t19) : await o12(e11, t19), await m2(m24, t19), 0;
      } catch (e12) {
        if (e12.code === "EEXIST") continue;
        return g18 || await m2(h24, `mktemp: failed to create ${p31.d ? "directory" : "file"} '${t19}': ${e12.message}`), 1;
      }
    }
    return g18 || await m2(h24, "mktemp: could not create a unique name"), 1;
  } finally {
    await m24.close().catch(() => {
    }), await h24.close().catch(() => {
    });
  }
};
var m22 = _2(p28);

// mithic/packages/coreutils/dist/commands/printenv.js
var r14 = async (e11) => {
  let { positionals: r16 } = t7(e11.args.slice(1), {}), i22 = e11.stdout.getWriter(), a20 = e11.stderr.getWriter();
  try {
    if (r16.length === 0) {
      for (let [t18, r17] of Object.entries(e11.env).sort(([e12], [t19]) => e12 < t19 ? -1 : +(e12 > t19))) await m2(i22, `${t18}=${r17}`);
      return 0;
    }
    let t17 = 0;
    for (let a21 of r16) {
      let r17 = e11.env[a21];
      r17 === void 0 ? t17 = 1 : await m2(i22, r17);
    }
    return t17;
  } finally {
    await i22.close().catch(() => {
    }), await a20.close().catch(() => {
    });
  }
};
var i20 = _2(r14);

// mithic/packages/coreutils/dist/commands/rmdir.js
var o22 = async (e11) => {
  let { positionals: o23, flags: s30 } = t7(e11.args.slice(1), {
    boolean: ["p"],
    alias: { parents: "p" }
  }), c37 = e11.stderr.getWriter(), l38 = 0;
  try {
    if (o23.length === 0) return await m2(c37, "rmdir: missing operand"), 1;
    for (let t17 of o23) try {
      if (await c16(e11, T3(t17)), s30.p) {
        let n18 = C4(T3(t17));
        for (; n18 !== "/" && n18 !== "." && n18 !== ""; ) {
          try {
            await c16(e11, n18);
          } catch {
            break;
          }
          n18 = C4(n18);
        }
      }
    } catch (e12) {
      await m2(c37, `rmdir: failed to remove '${t17}': ${e12.message}`), l38 = 1;
    }
    return l38;
  } finally {
    await c37.close().catch(() => {
    });
  }
};
var s29 = _2(o22);

// mithic/packages/coreutils/dist/commands/stat.js
var l35 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EXDEV: "Invalid cross-device link",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
  ENOSPC: "No space left on device",
  EIO: "Input/output error"
};
function u33(e11) {
  let t17 = e11?.code;
  return (t17 && l35[t17]) ?? r5(e11);
}
var d32 = {
  file: "regular file",
  directory: "directory",
  symlink: "symbolic link",
  "block-device": "block special file",
  "character-device": "character special file",
  fifo: "fifo",
  socket: "socket",
  unknown: "unknown"
};
var f29 = {
  file: 32768,
  directory: 16384,
  symlink: 40960,
  "block-device": 24576,
  "character-device": 8192,
  fifo: 4096,
  socket: 49152,
  unknown: 0
};
var p29 = {
  file: "-",
  directory: "d",
  symlink: "l",
  "block-device": "b",
  "character-device": "c",
  fifo: "p",
  socket: "s",
  unknown: "?"
};
var m23 = (e11) => Math.floor(new Date(e11).getTime() / 1e3);
var h23 = (e11) => (e11 & 4 ? "r" : "-") + (e11 & 2 ? "w" : "-") + (e11 & 1 ? "x" : "-");
function g17(e11, t17) {
  return p29[e11] + h23(t17 >> 6 & 7) + h23(t17 >> 3 & 7) + h23(t17 & 7);
}
var _20 = (e11) => f29[e11.type] | e11.mode & 4095;
function v16(e11) {
  let t17 = 2166136261;
  for (let n18 = 0; n18 < e11.length; n18++) t17 ^= e11.charCodeAt(n18), t17 = Math.imul(t17, 16777619);
  return (t17 >>> 0) % 9e7 + 1e7;
}
function y17(e11, t17, n18) {
  switch (e11) {
    case "n":
      return t17;
    case "N":
      return `'${t17}'`;
    case "s":
      return String(n18.size);
    case "f":
      return _20(n18).toString(16);
    case "a":
      return (n18.mode & 4095).toString(8);
    case "A":
      return g17(n18.type, n18.mode);
    case "F":
      return d32[n18.type] ?? "unknown";
    case "h":
      return String(n18.linkCount);
    case "b":
      return String(Math.ceil(n18.size / 512));
    case "B":
      return "512";
    case "o":
      return "4096";
    case "i":
      return String(v16(t17));
    case "d":
      return "0";
    case "D":
      return "0";
    case "t":
      return "0";
    case "T":
      return "0";
    case "u":
      return "0";
    case "g":
      return "0";
    case "U":
      return "root";
    case "G":
      return "root";
    case "X":
      return String(m23(n18.atime));
    case "Y":
      return String(m23(n18.mtime));
    case "Z":
      return String(m23(n18.ctime));
    case "W":
      return String(m23(n18.ctime));
    case "%":
      return "%";
    default:
      return "?";
  }
}
function b16(e11, t17, n18, r16) {
  let i22 = "";
  for (let a20 = 0; a20 < e11.length; a20++) {
    let o23 = e11[a20];
    if (o23 === "%" && a20 + 1 < e11.length) i22 += y17(e11[++a20], t17, n18);
    else if (r16 && o23 === "\\" && a20 + 1 < e11.length) {
      let t18 = e11[a20 + 1];
      if (t18 === "x" && /[0-9a-fA-F]/.test(e11[a20 + 2] ?? "")) {
        a20 += 2;
        let t19 = e11[a20];
        /[0-9a-fA-F]/.test(e11[a20 + 1] ?? "") && (t19 += e11[++a20]), i22 += String.fromCharCode(parseInt(t19, 16));
      } else if (t18 >= "0" && t18 <= "7") {
        a20++;
        let t19 = e11[a20];
        for (let n19 = 0; n19 < 2 && /[0-7]/.test(e11[a20 + 1] ?? ""); n19++) t19 += e11[++a20];
        i22 += String.fromCharCode(parseInt(t19, 8) & 255);
      } else a20++, i22 += t18 === "a" ? "\x07" : t18 === "b" ? "\b" : t18 === "f" ? "\f" : t18 === "n" ? "\n" : t18 === "r" ? "\r" : t18 === "t" ? "	" : t18 === "v" ? "\v" : t18 === "\\" ? "\\" : t18;
    } else i22 += o23;
  }
  return i22;
}
function x12(e11, t17) {
  let n18 = (t17.mode & 4095).toString(8).padStart(4, "0"), r16 = Math.ceil(t17.size / 512), i22 = (e12) => new Date(e12).toISOString().replace("T", " ").replace("Z", " +0000");
  return `  File: ${e11}
  Size: ${t17.size}		Blocks: ${r16}          IO Block: 4096   ${d32[t17.type] ?? "unknown"}
Device: 0,0	Inode: ${v16(e11)}   Links: ${t17.linkCount}
Access: (${n18}/${g17(t17.type, t17.mode)})  Uid: (    0/    root)   Gid: (    0/    root)
Access: ${i22(t17.atime)}
Modify: ${i22(t17.mtime)}
Change: ${i22(t17.ctime)}
 Birth: ${i22(t17.ctime)}`;
}
function S10(e11, t17) {
  return b16("%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o", e11, t17, false);
}
var C11 = async (e11) => {
  let n18 = e11.args[0] ?? "stat", l38 = t7(e11.args.slice(1), {
    boolean: [
      "L",
      "t",
      "f"
    ],
    string: ["c", "printf"],
    alias: {
      format: "c",
      dereference: "L",
      terse: "t",
      "file-system": "f"
    },
    unknown: "error"
  }), d36 = e11.stdout.getWriter(), f32 = e11.stderr.getWriter(), p31 = 0, m24 = !!l38.flags.L;
  try {
    if (l38.unknown.length) return await g2(f32, 1, h2(n18, l38.unknown[0]));
    let { positionals: i22, flags: h24 } = l38;
    if (i22.length === 0) return await g2(f32, 1, `${n18}: missing operand
Try '${n18} --help' for more information.`);
    let g18 = typeof h24.printf == "string" ? h24.printf : void 0, _21 = typeof h24.c == "string" ? h24.c : void 0;
    for (let t17 of i22) {
      let r16;
      try {
        r16 = await n11(e11, T3(t17), m24);
      } catch (e12) {
        await m2(f32, `${n18}: cannot stat '${t17}': ${u33(e12)}`), p31 = 1;
        continue;
      }
      g18 === void 0 ? _21 === void 0 ? h24.t ? await m2(d36, S10(t17, r16)) : await m2(d36, x12(t17, r16)) : await m2(d36, b16(_21, t17, r16, false)) : await p2(d36, b16(g18, t17, r16, true));
    }
    return p31;
  } finally {
    await d36.close().catch(() => {
    }), await f32.close().catch(() => {
    });
  }
};
var w8 = _2(C11);

// mithic/packages/coreutils/dist/commands/ln.js
var u34 = async (e11) => {
  let { positionals: u37, flags: d36 } = t7(e11.args.slice(1), {
    boolean: [
      "s",
      "f",
      "v"
    ],
    alias: {
      symbolic: "s",
      force: "f",
      verbose: "v"
    }
  }), f32 = e11.stdout.getWriter(), p31 = e11.stderr.getWriter(), m24 = 0;
  try {
    if (u37.length < 1) return await m2(p31, "ln: missing file operand"), 1;
    let t17, h24;
    u37.length === 1 ? (t17 = [u37[0]], h24 = S4(u37[0])) : (h24 = u37[u37.length - 1], t17 = u37.slice(0, -1));
    let g18 = await _10(e11, h24) === "directory";
    if (t17.length > 1 && !g18) return await m2(p31, `ln: target '${h24}' is not a directory`), 1;
    for (let c37 of t17) {
      let t18 = g18 ? w3(T3(h24), S4(c37)) : T3(h24);
      try {
        d36.f && await l14(e11, t18).catch(() => {
        }), d36.s ? await d14(e11, c37, t18) : await f13(e11, T3(c37), t18), d36.v && await m2(f32, `'${t18}' -> '${c37}'`);
      } catch (e12) {
        await m2(p31, `ln: failed to create link '${t18}': ${e12.message}`), m24 = 1;
      }
    }
    return m24;
  } finally {
    await f32.close().catch(() => {
    }), await p31.close().catch(() => {
    });
  }
};
var d33 = _2(u34);

// mithic/packages/coreutils/dist/commands/canonicalize.js
var n17 = 40;
var r15 = class extends Error {
  path;
  constructor(e11) {
    super("No such file or directory"), this.name = "CanonError", this.path = e11;
  }
};
async function i21(i22, a20, o23) {
  let s30 = o23 === "f" ? "all-but-last" : o23 === "e" ? "existing" : o23 === "m" ? "missing" : o23, c37 = a20.split("/").filter((e11) => e11 !== ""), l38 = [], u37 = 0;
  for (; c37.length > 0; ) {
    let a21 = c37.shift();
    if (a21 === ".") continue;
    if (a21 === "..") {
      l38.length > 0 && l38.pop();
      continue;
    }
    let o24 = "/" + [...l38, a21].join("/"), d36 = c37.length === 0, f32;
    try {
      f32 = await n11(i22, o24, false);
    } catch {
      if (s30 === "existing" || s30 === "all-but-last" && !d36) throw new r15(o24);
      l38.push(a21);
      for (let e11 of c37) if (e11 !== ".") {
        if (e11 === "..") {
          l38.length > 0 && l38.pop();
          continue;
        }
        l38.push(e11);
      }
      c37.length = 0;
      break;
    }
    if (f32.type === "symlink") {
      if (++u37 > n17) throw new r15(o24);
      let t17 = await h11(i22, o24), a22 = (t17.startsWith("/"), t17.split("/").filter((e11) => e11 !== ""));
      t17.startsWith("/") && (l38.length = 0), c37.unshift(...a22);
      continue;
    }
    l38.push(a21);
  }
  return "/" + l38.join("/");
}

// mithic/packages/coreutils/dist/commands/readlink.js
var c35 = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EINVAL: "Invalid argument",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long"
};
function l36(e11) {
  let t17 = e11?.code;
  return (t17 && c35[t17]) ?? r5(e11);
}
var u35 = async (e11) => {
  let n18 = t7(e11.args.slice(1), {
    boolean: [
      "f",
      "e",
      "m",
      "n",
      "q",
      "s",
      "v",
      "z"
    ],
    alias: {
      canonicalize: "f",
      "canonicalize-existing": "e",
      "canonicalize-missing": "m",
      quiet: "q",
      silent: "s",
      verbose: "v",
      "no-newline": "n",
      zero: "z"
    },
    unknown: "error"
  }), c37 = e11.stdout.getWriter(), u37 = e11.stderr.getWriter(), f32 = e11.args[0] ?? "readlink", p31 = new TextEncoder(), m24 = 0, h24 = n18.flags, g18 = h24.n ? "" : h24.z ? "\0" : "\n", _21 = h24.e ? "e" : h24.m ? "m" : h24.f ? "f" : void 0, v17 = !!h24.v;
  try {
    if (n18.unknown.length) return await g2(u37, 1, h2(f32, n18.unknown[0]));
    if (n18.positionals.length === 0) return await g2(u37, 1, `${f32}: missing operand
Try '${f32} --help' for more information.`);
    for (let t17 of n18.positionals) try {
      let n19;
      if (n19 = _21 === void 0 ? await h11(e11, t17) : await i21(e11, d34(t17, e11.cwd), _21), n19 === void 0) {
        m24 = 1, v17 && await m2(u37, `${f32}: ${t17}: No such file or directory`);
        continue;
      }
      await c37.write(p31.encode(n19 + g18));
    } catch (e12) {
      m24 = 1, v17 && await m2(u37, `${f32}: ${t17}: ${l36(e12)}`);
    }
    return m24;
  } finally {
    await c37.close().catch(() => {
    }), await u37.close().catch(() => {
    });
  }
};
function d34(e11, t17) {
  if (e11.startsWith("/")) return e11;
  let n18 = t17 || "/";
  return n18.endsWith("/") ? n18 + e11 : n18 + "/" + e11;
}
var f30 = _2(u35);

// mithic/packages/coreutils/dist/commands/realpath.js
var c36 = async (e11) => {
  let a20 = t7(e11.args.slice(1), {
    boolean: [
      "q",
      "m",
      "e",
      "s",
      "P",
      "L",
      "z"
    ],
    string: ["relative-to", "relative-base"],
    alias: {
      quiet: "q",
      "canonicalize-missing": "m",
      "canonicalize-existing": "e",
      strip: "s",
      "no-symlinks": "s",
      physical: "P",
      logical: "L",
      zero: "z"
    },
    unknown: "error"
  }), c37 = e11.stdout.getWriter(), p31 = e11.stderr.getWriter(), m24 = e11.args[0] ?? "realpath", h24 = a20.flags, g18 = 0, _21 = h24.z ? "\0" : "\n", v17 = h24.e ? "e" : h24.m ? "m" : "f";
  try {
    if (a20.unknown.length) return await g2(p31, 1, h2(m24, a20.unknown[0]));
    if (a20.positionals.length === 0) return await g2(p31, 1, `${m24}: missing operand
Try '${m24} --help' for more information.`);
    let r16 = typeof h24["relative-base"] == "string" ? h24["relative-base"] : void 0, y18 = typeof h24["relative-to"] == "string" ? h24["relative-to"] : r16 === void 0 ? void 0 : r16, b17 = r16 === void 0 ? void 0 : await l37(e11, r16, v17), x13 = y18 === void 0 ? void 0 : await l37(e11, y18, v17);
    for (let t17 of a20.positionals) try {
      let n18 = await i21(e11, u36(t17, e11.cwd), v17), r17 = n18, a21 = b17 === void 0 || d35(n18, b17);
      x13 !== void 0 && a21 && (r17 = f31(n18, x13)), await p2(c37, r17 + _21);
    } catch (e12) {
      e12 instanceof r15 ? (h24.q || await p2(p31, `${m24}: ${t17}: No such file or directory
`), g18 = 1) : (h24.q || await p2(p31, `${m24}: ${t17}: ${e12.message}
`), g18 = 1);
    }
    return g18;
  } finally {
    await c37.close().catch(() => {
    }), await p31.close().catch(() => {
    });
  }
};
async function l37(e11, t17, n18) {
  try {
    return await i21(e11, T3(u36(t17, e11.cwd)), n18);
  } catch {
    return T3(u36(t17, e11.cwd));
  }
}
function u36(e11, t17) {
  if (e11.startsWith("/")) return e11;
  let n18 = t17 || "/";
  return n18.endsWith("/") ? n18 + e11 : n18 + "/" + e11;
}
function d35(e11, t17) {
  if (e11 === t17) return true;
  let n18 = t17 === "/" ? "/" : t17 + "/";
  return e11.startsWith(n18);
}
function f31(e11, t17) {
  let n18 = e11.split("/").filter(Boolean), r16 = t17.split("/").filter(Boolean), i22 = 0;
  for (; i22 < n18.length && i22 < r16.length && n18[i22] === r16[i22]; ) i22++;
  let a20 = r16.slice(i22).map(() => ".."), o23 = n18.slice(i22), s30 = [...a20, ...o23];
  return s30.length === 0 ? "." : s30.join("/");
}
var p30 = _2(c36);

// coreutils-entry.mjs
var REGISTRY = {
  cat: m3,
  grep: z,
  egrep: z,
  fgrep: z,
  sed: y3,
  awk: d8,
  wc: d9,
  head: x2,
  tail: y6,
  sort: E2,
  seq: g9,
  ls: _11,
  printf: S6,
  echo: i10,
  uniq: m13,
  cut: S7,
  tr: m15,
  tee: i12,
  diff: f19,
  mkdir: l20,
  rm: l21,
  cp: p19,
  mv: _14,
  touch: c23,
  chmod: d22,
  pwd: r11,
  basename: o16,
  dirname: a16,
  tac: l24,
  nl: u25,
  od: C8,
  cksum: F2,
  sum: F2,
  shuf: p23,
  rev: f24,
  base64: g14,
  base32: v14,
  true: t15,
  false: t16,
  which: s25,
  env: i18,
  xargs: u30,
  find: F3,
  mktemp: p28,
  printenv: r14,
  rmdir: o22,
  stat: C11,
  ln: u34,
  readlink: u35,
  realpath: c36
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  REGISTRY
});
