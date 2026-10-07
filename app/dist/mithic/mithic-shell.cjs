var xt = Object.defineProperty;
var Ue = Object.getOwnPropertyDescriptor;
var je = Object.getOwnPropertyNames;
var _e = Object.prototype.hasOwnProperty;
var qe = (t, e) => {
  for (var i in e)
    xt(t, i, { get: e[i], enumerable: !0 });
}, ti = (t, e, i, s) => {
  if (e && typeof e == "object" || typeof e == "function")
    for (let r of je(e))
      !_e.call(t, r) && r !== i && xt(t, r, { get: () => e[r], enumerable: !(s = Ue(e, r)) || s.enumerable });
  return t;
};
var ei = (t) => ti(xt({}, "__esModule", { value: !0 }), t);

// entry.mjs
var ds = {};
qe(ds, {
  BUILTINS: () => St,
  Executor: () => qt,
  Expander: () => j,
  ast: () => ze,
  isBuiltin: () => G,
  parse: () => nt,
  parseCliArgs: () => Xt,
  runBuiltin: () => st,
  tokenize: () => rt
});
module.exports = ei(ds);

// mithic/packages/shell/dist/prompt.js
function ii(t, e) {
  if (!e) return t;
  if (t === e) return "~";
  let i = e.replace(/\/+$/, "");
  return i !== "" && t.startsWith(`${i}/`) ? "~" + t.slice(i.length) : t;
}
function si(t) {
  if (t === "/" || t === "") return "/";
  let e = t.replace(/\/+$/, "").split("/");
  return e[e.length - 1] || "/";
}
function ht(t, e) {
  let i = "";
  for (let s = 0; s < t.length; s++) {
    let r = t[s];
    if (r !== "\\") {
      i += r;
      continue;
    }
    let a = t[s + 1];
    if (t.startsWith("033", s + 1)) {
      i += "\x1B", s += 3;
      continue;
    }
    switch (a) {
      case "w":
        i += ii(e.cwd, e.env.HOME), s++;
        continue;
      case "W":
        i += si(e.cwd), s++;
        continue;
      case "u":
        i += e.env.USER || "user", s++;
        continue;
      case "h":
        i += (e.env.HOSTNAME || "mithic").split(".")[0], s++;
        continue;
      case "$":
        i += "$", s++;
        continue;
      case "e":
        i += "\x1B", s++;
        continue;
      case "a":
        i += "\x07", s++;
        continue;
      case "n":
        i += `
`, s++;
        continue;
      case "r":
        i += "\r", s++;
        continue;
      case "\\":
        i += "\\", s++;
        continue;
      default:
        i += "\\";
        continue;
    }
  }
  return i;
}

// mithic/packages/shell/dist/arith.js
var ri = [
  "<<=",
  ">>=",
  "**="
], ni = [
  "**",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "<<",
  ">>",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^="
], ai = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  "~",
  "!",
  "<",
  ">",
  "&",
  "|",
  "^",
  "?",
  ":",
  ",",
  "="
], ct = 1n << 64n, li = (1n << 63n) - 1n;
function I(t) {
  let e = (t % ct + ct) % ct;
  return e > li ? e - ct : e;
}
function bt(t) {
  let e = [], i = 0, s = t.length;
  for (; i < s; ) {
    let r = t[i];
    if (r === " " || r === "	" || r === `
`) {
      i++;
      continue;
    }
    if (r === "$") {
      i++;
      continue;
    }
    if (/[0-9]/.test(r)) {
      let l = i;
      for (; l < s && /[0-9a-fA-FxX]/.test(t[l]); ) l++;
      if (t[l] === "#") {
        let h = l + 1;
        for (; h < s && /[0-9a-zA-Z@_]/.test(t[h]); ) h++;
        e.push({
          t: "num",
          v: hi(t.slice(i, l), t.slice(l + 1, h))
        }), i = h;
        continue;
      }
      let o = t.slice(i, l);
      e.push({
        t: "num",
        v: oi(o)
      }), i = l;
      continue;
    }
    if (/[A-Za-z_]/.test(r)) {
      let l = i;
      for (; l < s && /[A-Za-z0-9_]/.test(t[l]); ) l++;
      if (t[l] === "[") {
        let o = 0, h = l;
        for (; h < s; h++) if (t[h] === "[") o++;
        else if (t[h] === "]" && (o--, o === 0)) {
          h++;
          break;
        }
        e.push({
          t: "name",
          v: t.slice(i, h)
        }), i = h;
        continue;
      }
      e.push({
        t: "name",
        v: t.slice(i, l)
      }), i = l;
      continue;
    }
    let a = t.slice(i, i + 3);
    if (ri.includes(a)) {
      e.push({
        t: "op",
        v: a
      }), i += 3;
      continue;
    }
    let n = t.slice(i, i + 2);
    if (ni.includes(n)) {
      e.push({
        t: "op",
        v: n
      }), i += 2;
      continue;
    }
    if (ai.includes(r)) {
      e.push({
        t: "op",
        v: r
      }), i++;
      continue;
    }
    throw SyntaxError(`arith: unexpected character '${r}'`);
  }
  return e;
}
function re(t) {
  let e = /^([+-]?)(.*)$/.exec(t.trim());
  if (e === null) return;
  let i = e[1] === "-" ? -1n : 1n, s = e[2];
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return I(BigInt(s) * i);
  if (/^0[0-7]+$/.test(s)) return I(BigInt("0o" + s.slice(1)) * i);
  if (/^0[0-9]+$/.test(s)) throw SyntaxError(`arith: ${t}: value too great for base (error token is "${t}")`);
  if (/^[0-9]+$/.test(s)) return I(BigInt(s) * i);
}
function oi(t) {
  return re(t) ?? 0n;
}
function hi(t, e) {
  let i = parseInt(t, 10);
  if (Number.isNaN(i) || i < 2 || i > 64) throw SyntaxError(`arith: ${t}: invalid arithmetic base`);
  let s = BigInt(i), r = (n) => {
    let l;
    if (n >= "0" && n <= "9") l = n.charCodeAt(0) - 48;
    else if (i <= 36) {
      let o = n.toLowerCase();
      l = o >= "a" && o <= "z" ? o.charCodeAt(0) - 97 + 10 : i;
    } else l = n >= "a" && n <= "z" ? n.charCodeAt(0) - 97 + 10 : n >= "A" && n <= "Z" ? n.charCodeAt(0) - 65 + 36 : n === "@" ? 62 : n === "_" ? 63 : i;
    if (l >= i) throw SyntaxError(`arith: ${t}#${e}: value too great for base`);
    return BigInt(l);
  }, a = 0n;
  for (let n of e) a = a * s + r(n);
  return I(a);
}
var ci = class It {
  toks;
  pos = 0;
  env;
  arr;
  suppress = 0;
  constructor(e, i, s) {
    this.toks = e, this.env = i, this.arr = s;
  }
  lazy(e) {
    this.suppress++;
    try {
      return e();
    } finally {
      this.suppress--;
    }
  }
  checkNonZero(e) {
    if (e === 0n) {
      if (this.suppress > 0) return 1n;
      throw SyntaxError("arith: division by 0");
    }
    return e;
  }
  arrayRef(e) {
    let i = e.indexOf("[");
    if (i < 0 || !e.endsWith("]")) return;
    let s = e.slice(0, i), r = e.slice(i + 1, -1);
    if (this.arr?.isAssoc?.(s)) return {
      arr: s,
      index: 0,
      key: r
    };
    let a = new It(bt(r), this.env, this.arr);
    return a.suppress = this.suppress, {
      arr: s,
      index: Number(a.parse())
    };
  }
  peek() {
    return this.toks[this.pos];
  }
  isOp(e) {
    let i = this.peek();
    return i?.t === "op" && i.v === e;
  }
  eat(e) {
    if (!this.isOp(e)) throw SyntaxError(`arith: expected '${e}'`);
    this.pos++;
  }
  read(e) {
    let i = this.arrayRef(e), s = i ? i.key === void 0 ? this.arr?.getElement(i.arr, i.index) : this.arr?.getAssocElement?.(i.arr, i.key) : this.env[e];
    if (s === void 0 || s === "") return 0n;
    let r = re(s);
    if (r !== void 0) return r;
    let a = new It(bt(s.trim()), this.env, this.arr);
    return a.suppress = this.suppress, I(a.parse());
  }
  write(e, i) {
    let s = I(i);
    if (this.suppress > 0) return s;
    let r = this.arrayRef(e);
    return r ? (r.key === void 0 ? this.arr?.setElement(r.arr, r.index, String(s)) : this.arr?.setAssocElement?.(r.arr, r.key, String(s)), s) : (this.env[e] = String(s), s);
  }
  parse() {
    let e = this.comma();
    if (this.pos < this.toks.length) throw SyntaxError("arith: trailing tokens");
    return e;
  }
  comma() {
    let e = this.assign();
    for (; this.isOp(","); ) this.pos++, e = this.assign();
    return e;
  }
  assign() {
    let e = this.pos, i = this.peek();
    if (i?.t === "name") {
      let s = this.toks[this.pos + 1];
      if (s?.t === "op" && [
        "=",
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        "**="
      ].includes(s.v)) {
        this.pos += 2;
        let r = this.assign(), a = this.read(i.v), n;
        switch (s.v) {
          case "=":
            n = r;
            break;
          case "+=":
            n = a + r;
            break;
          case "-=":
            n = a - r;
            break;
          case "*=":
            n = a * r;
            break;
          case "/=":
            n = se(a, this.checkNonZero(r));
            break;
          case "%=":
            n = a % this.checkNonZero(r);
            break;
          case "&=":
            n = a & r;
            break;
          case "|=":
            n = a | r;
            break;
          case "^=":
            n = a ^ r;
            break;
          case "<<=":
            n = a << dt(r);
            break;
          case ">>=":
            n = a >> dt(r);
            break;
          case "**=":
            n = this.powOp(a, r);
            break;
          default:
            n = r;
        }
        return this.write(i.v, n);
      }
    }
    return this.pos = e, this.ternary();
  }
  ternary() {
    let e = this.logicalOr();
    if (this.isOp("?")) {
      this.pos++;
      let i = e !== 0n, s = i ? this.assign() : this.lazy(() => this.assign());
      this.eat(":");
      let r = i ? this.lazy(() => this.assign()) : this.assign();
      return i ? s : r;
    }
    return e;
  }
  logicalOr() {
    let e = this.logicalAnd();
    for (; this.isOp("||"); ) {
      this.pos++;
      let i = e === 0n ? this.logicalAnd() : this.lazy(() => this.logicalAnd());
      e = e !== 0n || i !== 0n ? 1n : 0n;
    }
    return e;
  }
  logicalAnd() {
    let e = this.bitOr();
    for (; this.isOp("&&"); ) {
      this.pos++;
      let i = e === 0n ? this.lazy(() => this.bitOr()) : this.bitOr();
      e = e !== 0n && i !== 0n ? 1n : 0n;
    }
    return e;
  }
  bitOr() {
    let e = this.bitXor();
    for (; this.isOp("|"); ) this.pos++, e = I(e | this.bitXor());
    return e;
  }
  bitXor() {
    let e = this.bitAnd();
    for (; this.isOp("^"); ) this.pos++, e = I(e ^ this.bitAnd());
    return e;
  }
  bitAnd() {
    let e = this.equality();
    for (; this.isOp("&"); ) this.pos++, e = I(e & this.equality());
    return e;
  }
  equality() {
    let e = this.relational();
    for (; ; ) if (this.isOp("==")) this.pos++, e = e === this.relational() ? 1n : 0n;
    else if (this.isOp("!=")) this.pos++, e = e === this.relational() ? 0n : 1n;
    else break;
    return e;
  }
  relational() {
    let e = this.shift();
    for (; ; ) if (this.isOp("<=")) this.pos++, e = e <= this.shift() ? 1n : 0n;
    else if (this.isOp(">=")) this.pos++, e = e >= this.shift() ? 1n : 0n;
    else if (this.isOp("<")) this.pos++, e = e < this.shift() ? 1n : 0n;
    else if (this.isOp(">")) this.pos++, e = e > this.shift() ? 1n : 0n;
    else break;
    return e;
  }
  shift() {
    let e = this.additive();
    for (; ; ) if (this.isOp("<<")) this.pos++, e = I(e << dt(this.additive()));
    else if (this.isOp(">>")) this.pos++, e = I(e >> dt(this.additive()));
    else break;
    return e;
  }
  additive() {
    let e = this.multiplicative();
    for (; ; ) if (this.isOp("+")) this.pos++, e = I(e + this.multiplicative());
    else if (this.isOp("-")) this.pos++, e = I(e - this.multiplicative());
    else break;
    return e;
  }
  multiplicative() {
    let e = this.power();
    for (; ; ) if (this.isOp("*")) this.pos++, e = I(e * this.power());
    else if (this.isOp("/")) this.pos++, e = se(e, this.checkNonZero(this.power()));
    else if (this.isOp("%")) this.pos++, e %= this.checkNonZero(this.power());
    else break;
    return e;
  }
  power() {
    let e = this.unary();
    return this.isOp("**") ? (this.pos++, this.powOp(e, this.power())) : e;
  }
  powOp(e, i) {
    if (i < 0n) {
      if (this.suppress > 0) return 0n;
      throw SyntaxError("arith: exponent less than 0");
    }
    return di(e, i);
  }
  unary() {
    return this.isOp("+") ? (this.pos++, this.unary()) : this.isOp("-") ? (this.pos++, I(-this.unary())) : this.isOp("!") ? (this.pos++, this.unary() === 0n ? 1n : 0n) : this.isOp("~") ? (this.pos++, I(~this.unary())) : this.isOp("++") ? (this.pos++, this.prefixIncr(1n)) : this.isOp("--") ? (this.pos++, this.prefixIncr(-1n)) : this.postfix();
  }
  prefixIncr(e) {
    let i = this.peek();
    if (i?.t !== "name") throw SyntaxError("arith: ++/-- needs lvalue");
    return this.pos++, this.write(i.v, this.read(i.v) + e);
  }
  postfix() {
    let e = this.peek();
    if (e?.t === "name") {
      let i = this.toks[this.pos + 1];
      if (i?.t === "op" && (i.v === "++" || i.v === "--")) {
        this.pos += 2;
        let s = this.read(e.v);
        return this.write(e.v, s + (i.v === "++" ? 1n : -1n)), s;
      }
    }
    return this.primary();
  }
  primary() {
    let e = this.peek();
    if (!e) throw SyntaxError("arith: unexpected end");
    if (e.t === "num") return this.pos++, e.v;
    if (e.t === "name") return this.pos++, this.read(e.v);
    if (this.isOp("(")) {
      this.pos++;
      let i = this.comma();
      return this.eat(")"), i;
    }
    throw SyntaxError(`arith: unexpected '${e.v}'`);
  }
};
function se(t, e) {
  return I(t / e);
}
function di(t, e) {
  let i = 1n, s = t, r = e;
  for (; r > 0n; ) r & 1n && (i = I(i * s)), r >>= 1n, r > 0n && (s = I(s * s));
  return I(i);
}
function dt(t) {
  let e = t % 64n;
  return e < 0n ? e + 64n : e;
}
function J(t, e, i) {
  let s = bt(t);
  return s.length === 0 ? 0n : new ci(s, e, i).parse();
}

// mithic/packages/shell/dist/quote.js
var ne = /^[A-Za-z0-9_./:=@%+,-]+$/, Jt = /[\x00-\x1f\x7f]/;
function ae(t) {
  let e = {
    7: "\\a",
    8: "\\b",
    9: "\\t",
    10: "\\n",
    11: "\\v",
    12: "\\f",
    13: "\\r",
    27: "\\E"
  }, i = "$'";
  for (let s of t) {
    let r = s.codePointAt(0);
    s === "\\" ? i += "\\\\" : s === "'" ? i += "\\'" : e[r] === void 0 ? r < 32 || r === 127 ? i += "\\" + r.toString(8).padStart(3, "0") : i += s : i += e[r];
  }
  return i + "'";
}
function le(t) {
  return t === "'" ? "\\'" : "'" + t.replace(/'/g, "'\\''") + "'";
}
function ui(t) {
  return t === "" ? "''" : ne.test(t) ? t : Jt.test(t) ? ae(t) : le(t);
}
function N(t) {
  return t === "" ? "''" : Jt.test(t) ? ae(t) : le(t);
}
function oe(t) {
  return t === "" ? "''" : Jt.test(t) ? ui(t) : ne.test(t) ? t : t.replace(/[^A-Za-z0-9_./:=@%+,-]/g, (e) => "\\" + e);
}

// mithic/packages/shell/dist/escape.js
function L(t, e, i = !1) {
  let s = "", r = 0;
  for (; r < t.length; ) {
    if (t[r] !== "\\") {
      s += t[r], r++;
      continue;
    }
    let a = t[r + 1];
    switch (a) {
      case "n":
        s += `
`, r += 2;
        continue;
      case "t":
        s += "	", r += 2;
        continue;
      case "r":
        s += "\r", r += 2;
        continue;
      case "a":
        s += "\x07", r += 2;
        continue;
      case "e":
        s += "\x1B", r += 2;
        continue;
      case "b":
        s += "\b", r += 2;
        continue;
      case "f":
        s += "\f", r += 2;
        continue;
      case "v":
        s += "\v", r += 2;
        continue;
      case "\\":
        s += "\\", r += 2;
        continue;
      case '"':
        s += '"', r += 2;
        continue;
      case "'":
        if (i) {
          s += "'", r += 2;
          continue;
        }
        break;
      case "x": {
        let n = /^[0-9a-fA-F]{1,2}/.exec(t.slice(r + 2));
        if (n) {
          s += String.fromCharCode(parseInt(n[0], 16)), r += 2 + n[0].length;
          continue;
        }
        s += "\\x", r += 2;
        continue;
      }
      default:
        break;
    }
    if (e && a === "0") {
      let n = /^[0-7]{1,3}/.exec(t.slice(r + 2)), l = n ? n[0] : "";
      s += String.fromCharCode(parseInt(l || "0", 8)), r += 2 + l.length;
      continue;
    }
    if (/[0-7]/.test(a ?? "")) {
      let n = /^[0-7]{1,3}/.exec(t.slice(r + 1)), l = n ? n[0] : "0";
      s += String.fromCharCode(parseInt(l, 8)), r += 1 + l.length;
      continue;
    }
    s += "\\", r += 1;
  }
  return s;
}

// mithic/packages/shell/dist/glob.js
var pi = {
  digit: "0-9",
  alpha: "A-Za-z",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\r\\n\\f\\v",
  blank: " \\t",
  punct: "!-/:-@\\[-`{-~",
  print: " -~",
  graph: "!-~",
  cntrl: "\\x00-\\x1f\\x7f",
  xdigit: "0-9A-Fa-f"
};
function he(t) {
  return /[.*+?^${}()|[\]\\]/.test(t) ? "\\" + t : t;
}
function P(t, e = {}) {
  let i = "", s = 0;
  for (; s < t.length; ) {
    let r = t[s];
    if (r === "\\") {
      i += he(t[s + 1] ?? ""), s += 2;
      continue;
    }
    if (e.extglob && "?*+@!".includes(r) && t[s + 1] === "(") {
      let n = Ci(t, s + 2), l = "(?:" + gi(t.slice(s + 2, n)).map((o) => P(o, e)).join("|") + ")";
      if (r === "!") {
        let o = e.pathSegment === !1 ? "[\\s\\S]" : "[^/]", h = P(t.slice(n + 1), e);
        return i += "(?!" + l + h + "$)" + o + "*" + h, i;
      }
      switch (r) {
        case "?":
          i += l + "?";
          break;
        case "*":
          i += l + "*";
          break;
        case "+":
          i += l + "+";
          break;
        case "@":
          i += l;
          break;
      }
      s = n + 1;
      continue;
    }
    let a = e.pathSegment !== !1;
    if (r === "*") {
      if (t[s + 1] === "*") {
        i += ".*", s += 2;
        continue;
      }
      i += a ? "[^/]*" : ".*", s++;
      continue;
    }
    if (r === "?") {
      i += a ? "[^/]" : ".", s++;
      continue;
    }
    if (r === "[") {
      let n = fi(t, s);
      if (n) {
        i += n.re, s = n.next;
        continue;
      }
      i += "\\[", s++;
      continue;
    }
    i += he(r), s++;
  }
  return i;
}
function fi(t, e) {
  let i = e + 1, s = !1;
  (t[i] === "!" || t[i] === "^") && (s = !0, i++);
  let r = "";
  for (t[i] === "]" && (r += "\\]", i++); i < t.length && t[i] !== "]"; ) {
    if (t[i] === "[" && t[i + 1] === ":") {
      let n = t.indexOf(":]", i + 2);
      if (n >= 0) {
        let l = pi[t.slice(i + 2, n)];
        if (l !== void 0) {
          r += l, i = n + 2;
          continue;
        }
      }
    }
    let a = t[i];
    r += a === "\\" ? "\\\\" : /[\]^]/.test(a) ? "\\" + a : a, i++;
  }
  if (!(i >= t.length)) return {
    re: "[" + (s ? "^" : "") + r + "]",
    next: i + 1
  };
}
function gi(t) {
  let e = [], i = 0, s = "";
  for (let r = 0; r < t.length; r++) {
    let a = t[r];
    if (a === "\\") {
      s += a + (t[r + 1] ?? ""), r++;
      continue;
    }
    if (a === "(" ? i++ : a === ")" && i--, a === "|" && i === 0) {
      e.push(s), s = "";
      continue;
    }
    s += a;
  }
  return e.push(s), e;
}
function Ci(t, e) {
  let i = 1, s = e;
  for (; s < t.length; ) {
    if (t[s] === "\\") {
      s += 2;
      continue;
    }
    if (t[s] === "(") i++;
    else if (t[s] === ")" && (i--, i === 0)) return s;
    s++;
  }
  return t.length;
}
function At(t, e = {}) {
  return RegExp("^" + P(t, e) + "$", e.nocase ? "si" : "s");
}
function ut(t, e, i = {}) {
  try {
    return At(e, i).test(t);
  } catch {
    return t === e;
  }
}
function Qt(t, e = !1) {
  return !!(/[*?[]/.test(t) || e && /[?*+@!]\(/.test(t));
}

// mithic/packages/shell/dist/expander.js
var X = class extends Error {
}, j = class {
  env;
  constructor(t) {
    this.env = t;
  }
  async expandWord(t) {
    let e = this.env.posix?.() ? [t] : tt(t), i = [], s = !1, r = !1;
    for (let a of e) {
      let n = this.tildeExpand(a), { parts: l, emptiedByAt: o } = await this.substitute(n);
      if (o && l.length === 0) {
        s = !0;
        continue;
      }
      let h = Ai(l, Wt(this.env.get("IFS")));
      for (let d of h) {
        if (d.quoted) {
          i.push(d.text);
          continue;
        }
        let p = await this.maybeGlob(d.text);
        p.nullglobbed && (r = !0), i.push(...p.fields);
      }
    }
    return i.length > 0 ? i : s || r ? [] : [""];
  }
  async substituteOnly(t) {
    let { parts: e } = await this.substitute(t);
    return fe(e);
  }
  async expandToString(t) {
    let e = tt(t), i = [];
    for (let s of e) {
      let { parts: r } = await this.substitute(this.tildeExpand(s));
      i.push(fe(r));
    }
    return i.join(" ");
  }
  async expandRegexOperand(t) {
    let e = (a) => a.replace(/[.*+?^${}()|[\]\\]/g, (n) => "\\" + n), i = t.length, s = "", r = 0;
    for (; r < i; ) {
      let a = t[r];
      if (a === "\\") {
        let n = t[r + 1];
        if (n === void 0) {
          s += "\\", r += 1;
          continue;
        }
        s += ".*+?^${}()|[]\\".includes(n) ? "\\" + n : n, r += 2;
        continue;
      }
      if (a === "'") {
        r++;
        let n = "";
        for (; r < i && t[r] !== "'"; ) n += t[r], r++;
        r++, s += e(n);
        continue;
      }
      if (a === '"') {
        r++;
        let n = "";
        for (; r < i && t[r] !== '"'; ) {
          if (t[r] === "\\") {
            let l = t[r + 1] ?? "";
            if (l === '"' || l === "\\" || l === "$" || l === "`") {
              n += l, r += 2;
              continue;
            }
            n += "\\", r++;
            continue;
          }
          if (t[r] === "$") {
            let l = await this.readDollar(t, r);
            n += l.value ?? "", r = l.next;
            continue;
          }
          if (t[r] === "`") {
            let l = await this.readBacktick(t, r);
            n += l.value, r = l.next;
            continue;
          }
          n += t[r], r++;
        }
        r++, s += e(n);
        continue;
      }
      if (a === "$") {
        let n = await this.readDollar(t, r);
        s += n.value ?? "", r = n.next;
        continue;
      }
      if (a === "`") {
        let n = await this.readBacktick(t, r);
        s += n.value, r = n.next;
        continue;
      }
      s += a, r++;
    }
    return s;
  }
  tildeExpand(t) {
    if (t[0] !== "~") return t;
    let e = t.slice(1);
    if (e === "" || e[0] === "/") {
      let i = this.env.get("HOME");
      return i === void 0 || i === "" ? t : i + e;
    }
    return t;
  }
  async substitute(t) {
    let e = [], i = "", s = !1, r = !1, a = !1, n = !1, l = () => {
      s && e.push({
        text: i,
        quoted: r
      }), i = "", s = !1, r = !1;
    }, o = (c, u) => {
      i += c, s = !0, n = !0, u && (r = !0);
    }, h = (c, u, f) => {
      if (u !== void 0) {
        o(c.join(u), f);
        return;
      }
      if (c.length === 0) {
        a = !0;
        return;
      }
      n = !0, o(c[0], f);
      for (let g = 1; g < c.length; g++) l(), e.push({ fieldBreak: !0 }), o(c[g], f);
    }, d = 0, p = t.length;
    for (; d < p; ) {
      let c = t[d];
      if (c === "\\") {
        if (t[d + 1] === `
`) {
          d += 2;
          continue;
        }
        o(t[d + 1] ?? "", !0), d += t[d + 1] === void 0 ? 1 : 2;
        continue;
      }
      if (c === "'") {
        d++;
        let u = "";
        for (; d < p && t[d] !== "'"; ) u += t[d], d++;
        d++, o(u, !0);
        continue;
      }
      if (c === '"') {
        d++;
        let u = !1, f = !1;
        for (; d < p && t[d] !== '"'; ) {
          if (t[d] === "\\") {
            let g = t[d + 1] ?? "";
            if (g === `
`) {
              d += 2;
              continue;
            }
            if (g === '"' || g === "\\" || g === "$" || g === "`") {
              o(g, !0), u = !0, d += 2;
              continue;
            }
            o("\\", !0), u = !0, d++;
            continue;
          }
          if (t[d] === "$") {
            let g = await this.readDollar(t, d);
            g.fields === void 0 ? (o(g.value, !0), u = !0) : (h(g.fields, g.join, !0), g.join === void 0 && g.fields.length === 0 ? f = !0 : u = !0), d = g.next;
            continue;
          }
          if (t[d] === "`") {
            let g = await this.readBacktick(t, d);
            o(g.value, !0), u = !0, d = g.next;
            continue;
          }
          o(t[d], !0), u = !0, d++;
        }
        d++, (!f || u) && (s = !0, r = !0);
        continue;
      }
      if (c === "$" && t[d + 1] === "'") {
        let u = d + 2, f = "";
        for (; u < p && t[u] !== "'"; ) {
          if (t[u] === "\\" && u + 1 < p) {
            f += t[u] + t[u + 1], u += 2;
            continue;
          }
          f += t[u], u++;
        }
        o(L(f, !1, !0), !0), d = u + 1;
        continue;
      }
      if (c === "$" && t[d + 1] === '"') {
        d++;
        continue;
      }
      if (c === "$") {
        let u = await this.readDollar(t, d);
        u.fields === void 0 ? o(u.value, !1) : h(u.fields, u.join, !1), d = u.next;
        continue;
      }
      if (c === "`") {
        let u = await this.readBacktick(t, d);
        o(u.value, !1), d = u.next;
        continue;
      }
      if ((c === "<" || c === ">") && t[d + 1] === "(") {
        if (this.env.posix?.()) throw new X("syntax error: process substitution is not supported in POSIX mode");
        if (this.env.procSub) {
          let u = Nt(t, d + 2), f = t.slice(d + 2, u);
          o(await this.env.procSub(f, c === "<" ? "in" : "out"), !1), d = u + 1;
          continue;
        }
      }
      o(c, !1), d++;
    }
    return l(), e.length === 0 ? a && !n ? {
      parts: [],
      emptiedByAt: !0
    } : {
      parts: [{
        text: "",
        quoted: !1
      }],
      emptiedByAt: !1
    } : {
      parts: e,
      emptiedByAt: !1
    };
  }
  positionalFallback() {
    let t = parseInt(this.env.getSpecial("#") ?? "0", 10) || 0, e = [];
    for (let i = 1; i <= t; i++) e.push(this.env.getSpecial(String(i)) ?? "");
    return e;
  }
  ifsFirst() {
    let t = this.env.get("IFS");
    return t === void 0 ? " " : t.length > 0 ? t[0] : "";
  }
  async readDollar(t, e) {
    let i = t.length, s = t[e + 1];
    if (s === "(" && t[e + 2] === "(") {
      let l = ge(t, e + 3), o = t.slice(e + 3, l), h = await this.expandSubExpr(o), d = this.arithEnvProxy(), p;
      try {
        p = J(h, d, this.arithArrayAccess());
      } catch (c) {
        throw new X(c.message);
      }
      return {
        value: String(p),
        next: l + 2
      };
    }
    if (s === "(") {
      let l = Nt(t, e + 2), o = t.slice(e + 2, l);
      return {
        value: ue(await this.env.runCommandSub(o)),
        next: l + 1
      };
    }
    if (s === "{") {
      let l = Ce(t, e + 2), o = t.slice(e + 2, l), h = await this.paramExpansion(o);
      return typeof h == "string" ? {
        value: h,
        next: l + 1
      } : {
        fields: h.fields,
        join: h.join,
        next: l + 1
      };
    }
    if (s === "@" || s === "*") return {
      fields: this.env.getPositional?.() ?? this.positionalFallback(),
      join: s === "*" ? this.ifsFirst() : void 0,
      next: e + 2
    };
    if (s !== void 0 && "?#$!0-".includes(s) || s !== void 0 && /[1-9]/.test(s)) return {
      value: this.env.getSpecial(s) ?? "",
      next: e + 2
    };
    let r = e + 1, a = "";
    for (; r < i && /[A-Za-z0-9_]/.test(t[r]) && !(a === "" && /[0-9]/.test(t[r])); ) a += t[r], r++;
    if (a === "") return {
      value: "$",
      next: e + 1
    };
    let n = this.env.getArray?.(a);
    return n === void 0 ? {
      value: this.resolveVarStrict(a),
      next: r
    } : {
      value: n[0] ?? "",
      next: r
    };
  }
  async readBacktick(t, e) {
    let i = t.length, s = e + 1, r = "";
    for (; s < i && t[s] !== "`"; ) {
      if (t[s] === "\\" && (t[s + 1] === "`" || t[s + 1] === "\\" || t[s + 1] === "$")) {
        r += t[s + 1], s += 2;
        continue;
      }
      r += t[s], s++;
    }
    return {
      value: ue(await this.env.runCommandSub(r)),
      next: s + 1
    };
  }
  async expandSubExpr(t) {
    let e = "", i = 0;
    for (; i < t.length; ) {
      if (t[i] === "$") {
        let s = await this.readDollar(t, i);
        e += s.fields === void 0 ? s.value : s.fields.join(s.join ?? " "), i = s.next;
        continue;
      }
      e += t[i], i++;
    }
    return e;
  }
  arithEnvProxy() {
    let t = this.env;
    return new Proxy({}, {
      get: (e, i) => t.get(i) ?? t.getArray?.(i)?.[0] ?? "",
      set: (e, i, s) => t.isReadonly?.(i) ? (t.warn?.(`${i}: readonly variable`), !0) : (t.set(i, String(s)), !0),
      has: (e, i) => t.has(i) || this.env.getArray?.(i) !== void 0
    });
  }
  arithArrayAccess() {
    let t = this.env;
    if (!(!t.getArray || !t.setArrayElement)) return {
      getElement: (e, i) => {
        let s = t.getArray(e);
        if (s) return s[i < 0 ? s.length + i : i];
      },
      setElement: (e, i, s) => {
        if (t.isReadonly?.(e)) {
          t.warn?.(`${e}: readonly variable`);
          return;
        }
        t.setArrayElement(e, i, s);
      },
      isAssoc: (e) => t.getAssoc?.(e) !== void 0,
      getAssocElement: (e, i) => t.getAssoc?.(e)?.get(i),
      setAssocElement: (e, i, s) => {
        t.getAssoc?.(e)?.set(i, s);
      }
    };
  }
  defaultAssign(t, e) {
    return this.env.isReadonly?.(t) ? (this.env.warn?.(`${t}: readonly variable`), e) : (this.env.set(t, e), e);
  }
  resolveVar(t) {
    let e = this.env.get(t);
    return e === void 0 ? this.env.getSpecial(t) ?? "" : e;
  }
  declareStatement(t, e, i) {
    let s = this.env.getArray?.(t), r = this.env.getAssoc?.(t), a = this.env.attrFlags?.(t) ?? "";
    if (a.includes("n")) {
      let l = this.env.resolveNameref?.(t);
      return l !== void 0 && l !== t ? this.declareStatement(l, !0, this.resolveVar(l)) : `declare -n ${t}=${l ?? i}`;
    }
    if (!e && s === void 0 && r === void 0) return "";
    let n = "";
    if (r !== void 0 || a.includes("A") ? n += "A" : (s !== void 0 || a.includes("a")) && (n += "a"), a.includes("i") && (n += "i"), a.includes("r") && (n += "r"), a.includes("x") && (n += "x"), r !== void 0) {
      let l = [...r.entries()].map(([o, h]) => `[${pe(o)}]=${Zt(h)}`).join(" ");
      return `declare -${n} ${t}=(${l}${l === "" ? "" : " "})`;
    }
    if (s !== void 0) {
      let l = pt(s).map((o) => `[${o}]=${Zt(s[o])}`).join(" ");
      return `declare -${n} ${t}=(${l})`;
    }
    return n === "" ? `${t}=${N(i)}` : `declare -${n} ${t}=${N(i)}`;
  }
  keyValuePairs(t, e, i) {
    let s = this.env.getAssoc?.(t), r = this.env.getArray?.(t), a;
    if (s !== void 0) a = [...s.entries()];
    else if (r !== void 0) a = Gt(r).map((l, o) => [String(pt(r)[o]), l]);
    else return e;
    if (i) {
      let l = a.map(([o, h]) => `${pe(o)} ${Zt(h)}`).join(" ");
      return s !== void 0 && l !== "" ? l + " " : l;
    }
    let n = [];
    for (let [l, o] of a) n.push(l, o);
    return {
      fields: n,
      join: void 0
    };
  }
  wholeArrayTransform(t, e, i) {
    if (e.length !== 2 || e[0] !== "@") return;
    let s = e[1];
    if (s === "A") return this.declareStatement(t, !0, this.resolveVar(t));
    if (s === "K" || s === "k") return this.keyValuePairs(t, this.resolveVar(t), s === "K");
    let r = this.env.getAssoc?.(t), a = this.env.getArray?.(t), n = r === void 0 ? a === void 0 ? this.env.has(t) ? [this.resolveVar(t)] : [] : Gt(a) : [...r.values()], l = (h) => {
      switch (s) {
        case "Q":
          return N(h);
        case "U":
          return h.toUpperCase();
        case "u":
          return h.length > 0 ? h[0].toUpperCase() + h.slice(1) : h;
        case "L":
          return h.toLowerCase();
        case "E":
          return L(h, !1, !0);
        case "a":
          return this.env.attrFlags?.(t) ?? "";
        case "P":
          return ht(h, {
            cwd: this.env.cwd ?? "",
            env: this.promptEnv()
          });
        default:
          return;
      }
    }, o = [];
    for (let h of n) {
      let d = l(h);
      if (d === void 0) return;
      o.push(d);
    }
    return {
      fields: o,
      join: i ? this.ifsFirst() : void 0
    };
  }
  async applyOpToEach(t, e) {
    if (e === "" || e[0] === ":") return;
    let i = [];
    for (let s of t) i.push(await this.applyValueOp(s, !0, e, "element"));
    return i;
  }
  elementTransform(t, e, i, s) {
    if (!(i.length !== 2 || i[0] !== "@")) switch (i[1]) {
      case "a":
        return this.env.attrFlags?.(t) ?? "";
      case "A": {
        let r = this.env.attrFlags?.(t) ?? "", a = "";
        r.includes("A") ? a += "A" : r.includes("a") && (a += "a"), r.includes("i") && (a += "i"), r.includes("r") && (a += "r"), r.includes("x") && (a += "x");
        let n = a === "" ? "" : `declare -${a} `;
        return s ? `${n}${t}=${N(e)}` : a === "" ? `${n}${t}=''` : `declare -${a} ${t}`;
      }
      case "P":
        return ht(e, {
          cwd: this.env.cwd ?? "",
          env: this.promptEnv()
        });
      case "K":
      case "k":
        return s ? N(e) : "";
      default:
        return;
    }
  }
  promptEnv() {
    let t = {};
    for (let e of [
      "USER",
      "HOSTNAME",
      "HOME",
      "PWD"
    ]) {
      let i = this.env.get(e);
      i !== void 0 && (t[e] = i);
    }
    return t;
  }
  resolveVarStrict(t) {
    let e = this.env.get(t);
    if (e !== void 0) return e;
    let i = this.env.getSpecial(t);
    if (i !== void 0) return i;
    if (this.env.nounset?.()) throw new X(`${t}: unbound variable`);
    return "";
  }
  async resolveIndex(t) {
    let e = t.trim();
    return /^-?\d+$/.test(e) ? parseInt(e, 10) : this.evalArithSpec(e);
  }
  async evalArithSpec(t) {
    let e = t.trim();
    if (e === "") return 0;
    try {
      let i = await this.expandSubExpr(e), s = Number(J(i, this.arithEnvProxy(), this.arithArrayAccess()));
      return Number.isFinite(s) ? Math.trunc(s) : 0;
    } catch {
      return 0;
    }
  }
  async sliceArray(t, e) {
    let i = ce(e), s = i >= 0 ? e.slice(0, i) : e, r = await this.evalArithSpec(s);
    if (r < 0 && (r = t.length + r), r < 0 && (r = 0), i < 0) return t.slice(r);
    let a = await this.evalArithSpec(e.slice(i + 1));
    return a < 0 ? t.slice(r, t.length + a) : t.slice(r, r + a);
  }
  async paramExpansion(t) {
    if (t.startsWith("#") && t.length > 1) {
      let d = t.slice(1);
      if (d === "@" || d === "*") {
        let c = this.env.getPositional?.() ?? this.positionalFallback();
        return String(c.length);
      }
      let p = de(d);
      if (p) {
        let c = this.env.getAssoc?.(p.name);
        if (c !== void 0) {
          if (p.subscript === "@" || p.subscript === "*") return String(c.size);
          let g = await this.substituteOnly(p.subscript);
          return String((c.get(g) ?? "").length);
        }
        let u = this.env.getArray?.(p.name);
        if (u !== void 0) {
          if (p.subscript === "@" || p.subscript === "*") return String(pt(u).length);
          let g = await this.resolveIndex(p.subscript);
          return String((u[g] ?? "").length);
        }
        if (p.subscript === "@" || p.subscript === "*") return String(+!!this.env.has(p.name));
        let f = await this.resolveIndex(p.subscript);
        return String(f === 0 || f === -1 ? this.resolveVar(p.name).length : 0);
      }
      return String(this.resolveVar(d).length);
    }
    if (t.startsWith("!") && t.length > 1) {
      let d = t.slice(1), p = de(d);
      if (p && (p.subscript === "@" || p.subscript === "*")) {
        let u = this.env.getAssoc?.(p.name);
        return u === void 0 ? {
          fields: pt(this.env.getArray?.(p.name) ?? []).map(String),
          join: p.subscript === "*" ? this.ifsFirst() : void 0
        } : {
          fields: [...u.keys()],
          join: p.subscript === "*" ? this.ifsFirst() : void 0
        };
      }
      if ((d.endsWith("*") || d.endsWith("@")) && /^[A-Za-z_][A-Za-z0-9_]*[*@]$/.test(d)) {
        let u = d.slice(0, -1);
        return {
          fields: (this.env.names?.() ?? []).filter((f) => f.startsWith(u)).sort(),
          join: d.endsWith("*") ? this.ifsFirst() : void 0
        };
      }
      let c = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/s.exec(d);
      if (c) {
        let u = this.resolveVar(c[1]), f = c[2];
        return u === "" ? "" : this.paramExpansion(u + f);
      }
    }
    if (t === "@" || t === "*" || t.startsWith("@:") || t.startsWith("*:")) {
      let d = t[0] === "*", p = this.env.getPositional?.() ?? this.positionalFallback();
      if (t.length === 1) return {
        fields: p,
        join: d ? this.ifsFirst() : void 0
      };
      let c = [this.env.getSpecial("0") ?? "", ...p];
      return {
        fields: await this.sliceArray(c, t.slice(2)),
        join: d ? this.ifsFirst() : void 0
      };
    }
    let e = mi(t);
    if (e && this.env.getAssoc?.(e.name) !== void 0) {
      let d = this.env.getAssoc(e.name);
      if (e.subscript === "@" || e.subscript === "*") {
        let u = e.op === void 0 ? void 0 : this.wholeArrayTransform(e.name, e.op, e.subscript === "*");
        if (u !== void 0) return u;
        let f = [...d.values()];
        return {
          fields: (e.op === void 0 ? void 0 : await this.applyOpToEach(f, e.op)) ?? (e.op === void 0 ? f : await this.sliceArray(f, Bt(e.op))),
          join: e.subscript === "*" ? this.ifsFirst() : void 0
        };
      }
      let p = await this.substituteOnly(e.subscript), c = d.get(p) ?? "";
      if (e.op !== void 0) {
        let u = this.elementTransform(e.name, c, e.op, d.has(p));
        return u === void 0 ? this.applyValueOp(c, d.has(p), e.op, `${e.name}[${p}]`, (f) => (d.set(p, f), f)) : u;
      }
      return c;
    }
    if (e && this.env.getArray?.(e.name) !== void 0) {
      let d = this.env.getArray(e.name);
      if (e.subscript === "@" || e.subscript === "*") {
        let u = e.op === void 0 ? void 0 : this.wholeArrayTransform(e.name, e.op, e.subscript === "*");
        if (u !== void 0) return u;
        let f = Gt(d);
        return {
          fields: (e.op === void 0 ? void 0 : await this.applyOpToEach(f, e.op)) ?? (e.op === void 0 ? f : await this.sliceArray(f, Bt(e.op))),
          join: e.subscript === "*" ? this.ifsFirst() : void 0
        };
      }
      let p = await this.resolveIndex(e.subscript);
      p < 0 && (p = d.length + p);
      let c = d[p] ?? "";
      if (e.op !== void 0) {
        let u = p >= 0 && p < d.length && d[p] !== void 0, f = this.elementTransform(e.name, c, e.op, u);
        return f === void 0 ? this.applyValueOp(c, u, e.op, `${e.name}[${p}]`, (g) => (this.env.setArrayElement?.(e.name, p, g), g)) : f;
      }
      return c;
    }
    if (e && e.name !== "" && this.env.has(e.name) && this.env.getArray?.(e.name) === void 0 && this.env.getAssoc?.(e.name) === void 0) {
      let d = this.resolveVar(e.name);
      if (e.subscript === "@" || e.subscript === "*") {
        let f = e.op === void 0 ? void 0 : this.wholeArrayTransform(e.name, e.op, e.subscript === "*");
        return f === void 0 ? {
          fields: e.op === void 0 ? [d] : await this.sliceArray([d], Bt(e.op)),
          join: e.subscript === "*" ? this.ifsFirst() : void 0
        } : f;
      }
      let p = await this.resolveIndex(e.subscript), c = p === 0, u = c ? d : "";
      if (e.op !== void 0) {
        let f = this.elementTransform(e.name, u, e.op, c);
        return f === void 0 ? this.applyValueOp(u, c, e.op, `${e.name}[${p}]`, (g) => (c && this.env.set(e.name, g), g)) : f;
      }
      return u;
    }
    let i = t.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?#$!])(.*)$/s);
    if (!i) return this.resolveVar(t);
    let s = i[1], r = i[2];
    if (r === "") {
      let d = this.env.getArray?.(s);
      return d === void 0 ? this.resolveVarStrict(s) : d[0] ?? "";
    }
    let a = this.env.getArray?.(s), n = this.env.getAssoc?.(s), l = a !== void 0 || n !== void 0, o = l ? n === void 0 ? a[0] !== void 0 : n.has("0") : this.env.has(s) || this.env.getSpecial(s) !== void 0, h = l ? n === void 0 ? a[0] ?? "" : n.get("0") ?? "" : this.resolveVar(s);
    if (r[0] === "@") {
      let d = r[1];
      if (l) {
        let p = n === void 0 ? a[0] !== void 0 : n.has("0"), c = this.elementTransform(s, h, r, p);
        if (c !== void 0) return c;
      }
      return d === "Q" ? o ? N(h) : "" : d === "U" ? h.toUpperCase() : d === "u" ? h.length > 0 ? h[0].toUpperCase() + h.slice(1) : h : d === "L" ? h.toLowerCase() : d === "E" ? L(h, !1, !0) : d === "a" ? this.env.attrFlags?.(s) ?? "" : d === "A" ? this.declareStatement(s, o, h) : d === "P" ? ht(h, {
        cwd: this.env.cwd ?? "",
        env: this.promptEnv()
      }) : d === "K" || d === "k" ? this.keyValuePairs(s, h, d === "K") : h;
    }
    return this.applyValueOp(h, o, r, s);
  }
  async applyValueOp(t, e, i, s, r) {
    let a = r ?? ((n) => this.defaultAssign(s, n));
    if (i[0] === "@") {
      let n = i[1];
      return n === "Q" ? e ? N(t) : "" : n === "U" ? t.toUpperCase() : n === "u" ? t.length > 0 ? t[0].toUpperCase() + t.slice(1) : t : n === "L" ? t.toLowerCase() : n === "E" ? L(t, !1, !0) : t;
    }
    if (i[0] === ":" && "-=?+".includes(i[1] ?? "")) {
      let n = i[1], l = await this.expandToString(i.slice(2)), o = !e || t === "";
      switch (n) {
        case "-":
          return o ? l : t;
        case "+":
          return o ? "" : l;
        case "=":
          return o ? a(l) : t;
        case "?":
          if (o) throw new X(l || `${s}: parameter null or not set`);
          return t;
      }
    }
    if ("-=?+".includes(i[0])) {
      let n = i[0], l = await this.expandToString(i.slice(1));
      switch (n) {
        case "-":
          return e ? t : l;
        case "+":
          return e ? l : "";
        case "=":
          return e ? t : a(l);
        case "?":
          if (!e) throw new X(l || `${s}: parameter not set`);
          return t;
      }
    }
    if (i[0] === "#") {
      let n = i[1] === "#";
      return bi(t, await this.expandToString(i.slice(n ? 2 : 1)), n, this.globOpts());
    }
    if (i[0] === "%") {
      let n = i[1] === "%";
      return Ii(t, await this.expandToString(i.slice(n ? 2 : 1)), n, this.globOpts());
    }
    if (i[0] === "/") {
      let n = i[1] === "/", l = i.slice(n ? 2 : 1), o = "none";
      l[0] === "#" ? (o = "start", l = l.slice(1)) : l[0] === "%" && (o = "end", l = l.slice(1));
      let h = Si(l, "/");
      return Ji(t, await this.expandToString(h >= 0 ? l.slice(0, h) : l), h >= 0 ? await this.expandToString(l.slice(h + 1)) : "", n, o, this.globOpts());
    }
    if (i[0] === "^" || i[0] === ",") {
      let n = i[0] === "^", l = i[1] === i[0], o = i.slice(l ? 2 : 1), h = o === "" ? "?" : await this.expandToString(o), d = RegExp("^" + P(h, this.globOpts()) + "$"), p = (c) => d.test(c) ? n ? c.toUpperCase() : c.toLowerCase() : c;
      return l ? t.split("").map(p).join("") : t.length === 0 ? t : p(t[0]) + t.slice(1);
    }
    if (i[0] === "~") {
      let n = i[1] === "~", l = i.slice(n ? 2 : 1), o = l === "" ? "?" : await this.expandToString(l), h = RegExp("^" + P(o, this.globOpts()) + "$"), d = (p) => {
        if (!h.test(p)) return p;
        let c = p.toUpperCase();
        return p === c ? p.toLowerCase() : c;
      };
      return n ? t.split("").map(d).join("") : t.length === 0 ? t : d(t[0]) + t.slice(1);
    }
    if (i[0] === ":") {
      let n = i.slice(1), l = ce(n), o = l >= 0 ? n.slice(0, l) : n, h = l >= 0 ? n.slice(l + 1) : void 0, d = await this.evalArithSpec(o);
      if (d < 0 && (d = t.length + d, d < 0)) return "";
      if (h === void 0) return t.slice(d);
      let p = await this.evalArithSpec(h);
      return p < 0 ? t.slice(d, t.length + p) : t.slice(d, d + p);
    }
    return t;
  }
  globOpts() {
    return {
      extglob: this.env.shopt?.("extglob") ?? !1,
      nocase: this.env.shopt?.("nocaseglob") ?? !1,
      pathSegment: !1
    };
  }
  pathGlobOpts() {
    return {
      extglob: this.env.shopt?.("extglob") ?? !1,
      nocase: this.env.shopt?.("nocaseglob") ?? !1,
      pathSegment: !0
    };
  }
  async maybeGlob(t) {
    let e = this.env.shopt?.("extglob") ?? !1, i = this.env.shopt?.("globstar") ?? !1;
    if (!Qt(t, e)) return { fields: [t] };
    let s = await this.globPath(t, i);
    return s.length > 0 ? { fields: s } : this.env.shopt?.("nullglob") ? {
      fields: [],
      nullglobbed: !0
    } : { fields: [t] };
  }
  async globPath(t, e) {
    let i = t.startsWith("/"), s = i ? "/" : this.env.cwd ?? ".", r = t.split("/").filter((n, l) => !(l === 0 && n === "")), a = await this.globSegments(s, r, e);
    return a.sort(), a.map((n) => {
      if (i) return n;
      let l = s === "." ? "" : s.replace(/\/$/, "") + "/";
      return n.startsWith(l) ? n.slice(l.length) : n;
    });
  }
  async globSegments(t, e, i) {
    if (e.length === 0) return [t];
    let [s, ...r] = e;
    if (s === "") return this.globSegments(t, r, i);
    let a = this.pathGlobOpts(), n = this.env.shopt?.("dotglob") ?? !1;
    if (i && s === "**") {
      let p = [...await this.globSegments(t, r, i)], c = await this.env.listDir(t);
      for (let u of c ?? []) {
        if (u.startsWith(".") && !n) continue;
        let f = Rt(t, u);
        await this.isDir(f) && p.push(...await this.globSegments(f, e, i));
      }
      return p;
    }
    if (!Qt(s, a.extglob)) {
      let p = Rt(t, s);
      return this.globSegments(p, r, i);
    }
    let l = await this.env.listDir(t);
    if (!l) return [];
    let o = At(s, a), h = l.filter((p) => o.test(p) && !(p.startsWith(".") && !s.startsWith(".") && !n)), d = [];
    for (let p of h) {
      let c = Rt(t, p);
      r.length === 0 ? d.push(c) : d.push(...await this.globSegments(c, r, i));
    }
    return d;
  }
  async isDir(t) {
    return (await this.env.statPath?.(t))?.dir ?? !1;
  }
};
function ce(t) {
  let e = 0;
  for (let i = 0; i < t.length; i++) {
    let s = t[i];
    if (s === "(") e++;
    else if (s === ")") e--;
    else if (s === ":" && e === 0) return i;
  }
  return -1;
}
function de(t) {
  let e = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s.exec(t);
  if (e) return {
    name: e[1],
    subscript: e[2]
  };
}
function Bt(t) {
  return t[0] === ":" ? t.slice(1) : t;
}
function Gt(t) {
  return t.filter((e, i) => i in t);
}
function pt(t) {
  let e = [];
  for (let i = 0; i < t.length; i++) i in t && e.push(i);
  return e;
}
function mi(t) {
  let e = /^([A-Za-z_][A-Za-z0-9_]*)\[/.exec(t);
  if (!e) return;
  let i = e[1], s = e[0].length, r = 1, a = s;
  for (; s < t.length && r > 0; s++) if (t[s] === "[") r++;
  else if (t[s] === "]" && (r--, r === 0)) break;
  if (r !== 0) return;
  let n = t.slice(a, s), l = t.slice(s + 1);
  return {
    name: i,
    subscript: n,
    op: l === "" ? void 0 : l
  };
}
function Rt(t, e) {
  return t === "." || t === "" ? e : t.replace(/\/$/, "") + "/" + e;
}
function tt(t) {
  let e = yi(t);
  if (!e) return [t];
  let { pre: i, body: s, post: r, isRange: a } = e, n;
  if (a) {
    if (n = wi(s), n === null) return tt(i + "{" + s + "}" + r).map((h) => h);
  } else n = vi(s);
  let l = tt(r), o = [];
  for (let h of n) for (let d of tt(h)) for (let p of l) o.push(i + d + p);
  return o;
}
function Et(t, e) {
  if (t[e] !== "$") return e + 1;
  let i = t[e + 1];
  return i === "{" ? Ce(t, e + 2) + 1 : i === "(" ? t[e + 2] === "(" ? ge(t, e + 3) + 2 : Nt(t, e + 2) + 1 : e + 1;
}
function yi(t) {
  let e = 0, i = t.length;
  for (; e < i; ) {
    let s = t[e];
    if (s === "\\") {
      e += 2;
      continue;
    }
    if (s === "$" && (t[e + 1] === "{" || t[e + 1] === "(")) {
      e = Et(t, e);
      continue;
    }
    if (s === "'" || s === '"') {
      let r = s;
      for (e++; e < i && t[e] !== r; ) t[e] === "\\" && e++, e++;
      e++;
      continue;
    }
    if (s === "{") {
      let r = 1, a = e + 1, n = !1, l = !1, o = a;
      for (; a < i && r > 0; ) {
        let h = t[a];
        if (h === "\\") {
          a += 2;
          continue;
        }
        if (h === "$" && (t[a + 1] === "{" || t[a + 1] === "(")) {
          a = Et(t, a);
          continue;
        }
        if (h === "'" || h === '"') {
          let d = h;
          for (a++; a < i && t[a] !== d; ) t[a] === "\\" && a++, a++;
          a++;
          continue;
        }
        if (h === "{") r++;
        else if (h === "}") {
          if (r--, r === 0) break;
        } else h === "," && r === 1 ? n = !0 : h === "." && t[a + 1] === "." && r === 1 && (l = !0);
        a++;
      }
      if (r === 0) {
        let h = t.slice(o, a);
        if (n) return {
          pre: t.slice(0, e),
          body: h,
          post: t.slice(a + 1),
          isRange: !1
        };
        if (l && /^[^,]*\.\.[^,]*$/.test(h)) return {
          pre: t.slice(0, e),
          body: h,
          post: t.slice(a + 1),
          isRange: !0
        };
        e = a + 1;
        continue;
      }
    }
    e++;
  }
}
function vi(t) {
  let e = [], i = 0, s = "", r = 0;
  for (; r < t.length; ) {
    let a = t[r];
    if (a === "\\") {
      s += a + (t[r + 1] ?? ""), r += 2;
      continue;
    }
    if (a === "$" && (t[r + 1] === "{" || t[r + 1] === "(")) {
      let n = Et(t, r);
      s += t.slice(r, n), r = n;
      continue;
    }
    if (a === "{" && i++, a === "}" && i--, a === "," && i === 0) {
      e.push(s), s = "", r++;
      continue;
    }
    s += a, r++;
  }
  return e.push(s), e;
}
function wi(t) {
  let e = t.split("..");
  if (e.length < 2 || e.length > 3) return null;
  let [i, s, r] = e, a = r === void 0 ? 1 : Math.abs(parseInt(r, 10)) || 1;
  if (/^-?\d+$/.test(i) && /^-?\d+$/.test(s)) {
    let n = parseInt(i, 10), l = parseInt(s, 10), o = /^-?0\d/.test(i) || /^-?0\d/.test(s), h = Math.max(i.length, s.length), d = (c) => {
      if (!o) return String(c);
      let u = c < 0, f = Math.abs(c).toString().padStart(u ? h - 1 : h, "0");
      return u ? "-" + f : f;
    }, p = [];
    if (n <= l) for (let c = n; c <= l; c += a) p.push(d(c));
    else for (let c = n; c >= l; c -= a) p.push(d(c));
    return p;
  }
  if (/^[A-Za-z]$/.test(i) && /^[A-Za-z]$/.test(s)) {
    let n = i.charCodeAt(0), l = s.charCodeAt(0), o = [];
    if (n <= l) for (let h = n; h <= l; h += a) o.push(String.fromCharCode(h));
    else for (let h = n; h >= l; h -= a) o.push(String.fromCharCode(h));
    return o;
  }
  return null;
}
function Nt(t, e) {
  let i = 1, s = e;
  for (; s < t.length; ) {
    if (t[s] === "\\") {
      s += 2;
      continue;
    }
    if (t[s] === "(") i++;
    else if (t[s] === ")" && (i--, i === 0)) return s;
    s++;
  }
  return t.length;
}
function ge(t, e) {
  let i = 0, s = e;
  for (; s < t.length; ) {
    if (t[s] === "(") i++;
    else if (t[s] === ")") {
      if (i === 0 && t[s + 1] === ")") return s;
      i--;
    }
    s++;
  }
  return t.length;
}
function Ce(t, e) {
  let i = 1, s = e;
  for (; s < t.length; ) {
    if (t[s] === "\\") {
      s += 2;
      continue;
    }
    if (t[s] === "{") i++;
    else if (t[s] === "}" && (i--, i === 0)) return s;
    s++;
  }
  return t.length;
}
function Si(t, e) {
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") {
      i++;
      continue;
    }
    if (t[i] === e) return i;
  }
  return -1;
}
function ue(t) {
  return t.replace(/\n+$/, "");
}
function me(t) {
  return t.replace(/[\\"$`]/g, (e) => "\\" + e);
}
var ki = /[\x00-\x1f\x7f]/;
function Zt(t) {
  return ki.test(t) ? N(t) : `"${me(t)}"`;
}
var xi = /^[A-Za-z0-9_./:=@%+,-]+$/;
function pe(t) {
  return xi.test(t) ? t : `"${me(t)}"`;
}
function bi(t, e, i, s) {
  let r = [];
  for (let l = 0; l <= t.length; l++) r.push(l);
  let a = i ? r.reverse() : r, n = RegExp("^" + P(e, s) + "$");
  for (let l of a) if (n.test(t.slice(0, l))) return t.slice(l);
  return t;
}
function Ii(t, e, i, s) {
  let r = [];
  for (let l = 0; l <= t.length; l++) r.push(l);
  let a = i ? r.reverse() : r, n = RegExp("^" + P(e, s) + "$");
  for (let l of a) {
    let o = t.length - l;
    if (n.test(t.slice(o))) return t.slice(0, o);
  }
  return t;
}
function Ji(t, e, i, s, r, a) {
  if (e === "") return t;
  let n = P(e, a);
  if (r === "start") return t.replace(RegExp("^(?:" + n + ")"), i);
  if (r === "end") return t.replace(RegExp("(?:" + n + ")$"), i);
  let l = s ? "g" : "";
  return t.replace(new RegExp(n.replace(/\.\*/g, ".*?"), l), i);
}
function fe(t) {
  let e = "";
  for (let i of t) i.fieldBreak || (e += i.text);
  return e;
}
function Wt(t) {
  if (t === void 0) return {
    ws: ` 	
`,
    nonWs: ""
  };
  let e = "", i = "";
  for (let s of t) s === " " || s === "	" || s === `
` ? e.includes(s) || (e += s) : i.includes(s) || (i += s);
  return {
    ws: e,
    nonWs: i
  };
}
function Ai(t, e = {
  ws: ` 	
`,
  nonWs: ""
}) {
  let i = [];
  for (let u of t) {
    if (u.fieldBreak) {
      i.push({ fieldBreak: !0 });
      continue;
    }
    for (let f of u.text) i.push({
      c: f,
      quoted: u.quoted
    });
  }
  let s = (u) => "c" in u && !u.quoted && e.ws.includes(u.c), r = (u) => "c" in u && !u.quoted && e.nonWs.includes(u.c), a = (u) => s(u) || r(u), n = [], l = "", o = !0, h = !1, d = 0, p = i.length, c = () => {
    n.push({
      text: l,
      quoted: o
    }), l = "", o = !0, h = !1;
  };
  for (; d < p && s(i[d]); ) d++;
  for (; d < p; ) {
    let u = i[d];
    if ("fieldBreak" in u) {
      c(), d++;
      continue;
    }
    if (!a(u)) {
      l += u.c, "c" in u && !u.quoted && (o = !1), h = !0, d++;
      continue;
    }
    c();
    let f = r(u);
    for (d++; d < p && (s(i[d]) || !f && r(i[d])); ) r(i[d]) && (f = !0), d++;
    d < p && (h = !0);
  }
  return h && c(), n.length > 0 ? n : [{
    text: "",
    quoted: !1
  }];
}

// mithic/packages/shell/dist/builtins.js
function it(t, e) {
  return e === "lower" ? t.toLowerCase() : e === "upper" ? t.toUpperCase() : t;
}
var Ge = /* @__PURE__ */ new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "for",
  "select",
  "in",
  "case",
  "esac",
  "function",
  "time",
  "{",
  "}",
  "!",
  "[[",
  "]]",
  "coproc"
]);
function Pt(t) {
  return Ge.has(t);
}
var _ = [
  "errexit",
  "histexpand",
  "noclobber",
  "nounset",
  "pipefail",
  "posix",
  "verbose",
  "xtrace"
], Ot = {
  e: "errexit",
  u: "nounset",
  x: "xtrace",
  v: "verbose",
  C: "noclobber",
  H: "histexpand"
}, wt = [
  "dotglob",
  "extglob",
  "globstar",
  "nocaseglob",
  "nocasematch",
  "nullglob"
], St = /* @__PURE__ */ "cd,pwd,export,unset,echo,printf,test,[,true,false,exit,eval,set,cat,:,local,declare,typeset,readonly,let,shift,return,getopts,read,mapfile,readarray,jobs,fg,bg,wait,kill,break,continue,source,.,type,shopt,trap,disown,history,fc,exec,coproc,dirs,pushd,popd,hash,unalias,command,builtin,compgen,complete,compopt".split(","), Qi = new Set(St);
function G(t) {
  return Qi.has(t);
}
var Re = /* @__PURE__ */ new Set([
  ":",
  ".",
  "break",
  "continue",
  "eval",
  "exec",
  "exit",
  "export",
  "readonly",
  "return",
  "set",
  "shift",
  "trap",
  "unset"
]), q = class extends Error {
  builtin;
  code;
  constructor(t, e, i) {
    super(i), this.name = "PosixSpecialBuiltinError", this.builtin = t, this.code = e;
  }
};
function v(t, e) {
  (t.writeErr ?? t.write)(e);
}
function ye(t, e) {
  let i = `${e.startsWith("/") ? "" : t}/${e}`.split("/"), s = [];
  for (let r of i) if (!(r === "" || r === ".")) {
    if (r === "..") {
      s.pop();
      continue;
    }
    s.push(r);
  }
  return "/" + s.join("/");
}
async function ve(t, e) {
  if (!(!t.hasFs || t.condTest === void 0) && !await t.condTest("-d", e)) return await t.condTest("-e", e) ? "Not a directory" : "No such file or directory";
}
function et(t, e, i, s) {
  let r = (a) => i || s === void 0 || s === "" ? a : a === s ? "~" : a.startsWith(s + "/") ? "~" + a.slice(s.length) : a;
  return [t, ...e].map(r).join(" ");
}
function we(t, e) {
  let i = parseInt(t.slice(1), 10), s = t[0] === "+" ? i : e - 1 - i;
  return s >= 0 && s < e ? s : void 0;
}
async function st(t, e, i) {
  switch (t) {
    case ":":
    case "true":
      return 0;
    case "false":
      return 1;
    case "cd": {
      let s = e[0] ?? i.env.HOME ?? "/", r = ye(i.cwd, s), a = await ve(i, r);
      return a === void 0 ? (i.cwd = r, i.env.PWD = i.cwd, 0) : (v(i, `shell: cd: ${s}: ${a}
`), 1);
    }
    case "pwd":
      return i.write(i.cwd + `
`), 0;
    case "dirs": {
      let s = i.state?.dirStack?.();
      if (s === void 0) return v(i, `shell: dirs: directory stack not available
`), 1;
      if (e.includes("-c")) return s.length = 0, 0;
      let r = e.includes("-l");
      return i.write(et(i.cwd, s, r, i.env.HOME) + `
`), 0;
    }
    case "pushd": {
      let s = i.state?.dirStack?.();
      if (s === void 0) return v(i, `shell: pushd: directory stack not available
`), 1;
      let r = e.find((n) => /^[+-]\d+$/.test(n));
      if (r !== void 0) {
        let n = [i.cwd, ...s], l = we(r, n.length);
        if (l === void 0) return v(i, `shell: pushd: ${r}: directory stack index out of range
`), 1;
        let o = n.slice(l).concat(n.slice(0, l));
        return i.cwd = o[0], i.env.PWD = i.cwd, s.length = 0, s.push(...o.slice(1)), i.write(et(i.cwd, s, !1, i.env.HOME) + `
`), 0;
      }
      let a = e.find((n) => !n.startsWith("-") && !/^[+-]\d+$/.test(n));
      if (a === void 0) {
        if (s.length === 0) return v(i, `shell: pushd: no other directory
`), 1;
        let n = i.cwd;
        i.cwd = s[0], i.env.PWD = i.cwd, s[0] = n;
      } else {
        let n = ye(i.cwd, a), l = await ve(i, n);
        if (l !== void 0) return v(i, `shell: pushd: ${a}: ${l}
`), 1;
        s.unshift(i.cwd), i.cwd = n, i.env.PWD = i.cwd;
      }
      return i.write(et(i.cwd, s, !1, i.env.HOME) + `
`), 0;
    }
    case "popd": {
      let s = i.state?.dirStack?.();
      if (s === void 0) return v(i, `shell: popd: directory stack not available
`), 1;
      if (s.length === 0) return v(i, `shell: popd: directory stack empty
`), 1;
      let r = e.find((a) => /^[+-]\d+$/.test(a));
      if (r !== void 0) {
        let a = [i.cwd, ...s], n = we(r, a.length);
        return n === void 0 ? (v(i, `shell: popd: ${r}: directory stack index out of range
`), 1) : (a.splice(n, 1), i.cwd = a[0], i.env.PWD = i.cwd, s.length = 0, s.push(...a.slice(1)), i.write(et(i.cwd, s, !1, i.env.HOME) + `
`), 0);
      }
      return i.cwd = s.shift(), i.env.PWD = i.cwd, i.write(et(i.cwd, s, !1, i.env.HOME) + `
`), 0;
    }
    case "echo": {
      let s = !0, r = !1, a = 0, n = i.state?.getOption("posix") ?? !1;
      for (; !n && a < e.length && /^-[neE]+$/.test(e[a]); ) e[a].includes("n") && (s = !1), e[a].includes("e") && (r = !0), e[a].includes("E") && (r = !1), a++;
      let l = e.slice(a).join(" ");
      return r && (l = L(l, !0)), i.write(l + (s ? `
` : "")), 0;
    }
    case "printf": {
      let s = e, r;
      s[0] === "-v" && s.length > 1 ? (r = s[1], s = s.slice(2)) : s[0]?.startsWith("-v") && s[0].length > 2 ? (r = s[0].slice(2), s = s.slice(1)) : s[0] === "--" && (s = s.slice(1));
      let a = Vi(s[0] ?? "", s.slice(1));
      if (r !== void 0) {
        if (i.state?.isReadonly?.(r)) return v(i, `shell: printf: ${r}: readonly variable
`), 1;
        i.env[r] = a.out;
      } else i.write(a.out);
      for (let n of a.errors) v(i, `shell: printf: ${n}
`);
      return +(a.errors.length > 0);
    }
    case "export": {
      let s = 0;
      for (let r of e) if (r.length > 1 && r[0] === "-") {
        for (let a of r.slice(1)) if (a !== "f" && a !== "n" && a !== "p") return v(i, `shell: export: -${a}: invalid option
export: usage: export [-fn] [name[=value] ...] or export -p [-f]
`), 2;
      } else break;
      for (let r of i.builtinAssignments ?? []) r.array !== void 0 && (i.state?.isReadonly?.(r.name) ? (v(i, `shell: export: ${r.name}: readonly variable
`), s = 1) : await i.applyBuiltinAssignment?.(r) && (s = 1));
      for (let r of i.builtinAssignments ?? []) r.array !== void 0 && i.state?.markExport?.(r.name);
      for (let r of e) {
        if (r.startsWith("-")) continue;
        let a = r.indexOf("="), n = a > 0 ? r.slice(0, a) : r;
        if (a > 0) {
          if (i.state?.isReadonly?.(n)) {
            v(i, `shell: export: ${n}: readonly variable
`), s = 1;
            continue;
          }
          i.env[n] = r.slice(a + 1);
        }
        i.state?.markExport?.(n);
      }
      return s;
    }
    case "unset": {
      let s = 0, r = e[0] === "-f", a = e[0] === "-v" || e[0] === "-f" ? e.slice(1) : e;
      for (let n of a) {
        let l = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s.exec(n), o = l ? l[1] : n, h = l ? l[2] : void 0;
        if (!r && i.state?.isReadonly?.(o)) {
          v(i, `shell: unset: ${o}: cannot unset: readonly variable
`), s = 1;
          continue;
        }
        if (r) {
          i.state?.functions.delete(o);
          continue;
        }
        delete i.env[o], i.state?.unsetVar?.(o, h), h === void 0 && i.state?.functions.delete(o);
      }
      return s;
    }
    case "local":
    case "declare":
    case "typeset":
    case "readonly": {
      let s = t === "local", r = t === "readonly", a = t === "declare" || t === "typeset", n = /* @__PURE__ */ new Set(), l = /* @__PURE__ */ new Set();
      for (let y of e) if (y.length > 1 && y[0] === "-") for (let S of y.slice(1)) n.add(S);
      else if (y.length > 1 && y[0] === "+") for (let S of y.slice(1)) l.add(S);
      else break;
      if (r) {
        let y = /* @__PURE__ */ new Set([
          "a",
          "A",
          "f",
          "p"
        ]);
        for (let S of [...n, ...l]) if (!y.has(S)) return v(i, `shell: readonly: -${S}: invalid option
readonly: usage: readonly [-aAf] [name[=value] ...] or readonly -p
`), 2;
      }
      let o = (a || s) && n.has("A"), h = (a || s) && n.has("n");
      if (a && n.has("p")) {
        let y = e.filter((B) => !B.startsWith("-")), S = i.state?.declareP?.(y);
        if (S === void 0) return 0;
        if (S.missing.length > 0) for (let B of S.missing) v(i, `shell: declare: ${B}: not found
`);
        for (let B of S.lines) i.write(B + `
`);
        return +(S.missing.length > 0);
      }
      let d = e.some((y) => !y.startsWith("-") && !y.startsWith("+")) || (i.builtinAssignments ?? []).length > 0, p = new Set([...n].filter((y) => "aAirxlun".includes(y)));
      if (a && !d && p.size > 0) {
        let y = i.state?.declarePByAttr?.(p) ?? [];
        for (let S of y) i.write(S + `
`);
        return 0;
      }
      let c = n.has("g"), u = s || a && !c, f = n.has("i"), g = r || n.has("r"), C = n.has("x"), m = (y) => {
        c ? i.state?.markGlobalInteger?.(y) : i.state?.markInteger?.(y);
      }, w = (y) => {
        c ? i.state?.markGlobalReadonly?.(y) : i.state?.markReadonly?.(y);
      }, x = (y) => i.state?.declareAssoc?.(y, c), Q = n.has("l") || n.has("u") || l.has("l") || l.has("u"), K = (y) => {
        if (!(n.has("l") && n.has("u"))) {
          if (n.has("l")) return "lower";
          if (n.has("u")) return "upper";
          if (!(l.has("l") && y === "lower") && !(l.has("u") && y === "upper")) return y;
        }
      }, O = (y) => {
        Q && (c ? i.state?.markGlobalCaseFold?.(y, K(i.state?.globalCaseFoldOf?.(y))) : i.state?.markCaseFold?.(y, K(i.state?.caseFoldOf?.(y))));
      };
      if (o && (i.state?.getOption("posix") ?? !1)) return v(i, `shell: declare: -A: not supported in POSIX mode
`), 2;
      let D = 0;
      for (let y of i.builtinAssignments ?? []) if (y.array !== void 0) {
        if (u) {
          let S = i.state?.declareLocal(y.name) ?? "none";
          if (s && S === "none") return v(i, `shell: local: can only be used in a function
`), 1;
        }
        o && x(y.name), f && m(y.name), O(y.name), (c ? i.state?.isGlobalReadonly?.(y.name) ?? !1 : i.state?.isReadonly?.(y.name) ?? !1) ? (v(i, `shell: ${t}: ${y.name}: readonly variable
`), D = 1) : await i.applyBuiltinAssignment?.(y, c) && (D = 1), g && w(y.name), C && i.state?.markExport?.(y.name);
      }
      for (let y of e) {
        if (y.startsWith("-")) continue;
        let S = y.indexOf("="), B = S > 0 ? y.slice(0, S) : y, U = B.endsWith("+"), b = (U ? B.slice(0, -1) : B).replace(/\[.*\]$/, "");
        if (h) {
          if (u) {
            let Z = i.state?.declareLocal(b) ?? "none";
            if (s && Z === "none") return v(i, `shell: local: can only be used in a function
`), 1;
          }
          S > 0 ? i.state?.setNameref?.(b, y.slice(S + 1)) : i.state?.predeclare?.(b, "nameref");
          continue;
        }
        let F = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\](\+?)$/s.exec(B);
        if (F !== null && S > 0 && i.applyBuiltinAssignment !== void 0) {
          if (u) {
            let Z = i.state?.declareLocal(F[1]) ?? "none";
            if (s && Z === "none") return v(i, `shell: local: can only be used in a function
`), 1;
          }
          f && m(F[1]), O(F[1]), await i.applyBuiltinAssignment({
            name: F[1],
            value: y.slice(S + 1),
            index: F[2],
            append: F[3] === "+"
          }, c) && (D = 1), g && w(F[1]), C && i.state?.markExport?.(F[1]);
          continue;
        }
        if (u && (i.state?.isReadonly?.(b) ?? !1)) {
          v(i, `shell: ${t}: ${b}: readonly variable
`), D = 1;
          continue;
        }
        let te = !1;
        if (u) {
          let Z = i.state?.declareLocal(b) ?? "none";
          if (s && Z === "none") return v(i, `shell: local: can only be used in a function
`), 1;
          te = Z === "fresh", te && delete i.env[b];
        }
        if (o ? x(b) : n.has("a") && !c && (!r || S > 0) && i.state?.declareArray?.(b), f && m(b), O(b), S > 0) {
          if (c ? i.state?.isGlobalReadonly?.(b) ?? !1 : i.state?.isReadonly?.(b) ?? !1) {
            v(i, `shell: ${t}: ${b}: readonly variable
`), D = 1;
            continue;
          }
          if (!o) {
            let Z = y.slice(S + 1), ee = U ? (c ? i.state?.getGlobal?.(b) : i.env[b]) ?? "" : "", ot = f ? String(U ? (i.evalArith?.(ee || "0") ?? 0n) + (i.evalArith?.(Z) ?? 0n) : i.evalArith?.(Z) ?? 0n) : ee + Z, ie = c ? i.state?.globalCaseFoldOf?.(b) : i.state?.caseFoldOf?.(b);
            ie !== void 0 && !f && (ot = it(ot, ie)), c && i.state?.setGlobal?.(b, ot) || (i.env[b] = ot), i.state?.clearDeclaredUnset?.(b);
          }
        } else if (!h) {
          let Z = o ? "assoc" : n.has("a") && !r ? "array" : "scalar";
          i.state?.predeclare?.(b, Z);
        }
        g && w(b), C && i.state?.markExport?.(b);
      }
      return D;
    }
    case "let": {
      if (e.length === 0) return 1;
      let s = 0n;
      try {
        for (let r of e) s = i.evalArith?.(r) ?? 0n;
      } catch (r) {
        return v(i, `shell: let: ${r instanceof Error ? r.message : String(r)}
`), 2;
      }
      return +(s === 0n);
    }
    case "shift": {
      let s = e[0] === void 0 ? 1 : parseInt(e[0], 10) || 0;
      return i.state?.shiftPositional(s), 0;
    }
    case "return": {
      let s = e[0] === void 0 ? i.lastStatus ?? 0 : parseInt(e[0], 10) || 0;
      return i.doReturn && i.doReturn(s), s;
    }
    case "break": {
      let s = e[0] === void 0 ? 1 : parseInt(e[0], 10) || 1;
      return i.doBreak && i.doBreak(s), 0;
    }
    case "continue": {
      let s = e[0] === void 0 ? 1 : parseInt(e[0], 10) || 1;
      return i.doContinue && i.doContinue(s), 0;
    }
    case "getopts":
      return Ni(e, i);
    case "read":
      return await Ti(e, i);
    case "mapfile":
    case "readarray":
      return await Fi(e, i);
    case "set":
      return Ei(e, i);
    case "cat": {
      if (i.readStdinPump) return await i.readStdinPump((r) => {
        r.byteLength !== 0 && (i.writeBytes ? i.writeBytes(r) : i.write(new TextDecoder().decode(r)));
      }), 0;
      let s = await (i.readStdinAll?.() ?? Promise.resolve(new Uint8Array()));
      return s.byteLength > 0 && (i.writeBytes ? i.writeBytes(s) : i.write(new TextDecoder().decode(s))), 0;
    }
    case "jobs": {
      let s = i.state?.jobs ?? [];
      for (let r of s) {
        let a = r.state === "running" ? "Running" : r.state === "stopped" ? "Stopped" : "Done";
        i.write(`[${r.id}]  ${a}	${r.command}
`);
      }
      return 0;
    }
    case "fg":
    case "bg":
      if ((i.state?.jobs ?? []).length === 0) return v(i, `shell: ${t}: no current job
`), 1;
      if (t === "fg") {
        let s = ft(e[0]);
        return await i.state?.waitJob(s) ?? 0;
      }
      return 0;
    case "wait": {
      if (!i.state) return 0;
      if (e.includes("-n")) return i.state.waitNext ? i.state.waitNext() : 127;
      if (e.length === 0) return i.state.waitAll();
      let s = 0;
      for (let r of e) {
        let a = ft(r);
        if (r.startsWith("%") && a !== void 0 && !Bi(i, a)) return v(i, `shell: wait: ${r}: no such job
`), 127;
        s = await i.state.waitJob(a);
      }
      return s;
    }
    case "kill": {
      let s = e.filter((n) => !n.startsWith("-"));
      if (e.length === 0) return v(i, `shell: kill: usage: kill [-signal] pid|%job ...
`), 1;
      let r = "TERM";
      for (let n of e) n.startsWith("-") && n.length > 1 && (r = Lt(n.slice(1)));
      let a = 0;
      for (let n of s) {
        let l = ft(n);
        (l === void 0 || !i.state?.killJob || !i.state.killJob(l, r)) && (v(i, `shell: kill: ${n}: no such job
`), a = 1);
      }
      return a;
    }
    case "type": {
      let s = !1, r = !1, a = !1, n = !1, l = !1, o = [], h = !1;
      for (let p of e) {
        if (!h && p === "--") {
          h = !0;
          continue;
        }
        if (!h && p.length > 1 && p[0] === "-") {
          let c = "";
          for (let u of p.slice(1)) if (u === "t") s = !0;
          else if (u === "a") r = !0;
          else if (u === "p") a = !0;
          else if (u === "P") n = !0;
          else if (u === "f") l = !0;
          else {
            c = u;
            break;
          }
          if (c !== "") return v(i, `shell: type: -${c}: invalid option
`), 2;
          continue;
        }
        o.push(p);
      }
      let d = 0;
      for (let p of o) {
        let c = Ge.has(p), u = !l && (i.state?.functions.has(p) ?? !1), f = G(p), g = c || u || f, C = n || r || !g ? await i.resolveExternal?.(p) : void 0;
        if (!g && C === void 0) {
          !s && !a && !n && v(i, `type: ${p}: not found
`), d = 1;
          continue;
        }
        if (a || n) {
          C === void 0 ? (n || !g) && (d = 1) : i.write(`${C}
`);
          continue;
        }
        if (s) {
          r ? (c && i.write(`keyword
`), u && i.write(`function
`), f && i.write(`builtin
`), C !== void 0 && i.write(`file
`)) : i.write(`${c ? "keyword" : u ? "function" : f ? "builtin" : "file"}
`);
          continue;
        }
        c && (i.write(`${p} is a shell keyword
`), !r) || u && (i.write(`${p} is a function
`), !r) || f && (i.write(`${p} is a shell builtin
`), !r) || C !== void 0 && i.write(`${p} is ${C}
`);
      }
      return d;
    }
    case "command":
    case "builtin": {
      let s = e;
      if (t === "command") {
        let r = !1, a = !1;
        for (; s.length > 0 && s[0].length > 1 && s[0][0] === "-" && s[0] !== "--"; ) {
          let n = "";
          for (let l of s[0].slice(1)) if (l === "v") r = !0;
          else if (l === "V") a = !0;
          else if (l !== "p") {
            n = l;
            break;
          }
          if (n !== "") break;
          s = s.slice(1);
        }
        if (s[0] === "--" && (s = s.slice(1)), r || a) {
          let n = a, l = s[0];
          if (l !== void 0) {
            if (Pt(l)) return i.write(n ? `${l} is a shell keyword
` : `${l}
`), 0;
            if (i.state?.functions.has(l)) return i.write(n ? `${l} is a function
` : `${l}
`), 0;
            if (G(l)) return i.write(n ? `${l} is a shell builtin
` : `${l}
`), 0;
            let o = await i.resolveExternal?.(l);
            if (o !== void 0) return i.write(n ? `${l} is ${o}
` : `${o}
`), 0;
            n && v(i, `shell: command: ${l}: not found
`);
          }
          return 1;
        }
      }
      return s.length === 0 ? 0 : t === "builtin" && !G(s[0]) ? (v(i, `shell: builtin: ${s[0]}: not a shell builtin
`), 1) : i.eval ? await i.eval(s.join(" ")) : 0;
    }
    case "source":
    case ".":
      return t === "source" && (i.state?.getOption("posix") ?? !1) ? (v(i, `shell: source: not supported in POSIX mode (use . instead)
`), 1) : i.sourceFile ? i.sourceFile(e) : i.eval ? i.eval(e.join(" ")) : 0;
    case "exec":
      return e.length === 0 ? 0 : i.eval ? i.eval(e.join(" ")) : 0;
    case "coproc":
      return v(i, `shell: coproc: requires a transferable backend
`), 1;
    case "hash":
      for (let s of e) if (s.startsWith("-") && s !== "-") {
        for (let r of s.slice(1)) if (!"lrpdt".includes(r)) return v(i, `shell: hash: ${s}: invalid option
hash: usage: hash [-lr] [-p pathname] [-dt] [name ...]
`), 2;
      }
      return 0;
    case "complete":
    case "compopt":
    case "unalias":
      return 0;
    case "compgen": {
      let s = e.indexOf("-W");
      if (s >= 0 && e[s + 1] !== void 0) {
        let r = e[s + 1].split(/\s+/).filter((h) => h !== ""), a = e.slice(s + 2), n = a.indexOf("--"), l = n >= 0 ? a[n + 1] ?? "" : a.find((h) => !h.startsWith("-")) ?? "", o = r.filter((h) => h.startsWith(l));
        for (let h of o) i.write(h + `
`);
        return o.length > 0 ? 0 : 1;
      }
      return 1;
    }
    case "shopt":
      return Gi(e, i);
    case "trap":
      return Ri(e, i);
    case "disown": {
      if (!i.state?.removeJob) return 0;
      let s = 0;
      for (let r of e) {
        if (r.startsWith("-")) continue;
        let a = ft(r);
        (a === void 0 || !i.state.removeJob(a)) && (v(i, `shell: disown: ${r}: no such job
`), s = 1);
      }
      return s;
    }
    case "history":
      return Zi(e, i);
    case "fc":
      if (e.includes("-l") && i.state?.history) {
        let s = i.state.history.list(), r = s.length, a = Math.max(0, r - 16);
        for (let n = a; n < r; n++) i.write(`${n + 1}	${s[n]}
`);
      }
      return 0;
    case "test":
    case "[": {
      let s = e;
      if (t === "[") {
        if (s[s.length - 1] !== "]") return v(i, "shell: [: missing `]'\n"), 2;
        s = s.slice(0, -1);
      }
      try {
        return +!await vt(s, i.condTest);
      } catch (r) {
        if (r instanceof yt || r instanceof k) return v(i, `shell: ${t}: ${r.message}
`), 2;
        throw r;
      }
    }
    case "exit": {
      let s = e.length > 0 ? parseInt(e[0], 10) || 0 : i.lastStatus ?? 0;
      return i.exit && i.exit(s), s;
    }
    case "eval": {
      let s = e.join(" ");
      return i.eval ? i.eval(s) : 0;
    }
    default:
      return v(i, `shell: ${t}: not a builtin
`), 127;
  }
}
function ft(t) {
  if (t !== void 0) return t.startsWith("%") ? parseInt(t.slice(1), 10) : parseInt(t, 10);
}
function Bi(t, e) {
  return (t.state?.jobs ?? []).some((i) => i.id === e || i.pids.includes(e));
}
function Lt(t) {
  return /^\d+$/.test(t) ? {
    0: "EXIT",
    2: "INT",
    9: "KILL",
    15: "TERM",
    18: "CONT",
    20: "TSTP"
  }[t] ?? t : t.toUpperCase().replace(/^SIG/, "");
}
function Gi(t, e) {
  let i = e.state;
  if (!i?.getShopt || !i.setShopt) return 0;
  let s = "query", r = !1, a = !1, n = [];
  for (let p of t) if (p === "-s") s = "set";
  else if (p === "-u") s = "unset";
  else if (p === "-q") r = !0;
  else if (p === "-p") a = !0;
  else {
    if (p.startsWith("-")) return v(e, `shell: shopt: ${p}: invalid option
`), 2;
    n.push(p);
  }
  let l = (p) => {
    let c = i.getShopt(p);
    e.write(`shopt -${c ? "s" : "u"} ${p}
`);
  };
  if (s === "set" || s === "unset") {
    let p = 0;
    for (let c of n) i.setShopt(c, s === "set") || (v(e, `shell: shopt: ${c}: invalid shell option name
`), p = 2);
    return p;
  }
  let o = wt, h = n.length > 0 ? n : o;
  if (a || n.length === 0 && !r) {
    let p = 0;
    for (let c of h) {
      let u = i.getShopt(c);
      if (u === void 0) {
        v(e, `shell: shopt: ${c}: invalid shell option name
`), p = 1;
        continue;
      }
      l(c), u || (p = 1);
    }
    return p;
  }
  let d = 0;
  for (let p of h) {
    let c = i.getShopt(p);
    if (c === void 0) {
      v(e, `shell: shopt: ${p}: invalid shell option name
`), d = 1;
      continue;
    }
    r || e.write(`${p}	${c ? "on" : "off"}
`), c || (d = 1);
  }
  return d;
}
function Ri(t, e) {
  let i = e.state;
  if (!i?.setTrap || !i.listTraps) return 0;
  if (t.length === 0) {
    for (let [a, n] of i.listTraps()) e.write(`trap -- '${n}' ${a}
`);
    return 0;
  }
  if (t[0] === "-" && t.length === 1) {
    for (let [a] of i.listTraps()) i.setTrap(a, void 0);
    return 0;
  }
  if (t[0] === "-") {
    for (let a of t.slice(1)) i.setTrap(Lt(a), void 0);
    return 0;
  }
  let s = t[0], r = t.slice(1);
  if (r.length === 0) return v(e, `shell: trap: usage: trap [-lp] [[arg] signal_spec ...]
`), 1;
  for (let a of r) i.setTrap(Lt(a), s);
  return 0;
}
function Zi(t, e) {
  let i = e.state?.history;
  if (!i) return 0;
  if (t[0] === "-c") return i.clear(), 0;
  let s = i.list();
  for (let r = 0; r < s.length; r++) e.write(`${String(r + 1).padStart(5)}  ${s[r]}
`);
  return 0;
}
function Ei(t, e) {
  let i = e.state, s = 0;
  for (; s < t.length; s++) {
    let r = t[s];
    if (r === "--") return i?.setPositional(t.slice(s + 1)), 0;
    if (r !== "" && (r[0] === "-" || r[0] === "+")) {
      let a = r[0] === "-", n = r.slice(1);
      if (n === "o" || n === "") {
        let o = t[s + 1];
        if (o === void 0) return ke(e, a), 0;
        if (!Se(e, o, a)) return Tt(e, `shell: set: ${o}: invalid option name
`);
        s++;
        continue;
      }
      let l = !1;
      for (let o of n) {
        if (o === "o") {
          let d = t[s + 1];
          if (d === void 0) return ke(e, a), 0;
          if (!Se(e, d, a)) return Tt(e, `shell: set: ${d}: invalid option name
`);
          l = !0;
          continue;
        }
        let h = Ot[o];
        if (!h) return Tt(e, `shell: set: -${o}: invalid option
`);
        i?.setOption(h, a);
      }
      l && s++;
      continue;
    }
    return i?.setPositional(t.slice(s)), 0;
  }
  return 0;
}
function Tt(t, e) {
  if (t.state?.getOption("posix") ?? !1) throw new q("set", 2, e.replace(/\n$/, "").replace(/^shell: /, ""));
  return v(t, e), 2;
}
function Se(t, e, i) {
  return _.includes(e) ? (t.state?.setOption(e, i), !0) : !1;
}
function ke(t, e) {
  let i = t.state?.listOptions() ?? [];
  for (let [s, r] of i) e ? t.write(`${s}	${r ? "on" : "off"}
`) : t.write(`set ${r ? "-o" : "+o"} ${s}
`);
}
function Ni(t, e) {
  let i = t[0] ?? "", s = t[1] ?? "";
  if (e.state?.isReadonly?.(s)) return v(e, `shell: getopts: ${s}: readonly variable
`), 1;
  let r = t.length > 2 ? t.slice(2) : e.state?.positional ?? [], a = parseInt(e.env.OPTIND ?? "1", 10) || 1;
  if (a > r.length) return e.env[s] = "?", 1;
  let n = r[a - 1];
  if (n === void 0 || n[0] !== "-" || n === "-") return e.env[s] = "?", 1;
  if (n === "--") return e.env.OPTIND = String(a + 1), e.env[s] = "?", 1;
  let l = parseInt(e.env.OPTPOS ?? "1", 10) || 1, o = n[l], h = i.indexOf(o);
  if (h < 0) return e.env[s] = "?", e.env.OPTARG = o, l++, l >= n.length && (a++, l = 1), e.env.OPTIND = String(a), e.env.OPTPOS = String(l), 0;
  if (i[h + 1] === ":") {
    let d;
    return l + 1 < n.length ? (d = n.slice(l + 1), a++) : (d = r[a] ?? "", a += 2), e.env[s] = o, e.env.OPTARG = d, e.env.OPTIND = String(a), e.env.OPTPOS = "1", 0;
  }
  return e.env[s] = o, delete e.env.OPTARG, l++, l >= n.length && (a++, l = 1), e.env.OPTIND = String(a), e.env.OPTPOS = String(l), 0;
}
var xe = 142, Ze = /* @__PURE__ */ Symbol("read-timeout");
function Wi(t) {
  let e;
  return {
    promise: new Promise((i) => {
      e = setTimeout(() => i(Ze), Math.max(0, t * 1e3));
    }),
    cancel: () => clearTimeout(e)
  };
}
async function Ti(t, e) {
  let i = [], s, r, a = !1, n, l, o, h = !1;
  for (let c = 0; c < t.length; c++) {
    let u = t[c];
    if (u === "--") {
      i.push(...t.slice(c + 1));
      break;
    }
    if (!u.startsWith("-") || u.length < 2) {
      i.push(u);
      continue;
    }
    let f = 1;
    for (; f < u.length; ) {
      let g = u[f], C = () => {
        let m = f + 1 < u.length ? u.slice(f + 1) : t[++c] ?? "";
        return f = u.length, m;
      };
      if (g === "r") {
        a = !0, f++;
        continue;
      }
      if (g === "u") {
        s = parseInt(C(), 10);
        continue;
      }
      if (g === "t") {
        r = parseFloat(C());
        continue;
      }
      if (g === "a") {
        n = C();
        continue;
      }
      if (g === "d") {
        l = C();
        continue;
      }
      if (g === "n") {
        o = parseInt(C(), 10);
        continue;
      }
      if (g === "N") {
        o = parseInt(C(), 10), h = !0;
        continue;
      }
      if (g === "p") {
        C();
        continue;
      }
      if (g === "s") {
        f++;
        continue;
      }
      f++;
    }
  }
  r !== void 0 && Number.isNaN(r) && (r = void 0), o !== void 0 && Number.isNaN(o) && (o = void 0), s === void 0 && e.stdinFd !== void 0 && (s = e.stdinFd);
  let d = Wt(e.env.IFS), p = (c) => {
    let u = a ? c : Ki(c);
    return n === void 0 ? (Kt(i, u, d, e), 0) : (e.state?.setArray?.(n, Li(u, d)), 0);
  };
  if ((l !== void 0 || o !== void 0) && s === void 0) {
    let c = l === void 0 ? void 0 : l === "" ? "\0" : l[0], u = await (e.readStdinChunk?.(c, o, h) ?? Promise.resolve(void 0));
    return u === void 0 ? 1 : p(u);
  }
  if (s !== void 0) {
    let c = Promise.resolve(e.readFdLine?.(s)), u;
    if (r !== void 0) {
      let f = Wi(r);
      u = await Promise.race([c, f.promise]), f.cancel();
    } else u = await c;
    return u === Ze ? (n === void 0 ? Kt(i, "", d, e) : e.state?.setArray?.(n, []), xe) : (e.consumeFdLine?.(s), u === void 0 ? 1 : p(u));
  }
  if (e.readStdinLine) {
    let { line: c, timedOut: u } = await e.readStdinLine(r);
    return u ? (n === void 0 ? Kt(i, "", d, e) : e.state?.setArray?.(n, []), xe) : c === void 0 ? 1 : p(c);
  }
  return 1;
}
function Ki(t) {
  if (!t.includes("\\")) return t;
  let e = "";
  for (let i = 0; i < t.length; i++) t[i] === "\\" ? i + 1 < t.length && (e += t[i + 1], i++) : e += t[i];
  return e;
}
function Kt(t, e, i, s) {
  if (t.length === 0) {
    s.env.REPLY = e;
    return;
  }
  let { fields: r, rests: a } = Ee(e, i, t.length);
  for (let n = 0; n < t.length; n++) n === t.length - 1 ? s.env[t[n]] = a[n] ?? "" : s.env[t[n]] = r[n] ?? "";
}
function Li(t, e) {
  let { fields: i } = Ee(t, e, 1 / 0);
  return i;
}
function Ee(t, e, i) {
  let s = (d) => e.ws.includes(d), r = (d) => e.nonWs.includes(d), a = (d) => s(d) || r(d), n = [], l = [], o = 0, h = t.length;
  for (; o < h && s(t[o]); ) o++;
  for (; o < h; ) {
    let d = h;
    for (; d > o && s(t[d - 1]); ) d--;
    if (l.push(t.slice(o, d)), n.length >= i - 1) {
      n.push(t.slice(o, d));
      break;
    }
    let p = o;
    for (; p < h && !a(t[p]); ) p++;
    if (n.push(t.slice(o, p)), p >= h) break;
    let c = r(t[p]);
    for (p++; p < h && (s(t[p]) || !c && r(t[p])); ) r(t[p]) && (c = !0), p++;
    o = p;
  }
  return {
    fields: n,
    rests: l
  };
}
async function Fi(t, e) {
  let i = "mapfile", s = !1, r = `
`, a, n = "MAPFILE", l = 0, o = 0, h, d = !1, p = (C, m) => /^\d+$/.test(C) ? parseInt(C, 10) : (v(e, `${i}: ${C}: invalid ${m}
`), null);
  for (let C = 0; C < t.length; C++) {
    let m = t[C];
    if (m === "-t") {
      s = !0;
      continue;
    }
    if (m === "-d") {
      let w = t[++C] ?? "";
      r = w === "" ? "\0" : w[0];
      continue;
    }
    if (m.startsWith("-d") && m.length > 2) {
      r = m.slice(2)[0];
      continue;
    }
    if (m === "-u") {
      a = parseInt(t[++C] ?? "", 10);
      continue;
    }
    if (m.startsWith("-u") && m.length > 2) {
      a = parseInt(m.slice(2), 10);
      continue;
    }
    if (m === "-n" || m === "-s" || m === "-O") {
      let w = m === "-O" ? "array origin" : "line count", x = p(t[++C] ?? "", w);
      if (x === null) return 1;
      m === "-n" ? l = x : m === "-s" ? o = x : h = x;
      continue;
    }
    if ((m.startsWith("-n") || m.startsWith("-s") || m.startsWith("-O")) && m.length > 2) {
      let w = m.slice(0, 2), x = w === "-O" ? "array origin" : "line count", Q = p(m.slice(2), x);
      if (Q === null) return 1;
      w === "-n" ? l = Q : w === "-s" ? o = Q : h = Q;
      continue;
    }
    if (m === "-C") {
      d = !0, C++;
      continue;
    }
    if (m.startsWith("-C") && m.length > 2) {
      d = !0;
      continue;
    }
    if (m === "-c") {
      d = !0, C++;
      continue;
    }
    if (m.startsWith("-c") && m.length > 2) {
      d = !0;
      continue;
    }
    n = m;
  }
  if (d) return v(e, `${i}: -c/-C (per-quantum callback) is not supported
`), 2;
  let c;
  if (a !== void 0) {
    let C = [];
    for (; ; ) {
      let m = await Promise.resolve(e.readFdLine?.(a));
      if (m === void 0) break;
      e.consumeFdLine?.(a), C.push(m.endsWith(`
`) ? m : m + `
`);
    }
    c = C.join("");
  } else {
    let C = await (e.readStdinAll?.() ?? Promise.resolve(new Uint8Array()));
    c = new TextDecoder().decode(C);
  }
  let u = Pi(c, r), f = o > 0 ? u.slice(o) : u;
  l > 0 && (f = f.slice(0, l));
  let g = s ? f.map((C) => C.endsWith(r) ? C.slice(0, -r.length) : C) : f;
  return h === void 0 ? e.state?.setArray?.(n, g) : e.state?.setArrayFrom?.(n, g, h), 0;
}
function Pi(t, e) {
  if (t === "") return [];
  let i = [], s = 0;
  for (; ; ) {
    let r = t.indexOf(e, s);
    if (r < 0) {
      i.push(t.slice(s));
      break;
    }
    if (i.push(t.slice(s, r + e.length)), s = r + e.length, s >= t.length) break;
  }
  return i;
}
var V = new Set(/* @__PURE__ */ "-a.-b.-c.-d.-e.-f.-g.-h.-k.-n.-o.-p.-r.-s.-t.-u.-w.-x.-z.-G.-L.-N.-O.-R.-S.-v".split(".")), Ne = /* @__PURE__ */ new Set([
  "=",
  "==",
  "!=",
  "<",
  ">",
  "-eq",
  "-ne",
  "-lt",
  "-le",
  "-gt",
  "-ge",
  "-nt",
  "-ot",
  "-ef"
]);
async function We(t, e, i) {
  return t === "-z" ? e === "" : t === "-n" ? e !== "" : i ? await i(t, e) : !1;
}
var yt = class extends Error {
  operand;
  constructor(t) {
    super(`${t}: integer expected`), this.operand = t;
  }
}, k = class extends Error {
  constructor(t) {
    super(t);
  }
}, Oi = (1n << 63n) - 1n, Xi = -(1n << 63n);
function E(t) {
  let e = t.trim(), i = /^([+-]?)0*([0-9]+)$/.exec(e);
  if (i === null) throw new yt(t);
  let s;
  try {
    s = BigInt(i[1] + (i[2] || "0"));
  } catch {
    throw new yt(t);
  }
  if (s > Oi || s < Xi) throw new yt(t);
  return s;
}
function $i(t, e, i) {
  switch (e) {
    case "-eq":
      return E(t) === E(i);
    case "-ne":
      return E(t) !== E(i);
    case "-lt":
      return E(t) < E(i);
    case "-le":
      return E(t) <= E(i);
    case "-gt":
      return E(t) > E(i);
    case "-ge":
      return E(t) >= E(i);
    default:
      return;
  }
}
async function Te(t, e, i, s) {
  switch (e) {
    case "=":
    case "==":
      return t === i;
    case "!=":
      return t !== i;
    case "<":
      return t < i;
    case ">":
      return t > i;
    case "-nt":
    case "-ot":
    case "-ef":
      return s ? await s(e, t + "\0" + i) : !1;
    default:
      return $i(t, e, i) ?? !1;
  }
}
async function vt(t, e) {
  switch (t.length) {
    case 0:
      return !1;
    case 1:
      return t[0] !== "";
    case 2:
      if (t[0] === "!") return t[1] === "";
      if (V.has(t[0])) return await We(t[0], t[1], e);
      throw new k(`${t[0]}: unary operator expected`);
    case 3:
      if (Ne.has(t[1])) return await Te(t[0], t[1], t[2], e);
      if (t[1] === "-a") return t[0] !== "" && t[2] !== "";
      if (t[1] === "-o") return t[0] !== "" || t[2] !== "";
      if (t[0] === "!") return !await vt(t.slice(1), e);
      if (t[0] === "(" && t[2] === ")") return await vt([t[1]], e);
      throw new k(`${t[1]}: binary operator expected`);
    case 4:
      if (t[0] === "!") return !await vt(t.slice(1), e);
      break;
  }
  let i = new Hi(t, e), s = await i.parseExpr();
  if (!i.atEnd()) throw new k("too many arguments");
  return s;
}
var Hi = class {
  pos = 0;
  toks;
  fileTest;
  constructor(t, e) {
    this.toks = t, this.fileTest = e;
  }
  peek() {
    return this.toks[this.pos];
  }
  atEnd() {
    return this.pos >= this.toks.length;
  }
  async parseExpr() {
    return await this.parseOr();
  }
  async parseOr() {
    let t = await this.parseAnd();
    for (; this.peek() === "-o"; ) {
      this.pos++;
      let e = await this.parseAnd();
      t ||= e;
    }
    return t;
  }
  async parseAnd() {
    let t = await this.parseUnary();
    for (; this.peek() === "-a"; ) {
      this.pos++;
      let e = await this.parseUnary();
      t &&= e;
    }
    return t;
  }
  async parseUnary() {
    return this.peek() === "!" ? (this.pos++, !await this.parseUnary()) : await this.parsePrimary();
  }
  async parsePrimary() {
    if (this.peek() === "(") {
      this.pos++;
      let i = await this.parseOr();
      if (this.peek() !== ")") throw new k("`)' expected");
      return this.pos++, i;
    }
    let t = this.toks[this.pos], e = this.toks[this.pos + 1];
    if (t === void 0) throw new k("argument expected");
    if (e !== void 0 && Ne.has(e)) {
      let i = this.toks[this.pos + 2];
      if (i === void 0) throw new k("argument expected");
      return this.pos += 3, await Te(t, e, i, this.fileTest);
    }
    return V.has(t) && e !== void 0 ? (this.pos += 2, await We(t, e, this.fileTest)) : (this.pos++, t !== "");
  }
};
function Vi(t, e) {
  let i = L(t, !0), s = "", r = 0, a = [], n = !1, l = !0, o = () => (l = r < e.length, e[r++] ?? "");
  do {
    let h = r, d = !1, p = 0;
    for (; p < i.length && !n; ) {
      let c = i[p];
      if (c !== "%") {
        s += c, p++;
        continue;
      }
      if (i[p + 1] === "%") {
        s += "%", p += 2;
        continue;
      }
      let u = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?((?:hh|ll|[hlLjzt])*)/.exec(i.slice(p));
      if (!u) {
        s += c, p++;
        continue;
      }
      let f = u[0], g = i[p + f.length];
      if (g === "n") {
        d = !0, p += f.length + 1;
        continue;
      }
      if (g === void 0 || !"sbcCdiuoxXeEfFgGqSaA".includes(g)) {
        a.push(g === void 0 ? `\`${f}': missing format character` : `\`${g}': invalid format character`), n = !0;
        break;
      }
      d = !0;
      let C = u[1], m = u[2] === "*" ? parseInt(o(), 10) || 0 : u[2] ? parseInt(u[2], 10) : void 0;
      m !== void 0 && m < 0 && (C += "-", m = -m);
      let w;
      if (u[3] === "*") {
        let O = parseInt(o(), 10) || 0;
        w = O < 0 ? void 0 : O;
      } else u[3] !== void 0 && (w = parseInt(u[3], 10));
      let x = o(), Q = l, K = Di(g, C, m, w, x);
      s += K.text, Q && K.error !== void 0 && a.push(K.error), K.stop && (n = !0), p += f.length + 1;
    }
    if (n || !d || r === h) break;
  } while (r < e.length);
  return {
    out: s,
    errors: a
  };
}
function Di(t, e, i, s, r) {
  let a = e.includes("-"), n = e.includes("0") && !a, l = e.includes("+"), o = e.includes(" "), h = e.includes("#"), d, p = "";
  switch (t) {
    case "s":
    case "S":
      return d = r, s !== void 0 && (d = d.slice(0, s)), { text: $(d, i, a, !1) };
    case "b": {
      let { text: c, stop: u } = Yi(r);
      return d = c, s !== void 0 && (d = d.slice(0, s)), {
        text: $(d, i, a, !1),
        stop: u
      };
    }
    case "c":
    case "C":
      return d = r === "" ? "\0" : r.slice(0, 1), { text: $(d, i, a, !1) };
    case "q":
      return { text: $(oe(r), i, a, !1) };
    case "d":
    case "i":
    case "u": {
      let c = Ae(r, t === "u"), u;
      if (t === "u") u = ((c.value % H + H) % H).toString(10);
      else {
        let f = c.value < 0n;
        u = (f ? -c.value : c.value).toString(10), p = f ? "-" : l ? "+" : o ? " " : "";
      }
      return s !== void 0 && (u = u.padStart(s, "0"), s === 0 && c.value === 0n && (u = "")), d = u, {
        text: gt(p, d, i, a, n && s === void 0),
        error: c.error
      };
    }
    case "o":
    case "x":
    case "X": {
      let c = Ae(r, !0), u = (c.value % H + H) % H, f = u.toString(t === "o" ? 8 : 16);
      t === "X" && (f = f.toUpperCase()), s !== void 0 && (f = f.padStart(s, "0"), s === 0 && u === 0n && (f = ""));
      let g = "";
      return h && u !== 0n && (g = t === "o" ? "0" : t === "x" ? "0x" : "0X"), d = f, {
        text: gt(g, d, i, a, n && s === void 0),
        error: c.error
      };
    }
    case "a":
    case "A": {
      let c = Be(r), u = c.value;
      if (!Number.isFinite(u)) {
        let C = t === "A";
        return Number.isNaN(u) ? {
          text: $(C ? "NAN" : "nan", i, a, !1),
          error: c.error
        } : {
          text: $((u < 0 ? "-" : l ? "+" : o ? " " : "") + (C ? "INF" : "inf"), i, a, !1),
          error: c.error
        };
      }
      p = u < 0 || Object.is(u, -0) ? "-" : l ? "+" : o ? " " : "";
      let f = Mi(Math.abs(u), s !== void 0 && s >= 0 ? s : void 0, t === "A", h), g = f.slice(0, 2);
      return p += g, d = f.slice(2), {
        text: gt(p, d, i, a, n),
        error: c.error
      };
    }
    case "f":
    case "F":
    case "e":
    case "E":
    case "g":
    case "G": {
      let c = Be(r), u = c.value;
      if (!Number.isFinite(u)) {
        let m = t === "F" || t === "E" || t === "G";
        return Number.isNaN(u) ? {
          text: $(m ? "NAN" : "nan", i, a, !1),
          error: c.error
        } : {
          text: $((u < 0 ? "-" : l ? "+" : o ? " " : "") + (m ? "INF" : "inf"), i, a, !1),
          error: c.error
        };
      }
      let f = t === "F" ? "f" : t;
      s !== void 0 && s < 0 && (s = void 0);
      let g = s ?? 6, C;
      if (C = f === "f" ? Ke(Math.abs(u), g) : f === "e" || f === "E" ? Ft(Math.abs(u), g, f === "E") : zi(Math.abs(u), s === void 0 ? 6 : s === 0 ? 1 : s, f === "G", h), h && (f === "f" || f === "e" || f === "E") && !C.includes(".")) {
        let m = /^(\d+)(.*)$/s.exec(C);
        m !== null && (C = m[1] + "." + m[2]);
      }
      return p = u < 0 || Object.is(u, -0) ? "-" : l ? "+" : o ? " " : "", d = C, {
        text: gt(p, d, i, a, n),
        error: c.error
      };
    }
    default:
      return { text: "" };
  }
}
function Yi(t) {
  let e = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === "\\") {
    if (t[i + 1] === "c") {
      e = i;
      break;
    }
    i++;
  }
  return e < 0 ? {
    text: L(t, !1),
    stop: !1
  } : {
    text: L(t.slice(0, e), !1),
    stop: !0
  };
}
function $(t, e, i, s) {
  if (e === void 0 || t.length >= e) return t;
  let r = " ".repeat(e - t.length);
  return i ? t + r : r + t;
}
function gt(t, e, i, s, r) {
  let a = t.length + e.length;
  if (i === void 0 || a >= i) return t + e;
  let n = i - a;
  return s ? t + e + " ".repeat(n) : r ? t + "0".repeat(n) + e : " ".repeat(n) + t + e;
}
function Y(t, e) {
  let i = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
  i.setFloat64(0, t);
  let s = i.getUint32(0), r = i.getUint32(4), a = s >>> 20 & 2047, n = BigInt(s & 1048575) << 32n | BigInt(r >>> 0), l;
  if (a === 0 ? l = -1074 : (n |= 1n << 52n, l = a - 1075), n === 0n) return 0n;
  let o = n, h = 1n;
  e >= 0 ? o *= 10n ** BigInt(e) : h *= 10n ** BigInt(-e), l >= 0 ? o <<= BigInt(l) : h <<= BigInt(-l);
  let d = o / h, p = (o - d * h) * 2n;
  return (p > h || p === h && d % 2n == 1n) && (d += 1n), d;
}
function Mi(t, e, i, s) {
  let r;
  if (t === 0) r = "0x0" + (e !== void 0 && e > 0 ? "." + "0".repeat(e) : s ? "." : "") + "p+0";
  else {
    let a = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8));
    a.setFloat64(0, t);
    let n = a.getUint32(0), l = a.getUint32(4), o = n >>> 20 & 2047, h = BigInt(n & 1048575) << 32n | BigInt(l >>> 0), d, p;
    if (o === 0) {
      let f = 51;
      for (; f >= 0 && (h & 1n << BigInt(f)) == 0n; ) f--;
      h = h - (1n << BigInt(f)) << BigInt(52 - f), d = f - 1074, p = 1n;
    } else d = o - 1023, p = 1n;
    let c = h.toString(16).padStart(13, "0");
    if (e === void 0) c = c.replace(/0+$/, "");
    else if (e < 13) {
      let f = c.slice(e), g = BigInt("0x" + (c.slice(0, e) || "0")), C = BigInt("0x8" + "0".repeat(f.length - 1)), m = BigInt("0x" + f);
      (m > C || m === C && (g & 1n) == 1n) && (g += 1n);
      let w = 1n << BigInt(4 * e);
      g >= w && (g -= w, p += 1n), c = e > 0 ? g.toString(16).padStart(e, "0") : "";
    } else c = c.padEnd(e, "0");
    let u = c.length > 0 ? "." + c : s ? "." : "";
    r = "0x" + p.toString(16) + u + "p" + (d < 0 ? "-" : "+") + Math.abs(d);
  }
  return i ? r.toUpperCase() : r;
}
function Ke(t, e) {
  if (!Number.isFinite(t)) return Math.abs(t).toFixed(Math.min(e, 100));
  let i = Y(t, e).toString();
  if (e === 0) return i;
  let s = i.padStart(e + 1, "0");
  return s.slice(0, s.length - e) + "." + s.slice(s.length - e);
}
function Ft(t, e, i) {
  if (!Number.isFinite(t)) {
    let d = t.toExponential(e).replace(/e([+-])(\d)$/, "e$10$2");
    return i ? d.toUpperCase() : d;
  }
  let s = i ? "E" : "e";
  if (t === 0) return (e > 0 ? "0." + "0".repeat(e) : "0") + s + "+00";
  let r = e + 1, a = Math.floor(Math.log10(t)), n = Y(t, e - a);
  for (; n.toString().length > r; ) a += 1, n = Y(t, e - a);
  for (; n !== 0n && n.toString().length < r; ) --a, n = Y(t, e - a);
  let l = n.toString().padStart(r, "0"), o = e > 0 ? l[0] + "." + l.slice(1) : l, h = a < 0 ? "-" : "+";
  return o + s + h + String(Math.abs(a)).padStart(2, "0");
}
function zi(t, e, i, s) {
  if (e < 1 && (e = 1), t === 0) return s ? "0." + "0".repeat(Math.max(0, e - 1)) : "0";
  if (!Number.isFinite(t)) return Ft(t, e - 1, i);
  let r = Math.floor(Math.log10(t)), a = Y(t, e - 1 - r);
  for (; a.toString().length > e; ) r += 1, a = Y(t, e - 1 - r);
  for (; a !== 0n && a.toString().length < e; ) --r, a = Y(t, e - 1 - r);
  let n;
  return r < -4 || r >= e ? (n = Ft(t, e - 1, i), s ? n.includes(".") || (n = n.replace(/([eE])/, ".$1")) : n = n.replace(/\.?0+([eE])/, "$1")) : (n = Ke(t, Math.max(0, e - 1 - r)), !s && n.includes(".") ? n = n.replace(/\.?0+$/, "") : s && !n.includes(".") && (n += ".")), n;
}
var H = 1n << 64n, be = (1n << 63n) - 1n, Ie = -(1n << 63n), Je = H - 1n, Ui = -(H - 1n);
function Ct(t, e) {
  let i = 0n;
  for (let s of t) i = i * e + BigInt(parseInt(s, Number(e)));
  return i;
}
function Ae(t, e) {
  let i = t.replace(/^\s+/, "");
  if (i[0] === "'" || i[0] === '"') return { value: BigInt(i.codePointAt(1) ?? 0) };
  let s = i[0] === "+" || i[0] === "-", r = i[0] === "-" ? -1n : 1n, a = s ? i.slice(1) : i, n = s ? "invalid number" : void 0;
  if (/^0[xX]/.test(a)) {
    let o = a.slice(2).match(/^[0-9a-fA-F]+/);
    if (o === null) return {
      value: 0n,
      error: `${t}: ${n ?? "invalid hex number"}`
    };
    let h = mt(Ct(o[0], 16n) * r, e, t);
    return o[0].length === a.length - 2 ? h : {
      value: h.value,
      error: `${t}: ${n ?? "invalid hex number"}`
    };
  }
  if (/^0[0-9]+$/.test(a)) {
    let o = a.slice(1).match(/^[0-7]+/), h = o ? o[0] : "", d = mt(Ct(h, 8n) * r, e, t);
    return h.length === a.length - 1 ? d : {
      value: d.value,
      error: `${t}: ${n ?? "invalid octal number"}`
    };
  }
  if (/^\d+$/.test(a)) return mt(Ct(a, 10n) * r, e, t);
  let l = a.match(/^\d+/);
  return l === null ? {
    value: 0n,
    error: `${t}: invalid number`
  } : {
    value: mt(Ct(l[0], 10n) * r, e, t).value,
    error: `${t}: invalid number`
  };
}
function mt(t, e, i) {
  return e ? t > Je || t < Ui ? {
    value: Je,
    error: `${i.trim()}: Result too large`
  } : { value: t } : t > be ? {
    value: be,
    error: `${i.trim()}: Result too large`
  } : t < Ie ? {
    value: Ie,
    error: `${i.trim()}: Result too large`
  } : { value: t };
}
var ji = 2 ** -1022;
function Qe(t, e) {
  return !Number.isNaN(t) && (Math.abs(t) === 1 / 0 || t !== 0 && Math.abs(t) < ji) ? {
    value: t,
    error: `${e.trim()}: Result too large`
  } : { value: t };
}
function Be(t) {
  let e = t.replace(/^\s+/, "");
  if (e[0] === "'" || e[0] === '"') return { value: e.codePointAt(1) ?? 0 };
  let i = /^([+-]?)(inf(inity)?|nan)$/i.exec(e);
  if (i !== null) {
    let a = i[1] === "-";
    return /^nan$/i.test(i[2]) ? { value: NaN } : { value: a ? -1 / 0 : 1 / 0 };
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(e)) return Qe(parseFloat(e), t);
  let s = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?/.exec(e);
  if (s !== null) {
    let a = s[2], n = s[3];
    if (a === "" && (n === void 0 || n === "")) return {
      value: 0,
      error: `${t}: invalid hex number`
    };
    let l = s[1] === "-" ? -1 : 1, o = a === "" ? 0 : parseInt(a, 16);
    if (n !== void 0 && n !== "") for (let p = 0; p < n.length; p++) o += parseInt(n[p], 16) * 16 ** -(p + 1);
    let h = s[4] === void 0 ? 0 : parseInt(s[4], 10), d = l * o * 2 ** h;
    return s[0].length === e.length ? Qe(d, t) : {
      value: d,
      error: `${t}: invalid hex number`
    };
  }
  let r = parseFloat(e);
  return Number.isNaN(r) ? {
    value: 0,
    error: `${t}: invalid number`
  } : {
    value: r,
    error: `${t}: invalid number`
  };
}

// mithic/packages/shell/dist/cli.js
var _i = [
  "Usage: sh [options] [script] [args...]",
  "  -c string   execute command string",
  "  -s          read commands from stdin",
  "  -e          exit on error",
  "  -u          error on unset variable",
  "  -x          trace commands",
  "  -v          verbose (print input lines)",
  "  -C          noclobber (do not overwrite files with >)",
  "  --posix     enable POSIX mode (disable bash extensions)",
  "  --version   print version",
  "  --help      print this help"
].join(`
`) + `
`, qi = {
  e: "errexit",
  u: "nounset",
  x: "xtrace",
  v: "verbose",
  C: "noclobber"
};
function Xt(t, e = "sh", i = {}) {
  let s = {
    options: [],
    posix: !1,
    fromStdin: !1,
    positional: [],
    name: Le(e)
  };
  ("POSIXLY_CORRECT" in i || Le(e) === "sh") && (s.posix = !0);
  let r = 0, a = !1, n = !1, l = !1;
  for (; r < t.length; ) {
    let o = t[r];
    if (a) {
      ts(s, o, n), n = !0, r++;
      continue;
    }
    if (o === "--") {
      a = !0, r++;
      continue;
    }
    if (o === "--version") return s.action = "version", s;
    if (o === "--help") return s.action = "help", s;
    if (o === "--posix") {
      s.posix = !0, r++;
      continue;
    }
    if (o === "-c") {
      if (r++, r >= t.length) return s.error = `${s.name}: -c: option requires an argument`, s;
      for (s.commandString = t[r], r++, r < t.length && (s.name = t[r], r++); r < t.length; ) s.positional.push(t[r]), r++;
      return s;
    }
    if (o === "-s") {
      l = !0, r++;
      continue;
    }
    if (o.length > 1 && o[0] === "-" && o[1] !== "-") {
      for (let h of o.slice(1)) {
        if (h === "s") {
          l = !0;
          continue;
        }
        let d = qi[h];
        if (!d) return s.error = `${s.name}: -${h}: invalid option`, s;
        s.options.includes(d) || s.options.push(d);
      }
      r++;
      continue;
    }
    for (s.scriptFile = o, n = !0, r++; r < t.length; ) s.positional.push(t[r]), r++;
    return s;
  }
  return s.commandString === void 0 && s.scriptFile === void 0 && (s.fromStdin = !0), l && (s.fromStdin = !0), s;
}
function ts(t, e, i) {
  !i && t.scriptFile === void 0 && t.commandString === void 0 ? t.scriptFile = e : t.positional.push(e);
}
function Le(t) {
  let e = t.lastIndexOf("/");
  return e >= 0 ? t.slice(e + 1) : t;
}

// mithic/packages/shell/dist/lexer.js
function kt(t) {
  return t === " " || t === "	" || t === "\r";
}
function es(t, e) {
  let i = t.length, s = e + 1;
  for ((t[s] === "!" || t[s] === "^") && s++, t[s] === "]" && s++; s < i; ) {
    let r = t[s];
    if (r === "]") return s + 1;
    if (r === " " || r === "	" || r === `
`) return e;
    if (r === "[" && t[s + 1] === ":") {
      let a = t.indexOf(":]", s + 2);
      if (a >= 0) {
        s = a + 2;
        continue;
      }
    }
    s++;
  }
  return e;
}
function Fe(t, e) {
  let i = t.length, s = t[e + 2] === "(", r = e + (s ? 3 : 2), a = 1;
  for (; r < i && a > 0 && (t[r] === "(" ? a++ : t[r] === ")" && a--, a !== 0); ) r++;
  return r++, s && t[r] === ")" && r++, r;
}
function Pe(t, e) {
  let i = t.length, s = e + 2, r = 1;
  for (; s < i && r > 0; ) {
    if (t[s] === "(") r++;
    else if (t[s] === ")" && (r--, r === 0)) return s + 1;
    s++;
  }
  return e;
}
function $t(t, e) {
  let i = t, s = i[e];
  if (i.startsWith("<<<", e)) return {
    type: "LESSLESSLESS",
    len: 3
  };
  if (i.startsWith("<<-", e)) return {
    type: "LESSLESSDASH",
    len: 3
  };
  if (i.startsWith("&>>", e)) return {
    type: "AMPGREATGREAT",
    len: 3
  };
  if (i.startsWith(";;&", e)) return {
    type: "SEMISEMIAMP",
    len: 3
  };
  if (i.startsWith(";&", e)) return {
    type: "SEMIAMP",
    len: 2
  };
  if (i.startsWith("&&", e)) return {
    type: "AND_IF",
    len: 2
  };
  if (i.startsWith("||", e)) return {
    type: "OR_IF",
    len: 2
  };
  if (i.startsWith("|&", e)) return {
    type: "PIPEAMP",
    len: 2
  };
  if (i.startsWith(">>", e)) return {
    type: "GREATGREAT",
    len: 2
  };
  if (i.startsWith(">|", e)) return {
    type: "GREATPIPE",
    len: 2
  };
  if (i.startsWith("<<", e)) return {
    type: "LESSLESS",
    len: 2
  };
  if (i.startsWith("<>", e)) return {
    type: "LESSGREAT",
    len: 2
  };
  if (i.startsWith(">&", e)) return {
    type: "GREATAMP",
    len: 2
  };
  if (i.startsWith("<&", e)) return {
    type: "LESSAMP",
    len: 2
  };
  if (i.startsWith("&>", e)) return {
    type: "AMPGREAT",
    len: 2
  };
  if (i.startsWith(";;", e)) return {
    type: "DSEMI",
    len: 2
  };
  if (i.startsWith("((", e)) return {
    type: "DLPAREN",
    len: 2
  };
  if (i.startsWith("))", e)) return {
    type: "DRPAREN",
    len: 2
  };
  if (i.startsWith("[[", e) && kt(i[e + 2] ?? " ")) return {
    type: "DLBRACKET",
    len: 2
  };
  if (i.startsWith("]]", e)) return {
    type: "DRBRACKET",
    len: 2
  };
  if (s === "|") return {
    type: "PIPE",
    len: 1
  };
  if (s === ">") return {
    type: "GREAT",
    len: 1
  };
  if (s === "<") return {
    type: "LESS",
    len: 1
  };
  if (s === "&") return {
    type: "AMP",
    len: 1
  };
  if (s === ";") return {
    type: "SEMI",
    len: 1
  };
  if (s === "(") return {
    type: "LPAREN",
    len: 1
  };
  if (s === ")") return {
    type: "RPAREN",
    len: 1
  };
  if (s === `
`) return {
    type: "NEWLINE",
    len: 1
  };
}
function rt(t) {
  let e = [], i = 0, s = t.length, r = 1, a = 0, n = (l) => {
    for (; a < l; a++) t[a] === `
` && r++;
    return r;
  };
  for (; i < s; ) {
    let l = t[i];
    if (kt(l)) {
      i++;
      continue;
    }
    if (l === "#" && (i === 0 || kt(t[i - 1]) || t[i - 1] === `
`)) {
      for (; i < s && t[i] !== `
`; ) i++;
      continue;
    }
    let o = /^(\d+)([<>])/.exec(t.slice(i));
    if (o) {
      let u = parseInt(o[1], 10), f = i + o[1].length, g = $t(t, f);
      e.push({
        type: g.type,
        value: t.slice(i, f + g.len),
        raw: t.slice(i, f + g.len),
        fd: u,
        line: n(i)
      }), i = f + g.len;
      continue;
    }
    (l === "<" || l === ">") && t[i + 1] === "(" && Pe(t, i);
    let h = $t(t, i);
    if (h && !((l === "<" || l === ">") && t[i + 1] === "(")) {
      e.push({
        type: h.type,
        value: t.slice(i, i + h.len),
        raw: t.slice(i, i + h.len),
        line: n(i)
      }), i += h.len;
      continue;
    }
    let d = i, p = "", c = "";
    for (; i < s; ) {
      let u = t[i];
      if (kt(u)) break;
      if ((u === "<" || u === ">") && t[i + 1] === "(") {
        let f = Pe(t, i);
        if (f > i) {
          let g = t.slice(i, f);
          p += g, c += g, i = f;
          continue;
        }
      }
      if ("?*+@!".includes(u) && t[i + 1] === "(") {
        let f = i;
        i += 2;
        let g = 1;
        for (; i < s && g > 0; ) {
          if (t[i] === "(") g++;
          else if (t[i] === ")" && (g--, g === 0)) {
            i++;
            break;
          }
          i++;
        }
        let C = t.slice(f, i);
        p += C, c += C;
        continue;
      }
      if (u === "[") {
        let f = es(t, i);
        if (f > i) {
          let g = t.slice(i, f);
          p += g, c += g, i = f;
          continue;
        }
      }
      if ($t(t, i)) break;
      if (u === "\\") {
        let f = t[i + 1] ?? "";
        if (f === `
`) {
          i += 2;
          continue;
        }
        p += f, c += u + f, i += f ? 2 : 1;
        continue;
      }
      if (u === "'") {
        let f = i;
        i++;
        let g = "";
        for (; i < s && t[i] !== "'"; ) g += t[i], i++;
        i++, p += g, c += t.slice(f, i);
        continue;
      }
      if (u === '"') {
        let f = i;
        i++;
        let g = "";
        for (; i < s && t[i] !== '"'; ) {
          if (t[i] === "\\") {
            let C = t[i + 1] ?? "";
            if (C === `
`) {
              i += 2;
              continue;
            }
            if (C === '"' || C === "\\" || C === "$" || C === "`") {
              g += C, i += 2;
              continue;
            }
            g += "\\", i++;
            continue;
          }
          if (t[i] === "$" && t[i + 1] === "(") {
            let C = Fe(t, i);
            g += t.slice(i, C), i = C;
            continue;
          }
          g += t[i], i++;
        }
        i++, p += g, c += t.slice(f, i);
        continue;
      }
      if (u === "`") {
        let f = i;
        for (i++; i < s && t[i] !== "`"; ) t[i] === "\\" && i++, i++;
        i++, p += t.slice(f, i), c += t.slice(f, i);
        continue;
      }
      if (u === "$" && t[i + 1] === "'") {
        let f = i;
        for (i += 2; i < s && t[i] !== "'"; ) t[i] === "\\" && i + 1 < s && i++, i++;
        i++, p += t.slice(f, i), c += t.slice(f, i);
        continue;
      }
      if (u === "$" && t[i + 1] === "(") {
        let f = i;
        i = Fe(t, i), p += t.slice(f, i), c += t.slice(f, i);
        continue;
      }
      if (u === "$" && t[i + 1] === "{") {
        let f = i;
        i += 2;
        let g = 1;
        for (; i < s && g > 0; ) {
          if (t[i] === "\\") {
            i += 2;
            continue;
          }
          if (t[i] === "{") g++;
          else if (t[i] === "}" && (g--, g === 0)) break;
          i++;
        }
        i++, p += t.slice(f, i), c += t.slice(f, i);
        continue;
      }
      p += u, c += u, i++;
    }
    e.push({
      type: "WORD",
      value: p,
      raw: c,
      line: n(d)
    });
  }
  return e;
}

// mithic/packages/shell/dist/parser.js
var Ht = /* @__PURE__ */ new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "for",
  "select",
  "in",
  "case",
  "esac",
  "function",
  "{",
  "}",
  "!",
  "coproc"
]), is = /* @__PURE__ */ new Set([
  "declare",
  "local",
  "readonly",
  "export",
  "typeset"
]), ss = class {
  tokens;
  pos = 0;
  heredocs;
  posix;
  constructor(t, e, i = {}) {
    this.tokens = t, this.heredocs = e, this.posix = i.posix ?? !1;
  }
  posixReject(t) {
    throw SyntaxError(`shell: syntax error: ${t} is not supported in POSIX mode`);
  }
  peek() {
    return this.tokens[this.pos];
  }
  at(t = 0) {
    return this.tokens[this.pos + t];
  }
  next() {
    return this.tokens[this.pos++];
  }
  atType(t) {
    return this.peek()?.type === t;
  }
  atReserved(t) {
    let e = this.peek();
    return e?.type === "WORD" && e.value === t;
  }
  atAnyReserved(t) {
    let e = this.peek();
    return e?.type === "WORD" ? t.includes(e.value) : !1;
  }
  skipSeparators() {
    for (; this.atType("SEMI") || this.atType("NEWLINE"); ) this.next();
  }
  skipNewlines() {
    for (; this.atType("NEWLINE"); ) this.next();
  }
  parseProgram() {
    let t = [];
    for (this.skipSeparators(); this.peek() && !this.atTerminator(); ) {
      let e = this.pos;
      t.push(this.parseAndOr()), (this.atType("SEMI") || this.atType("NEWLINE") || this.atType("AMP")) && this.next(), this.skipSeparators(), this.pos === e && this.next();
    }
    return {
      type: "Program",
      body: t
    };
  }
  atTerminator() {
    let t = this.peek();
    return !!(!t || t.type === "WORD" && Ht.has(t.value) && ![
      "if",
      "while",
      "until",
      "for",
      "select",
      "case",
      "function",
      "{",
      "!",
      "coproc"
    ].includes(t.value) || t.type === "RPAREN" || t.type === "DSEMI" || t.type === "DRPAREN");
  }
  parseAndOr() {
    let t = this.peek()?.line, e = this.parsePipeline();
    for (; this.atType("AND_IF") || this.atType("OR_IF"); ) {
      let i = this.next().type === "AND_IF" ? "And" : "Or";
      this.skipNewlines();
      let s = this.parsePipeline();
      e = {
        type: i,
        left: e,
        right: s
      };
    }
    return t !== void 0 && (e.line = t), e;
  }
  parsePipeline() {
    let t = this.peek()?.line, e = !1;
    this.atReserved("!") && (this.next(), e = !0);
    let i = this.parseCommand();
    if (!this.atType("PIPE") && !this.atType("PIPEAMP")) return e && (i.negate = !0), this.maybeBackground(i), t !== void 0 && (i.line ??= t), i;
    let s = [i], r = [];
    for (; this.atType("PIPE") || this.atType("PIPEAMP"); ) {
      let l = this.atType("PIPEAMP");
      l && this.posix && this.posixReject("|&"), r.push(l), this.next(), this.skipNewlines(), s.push(this.parseCommand());
    }
    let a = s.every((l) => l.type === "Pipeline" && l.stages?.length === 1), n = {
      type: "Pipeline",
      negate: e
    };
    return a && !r.some(Boolean) ? n.stages = s.map((l) => l.stages[0]) : (n.stageNodes = s, n.pipeStderr = r), this.maybeBackground(n), t !== void 0 && (n.line ??= t), n;
  }
  maybeBackground(t) {
    this.atType("AMP") && (this.next(), t.background = !0);
  }
  parseCommand() {
    if (this.atReserved("if")) return this.parseIf();
    if (this.atReserved("while") || this.atReserved("until")) return this.parseWhile();
    if (this.atReserved("for")) return this.parseFor();
    if (this.atReserved("case")) return this.parseCase();
    if (this.atReserved("function")) return this.parseFunctionKw();
    if (this.atReserved("{")) return this.parseGroup();
    if (this.atType("LPAREN")) return this.parseSubshell();
    if (this.atType("DLPAREN")) return this.posix && this.posixReject("(( ))"), this.parseArithCmd();
    if (this.atType("DLBRACKET")) return this.posix && this.posixReject("[[ ]]"), this.parseCond();
    if (this.atReserved("select")) return this.posix && this.posixReject("select"), this.parseSelect();
    if (this.atReserved("coproc")) return this.posix && this.posixReject("coproc"), this.parseCoproc();
    let t = this.peek();
    return t?.type === "WORD" && this.at(1)?.type === "LPAREN" && this.at(2)?.type === "RPAREN" && Oe(t.value) ? this.parseFunctionParen() : this.wrapSimple(this.parseSimpleCommand());
  }
  wrapSimple(t) {
    return {
      type: "Pipeline",
      stages: [t]
    };
  }
  parseCoproc() {
    this.next();
    let t = "COPROC", e = this.peek(), i = this.at(1);
    e?.type === "WORD" && Oe(e.value) && !Ht.has(e.value) && i !== void 0 && this.startsCompound(i) && (t = e.value, this.next());
    let s = this.parseCommand();
    return {
      type: "Coproc",
      coprocName: t,
      coprocBody: s
    };
  }
  startsCompound(t) {
    return t.type === "LPAREN" || t.type === "DLPAREN" || t.type === "DLBRACKET" ? !0 : t.type === "WORD" ? [
      "{",
      "if",
      "while",
      "until",
      "for",
      "case",
      "select"
    ].includes(t.value) : !1;
  }
  parseIf() {
    this.next();
    let t = this.parseStatementListUntil(["then"]);
    this.expectReserved("then");
    let e = this.parseStatementListUntil([
      "elif",
      "else",
      "fi"
    ]), i;
    return this.atReserved("elif") ? (i = [this.parseElif()], {
      type: "If",
      condition: t,
      then: e,
      else: i
    }) : (this.atReserved("else") && (this.next(), i = this.parseStatementListUntil(["fi"])), this.expectReserved("fi"), {
      type: "If",
      condition: t,
      then: e,
      else: i
    });
  }
  parseElif() {
    this.next();
    let t = this.parseStatementListUntil(["then"]);
    this.expectReserved("then");
    let e = this.parseStatementListUntil([
      "elif",
      "else",
      "fi"
    ]), i;
    return this.atReserved("elif") ? i = [this.parseElif()] : this.atReserved("else") && (this.next(), i = this.parseStatementListUntil(["fi"])), this.atReserved("fi") && this.next(), {
      type: "If",
      condition: t,
      then: e,
      else: i
    };
  }
  parseWhile() {
    let t = this.peek().value === "until";
    this.next();
    let e = this.parseStatementListUntil(["do"]);
    this.expectReserved("do");
    let i = this.parseStatementListUntil(["done"]);
    this.expectReserved("done");
    let s = {
      type: "While",
      condition: e,
      body: i,
      until: t
    };
    return this.attachTrailingRedirects(s), s;
  }
  parseFor() {
    if (this.next(), this.atType("DLPAREN")) return this.parseArithFor();
    let t = this.next();
    if (t?.type !== "WORD") throw SyntaxError("shell: syntax error: expected for variable");
    let e;
    if (this.atReserved("in")) for (this.next(), e = []; this.peek() && !this.atType("SEMI") && !this.atType("NEWLINE") && !this.atReserved("do"); ) e.push(this.next().raw);
    for (; this.atType("SEMI") || this.atType("NEWLINE"); ) this.next();
    this.expectReserved("do");
    let i = this.parseStatementListUntil(["done"]);
    this.expectReserved("done");
    let s = {
      type: "For",
      varName: t.value,
      words: e,
      body: i
    };
    return this.attachTrailingRedirects(s), s;
  }
  parseArithFor() {
    this.next();
    let t = [""];
    for (; this.peek() && !this.atType("DRPAREN"); ) {
      if (this.atType("SEMI")) {
        t.push(""), this.next();
        continue;
      }
      if (this.atType("DSEMI")) {
        t.push(""), t.push(""), this.next();
        continue;
      }
      t[t.length - 1] += this.next().raw;
    }
    for (this.atType("DRPAREN") && this.next(); this.atType("SEMI") || this.atType("NEWLINE"); ) this.next();
    this.expectReserved("do");
    let e = this.parseStatementListUntil(["done"]);
    this.expectReserved("done");
    let i = {
      type: "For",
      arithFor: !0,
      body: e,
      arithInit: (t[0] ?? "").trim(),
      arithCond: (t[1] ?? "").trim(),
      arithIncr: (t[2] ?? "").trim()
    };
    return this.attachTrailingRedirects(i), i;
  }
  parseSelect() {
    this.next();
    let t = this.next();
    if (t?.type !== "WORD") throw SyntaxError("shell: syntax error: expected select variable");
    let e;
    if (this.atReserved("in")) for (this.next(), e = []; this.peek() && !this.atType("SEMI") && !this.atType("NEWLINE") && !this.atReserved("do"); ) e.push(this.next().raw);
    for (; this.atType("SEMI") || this.atType("NEWLINE"); ) this.next();
    this.expectReserved("do");
    let i = this.parseStatementListUntil(["done"]);
    this.expectReserved("done");
    let s = {
      type: "Select",
      varName: t.value,
      words: e,
      body: i
    };
    return this.attachTrailingRedirects(s), s;
  }
  parseCase() {
    this.next();
    let t = this.next();
    if (t?.type !== "WORD") throw SyntaxError("shell: syntax error: expected case word");
    this.expectReserved("in"), this.skipNewlines();
    let e = [];
    for (; this.peek() && !this.atReserved("esac"); ) {
      this.atType("LPAREN") && this.next();
      let i = [];
      for (i.push(this.next().raw); this.atType("PIPE"); ) this.next(), i.push(this.next().raw);
      if (!this.atType("RPAREN")) throw SyntaxError("shell: syntax error: expected ) in case");
      this.next();
      let s = {
        patterns: i,
        body: this.parseStatementListUntil([], [
          "DSEMI",
          "SEMIAMP",
          "SEMISEMIAMP",
          "esac-word"
        ])
      };
      this.atType("SEMISEMIAMP") ? (s.continueMatch = !0, this.next()) : this.atType("SEMIAMP") ? (s.fallthrough = !0, this.next()) : this.atType("DSEMI") && this.next(), e.push(s), this.skipNewlines();
    }
    return this.expectReserved("esac"), {
      type: "Case",
      caseWord: t.raw,
      clauses: e
    };
  }
  parseFunctionKw() {
    this.next();
    let t = this.next();
    if (t?.type !== "WORD") throw SyntaxError("shell: syntax error: expected function name");
    this.atType("LPAREN") && (this.next(), this.atType("RPAREN") && this.next()), this.skipNewlines();
    let e = this.parseBraceBody();
    return {
      type: "Function",
      funcName: t.value,
      funcBody: e
    };
  }
  parseFunctionParen() {
    let t = this.next();
    this.next(), this.next(), this.skipNewlines();
    let e = this.parseBraceBody();
    return {
      type: "Function",
      funcName: t.value,
      funcBody: e
    };
  }
  parseBraceBody() {
    this.expectReserved("{");
    let t = this.parseStatementListUntil(["}"]);
    return this.expectReserved("}"), t;
  }
  parseGroup() {
    this.next();
    let t = this.parseStatementListUntil(["}"]);
    this.expectReserved("}");
    let e = {
      type: "Group",
      body: t
    };
    return this.attachTrailingRedirects(e), e;
  }
  parseSubshell() {
    this.next();
    let t = [];
    for (this.skipSeparators(); this.peek() && !this.atType("RPAREN"); ) {
      let i = this.pos;
      t.push(this.parseAndOr()), (this.atType("SEMI") || this.atType("NEWLINE") || this.atType("AMP")) && this.next(), this.skipSeparators(), this.pos === i && this.next();
    }
    this.atType("RPAREN") && this.next();
    let e = {
      type: "Subshell",
      body: t
    };
    return this.attachTrailingRedirects(e), e;
  }
  parseArithCmd() {
    this.next();
    let t = "";
    for (; this.peek() && !this.atType("DRPAREN"); ) t += this.next().raw;
    return this.atType("DRPAREN") && this.next(), {
      type: "Arithmetic",
      expr: t
    };
  }
  parseCond() {
    this.next();
    let t = [], e = [];
    for (; this.peek() && !this.atType("DRBRACKET"); ) {
      if (this.atType("DLPAREN")) {
        this.next(), t.push("(", "("), e.push(!0, !0);
        continue;
      }
      if (this.atType("DRPAREN")) {
        this.next(), t.push(")", ")"), e.push(!0, !0);
        continue;
      }
      let i = this.atType("LPAREN") || this.atType("RPAREN"), s = this.next().raw;
      if (t.push(s), e.push(i), s === "=~") {
        let r = "", a = 0, n = 0;
        for (; this.peek() && !this.atType("DRBRACKET") && !this.atType("AND_IF") && !this.atType("OR_IF") && !(this.atType("RPAREN") && a === 0); ) this.atType("LPAREN") ? a++ : this.atType("RPAREN") && a--, r += this.next().raw, n++;
        n > 0 && (t.push(r), e.push(!1));
      }
    }
    return this.atType("DRBRACKET") && this.next(), {
      type: "Cond",
      condWords: t,
      condGroup: e
    };
  }
  expectReserved(t) {
    if (!this.atReserved(t)) {
      let e = this.peek()?.value ?? "end of input";
      throw SyntaxError(`shell: syntax error: expected '${t}' but got '${e}'`);
    }
    this.next();
  }
  parseStatementListUntil(t, e = []) {
    let i = [];
    for (this.skipSeparators(); this.peek() && !this.atAnyReserved(t) && !this.atStopToken(e); ) {
      let s = this.pos;
      if (i.push(this.parseAndOr()), (this.atType("SEMI") || this.atType("NEWLINE") || this.atType("AMP")) && this.next(), this.skipSeparators(), this.atStopToken(e)) break;
      this.pos === s && this.next();
    }
    return i;
  }
  atStopToken(t) {
    return !!(t.includes("DSEMI") && this.atType("DSEMI") || t.includes("SEMIAMP") && this.atType("SEMIAMP") || t.includes("SEMISEMIAMP") && this.atType("SEMISEMIAMP") || t.includes("esac-word") && this.atReserved("esac"));
  }
  parseSimpleCommand() {
    let t = [], e = [], i = [], s = "", r = !1;
    for (; this.atType("WORD") && !r && rs(this.peek().value); ) t.push(this.parseAssignmentWord());
    let a = !1;
    for (; ; ) {
      let n = this.peek();
      if (!n) break;
      if (n.type === "WORD") {
        if (Ht.has(n.value) && !r) break;
        if (!r) {
          s = n.raw, r = !0, a = is.has(n.value), this.next();
          continue;
        }
        if (a && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(n.value) && this.tokens[this.pos + 1]?.type === "LPAREN") {
          t.push(this.parseAssignmentWord());
          continue;
        }
        e.push(n.raw), this.next();
        continue;
      }
      if (this.isRedirectToken(n.type)) {
        i.push(this.parseRedirect());
        continue;
      }
      break;
    }
    return {
      type: "SimpleCommand",
      name: s,
      args: e,
      redirects: i,
      assignments: t
    };
  }
  parseAssignmentWord() {
    let t = this.next(), e = /^([A-Za-z_][A-Za-z0-9_]*)(\[((?:[^[\]]|\[[^\]]*\])*)\])?(\+?)=(.*)$/s.exec(t.raw);
    if (!e) {
      let l = t.value.indexOf("=");
      return {
        name: t.value.slice(0, l),
        value: t.raw.slice(t.raw.indexOf("=") + 1)
      };
    }
    let i = e[1], s = e[3], r = e[4] === "+", a = e[5];
    if (a === "" && s === void 0 && this.atType("LPAREN")) {
      this.posix && this.posixReject("arrays"), this.next();
      let l = [];
      for (; this.peek() && !this.atType("RPAREN"); ) {
        if (this.atType("NEWLINE")) {
          this.next();
          continue;
        }
        let h = this.next();
        l.push(h.raw);
      }
      this.atType("RPAREN") && this.next();
      let o = {
        name: i,
        value: "",
        array: l
      };
      return r && (o.append = !0), o;
    }
    let n = {
      name: i,
      value: a
    };
    return s !== void 0 && (n.index = s), r && (n.append = !0), n;
  }
  isRedirectToken(t) {
    return t === "GREAT" || t === "GREATGREAT" || t === "GREATPIPE" || t === "LESS" || t === "LESSGREAT" || t === "LESSLESS" || t === "LESSLESSDASH" || t === "LESSLESSLESS" || t === "GREATAMP" || t === "LESSAMP" || t === "AMPGREAT" || t === "AMPGREATGREAT";
  }
  attachTrailingRedirects(t) {
    let e = [];
    for (; this.peek() && this.isRedirectToken(this.peek().type); ) e.push(this.parseRedirect());
    e.length && (t.redirects = e);
  }
  parseRedirect() {
    let t = this.next(), e = t.fd;
    switch (t.type) {
      case "GREAT":
        return this.targetRedirect(">", e);
      case "GREATPIPE":
        return this.targetRedirect(">|", e);
      case "GREATGREAT":
        return this.targetRedirect(">>", e);
      case "LESS":
        return this.targetRedirect("<", e);
      case "LESSGREAT":
        return this.targetRedirect("<>", e);
      case "LESSLESSLESS":
        return this.hereString();
      case "LESSLESS":
        return this.hereDocRedirect(!1);
      case "LESSLESSDASH":
        return this.hereDocRedirect(!0);
      case "GREATAMP":
        return this.dupRedirect(">&", e);
      case "LESSAMP":
        return this.dupRedirect("<&", e);
      case "AMPGREAT":
        return this.targetRedirect("&>", e);
      case "AMPGREATGREAT":
        return this.targetRedirect("&>>", e);
      default:
        throw SyntaxError("shell: syntax error: bad redirect");
    }
  }
  targetRedirect(t, e) {
    let i = this.peek();
    if (i?.type !== "WORD") throw SyntaxError("shell: syntax error: expected redirect target");
    return this.next(), {
      op: t,
      fd: e,
      target: i.raw
    };
  }
  dupRedirect(t, e) {
    let i = this.peek();
    if (i?.type !== "WORD") throw SyntaxError("shell: syntax error: expected dup target");
    return this.next(), {
      op: t,
      fd: e,
      target: i.value
    };
  }
  hereString() {
    this.posix && this.posixReject("<<< here-string");
    let t = this.peek();
    if (t?.type !== "WORD") throw SyntaxError("shell: syntax error: expected here-string word");
    return this.next(), {
      op: "<<<",
      target: t.raw
    };
  }
  hereDocRedirect(t) {
    let e = this.peek();
    if (e?.type !== "WORD") throw SyntaxError("shell: syntax error: expected here-doc delimiter");
    this.next();
    let i = parseInt(e.value.replace(/^__HEREDOC_(\d+)__$/, "$1"), 10), s = this.heredocs.get(i), r = s?.body ?? "";
    return t && (r = r.split(`
`).map((a) => a.replace(/^\t+/, "")).join(`
`)), {
      op: "<<",
      target: "",
      hereDoc: r,
      hereDocQuoted: s?.quoted
    };
  }
};
function rs(t) {
  return /^[A-Za-z_][A-Za-z0-9_]*(\[(?:[^[\]]|\[[^\]]*\])*\])?\+?=/.test(t);
}
function Oe(t) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t);
}
function ns(t) {
  let e = /* @__PURE__ */ new Map(), i = t.split(`
`), s = [], r = 0;
  for (let a = 0; a < i.length; a++) {
    let n = i[a], l = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g, o = [];
    n = n.replace(l, (h, d, p) => {
      let c = h.startsWith("<<-"), u = r++;
      return o.push({
        delim: p,
        quoted: d !== "",
        strip: c,
        hid: u
      }), `${c ? "<<-" : "<<"} __HEREDOC_${u}__`;
    }), s.push(n);
    for (let h of o) {
      let d = [], p = 0;
      for (; a + 1 < i.length; ) {
        a++, p++;
        let c = i[a];
        if ((h.strip ? c.replace(/^\t+/, "") : c) === h.delim) break;
        d.push(c);
      }
      e.set(h.hid, {
        id: h.hid,
        body: d.length ? d.join(`
`) + `
` : "",
        quoted: h.quoted
      });
      for (let c = 0; c < p; c++) s.push("");
    }
  }
  return {
    src: s.join(`
`),
    heredocs: e
  };
}
function nt(t, e = {}) {
  let { src: i, heredocs: s } = ns(t);
  return new ss(rt(i), s, e).parseProgram();
}

// mithic/packages/shell/dist/stdin-reader.js
var Vt = class {
  #n;
  #r = new Uint8Array();
  #t = 0;
  #e = !1;
  #s;
  constructor(t) {
    this.#n = t.getReader();
  }
  async #o() {
    if (this.#e) return !1;
    let t = this.#s ?? this.#n.read();
    this.#s = t;
    let { value: e, done: i } = await t;
    return this.#s = void 0, i ? (this.#e = !0, !1) : (e && e.byteLength > 0 && this.#c(e), !0);
  }
  #c(t) {
    let e = this.#r.byteLength - this.#t, i = new Uint8Array(e + t.byteLength);
    i.set(this.#r.subarray(this.#t), 0), i.set(t, e), this.#r = i, this.#t = 0;
  }
  #i() {
    return this.#r.subarray(this.#t);
  }
  #h(t) {
    let e = this.#i();
    for (let i = 0; i < e.byteLength; i++) if (e[i] === t) return i;
    return -1;
  }
  #a(t) {
    let e = this.#i(), i = Math.min(t, e.byteLength), s = new TextDecoder().decode(e.subarray(0, i));
    return this.#t += i, s;
  }
  async #l(t) {
    for (; this.#i().byteLength < t * 4 && !this.#e; ) await this.#o();
    let e = this.#i(), i = new TextDecoder().decode(e).slice(0, t), s = new TextEncoder().encode(i).byteLength;
    return this.#t += s, i;
  }
  async readLine() {
    for (; ; ) {
      let t = this.#h(10);
      if (t >= 0) {
        let e = this.#a(t);
        return this.#t += 1, e;
      }
      if (this.#e) {
        let e = this.#i();
        return e.byteLength === 0 ? void 0 : this.#a(e.byteLength);
      }
      await this.#o();
    }
  }
  async readUntil(t, e) {
    let i = new TextEncoder().encode(t)[0];
    for (; ; ) {
      let s = this.#h(i);
      if (s >= 0) {
        if (e !== void 0 && e >= 0 && new TextDecoder().decode(this.#i().subarray(0, s)).length > e) return await this.#l(e);
        let r = this.#a(s);
        return this.#t += 1, r;
      }
      if (e !== void 0 && e >= 0 && new TextDecoder().decode(this.#i()).length >= e) return await this.#l(e);
      if (this.#e) {
        let r = this.#i();
        return r.byteLength === 0 ? void 0 : e !== void 0 && e >= 0 ? await this.#l(e) : this.#a(r.byteLength);
      }
      await this.#o();
    }
  }
  async readBytes(t) {
    return this.#l(t);
  }
  async readAll() {
    let t = [], e = this.#i();
    for (e.byteLength > 0 && t.push(e.slice()), this.#t = this.#r.byteLength; !this.#e; ) {
      let a = this.#s ?? this.#n.read();
      this.#s = a;
      let { value: n, done: l } = await a;
      if (this.#s = void 0, l) {
        this.#e = !0;
        break;
      }
      n && n.byteLength > 0 && t.push(n);
    }
    let i = 0;
    for (let a of t) i += a.byteLength;
    let s = new Uint8Array(i), r = 0;
    for (let a of t) s.set(a, r), r += a.byteLength;
    return s;
  }
  async pumpTo(t) {
    let e = this.#i();
    if (e.byteLength > 0) {
      let i = e.slice();
      this.#t = this.#r.byteLength, await t(i);
    }
    for (; !this.#e; ) {
      let i = this.#s ?? this.#n.read();
      this.#s = i;
      let { value: s, done: r } = await i;
      if (this.#s = void 0, r) {
        this.#e = !0;
        break;
      }
      s && s.byteLength > 0 && await t(s);
    }
  }
  hasData() {
    return this.#t < this.#r.byteLength || !this.#e;
  }
  cancel() {
    this.#n.cancel().catch(() => {
    });
  }
};

// mithic/packages/shell/dist/output-sink.js
var Dt = class extends Error {
  code = 141;
  constructor() {
    super("broken pipe"), this.name = "BrokenPipeError";
  }
};
function A(t) {
  if ("writeBytes" in t && typeof t.writeBytes == "function") return t;
  let e = t, i = new TextDecoder();
  return Object.assign((s) => e(s), { writeBytes: (s) => e(i.decode(s, { stream: !0 })) });
}
function Xe(t) {
  let e = t.getWriter(), i = new TextEncoder(), s = Promise.resolve(), r = !1, a = (n) => {
    if (r) throw new Dt();
    s = s.then(() => e.write(n)).catch(() => {
      r = !0;
    });
  };
  return {
    sink: Object.assign((n) => a(i.encode(n)), { writeBytes: (n) => a(n) }),
    close: async () => {
      if (r) {
        await e.close().catch(() => {
        });
        return;
      }
      await s, await e.close().catch(() => {
      });
    },
    done: s,
    isBroken: () => r,
    abort: () => {
      r = !0, e.abort().catch(() => {
      });
    }
  };
}

// mithic/packages/shell/dist/history-expand.js
var Yt = class extends Error {
  token;
  constructor(t) {
    super(`${t}: event not found`), this.name = "HistoryEventNotFound", this.token = t;
  }
};
function $e(t, e) {
  if (!t.includes("!")) return t;
  let i = "", s = 0, r = !1, a = !1;
  for (; s < t.length; ) {
    let n = t[s];
    if (n === "\\" && !r) {
      i += n + (t[s + 1] ?? ""), s += 2;
      continue;
    }
    if (n === "'" && !a) {
      r = !r, i += n, s++;
      continue;
    }
    if (n === '"' && !r) {
      a = !a, i += n, s++;
      continue;
    }
    if (n === "!" && !r) {
      let l = t[s + 1], o = t[s - 1];
      if (l === void 0 || l === " " || l === "	" || l === "=" || l === "(" || o === "$" || o === "{") {
        i += n, s++;
        continue;
      }
      let h = as(t, s), d = ls(h.designator, e);
      if (d === void 0) throw new Yt(t.slice(s, h.next));
      i += d, s = h.next;
      continue;
    }
    i += n, s++;
  }
  return i;
}
function as(t, e) {
  let i = e + 1;
  if (t[i] === "!") return {
    designator: "!!",
    next: i + 1
  };
  if (t[i] === "?") {
    i++;
    let r = t.indexOf("?", i), a = r >= 0 ? r : t.length;
    return {
      designator: "?" + t.slice(i, a),
      next: r >= 0 ? r + 1 : a
    };
  }
  if (t[i] === "-") {
    let r = i + 1;
    for (; r < t.length && /[0-9]/.test(t[r]); ) r++;
    return {
      designator: t.slice(e + 1, r),
      next: r
    };
  }
  if (/[0-9]/.test(t[i] ?? "")) {
    let r = i;
    for (; r < t.length && /[0-9]/.test(t[r]); ) r++;
    return {
      designator: t.slice(e + 1, r),
      next: r
    };
  }
  let s = i;
  for (; s < t.length && !/[\s'"`;&|<>()$!]/.test(t[s]); ) s++;
  return {
    designator: t.slice(e + 1, s),
    next: s
  };
}
function ls(t, e) {
  if (e.length !== 0) {
    if (t === "!!") return e[e.length - 1];
    if (t.startsWith("?")) {
      let i = t.slice(1);
      for (let s = e.length - 1; s >= 0; s--) if (e[s].includes(i)) return e[s];
      return;
    }
    if (t.startsWith("-")) {
      let i = parseInt(t.slice(1), 10);
      if (!Number.isFinite(i) || i <= 0) return;
      let s = e.length - i;
      return s >= 0 ? e[s] : void 0;
    }
    if (/^[0-9]+$/.test(t)) {
      let i = parseInt(t, 10);
      return i >= 1 && i <= e.length ? e[i - 1] : void 0;
    }
    for (let i = e.length - 1; i >= 0; i--) if (e[i].startsWith(t)) return e[i];
  }
}

// mithic/packages/shell/dist/environment.js
var M = [
  "5",
  "3",
  "0",
  "1",
  "release",
  "mithic"
], os = `${M[0]}.${M[1]}.${M[2]}(${M[3]})-${M[4]}`;
function Mt(t) {
  return !Number.isFinite(t) || t < 0 || t === 0 || t >= 1e3 ? 1 : t + 1;
}
var He = class Ve {
  context;
  host;
  randomBox;
  overlayVars;
  constructor(e, i, s, r) {
    this.context = e, this.host = i, this.randomBox = s ?? { state: BigInt(Date.now()) ^ 11400714819323198485n }, this.overlayVars = r;
  }
  get vars() {
    return this.overlayVars ?? this.context.env;
  }
  get arrays() {
    return this.host.arrays();
  }
  get assocArrays() {
    return this.host.assocArrays();
  }
  child(e) {
    let i = this.vars, s = new Proxy({
      ...i,
      ...e
    }, {
      get: (r, a) => r[a],
      set: (r, a, n) => (r[a] = n, i[a] = n, !0),
      has: (r, a) => a in r,
      deleteProperty: (r, a) => (delete r[a], !0)
    });
    return new Ve(this.context, this.host, this.randomBox, s);
  }
  nextRandom() {
    return this.randomBox.state = this.randomBox.state * 6364136223846793005n + 1442695040888963407n & 18446744073709551615n, Number((this.randomBox.state >> 33n) % 32768n);
  }
  seedRandom(e) {
    this.randomBox.state = BigInt(e >>> 0);
  }
  deref(e) {
    return this.host.resolveNameref?.(e) ?? e;
  }
  resolveNameref(e) {
    return this.host.resolveNameref?.(e);
  }
  get(e) {
    if (e = this.deref(e), e !== "RANDOM") return this.vars[e];
  }
  set(e, i) {
    if (e = this.deref(e), e === "RANDOM") {
      let s = parseInt(i, 10);
      Number.isNaN(s) || this.seedRandom(s);
      return;
    }
    if (e === "SHLVL") {
      let s = parseInt(i, 10);
      this.vars.SHLVL = String(Mt(Number.isNaN(s) ? 0 : s));
      return;
    }
    e === "BASH_VERSION" || e === "BASH_VERSINFO" || (this.vars[e] = i);
  }
  has(e) {
    return e = this.deref(e), e === "RANDOM" || e === "BASH_VERSION" || e === "BASH_VERSINFO" ? !0 : e in this.vars;
  }
  getArray(e) {
    if (e = this.deref(e), e === "BASH_VERSINFO") return [...M];
    if (e === "FUNCNAME") {
      let i = this.host.funcNameStack?.();
      return i && i.length > 0 ? [...i] : void 0;
    }
    if (e === "BASH_REMATCH") {
      let i = this.host.bashRematch?.();
      return i && i.length > 0 ? [...i] : void 0;
    }
    return this.arrays.get(e);
  }
  setArrayElement(e, i, s) {
    e = this.deref(e);
    let r = this.arrays.get(e) ?? [], a = i < 0 ? r.length + i : i;
    a < 0 && (a = 0), r[a] = s, this.arrays.set(e, r);
  }
  getAssoc(e) {
    return this.assocArrays.get(this.deref(e));
  }
  get cwd() {
    return this.context.cwd;
  }
  getSpecial(e) {
    switch (e) {
      case "?":
        return String(this.host.lastStatus());
      case "#":
        return String((this.context.positional ?? []).length);
      case "$":
        return String(this.context.pid ?? 0);
      case "!":
        return this.host.lastBgPid() === 0 ? "" : String(this.host.lastBgPid());
      case "-":
        return this.host.currentFlags();
      case "0":
        return this.context.name ?? "sh";
      case "@":
      case "*":
        return (this.context.positional ?? []).join(" ");
      case "PIPESTATUS":
        return this.host.pipeStatus().join(" ");
      case "LINENO":
        return String(this.host.currentLine());
      case "RANDOM":
        return String(this.nextRandom());
      case "BASH_VERSION":
        return os;
      case "BASH_VERSINFO":
        return M[0];
      case "FUNCNAME":
        return this.host.funcNameStack?.()[0];
      case "BASH_REMATCH":
        return this.host.bashRematch?.()[0] ?? void 0;
      case "_":
        return this.host.lastArg?.();
      case "SECONDS": {
        let i = this.host.secondsElapsed?.();
        return i === void 0 ? void 0 : String(i);
      }
    }
    if (/^[1-9][0-9]*$/.test(e)) return (this.context.positional ?? [])[parseInt(e, 10) - 1];
  }
  getPositional() {
    return this.context.positional ?? [];
  }
  names() {
    return [.../* @__PURE__ */ new Set([...Object.keys(this.vars), ...this.arrays.keys()])];
  }
  attrFlags(e) {
    return this.host.attrFlags?.(e) ?? "";
  }
  isReadonly(e) {
    return this.host.isReadonly?.(this.deref(e)) ?? !1;
  }
  warn(e) {
    this.host.warn?.(e);
  }
  nounset() {
    return this.host.nounset();
  }
  posix() {
    return this.host.posix();
  }
  shopt(e) {
    return this.host.shopt(e);
  }
  runCommandSub(e) {
    return this.host.runCommandSub(e);
  }
  listDir(e) {
    return this.host.listDir(e);
  }
  statPath(e) {
    return this.host.statPath(e);
  }
  procSub(e, i) {
    return this.host.procSub(e, i);
  }
};

// mithic/packages/shell/dist/job-controller.js
var De = class {
  jobs = [];
  nextJobId = 1;
  lastBg = 0;
  kill;
  constructor(t) {
    this.kill = t;
  }
  setKill(t) {
    this.kill = t;
  }
  list() {
    return this.jobs;
  }
  lastBgPid() {
    return this.lastBg;
  }
  setLastBgPid(t) {
    this.lastBg = t;
  }
  allocId() {
    return this.nextJobId++;
  }
  register(t, e = []) {
    let i = {
      id: this.allocId(),
      pids: e,
      command: t,
      state: "running"
    };
    return this.jobs.push(i), i;
  }
  async waitJob(t) {
    if (t === void 0) return this.waitAll();
    let e = this.jobs.find((i) => i.pids.includes(t) || i.id === t);
    return e ? e.promise ? await e.promise ?? 0 : e.exitCode ?? 0 : 0;
  }
  async waitAll() {
    let t = 0;
    for (let e of this.jobs) e.promise && (t = await e.promise ?? 0);
    return t;
  }
  async waitNext() {
    if (this.jobs.length === 0) return 127;
    let t = this.jobs.map((e) => ({
      job: e,
      p: e.promise
    })).filter((e) => e.p !== void 0);
    return t.length === 0 ? this.jobs.shift().exitCode ?? 0 : await Promise.race(t.map((e) => e.p.then((i) => ({
      job: e.job,
      c: i
    })))).then((e) => (this.jobs = this.jobs.filter((i) => i !== e.job), e.c ?? 0));
  }
  remove(t) {
    let e = this.jobs.findIndex((i) => i.id === t || i.pids.includes(t));
    return e < 0 ? !1 : (this.jobs.splice(e, 1), !0);
  }
  killJob(t, e) {
    let i = this.jobs.find((s) => s.id === t || s.pids.includes(t));
    if (!i) return !1;
    if (this.kill) {
      let s = e.startsWith("SIG") ? e : "SIG" + e;
      for (let r of i.pids) try {
        this.kill(r, s);
      } catch {
      }
    }
    return e === "CONT" ? i.state = "running" : e === "STOP" || e === "TSTP" ? i.state = "stopped" : i.state = "done", !0;
  }
};

// mithic/packages/shell/dist/executor.js
var Ye = class extends Error {
  code;
  constructor(t) {
    super("exit"), this.code = t;
  }
}, W = class extends Error {
  count;
  constructor(t) {
    super("break"), this.count = t;
  }
}, T = class extends Error {
  count;
  constructor(t) {
    super("continue"), this.count = t;
  }
}, at = class extends Error {
  code;
  constructor(t) {
    super("return"), this.code = t;
  }
}, z = class extends Error {
}, zt = 128, Ut = () => new Promise((t) => {
  setTimeout(t, 0);
}), jt = /* @__PURE__ */ Symbol("stdinReader"), lt = /* @__PURE__ */ Symbol("stdinPendingLine");
function R(t) {
  return new ReadableStream({ start(e) {
    t.byteLength > 0 && e.enqueue(t), e.close();
  } });
}
var qt = class {
  context;
  environment;
  kernel;
  resolve;
  fs;
  rootStdinStream;
  stdinDupFds = /* @__PURE__ */ new Map();
  lastStatus = 0;
  pipeStatus = [];
  currentLine = 0;
  jobControl;
  lastCmdSubStatus;
  exiting;
  io;
  functions = /* @__PURE__ */ new Map();
  arrays = /* @__PURE__ */ new Map();
  localScopes = [];
  localSaved = [];
  localSavedArrays = [];
  readonlyNames = /* @__PURE__ */ new Set();
  integerNames = /* @__PURE__ */ new Set();
  exportedNames = /* @__PURE__ */ new Set();
  caseFoldNames = /* @__PURE__ */ new Map();
  declaredUnset = /* @__PURE__ */ new Map();
  bashRematch = [];
  lastArgValue = "";
  startTimeMs = Date.now();
  namerefs = /* @__PURE__ */ new Map();
  dirStackBelow = [];
  options = {
    errexit: !1,
    nounset: !1,
    xtrace: !1,
    pipefail: !1,
    noclobber: !1,
    verbose: !1,
    posix: !1,
    histexpand: !1
  };
  shoptStore = {
    dotglob: !1,
    extglob: !1,
    globstar: !1,
    nocaseglob: !1,
    nocasematch: !1,
    nullglob: !1
  };
  traps = /* @__PURE__ */ new Map();
  inDebugTrap = !1;
  funcStack = [];
  historyLines = [];
  fdTable = /* @__PURE__ */ new Map();
  procSubSeq = 0;
  pendingProcSubs = [];
  assocArrays = /* @__PURE__ */ new Map();
  constructor(t, e, i = {}) {
    this.kernel = t, this.context = e, e.interactive && (this.options.histexpand = !0), this.resolve = i.resolve ?? ((l) => l), this.fs = i.fs, this.rootStdinStream = i.stdinStream;
    let s = A(i.onStdout ?? ((l) => {
      typeof process < "u" && process.stdout && process.stdout.write(l);
    })), r = A(i.onStderr ?? ((l) => {
      typeof process < "u" && process.stderr && process.stderr.write(l);
    }));
    this.io = {
      stdout: s,
      stderr: r,
      stdin: i.stdinStream,
      fdTable: this.fdTable
    }, this.jobControl = new De(t.kill ? (l, o) => t.kill(l, o) : void 0);
    let a = {
      lastStatus: () => this.lastStatus,
      lastBgPid: () => this.jobControl.lastBgPid(),
      pipeStatus: () => this.pipeStatus,
      currentLine: () => this.currentLine,
      currentFlags: () => this.currentFlags(),
      arrays: () => this.arrays,
      assocArrays: () => this.assocArrays,
      nounset: () => this.options.nounset,
      posix: () => this.options.posix,
      shopt: (l) => this.shoptStore[l] ?? !1,
      runCommandSub: (l) => this.runCommandSub(l),
      listDir: (l) => this.listDir(l),
      statPath: (l) => this.statPath(l),
      procSub: (l, o) => this.procSub(l, o),
      resolveNameref: (l) => this.namerefs.get(l),
      attrFlags: (l) => {
        let o = "";
        return this.assocArrays.has(l) ? o += "A" : this.arrays.has(l) && (o += "a"), this.integerNames.has(l) && (o += "i"), this.namerefs.has(l) && (o += "n"), this.readonlyNames.has(l) && (o += "r"), this.exportedNames.has(l) && (o += "x"), o;
      },
      isReadonly: (l) => this.readonlyNames.has(l),
      warn: (l) => this.io.stderr(`shell: ${l}
`),
      funcNameStack: () => this.funcStack,
      bashRematch: () => this.bashRematch,
      lastArg: () => this.lastArgValue,
      secondsElapsed: () => Math.floor((Date.now() - this.startTimeMs) / 1e3)
    };
    this.environment = new He(this.context, a);
    let n = parseInt(this.context.env.SHLVL ?? "", 10);
    this.context.env.SHLVL = String(Mt(Number.isNaN(n) ? 0 : n));
  }
  async procSub(t, e) {
    let i = `/tmp/.mithic-procsub-${this.procSubSeq++}`;
    if (!this.fs) return "/dev/null";
    if (e === "in") {
      let s = await this.runCommandSubRaw(t), r = this.fs.fsOpen(i, {
        write: !0,
        create: !0,
        truncate: !0
      });
      this.fs.fsWrite(r, s), this.fs.fsClose(r);
    } else {
      let s = this.fs.fsOpen(i, {
        write: !0,
        create: !0,
        truncate: !0
      });
      this.fs.fsWrite(s, ""), this.fs.fsClose(s), this.pendingProcSubs.push({
        path: i,
        src: t
      });
    }
    return i;
  }
  inheritedSubStdin() {
    return this.io.stdin === this.rootStdinStream ? void 0 : this.io.stdin;
  }
  async runCommandSubRaw(t) {
    let e = "", i = this.deriveIo(this.io, {
      stdout: (s) => {
        e += s;
      },
      stdin: this.inheritedSubStdin()
    });
    return await this.run(this.parseSrc(t), !0, i), e;
  }
  async flushPendingProcSubs() {
    if (this.pendingProcSubs.length === 0 || !this.fs) return;
    let t = this.pendingProcSubs;
    this.pendingProcSubs = [];
    let e = new TextEncoder();
    for (let { path: i, src: s } of t) {
      let r = "";
      try {
        r = await Promise.resolve(this.fs.fsRead(this.fs.fsOpen(i, { read: !0 })));
      } catch {
        r = "";
      }
      let a = this.deriveIo(this.io, { stdin: R(e.encode(r)) });
      await this.run(this.parseSrc(s), !0, a);
    }
  }
  globMatchOpts() {
    return {
      extglob: this.shoptStore.extglob,
      nocase: this.shoptStore.nocasematch,
      pathSegment: !1
    };
  }
  currentFlags() {
    let t = "";
    for (let [e, i] of Object.entries(Ot)) this.options[i] && (t += e);
    return t;
  }
  parseSrc(t) {
    return nt(t, { posix: this.options.posix });
  }
  setOption(t, e) {
    this.options[t] = e, this.syncShellOpts();
  }
  getOption(t) {
    return this.options[t];
  }
  setShopt(t, e) {
    t in this.shoptStore && (this.shoptStore[t] = e, this.syncBashOpts());
  }
  async sourceFile(t) {
    let e = t[0];
    if (e === void 0) return this.writeStderr(`shell: source: filename argument required
`), 2;
    let i = this.fs;
    if (!i) return this.writeStderr(`shell: source: ${e}: cannot read
`), 1;
    let s;
    try {
      let a = e.startsWith("/") ? e : this.absPath(e);
      s = await Promise.resolve(i.fsRead(i.fsOpen(a, { read: !0 })));
    } catch {
      return this.writeStderr(`shell: source: ${e}: No such file or directory
`), 1;
    }
    let r = this.context.positional;
    t.length > 1 && (this.context.positional = t.slice(1));
    try {
      return await this.run(this.parseSrc(s), !0);
    } catch (a) {
      if (a instanceof at) return a.code;
      throw a;
    } finally {
      this.context.positional = r;
    }
  }
  async runTrap(t) {
    let e = this.traps.get(t);
    if (e) try {
      await this.run(this.parseSrc(e), !0);
    } catch {
    }
  }
  async execSelect(t, e) {
    let i = this.expander(), s;
    if (t.words === void 0) s = this.environment.getPositional();
    else {
      s = [];
      for (let c of t.words) s.push(...await i.expandWord(c));
    }
    let r = this.context.env.PS3 ?? "#? ", a = await this.resolveStdinStream(t.redirects ?? []) ?? (e.stdin === this.rootStdinStream ? void 0 : e.stdin), n = a ? new TextDecoder().decode(await new Vt(a).readAll()) : "", l = n.length > 0 ? n.split(`
`) : [];
    l.length > 0 && l[l.length - 1] === "" && l.pop();
    let o = () => {
      for (let c = 0; c < s.length; c++) e.stderr(`${c + 1}) ${s[c]}
`);
    }, h = 0, d = 0, p = !0;
    for (; p &&= (o(), !1), e.stderr(r), !(d >= l.length); ) {
      let c = l[d++];
      if (this.context.env.REPLY = c, c.trim() === "") {
        p = !0;
        continue;
      }
      let u = parseInt(c.trim(), 10);
      this.context.env[t.varName] = Number.isInteger(u) && u >= 1 && u <= s.length ? s[u - 1] : "";
      try {
        h = await this.execList(t.body ?? [], e);
      } catch (f) {
        if (f instanceof W) {
          if (f.count > 1) throw new W(f.count - 1);
          break;
        }
        if (f instanceof T) {
          if (f.count > 1) throw new T(f.count - 1);
          continue;
        }
        throw f;
      }
      if (this.exiting !== void 0) return h;
    }
    return h;
  }
  async runCommandSub(t) {
    let e = "", i = this.deriveIo(this.io, {
      stdout: (r) => {
        e += r;
      },
      stdin: this.inheritedSubStdin()
    }), s = t.match(/^\s*<\s*(\S+)\s*$/);
    return s ? this.lastCmdSubStatus = await this.readFileForCmdSub(s[1], i) : this.lastCmdSubStatus = await this.run(this.parseSrc(t), !0, i), e;
  }
  async readFileForCmdSub(t, e) {
    let i = await this.expander().expandToString(t), s = this.fs;
    if (!s) return 1;
    try {
      let r = await Promise.resolve(s.fsRead(s.fsOpen(i, { read: !0 })));
      return e.stdout(r), 0;
    } catch {
      return e.stderr(`shell: ${i}: No such file or directory
`), 1;
    }
  }
  async listDir(t) {
    if (this.fs?.fsReaddir) try {
      return await this.fs.fsReaddir(t);
    } catch {
      return;
    }
  }
  async statPath(t) {
    if (this.fs?.fsStat) try {
      let e = await this.fs.fsStat(t);
      return e ? {
        dir: e.dir,
        type: e.type,
        size: e.size,
        mode: e.mode,
        mtimeMs: e.mtimeMs
      } : void 0;
    } catch {
      return;
    }
  }
  async resolveExternalPath(t) {
    if (!this.fs?.fsStat) return;
    let e = async (s) => {
      let r = await this.statPath(s);
      return r !== void 0 && !r.dir;
    };
    if (t.startsWith("/") || t.startsWith("./") || t.startsWith("../")) {
      let s = this.absPath(t);
      return await e(s) ? s : void 0;
    }
    let i = this.context.env.PATH ?? "/usr/bin:/bin";
    for (let s of i.split(":")) {
      if (s === "") continue;
      let r = (s.endsWith("/") ? s.slice(0, -1) : s) + "/" + t;
      if (await e(r)) return r;
    }
  }
  expander() {
    return new j(this.environment);
  }
  stdinReaderFor(t) {
    if (!t.stdin) return;
    let e = t;
    return e[jt] ??= new Vt(t.stdin);
  }
  stdinReaderExists(t) {
    return t[jt] !== void 0;
  }
  resetStdinReader(t) {
    let e = t;
    delete e[jt], delete e[lt];
  }
  shellState() {
    return {
      functions: this.functions,
      jobs: this.jobControl.list(),
      positional: this.context.positional ?? [],
      setPositional: (t) => {
        this.context.positional = t;
      },
      shiftPositional: (t) => {
        let e = this.context.positional ?? [];
        this.context.positional = e.slice(t);
      },
      declareLocal: (t) => this.declareLocal(t),
      declareAssoc: (t, e) => {
        if (e) {
          for (let s = 0; s < this.localScopes.length; s++) if (this.localScopes[s].has(t)) {
            let r = this.localSavedArrays[s].get(t), a = r?.assoc ?? /* @__PURE__ */ new Map();
            r === void 0 ? this.localSavedArrays[s].set(t, {
              assoc: a,
              integer: !1,
              readonly: !1
            }) : (r.assoc = a, r.arr = void 0);
            return;
          }
        }
        this.assocArrays.has(t) || this.assocArrays.set(t, /* @__PURE__ */ new Map());
        let i = this.assocArrays.get(t);
        t in this.context.env ? i.set("0", this.context.env[t]) : this.arrays.has(t) && this.arrays.get(t).forEach((s, r) => {
          r in this.arrays.get(t) && i.set(String(r), s);
        }), delete this.context.env[t], this.arrays.delete(t);
      },
      declareArray: (t) => {
        if (this.arrays.has(t)) return;
        let e = [];
        t in this.context.env && (e[0] = this.context.env[t]), this.arrays.set(t, e), delete this.context.env[t];
      },
      setArray: (t, e) => {
        this.arrays.set(t, e), delete this.context.env[t], this.clearDeclaredUnset(t);
      },
      setArrayFrom: (t, e, i) => {
        let s = this.arrays.get(t);
        s === void 0 && (s = [], t in this.context.env && (s[0] = this.context.env[t]));
        for (let r = 0; r < e.length; r++) s[i + r] = e[r];
        this.arrays.set(t, s), delete this.context.env[t], this.clearDeclaredUnset(t);
      },
      predeclare: (t, e) => this.predeclare(t, e),
      clearDeclaredUnset: (t) => this.clearDeclaredUnset(t),
      waitJob: (t) => this.jobControl.waitJob(t),
      waitAll: () => this.jobControl.waitAll(),
      waitNext: () => this.jobControl.waitNext(),
      setErrExit: (t) => {
        this.options.errexit = t;
      },
      setOption: (t, e) => {
        this.options[t] = e, (t === "errexit" || t === "pipefail" || t === "posix" || t === "verbose" || t === "xtrace" || t === "noclobber" || t === "nounset") && this.syncShellOpts();
      },
      getOption: (t) => this.options[t],
      listOptions: () => _.map((t) => [t, this.options[t]]),
      setShopt: (t, e) => t in this.shoptStore ? (this.shoptStore[t] = e, this.syncBashOpts(), !0) : !1,
      getShopt: (t) => t in this.shoptStore ? this.shoptStore[t] : void 0,
      setTrap: (t, e) => {
        e === void 0 ? this.traps.delete(t) : this.traps.set(t, e);
      },
      listTraps: () => [...this.traps.entries()],
      history: {
        list: () => this.historyLines,
        add: (t) => this.addHistory(t),
        clear: () => {
          this.historyLines = [];
        }
      },
      removeJob: (t) => this.jobControl.remove(t),
      killJob: (t, e) => this.jobControl.killJob(t, e),
      markReadonly: (t) => {
        this.readonlyNames.add(t);
      },
      markGlobalReadonly: (t) => this.markGlobalReadonly(t),
      isReadonly: (t) => this.readonlyNames.has(t),
      isGlobalReadonly: (t) => this.isGlobalReadonly(t),
      unsetVar: (t, e) => this.unsetVar(t, e),
      markInteger: (t) => {
        this.integerNames.add(t);
      },
      markGlobalInteger: (t) => this.markGlobalInteger(t),
      isInteger: (t) => this.integerNames.has(t),
      markCaseFold: (t, e) => {
        e === void 0 ? this.caseFoldNames.delete(t) : this.caseFoldNames.set(t, e);
      },
      caseFoldOf: (t) => this.caseFoldNames.get(t),
      globalCaseFoldOf: (t) => this.globalCaseFoldOf(t),
      markGlobalCaseFold: (t, e) => this.markGlobalCaseFold(t, e),
      markExport: (t) => {
        this.exportedNames.add(t);
      },
      declareP: (t) => this.declareP(t),
      declarePByAttr: (t) => this.declarePByAttr(t),
      setNameref: (t, e) => {
        this.namerefs.set(t, e);
      },
      resolveNameref: (t) => this.namerefs.get(t),
      setGlobal: (t, e) => this.setGlobal(t, e),
      getGlobal: (t) => this.getGlobal(t),
      dirStack: () => this.dirStackBelow
    };
  }
  expandHistoryStage(t) {
    if (!t.includes("!")) return t;
    let e = [...this.historyLines];
    return t.split(`
`).map((i) => {
      let s = $e(i, e);
      return i.trim() !== "" && e.push(s), s;
    }).join(`
`);
  }
  addHistory(t) {
    if (t.trim() === "") return;
    this.historyLines.push(t);
    let e = parseInt(this.context.env.HISTSIZE ?? "500", 10), i = Number.isFinite(e) && e >= 0 ? e : 500;
    this.historyLines.length > i && this.historyLines.splice(0, this.historyLines.length - i);
  }
  syncShellOpts() {
    let t = _.filter((e) => this.options[e]);
    this.context.env.SHELLOPTS = t.join(":");
  }
  syncBashOpts() {
    let t = wt.filter((e) => this.shoptStore[e]);
    this.context.env.BASHOPTS = t.join(":");
  }
  isGlobalReadonly(t) {
    for (let e = 0; e < this.localScopes.length; e++) if (this.localScopes[e].has(t)) return this.localSavedArrays[e].get(t)?.readonly ?? !1;
    return this.readonlyNames.has(t);
  }
  globalCaseFoldOf(t) {
    for (let e = 0; e < this.localScopes.length; e++) if (this.localScopes[e].has(t)) return this.localSavedArrays[e].get(t)?.caseFold;
    return this.caseFoldNames.get(t);
  }
  markGlobalCaseFold(t, e) {
    for (let i = 0; i < this.localScopes.length; i++) if (this.localScopes[i].has(t)) {
      let s = this.localSavedArrays[i].get(t);
      s === void 0 ? this.localSavedArrays[i].set(t, {
        integer: !1,
        readonly: !1,
        caseFold: e
      }) : s.caseFold = e;
      return;
    }
    e === void 0 ? this.caseFoldNames.delete(t) : this.caseFoldNames.set(t, e);
  }
  markGlobalInteger(t) {
    for (let e = 0; e < this.localScopes.length; e++) if (this.localScopes[e].has(t)) {
      let i = this.localSavedArrays[e].get(t);
      i === void 0 ? this.localSavedArrays[e].set(t, {
        integer: !0,
        readonly: !1
      }) : i.integer = !0;
      return;
    }
    this.integerNames.add(t);
  }
  markGlobalReadonly(t) {
    for (let e = 0; e < this.localScopes.length; e++) if (this.localScopes[e].has(t)) {
      let i = this.localSavedArrays[e].get(t);
      i === void 0 ? this.localSavedArrays[e].set(t, {
        integer: !1,
        readonly: !0
      }) : i.readonly = !0;
      return;
    }
    this.readonlyNames.add(t);
  }
  setGlobal(t, e) {
    for (let i = 0; i < this.localScopes.length; i++) if (this.localScopes[i].has(t)) return this.localSaved[i].set(t, e), !0;
    return this.context.env[t] = e, !1;
  }
  getGlobal(t) {
    for (let e = 0; e < this.localScopes.length; e++) if (this.localScopes[e].has(t)) return this.localSaved[e].get(t);
    return this.context.env[t];
  }
  predeclare(t, e) {
    t in this.context.env || this.arrays.has(t) && this.arrays.get(t).length > 0 || this.assocArrays.has(t) && this.assocArrays.get(t).size > 0 || (e === "array" && !this.arrays.has(t) ? this.arrays.set(t, []) : e === "assoc" && !this.assocArrays.has(t) && this.assocArrays.set(t, /* @__PURE__ */ new Map()), this.declaredUnset.set(t, e));
  }
  clearDeclaredUnset(t, e = !1) {
    if (e) {
      for (let i = 0; i < this.localScopes.length; i++) if (this.localScopes[i].has(t)) {
        let s = this.localSavedArrays[i].get(t);
        s !== void 0 && (s.declaredUnset = void 0);
        return;
      }
    }
    this.declaredUnset.delete(t);
  }
  declareLocal(t) {
    if (this.localScopes.length === 0) return "none";
    let e = this.localScopes[this.localScopes.length - 1], i = this.localSaved[this.localSaved.length - 1];
    return e.has(t) ? "existing" : (e.add(t), i.set(t, t in this.context.env ? this.context.env[t] : void 0), this.localSavedArrays[this.localSavedArrays.length - 1].set(t, {
      arr: this.arrays.has(t) ? this.arrays.get(t).slice() : void 0,
      assoc: this.assocArrays.has(t) ? new Map(this.assocArrays.get(t)) : void 0,
      integer: this.integerNames.has(t),
      readonly: this.readonlyNames.has(t),
      nameref: this.namerefs.get(t),
      caseFold: this.caseFoldNames.get(t),
      declaredUnset: this.declaredUnset.get(t)
    }), this.arrays.delete(t), this.assocArrays.delete(t), this.integerNames.delete(t), this.readonlyNames.delete(t), this.caseFoldNames.delete(t), this.namerefs.delete(t), this.declaredUnset.delete(t), "fresh");
  }
  async run(t, e = !1, i = this.io) {
    let s = this.io;
    this.io = i;
    try {
      for (let r of t.body) {
        e || this.addHistory(cs(r));
        try {
          this.lastStatus = await this.execStatement(r, i);
        } catch (a) {
          if (a instanceof X) return i.stderr(`shell: ${a.message}
`), this.lastStatus = 1, e || (this.exiting = 1), 1;
          if (a instanceof SyntaxError) return i.stderr(`${a.message}
`), this.lastStatus = 2, e || (this.exiting = 2), 2;
          if (a instanceof q) return i.stderr(`shell: ${a.message}
`), this.lastStatus = a.code, this.exiting = a.code, a.code;
          if (a instanceof W) {
            i.stderr("shell: break: only meaningful in a `for', `while', or `until' loop\n"), this.lastStatus = 1;
            continue;
          }
          if (a instanceof T) {
            i.stderr("shell: continue: only meaningful in a `for', `while', or `until' loop\n"), this.lastStatus = 1;
            continue;
          }
          if (a instanceof at) {
            if (e) throw a;
            i.stderr("shell: return: can only `return' from a function or sourced script\n"), this.lastStatus = 1;
            continue;
          }
          throw a;
        }
        if (this.lastStatus !== 0 && this.traps.has("ERR") && this.exiting === void 0 && await this.runTrap("ERR"), this.exiting !== void 0) return this.exiting;
        if (this.options.errexit && this.lastStatus !== 0 && !e) return this.exiting = this.lastStatus, this.lastStatus;
      }
    } catch (r) {
      if (r instanceof Ye) return r.code;
      throw r;
    } finally {
      this.io = s;
    }
    return this.lastStatus;
  }
  async runTop(t) {
    let e;
    try {
      e = await this.run(t, !1);
    } finally {
      await this.runTrap("EXIT");
    }
    return e;
  }
  async exec(t) {
    if (this.options.histexpand) try {
      t = this.expandHistoryStage(t);
    } catch (i) {
      if (i instanceof Yt) return this.writeStderr(`shell: ${i.message}
`), this.lastStatus = 1, 1;
      throw i;
    }
    let e;
    try {
      e = this.parseSrc(t);
    } catch (i) {
      if (i instanceof SyntaxError) return this.writeStderr(`${i.message}
`), await this.runTrap("EXIT"), 2;
      throw i;
    }
    return this.runTop(e);
  }
  async execStatement(t, e) {
    switch (this.io = e, t.line !== void 0 && (this.currentLine = t.line), t.type) {
      case "Pipeline":
        return this.withRedirects(t, e, (i) => this.execPipeline(t, i));
      case "And": {
        let i = await this.execStatement(t.left, e);
        return this.exiting === void 0 && i === 0 ? this.execStatement(t.right, e) : i;
      }
      case "Or": {
        let i = await this.execStatement(t.left, e);
        return this.exiting === void 0 ? i === 0 ? i : this.execStatement(t.right, e) : i;
      }
      case "If":
        return this.execIf(t, e);
      case "While":
        return this.withRedirects(t, e, (i) => this.execWhile(t, i));
      case "For":
        return this.withRedirects(t, e, (i) => this.execFor(t, i));
      case "Select":
        return this.withRedirects(t, e, (i) => this.execSelect(t, i));
      case "Case":
        return this.execCase(t, e);
      case "Function":
        return this.functions.set(t.funcName, {
          name: t.funcName,
          body: t.funcBody
        }), 0;
      case "Subshell":
        return this.execSubshell(t, e);
      case "Group":
        return this.withRedirects(t, e, (i) => this.execList(t.body ?? [], i));
      case "Coproc":
        return this.execCoproc(t, e);
      case "Arithmetic":
        return this.execArithCmd(t);
      case "Cond":
        return this.execCond(t);
      default:
        return 0;
    }
  }
  async execList(t, e) {
    let i = 0;
    for (let s of t) if (i = await this.execStatement(s, e), this.lastStatus = i, this.exiting !== void 0) return i;
    return i;
  }
  async execIf(t, e) {
    let i = await this.execList(t.condition ?? [], e);
    return this.exiting === void 0 ? i === 0 ? this.execList(t.then ?? [], e) : t.else ? this.execList(t.else, e) : 0 : i;
  }
  async execWhile(t, e) {
    let i = 0, s = t.until === !0, r = 0;
    for (; ; ) {
      let a = await this.execList(t.condition ?? [], e);
      if (this.exiting !== void 0) return a;
      if (!(s ? a !== 0 : a === 0)) break;
      try {
        i = await this.execList(t.body ?? [], e);
      } catch (n) {
        if (n instanceof W) {
          if (n.count > 1) throw new W(n.count - 1);
          break;
        }
        if (n instanceof T) {
          if (n.count > 1) throw new T(n.count - 1);
          continue;
        }
        throw n;
      }
      if (this.exiting !== void 0) return i;
      ++r % zt === 0 && await Ut();
    }
    return i;
  }
  async execFor(t, e) {
    if (t.arithFor) return this.execArithFor(t, e);
    let i = 0, s = this.expander(), r;
    if (t.words === void 0) r = this.environment.getPositional();
    else {
      r = [];
      for (let n of t.words) r.push(...await s.expandWord(n));
    }
    if (this.readonlyNames.has(t.varName)) {
      let n = `${t.varName}: readonly variable`;
      if (this.options.posix) throw new q(t.varName, 1, n);
      return e.stderr(`shell: ${n}
`), this.lastStatus = 1, 1;
    }
    let a = 0;
    for (let n of r) {
      this.context.env[t.varName] = n;
      try {
        i = await this.execList(t.body ?? [], e);
      } catch (l) {
        if (l instanceof W) {
          if (l.count > 1) throw new W(l.count - 1);
          break;
        }
        if (l instanceof T) {
          if (l.count > 1) throw new T(l.count - 1);
          continue;
        }
        throw l;
      }
      if (this.exiting !== void 0) return i;
      ++a % zt === 0 && await Ut();
    }
    return i;
  }
  async execArithFor(t, e) {
    let i = 0, s = /* @__PURE__ */ new Set(), r = this.arithEnvForExpr(s), a = this.arithArrayAccessExec();
    if (t.arithInit && J(t.arithInit, r, a), s.size > 0) return 1;
    let n = t.arithCond ?? "", l = 0;
    for (; !(n !== "" && J(n, r, a) === 0n || ++l > 1e6); ) {
      try {
        i = await this.execList(t.body ?? [], e);
      } catch (o) {
        if (o instanceof W) {
          if (o.count > 1) throw new W(o.count - 1);
          break;
        }
        if (o instanceof T) {
          if (o.count > 1) throw new T(o.count - 1);
        } else throw o;
      }
      if (this.exiting !== void 0) return i;
      if (t.arithIncr && J(t.arithIncr, r, a), s.size > 0) break;
      l % zt === 0 && await Ut();
    }
    return i;
  }
  arithEnvForExpr(t) {
    let e = /* @__PURE__ */ new Set();
    return new Proxy({}, {
      get: (i, s) => this.context.env[s] ?? this.arrays.get(s)?.[0] ?? "",
      set: (i, s, r) => this.readonlyNames.has(s) ? (t?.add(s), e.has(s) || (e.add(s), this.io.stderr(`shell: ${s}: readonly variable
`)), !0) : (this.context.env[s] = String(r), !0),
      has: (i, s) => s in this.context.env || this.arrays.get(s) !== void 0
    });
  }
  unsetVar(t, e) {
    if (e !== void 0) {
      let i = this.assocArrays.get(t);
      if (i !== void 0) {
        i.delete(e);
        return;
      }
      let s = this.arrays.get(t);
      if (s !== void 0) {
        let r = /^-?\d+$/.test(e.trim()) ? parseInt(e.trim(), 10) : (() => {
          try {
            return Number(J(e, this.arithEnvForExpr(), this.arithArrayAccessExec()));
          } catch {
            return 0;
          }
        })(), a = r < 0 ? s.length + r : r;
        delete s[a];
      }
      return;
    }
    delete this.context.env[t], this.arrays.delete(t), this.assocArrays.delete(t), this.integerNames.delete(t), this.caseFoldNames.delete(t), this.namerefs.delete(t), this.declaredUnset.delete(t), this.exportedNames.delete(t);
  }
  arithArrayAccessExec() {
    return {
      getElement: (t, e) => {
        let i = this.arrays.get(t);
        if (i) return i[e < 0 ? i.length + e : e];
      },
      setElement: (t, e, i) => {
        if (this.readonlyNames.has(t)) {
          this.io.stderr(`shell: ${t}: readonly variable
`);
          return;
        }
        let s = this.arrays.get(t) ?? [], r = e < 0 ? s.length + e : e;
        r < 0 && (r = 0), s[r] = i, this.arrays.set(t, s);
      },
      isAssoc: (t) => this.assocArrays.has(t),
      getAssocElement: (t, e) => this.assocArrays.get(t)?.get(e),
      setAssocElement: (t, e, i) => {
        if (this.readonlyNames.has(t)) {
          this.io.stderr(`shell: ${t}: readonly variable
`);
          return;
        }
        let s = this.assocArrays.get(t) ?? /* @__PURE__ */ new Map();
        s.set(e, i), this.assocArrays.set(t, s);
      }
    };
  }
  async execCase(t, e) {
    let i = this.expander(), s = await i.expandToString(t.caseWord), r = t.clauses ?? [], a = 0, n = 0;
    for (; n < r.length; ) {
      let l = r[n], o = !1;
      for (let d of l.patterns) if (ut(s, await i.expandToString(d), this.globMatchOpts())) {
        o = !0;
        break;
      }
      if (!o) {
        n++;
        continue;
      }
      a = await this.execList(l.body, e);
      let h = l;
      for (; h.fallthrough && n + 1 < r.length; ) n++, h = r[n], a = await this.execList(h.body, e);
      if (h.continueMatch) {
        n++;
        continue;
      }
      break;
    }
    return a;
  }
  async execSubshell(t, e) {
    let i = { ...this.context.env }, s = this.context.cwd, r = this.context.positional ? [...this.context.positional] : void 0, a = { ...this.options }, n = { ...this.shoptStore }, l = new Map(this.functions), o = new Map(this.arrays), h = this.exiting;
    this.exiting = void 0;
    let d = this.deriveIo(e, {}, !0);
    try {
      let p;
      try {
        p = await this.applyRedirects(t.redirects ?? [], d, !0);
      } catch (u) {
        if (u instanceof z) return this.onRedirectError(void 0, u, d);
        throw u;
      }
      let c;
      try {
        c = await this.execList(t.body ?? [], d);
      } finally {
        p();
      }
      return this.exiting !== void 0 && (c = this.exiting), c;
    } catch (p) {
      if (p instanceof W || p instanceof T) return 0;
      if (p instanceof at || p instanceof Ye) return p.code;
      throw p;
    } finally {
      this.context.env = i, this.context.cwd = s, this.context.positional = r, this.options = a, this.shoptStore = n, this.functions = l, this.arrays = o, this.exiting = h;
    }
  }
  async execArithCmd(t) {
    let e = this.expander(), i;
    try {
      i = await e.expandToString("$(( " + (t.expr ?? "0") + " ))");
    } catch (s) {
      return this.io.stderr(`shell: ((: ${s instanceof X ? s.message.replace(/^arith: /, "") : String(s)}
`), 1;
    }
    return +((parseInt(i, 10) || 0) === 0);
  }
  async execCond(t) {
    let e = this.expander(), i = t.condWords ?? [], s = [], r = [], a = [];
    for (let l = 0; l < i.length; l++) {
      let o = i[l], h = await e.expandToString(o);
      s.push(h), r.push(i[l - 1] === "=~" ? await e.expandRegexOperand(o) : void 0), a.push(o === h && !/[$`'"\\]/.test(o));
    }
    let n = t.condGroup ?? s.map(() => !1);
    try {
      return this.validateCond(s, n, a), +!await this.evalConditional(s, n, r, a);
    } catch (l) {
      if (l instanceof k) return this.io.stderr(`shell: ${l.message}
`), 2;
      throw l;
    }
  }
  validateCond(t, e, i) {
    let s = (h, d) => t[h] === d && (i.length === 0 || i[h]), r = (h) => i.length === 0 || i[h], a = 0;
    for (let h = 0; h < t.length; h++) if (e[h] && t[h] === "(") a++;
    else if (e[h] && t[h] === ")" && (a--, a < 0)) throw new k("syntax error near `)'");
    if (a !== 0) throw new k("syntax error near `('");
    let n = (h) => {
      let d = 0, p = -1;
      for (let c = 0; c < t.length; c++) e[c] && t[c] === "(" ? d++ : e[c] && t[c] === ")" ? d-- : d === 0 && t[c] === h && (p = c);
      return p;
    }, l = n("||");
    if (l >= 0) {
      if (l === 0 || l === t.length - 1) throw new k("syntax error near `||'");
      this.validateCond(t.slice(0, l), e.slice(0, l), i.slice(0, l)), this.validateCond(t.slice(l + 1), e.slice(l + 1), i.slice(l + 1));
      return;
    }
    let o = n("&&");
    if (o >= 0) {
      if (o === 0 || o === t.length - 1) throw new k("syntax error near `&&'");
      this.validateCond(t.slice(0, o), e.slice(0, o), i.slice(0, o)), this.validateCond(t.slice(o + 1), e.slice(o + 1), i.slice(o + 1));
      return;
    }
    if (t[0] === "!") {
      if (t.length === 1) throw new k("syntax error near `!'");
      this.validateCond(t.slice(1), e.slice(1), i.slice(1));
      return;
    }
    if (e[0] && t[0] === "(" && e[t.length - 1] && t[t.length - 1] === ")") {
      this.validateCond(t.slice(1, -1), e.slice(1, -1), i.slice(1, -1));
      return;
    }
    if (t.length === 0) throw new k("syntax error: conditional expression expected");
    if (t.length === 1) {
      if ((V.has(t[0]) || t[0] === "<" || t[0] === ">") && r(0)) throw new k(`unexpected argument to conditional unary operator; syntax error near \`${t[0]}'`);
      return;
    }
    if (t.length === 2) {
      if (V.has(t[0]) && r(0)) return;
      throw new k(`syntax error: \`${t[1]}' unexpected; conditional binary operator expected`);
    }
    if (t.length === 3) {
      if ((V.has(t[0]) || t[0] === "<" || t[0] === ">") && r(0)) throw new k(`syntax error in conditional expression: unexpected token \`${t[2]}'`);
      if ([
        "=~",
        "==",
        "=",
        "!=",
        "<",
        ">",
        "-nt",
        "-ot",
        "-ef",
        "-eq",
        "-ne",
        "-lt",
        "-le",
        "-gt",
        "-ge"
      ].some((h) => s(1, h))) return;
      throw new k(`syntax error: \`${t[1]}' conditional binary operator expected`);
    }
    throw new k(`syntax error near \`${t[1] ?? ""}'`);
  }
  async evalConditional(t, e, i = [], s = []) {
    let r = (h, d) => t[h] === d && (s.length === 0 || s[h]), a = (h) => {
      let d = 0, p = -1;
      for (let c = 0; c < t.length; c++) e[c] && t[c] === "(" ? d++ : e[c] && t[c] === ")" ? d-- : d === 0 && t[c] === h && (p = c);
      return p;
    }, n = a("||");
    if (n >= 0) {
      if (n === 0 || n === t.length - 1) throw new k("syntax error near `||'");
      return await this.evalConditional(t.slice(0, n), e.slice(0, n), i.slice(0, n), s.slice(0, n)) || await this.evalConditional(t.slice(n + 1), e.slice(n + 1), i.slice(n + 1), s.slice(n + 1));
    }
    let l = a("&&");
    if (l >= 0) {
      if (l === 0 || l === t.length - 1) throw new k("syntax error near `&&'");
      return await this.evalConditional(t.slice(0, l), e.slice(0, l), i.slice(0, l), s.slice(0, l)) && await this.evalConditional(t.slice(l + 1), e.slice(l + 1), i.slice(l + 1), s.slice(l + 1));
    }
    if (t[0] === "!") return !await this.evalConditional(t.slice(1), e.slice(1), i.slice(1), s.slice(1));
    if (e[0] && t[0] === "(" && e[t.length - 1] && t[t.length - 1] === ")") return await this.evalConditional(t.slice(1, -1), e.slice(1, -1), i.slice(1, -1), s.slice(1, -1));
    if (t.length === 3 && r(1, "=~")) {
      let h = i[2] ?? t[2];
      if (h === "") throw new k("invalid regular expression; empty (sub)expression");
      let d;
      try {
        d = new RegExp(h);
      } catch {
        throw new k(`invalid regular expression \`${h}'`);
      }
      let p = d.exec(t[0]);
      return this.bashRematch = p ? p.map((c) => c ?? "") : [], p !== null;
    }
    if (t.length === 3 && (r(1, "==") || r(1, "="))) return ut(t[0], t[2], this.globMatchOpts());
    if (t.length === 3 && r(1, "!=")) return !ut(t[0], t[2], this.globMatchOpts());
    if (t.length === 3 && r(1, "<")) return t[0] < t[2];
    if (t.length === 3 && r(1, ">")) return t[0] > t[2];
    if (t.length === 3 && (r(1, "-nt") || r(1, "-ot") || r(1, "-ef"))) return this.condFileTest(t[1], t[0] + "\0" + t[2]);
    if (t.length === 2 && V.has(t[0]) && (s.length === 0 || s[0])) return this.condFileTest(t[0], t[1]);
    if (t.length === 3 && [
      "-eq",
      "-ne",
      "-lt",
      "-le",
      "-gt",
      "-ge"
    ].some((h) => r(1, h))) {
      let h = this.arithArrayAccessExec(), d = this.arithEnvForExpr(), p, c;
      try {
        p = J(t[0], d, h), c = J(t[2], d, h);
      } catch (u) {
        return this.io.stderr(`shell: [[: ${u instanceof Error ? u.message.replace(/^arith: /, "") : String(u)}
`), !1;
      }
      switch (t[1]) {
        case "-eq":
          return p === c;
        case "-ne":
          return p !== c;
        case "-lt":
          return p < c;
        case "-le":
          return p <= c;
        case "-gt":
          return p > c;
        case "-ge":
          return p >= c;
      }
    }
    let o = (h) => s.length === 0 || s[h];
    if (t.length === 0) throw new k("syntax error: conditional expression expected");
    if (t.length === 1) {
      if ((V.has(t[0]) || t[0] === "<" || t[0] === ">") && o(0)) throw new k(`unexpected argument to conditional unary operator; syntax error near \`${t[0]}'`);
      return t[0] !== "";
    }
    throw t.length === 2 ? new k(`syntax error: \`${t[1]}' unexpected; conditional binary operator expected`) : t.length === 3 ? new k(`syntax error: \`${t[1]}' conditional binary operator expected`) : new k(`syntax error near \`${t[1] ?? ""}'`);
  }
  async condFileTest(t, e) {
    if (t === "-z") return e === "";
    if (t === "-n") return e !== "";
    if (t === "-v" || t === "-R") {
      let n = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/s.exec(e);
      if (n === null) return !1;
      let l = n[1], o = n[2];
      if (t === "-R") return this.namerefs.has(l);
      if (o === "@" || o === "*") return (this.arrays.get(l)?.length ?? this.assocArrays.get(l)?.size ?? 0) > 0;
      if (o !== void 0) {
        if (this.assocArrays.has(l)) return this.assocArrays.get(l).has(o);
        let h = this.arrays.get(l);
        return h !== void 0 && h[Number(o)] !== void 0;
      }
      return this.arrays.has(l) ? this.arrays.get(l)[0] !== void 0 : this.assocArrays.has(l) ? this.assocArrays.get(l).has("0") : l in this.context.env || this.namerefs.has(l);
    }
    if (t === "-o") return _.includes(e) && this.options[e];
    if (t === "-nt" || t === "-ot" || t === "-ef") {
      let [n, l] = e.split("\0"), o = n === "" ? void 0 : await this.statPath(this.absPath(n)), h = l === "" ? void 0 : await this.statPath(this.absPath(l));
      if (t === "-ef") return o !== void 0 && h !== void 0 && this.absPath(n) === this.absPath(l);
      let d = o?.mtimeMs, p = h?.mtimeMs;
      return t === "-nt" ? o === void 0 ? !1 : h === void 0 ? !0 : d !== void 0 && p !== void 0 && d > p : h === void 0 ? !1 : o === void 0 ? !0 : d !== void 0 && p !== void 0 && d < p;
    }
    let i = e === "" ? void 0 : await this.statPath(this.absPath(e)), s = i !== void 0, r = (n) => i?.mode !== void 0 && (i.mode & n) !== 0, a = i?.type === "symlink";
    switch (t) {
      case "-f":
        return s && !i.dir && !a;
      case "-d":
        return s && i.dir;
      case "-h":
      case "-L":
        return a;
      case "-e":
      case "-a":
        return s;
      case "-s":
        return s && (i.dir || (i.size ?? 0) > 0);
      case "-r":
        return r(292);
      case "-w":
        return r(146);
      case "-x":
        return s && (i.dir || r(73));
      case "-O":
      case "-G":
      case "-N":
        return s;
      case "-u":
        return r(2048);
      case "-g":
        return r(1024);
      case "-k":
        return r(512);
      case "-b":
        return i?.type === "block-device";
      case "-c":
        return i?.type === "character-device";
      case "-p":
        return i?.type === "fifo";
      case "-S":
        return i?.type === "socket";
      case "-t":
        return !1;
      default:
        return !1;
    }
  }
  absPath(t) {
    return t.startsWith("/") ? t : this.context.cwd.replace(/\/$/, "") + "/" + t;
  }
  async withRedirects(t, e, i) {
    let s = t.redirects;
    if (!s || s.length === 0) return i(e);
    let r;
    try {
      r = await this.applyRedirects(s, e, !0);
    } catch (a) {
      if (a instanceof z) return this.onRedirectError(void 0, a, e);
      throw a;
    }
    try {
      return await i(e);
    } finally {
      r();
    }
  }
  onRedirectError(t, e, i) {
    if (this.options.posix && t !== void 0 && Re.has(t)) throw new q(t, 1, e.message);
    return i.stderr(`shell: ${e.message}
`), 1;
  }
  sinkForFd(t, e) {
    if (t === 1) return e.stdout;
    if (t === 2) return e.stderr;
    let i = e.fdTable.get(t);
    return i?.sink ? i.sink : A(() => {
    });
  }
  setFdSink(t, e, i) {
    let s = A(e);
    if (t === 1) i.stdout = s;
    else if (t === 2) i.stderr = s;
    else {
      let r = i.fdTable.get(t) ?? { mode: "write" };
      r.sink = s, i.fdTable.set(t, r);
    }
  }
  async applyRedirects(t, e, i = !1) {
    let s = this.expander(), r = e.stdout, a = e.stderr, n = e.stdin, l = /* @__PURE__ */ new Map(), o = [], h = [], d = (c) => {
      c !== 1 && c !== 2 && !l.has(c) && l.set(c, e.fdTable.get(c));
    }, p = {
      stdout: r,
      stderr: a,
      stdin: e.stdin,
      fdTable: e.fdTable
    };
    for (let c of t) {
      if (c.op === "<" || c.op === "<<" || c.op === "<<<" || c.op === "<>") {
        if (i) {
          let m = await this.resolveStdinStream([c]);
          m !== void 0 && (e.stdin = m, this.resetStdinReader(e));
        }
        continue;
      }
      if (c.op === "<&") {
        let m = c.fd ?? 0;
        d(m);
        let w = c.target === "-" ? "-" : await s.expandToString(c.target);
        if (w === "-") {
          e.fdTable.delete(m);
          continue;
        }
        let x = parseInt(w, 10);
        if (!Number.isNaN(x)) {
          let Q = e.fdTable.get(x);
          Q && e.fdTable.set(m, Q);
        }
        this.stdinDupFds.set(m, (this.stdinDupFds.get(m) ?? 0) + 1), h.push(m);
        continue;
      }
      if (c.op === ">&") {
        let m = c.fd ?? 1;
        d(m);
        let w = c.target === "-" ? "-" : await s.expandToString(c.target);
        if (w === "-") {
          this.setFdSink(m, () => {
          }, e), m > 2 && e.fdTable.delete(m);
          continue;
        }
        let x = parseInt(w, 10);
        Number.isNaN(x) || this.setFdSink(m, this.sinkForFd(x, p), e);
        continue;
      }
      let u = c.fd ?? 1, f = await s.expandToString(c.target), g = c.op === ">>" || c.op === "&>>";
      if (this.options.noclobber && c.op === ">" && f !== "/dev/null" && f !== "/dev/stdout" && f !== "/dev/stderr") {
        let m = await this.statPath(this.absPath(f));
        if (m !== void 0 && !m.dir) throw new z(`${f}: cannot overwrite existing file`);
      }
      let C = this.makeFileSink(f, g, o, p);
      c.op === "&>" || c.op === "&>>" ? (e.stdout = A(C), e.stderr = A(C)) : (d(u), this.setFdSink(u, C, e));
    }
    return () => {
      for (let c of o) c();
      e.stdout = r, e.stderr = a, e.stdin = n, this.resetStdinReader(e);
      for (let c of h) {
        let u = (this.stdinDupFds.get(c) ?? 0) - 1;
        u > 0 ? this.stdinDupFds.set(c, u) : this.stdinDupFds.delete(c);
      }
      for (let [c, u] of l) u === void 0 ? e.fdTable.delete(c) : e.fdTable.set(c, u);
    };
  }
  async execBuiltinRedirects(t, e) {
    let i = this.expander(), s = this.fs;
    for (let r of t) {
      let a = r.fd ?? (r.op === "<" || r.op === "<>" ? 0 : 1);
      if (r.op === ">&") {
        let d = r.target === "-" ? "-" : await i.expandToString(r.target);
        if (d === "-") {
          this.closeFdEntry(a, e), e.fdTable.delete(a);
          continue;
        }
        let p = parseInt(d, 10);
        Number.isNaN(p) || (this.closeFdEntry(a, e), e.fdTable.set(a, {
          mode: "write",
          sink: this.sinkForFd(p, e)
        }));
        continue;
      }
      if (r.op === "<" || r.op === "<>") {
        let d = await i.expandToString(r.target);
        if (!s) return e.stderr(`shell: exec: ${d}: cannot open
`), 1;
        if (r.op === "<>" && s.fsOpenDuplex) {
          let u;
          try {
            u = await Promise.resolve(s.fsOpenDuplex(d));
          } catch (g) {
            return e.stderr(`shell: ${d}: ${g?.message ?? "cannot open"}
`), 1;
          }
          let f = {
            mode: "rw",
            duplex: u,
            sink: A((g) => {
              Promise.resolve(u.write(g));
            }),
            close: () => {
              Promise.resolve(u.close());
            }
          };
          e.fdTable.set(a, f);
          continue;
        }
        let p = "";
        if (r.op === "<" || d !== "/dev/null") try {
          p = await Promise.resolve(s.fsRead(s.fsOpen(d, { read: !0 })));
        } catch {
          if (r.op === "<>") p = "";
          else return e.stderr(`shell: ${d}: No such file or directory
`), 1;
        }
        let c = {
          mode: r.op === "<>" ? "rw" : "read",
          input: p,
          pos: 0
        };
        r.op === "<>" && (c.sink = this.makeFileSink(d, !1, [], e)), e.fdTable.set(a, c);
        continue;
      }
      let n = await i.expandToString(r.target), l = r.op === ">>" || r.op === "&>>", o = "";
      if (l && s && n !== "/dev/null" && n !== "/dev/stdout" && n !== "/dev/stderr") try {
        o = await Promise.resolve(s.fsRead(s.fsOpen(n, { read: !0 })));
      } catch {
        o = "";
      }
      let h = this.makeExecFileSink(n, o, e);
      r.op === "&>" || r.op === "&>>" ? (e.fdTable.set(1, {
        mode: "write",
        sink: h
      }), e.fdTable.set(2, {
        mode: "write",
        sink: h
      })) : e.fdTable.set(a, {
        mode: "write",
        sink: h
      });
    }
    return 0;
  }
  makeExecFileSink(t, e, i) {
    if (t === "/dev/null") return A(() => {
    });
    if (t === "/dev/stdout") return i.stdout;
    if (t === "/dev/stderr") return i.stderr;
    let s = this.fs;
    if (!s) throw Error(`shell: exec redirect to '${t}' requires an FsClient`);
    let r = e;
    return A((a) => {
      r += a;
      let n = s.fsOpen(t, {
        write: !0,
        create: !0,
        truncate: !0
      });
      s.fsWrite(n, r), s.fsClose(n);
    });
  }
  closeFdEntry(t, e) {
    let i = e.fdTable.get(t);
    if (i?.close) try {
      i.close();
    } catch {
    }
  }
  closeAllFds() {
    for (let t of [...this.fdTable.keys()]) this.closeFdEntry(t, this.io);
  }
  readFdLine(t, e) {
    let i = e.fdTable.get(t);
    if (i?.duplex) {
      let l = i.duplex.datagram && i.duplex.readDatagram ? i.duplex.readDatagram() : i.duplex.readLine(), o = i.pendingRead ?? Promise.resolve(l);
      return i.pendingRead = o, o;
    }
    if (!i || i.input === void 0) return;
    let s = i.pos ?? 0;
    if (s >= i.input.length) return;
    let r = i.input.indexOf(`
`, s), a = r >= 0 ? r : i.input.length, n = i.input.slice(s, a);
    return i.pos = r >= 0 ? r + 1 : i.input.length, n;
  }
  consumeFdLine(t, e) {
    let i = e.fdTable.get(t);
    i?.duplex && (i.pendingRead = void 0);
  }
  async readStdinLine(t, e) {
    let i = this.stdinReaderFor(t);
    if (!i) return {
      line: void 0,
      timedOut: !1
    };
    let s = t, r = s[lt] ?? i.readLine();
    if (s[lt] = r, e === void 0) {
      let h = await r;
      return s[lt] = void 0, {
        line: h,
        timedOut: !1
      };
    }
    let a = /* @__PURE__ */ Symbol("t"), n, l = new Promise((h) => {
      n = setTimeout(() => h(a), Math.max(0, e * 1e3));
    }), o = await Promise.race([r, l]);
    return n !== void 0 && clearTimeout(n), o === a ? {
      line: void 0,
      timedOut: !0
    } : (s[lt] = void 0, {
      line: o,
      timedOut: !1
    });
  }
  makeFileSink(t, e, i, s) {
    if (t === "/dev/null") return A(() => {
    });
    if (t === "/dev/stdout") return s.stdout;
    if (t === "/dev/stderr") return s.stderr;
    let r = this.fs;
    if (!r) throw Error(`shell: redirect to '${t}' requires an FsClient (pass 'fs' in ExecutorOptions)`);
    let a = r.fsOpen(t, {
      write: !e,
      append: e,
      create: !0,
      truncate: !e
    });
    return i.push(() => r.fsClose(a)), A((n) => r.fsWrite(a, n));
  }
  async resolveStdinStream(t) {
    let e = this.expander(), i = new TextEncoder(), s;
    for (let r of t) if (r.op === "<<<") s = R(i.encode(await e.expandToString(r.target) + `
`));
    else if (r.op === "<<") {
      let a = r.hereDocQuoted ? r.hereDoc ?? "" : await this.expandHereDoc(r.hereDoc ?? "");
      s = R(i.encode(a));
    } else if (r.op === "<" || r.op === "<>") {
      let a = await e.expandToString(r.target);
      if (a === "/dev/null") {
        s = R(new Uint8Array());
        continue;
      }
      s = await this.fileStdinStream(a, r.op === "<>");
    }
    return s;
  }
  async resolveStdinFd(t, e) {
    let i = this.expander(), s, r = !1;
    for (let a of t) if (a.op === "<<<") r = !0, s = {
      action: "bytes",
      data: new TextEncoder().encode(await i.expandToString(a.target) + `
`)
    };
    else if (a.op === "<<") {
      r = !0;
      let n = a.hereDocQuoted ? a.hereDoc ?? "" : await this.expandHereDoc(a.hereDoc ?? "");
      s = {
        action: "bytes",
        data: new TextEncoder().encode(n)
      };
    } else if (a.op === "<" || a.op === "<>") {
      r = !0;
      let n = await i.expandToString(a.target);
      s = n === "/dev/null" ? {
        action: "bytes",
        data: new Uint8Array()
      } : {
        action: "open",
        path: this.absPath(n),
        flags: { read: !0 }
      };
    }
    if (r) return s;
    if (e.stdin !== void 0 && e.stdin !== this.rootStdinStream) {
      let a = this.stdinReaderFor(e);
      if (a) return {
        action: "bytes",
        data: await a.readAll()
      };
    }
  }
  async resolveStdinInput(t) {
    let e = this.expander(), i = new TextEncoder(), s;
    for (let r of t) if (r.op === "<<<") {
      let a = i.encode(await e.expandToString(r.target) + `
`);
      s = {
        stream: R(a),
        fdSpec: {
          action: "bytes",
          data: a
        }
      };
    } else if (r.op === "<<") {
      let a = r.hereDocQuoted ? r.hereDoc ?? "" : await this.expandHereDoc(r.hereDoc ?? ""), n = i.encode(a);
      s = {
        stream: R(n),
        fdSpec: {
          action: "bytes",
          data: n
        }
      };
    } else if (r.op === "<" || r.op === "<>") {
      let a = await e.expandToString(r.target);
      if (a === "/dev/null") {
        s = {
          stream: R(new Uint8Array()),
          fdSpec: {
            action: "bytes",
            data: new Uint8Array()
          }
        };
        continue;
      }
      s = {
        stream: await this.fileStdinStream(a, r.op === "<>"),
        fdSpec: {
          action: "open",
          path: this.absPath(a),
          flags: { read: !0 }
        }
      };
    }
    return s;
  }
  async fileStdinStream(t, e) {
    let i = this.fs;
    if (!i) throw Error(`shell: input redirect from '${t}' requires an FsClient`);
    try {
      if (i.fsReadBytes) return R(await Promise.resolve(i.fsReadBytes(i.fsOpen(t, { read: !0 }))));
      let s = await Promise.resolve(i.fsRead(i.fsOpen(t, { read: !0 })));
      return R(new TextEncoder().encode(s));
    } catch (s) {
      if (s instanceof z) throw s;
      if (e) return R(new Uint8Array());
      throw new z(`${t}: No such file or directory`);
    }
  }
  async expandHereDoc(t) {
    let e = this.expander(), i = [];
    for (let s of t.split(`
`)) i.push(await e.substituteOnly(s));
    return i.join(`
`);
  }
  async execPipeline(t, e) {
    if (t.stageNodes && t.stageNodes.length > 0) {
      if (t.background) return this.execBackground(t, e);
      let r = this.flattenSimpleStageNodes(t.stageNodes, t.pipeStderr ?? []);
      if (r) {
        let n = await this.execMultiStagePipeline(r, e);
        return t.negate && (n = +(n === 0)), n;
      }
      let a = await this.execNodePipeline(t.stageNodes, t.pipeStderr ?? [], e);
      return t.negate && (a = +(a === 0)), a;
    }
    let i = t.stages ?? [];
    if (i.length === 0) return 0;
    if (t.background) return this.execBackground(t, e);
    let s;
    return i.length === 1 ? (s = await this.execSimple(i[0], e), this.pipeStatus = [s]) : s = await this.execMultiStagePipeline(i, e), t.negate && (s = +(s === 0)), s;
  }
  flattenSimpleStageNodes(t, e) {
    if (e.some(Boolean)) return;
    let i = [];
    for (let s = 0; s < t.length; s++) {
      let r = this.extractSimpleCommand(t[s]);
      if (!r || s > 0 && r.redirects.length > 0) return;
      i.push(r);
    }
    return i;
  }
  async execNodePipeline(t, e, i) {
    let s = t.length, r = Array.from({ length: s - 1 }, () => new TransformStream()), a = Array(s).fill(0), n = r.map((o) => Xe(o.writable)), l = async (o) => {
      let h = o === s - 1, d = h ? void 0 : n[o], p = h ? i.stdout : d.sink, c = !h && e[o], u = this.deriveIo(i, {
        stdout: p,
        stderr: c ? p : i.stderr,
        stdin: o === 0 ? void 0 : r[o - 1].readable
      });
      try {
        let f = await this.execStatement(t[o], u);
        this.exiting === void 0 ? a[o] = f : (a[o] = this.exiting, this.exiting = void 0);
      } catch (f) {
        if (f instanceof Dt) a[o] = f.code;
        else throw f;
      } finally {
        o > 0 && (n[o - 1].abort(), await r[o - 1].readable.cancel().catch(() => {
        })), d && await d.close();
      }
    };
    return await Promise.all(t.map((o, h) => l(h))), this.pipeStatus = a, this.pipelineStatus(a, a[a.length - 1] ?? 0);
  }
  async execMultiStagePipeline(t, e) {
    let i = this.expander(), s = [];
    for (let u of t) s.push(await this.expandCommandName(u, i));
    let r = (u) => {
      let { name: f, extraArgv: g } = s[u];
      return this.functions.has(f) ? !0 : G(f) ? f === "cat" ? t[u].args.length === 0 && g.length === 0 : !0 : !1;
    };
    if (s.every((u, f) => r(f))) {
      let u = new TextEncoder(), f = await this.resolveStdinStream(t[0].redirects);
      if (f === void 0 && e.stdin !== void 0 && e.stdin !== this.rootStdinStream && !this.stdinReaderExists(e)) {
        let x = this.stdinReaderFor(e);
        x && (f = R(await x.readAll()));
      }
      let g = "", C = 0, m = [], w = this.io;
      try {
        for (let x = 0; x < t.length; x++) {
          let Q = x === t.length - 1, { name: K, extraArgv: O, env: D } = s[x], y = "", S = x === 0 ? f ?? R(u.encode(g)) : R(u.encode(g)), B = this.deriveIo(e, {
            stdout: Q ? e.stdout : (b) => {
              y += b;
            },
            stdin: S
          });
          this.io = B;
          let U = [...O, ...await this.expandCommandArgs(t[x], i)];
          this.options.xtrace && w.stderr("+ " + [K, ...U].join(" ") + `
`), C = await this.dispatch(K, U, B, { stdin: S }), this.exiting !== void 0 && (C = this.exiting, this.exiting = void 0), m.push(C), g = y;
        }
      } finally {
        this.io = w;
      }
      return this.pipeStatus = m, this.pipelineStatus(m, C);
    }
    let a = [];
    for (let u = 0; u < t.length; u++) {
      let { name: f, extraArgv: g, env: C } = s[u], m = [...g, ...await this.expandCommandArgs(t[u], i)];
      this.options.xtrace && e.stderr("+ " + [f, ...m].join(" ") + `
`), a.push({
        name: f,
        argv: m,
        env: C
      });
    }
    let n = t[0].redirects.some((u) => u.op === "<" || u.op === "<<" || u.op === "<<<" || u.op === "<>") || !this.stdinReaderExists(e), l = await this.resolveStdinFd(t[0].redirects, n ? e : {
      ...e,
      stdin: void 0
    }), o = [];
    for (let u = 0; u < a.length; u++) {
      let { name: f, argv: g, env: C } = a[u], m = u === a.length - 1, w = this.resolve(f);
      if (w === void 0) return e.stderr(`shell: ${f}: command not found
`), this.pipeStatus = [127], 127;
      o.push({
        code: w,
        args: [f, ...g],
        env: {
          ...this.context.env,
          ...C
        },
        cwd: this.context.cwd,
        captureStdout: m,
        captureStderr: !0,
        fds: u === 0 && l ? { 0: l } : void 0
      });
    }
    if (this.kernel.runPipeline) {
      let u = await this.kernel.runPipeline(o);
      u.lastStdout && await this.writeCaptured(u.lastStdout, e);
      for (let f of u.stderr) await this.surfaceStderr(f, e);
      return this.pipeStatus = u.exitCodes, this.pipelineStatus(u.exitCodes, u.exitCodes[u.exitCodes.length - 1] ?? 0);
    }
    let h = await Promise.all(o.map((u) => this.kernel.spawn(hs(u)))), d = h[h.length - 1];
    d?.stdout && await this.writeCaptured(d.stdout, e);
    let p = await Promise.all(h.map((u) => this.kernel.wait(u.pid)));
    for (let u of h) await this.surfaceStderr(u.stderr, e);
    let c = p.map((u) => u.code);
    return this.pipeStatus = c, this.pipelineStatus(c, c[c.length - 1] ?? 0);
  }
  pipelineStatus(t, e) {
    if (!this.options.pipefail) return e;
    for (let i = t.length - 1; i >= 0; i--) if (t[i] !== 0) return t[i];
    return 0;
  }
  async execSimple(t, e) {
    if (!this.inDebugTrap && this.traps.has("DEBUG")) {
      this.inDebugTrap = !0;
      try {
        await this.runTrap("DEBUG");
      } finally {
        this.inDebugTrap = !1;
      }
    }
    let i = this.expander(), s = t.name !== "", r = {};
    if (s) for (let p of t.assignments) p.array === void 0 && p.index === void 0 && !p.append && (r[p.name] = await i.expandToString(p.value));
    let a = s && Object.keys(r).length > 0 ? new j(this.environment.child(r)) : i, { name: n, argv: l } = await this.expandCommand(t, a, !1);
    if (n !== "" && (this.lastArgValue = l.length > 0 ? l[l.length - 1] : n), n === "") {
      this.options.xtrace && t.assignments.length > 0 && e.stderr("+ " + t.assignments.map((u) => `${u.name}=${u.value}`).join(" ") + `
`), this.lastCmdSubStatus = void 0;
      let p = !1;
      for (let u of t.assignments) await this.applyAssignment(u, i) && (p = !0);
      if (p) return 1;
      let c = this.lastCmdSubStatus;
      return this.lastCmdSubStatus = void 0, c ?? 0;
    }
    if (n === "exec" && l.length === 0) return await this.execBuiltinRedirects(t.redirects, e);
    this.options.xtrace && e.stderr("+ " + [n, ...l].join(" ") + `
`);
    let o;
    try {
      o = await this.resolveStdinInput(t.redirects);
    } catch (p) {
      if (p instanceof z) return this.onRedirectError(n, p, e);
      throw p;
    }
    let h = o?.stream ?? e.stdin, d;
    if (t.redirects.length) try {
      d = await this.applyRedirects(t.redirects, e);
    } catch (p) {
      if (p instanceof z) return this.onRedirectError(n, p, e);
      throw p;
    }
    if ((n === "command" || n === "builtin") && l.length > 0) {
      let p = l, c = !1, u = !1;
      if (n === "command") {
        for (; p.length > 0 && p[0].length > 1 && p[0][0] === "-" && p[0] !== "--"; ) {
          let g = !1;
          for (let C of p[0].slice(1)) if (C === "v") c = !0;
          else if (C === "V") u = !0;
          else if (C !== "p") {
            g = !0;
            break;
          }
          if (g) break;
          p = p.slice(1);
        }
        p[0] === "--" && (p = p.slice(1));
      }
      if (p.length === 0) return 0;
      let f = p[0];
      if (c || u) {
        if (Pt(f)) return e.stdout(u ? `${f} is a shell keyword
` : `${f}
`), 0;
        if (this.functions.has(f)) return e.stdout(u ? `${f} is a function
` : `${f}
`), 0;
        if (G(f)) return e.stdout(u ? `${f} is a shell builtin
` : `${f}
`), 0;
        let g = await this.resolveExternalPath(f);
        return g === void 0 ? (u && e.stderr(`shell: command: ${f}: not found
`), 1) : (e.stdout(u ? `${f} is ${g}
` : `${g}
`), 0);
      }
      return n === "builtin" ? G(f) ? await this.dispatch(f, p.slice(1), e, { stdin: h }) : (e.stderr(`shell: builtin: ${f}: not a shell builtin
`), 1) : G(f) && _t(f, p.slice(1)) ? await this.dispatch(f, p.slice(1), e, { stdin: h }) : await this.spawnExternal(f, p.slice(1), r, e, o?.fdSpec);
    }
    try {
      if (this.functions.has(n)) return await this.callFunction(n, l, r, e);
      if (G(n) && _t(n, l)) {
        let u = Object.keys(r), f = {};
        if (u.length > 0) for (let w of u) f[w] = this.context.env[w];
        Object.assign(this.context.env, r);
        let g = t.assignments.filter((w) => w.array !== void 0), C = n === "declare" || n === "typeset" || n === "local" || n === "readonly" || n === "export", m = await this.dispatch(n, l, e, C ? {
          stdin: h,
          builtinAssignments: g,
          assignExpander: i
        } : { stdin: h });
        if (u.length > 0) for (let w of u) this.context.env[w] === r[w] && (f[w] === void 0 ? delete this.context.env[w] : this.context.env[w] = f[w]);
        return m;
      }
      if (o) return await this.spawnExternal(n, l, r, e, o.fdSpec);
      let p = e.stdin !== void 0 && e.stdin !== this.rootStdinStream ? e.stdin : void 0;
      if (p && this.kernel.spawnStream && !this.stdinReaderExists(e)) return e.stdin = void 0, this.resetStdinReader(e), await this.spawnExternal(n, l, r, e, void 0, p);
      let c = await this.resolveStdinFd(t.redirects, e);
      return await this.spawnExternal(n, l, r, e, c);
    } finally {
      d && d(), await this.flushPendingProcSubs();
    }
  }
  async applyArrayLiteral(t, e, i, s, r = !1) {
    let a = r ? this.localScopes.findIndex((u) => u.has(t)) : -1, n = this.integerNames.has(t), l = r ? this.globalCaseFoldOf(t) : this.caseFoldNames.get(t), o = (u) => n ? String(this.evalArithValue(u)) : it(u, l);
    if (a >= 0) {
      let u = this.localSavedArrays[a].get(t);
      if (u?.assoc !== void 0) {
        let f = u?.assoc ?? /* @__PURE__ */ new Map();
        i || f.clear();
        for (let g of e) {
          let C = /^\[(.*?)\]([+]?)=(.*)$/s.exec(g);
          if (C === null) continue;
          let m = await s.substituteOnly(C[1]), w = o(await s.expandToString(C[3]));
          f.set(m, C[2] === "+" ? (f.get(m) ?? "") + w : w);
        }
        return u === void 0 ? this.localSavedArrays[a].set(t, {
          assoc: f,
          integer: n,
          readonly: !1
        }) : (u.assoc = f, u.arr = void 0), !1;
      }
    }
    let h = a < 0 ? this.assocArrays.get(t) : void 0;
    if (h !== void 0) {
      i || h.clear();
      for (let u of e) {
        let f = /^\[(.*?)\]([+]?)=(.*)$/s.exec(u);
        if (f === null) continue;
        let g = await s.substituteOnly(f[1]), C = o(await s.expandToString(f[3]));
        h.set(g, f[2] === "+" ? (h.get(g) ?? "") + C : C);
      }
      return delete this.context.env[t], !1;
    }
    let d = a >= 0 ? this.localSavedArrays[a].get(t)?.arr ?? [] : this.arrays.get(t) ?? [], p = i ? d.slice() : [], c = p.length;
    for (let u of e) {
      let f = /^\[(.*?)\]([+]?)=(.*)$/s.exec(u);
      if (f !== null) {
        let g = (await s.substituteOnly(f[1])).trim(), C = /^-?\d+$/.test(g) ? parseInt(g, 10) : (() => {
          try {
            return Number(J(g, this.arithEnvForExpr(), this.arithArrayAccessExec()));
          } catch {
            return 0;
          }
        })();
        C < 0 && (C = p.length + C);
        let m = o(await s.expandToString(f[3]));
        p[C] = f[2] === "+" ? (p[C] ?? "") + m : m, c = C + 1;
      } else for (let g of await s.expandWord(u)) p[c++] = o(g);
    }
    if (a >= 0) {
      let u = this.localSavedArrays[a].get(t);
      u === void 0 ? this.localSavedArrays[a].set(t, {
        arr: p,
        integer: n,
        readonly: !1
      }) : u.arr = p;
    } else this.arrays.set(t, p), delete this.context.env[t];
    return !1;
  }
  async applyAssignment(t, e, i = !1) {
    let s = this.namerefs.get(t.name);
    if (s !== void 0 && (t = {
      ...t,
      name: s
    }), i ? this.isGlobalReadonly(t.name) : this.readonlyNames.has(t.name)) {
      let n = `${t.name}: readonly variable`;
      if (this.options.posix) throw new q(t.name, 1, n);
      return this.io.stderr(`shell: ${n}
`), this.lastStatus = 1, !0;
    }
    if (this.clearDeclaredUnset(t.name, i), t.array !== void 0) return await this.applyArrayLiteral(t.name, t.array, t.append ?? !1, e, i);
    if (t.index !== void 0) {
      let n = this.integerNames.has(t.name), l = this.caseFoldNames.get(t.name), o = (u, f) => {
        if (!n) return it(t.append ? f + u : u, l);
        let g = this.evalArithValue(u);
        return String(t.append ? this.evalArithValue(f || "0") + g : g);
      }, h = this.assocArrays.get(t.name);
      if (h !== void 0) {
        let u = await e.substituteOnly(t.index), f = await e.expandToString(t.value);
        return h.set(u, o(f, h.get(u) ?? "")), !1;
      }
      let d = await e.substituteOnly(t.index), p = /^-?\d+$/.test(d.trim()) ? parseInt(d.trim(), 10) : (() => {
        try {
          return Number(J(d, this.arithEnvForExpr(), this.arithArrayAccessExec()));
        } catch {
          return 0;
        }
      })(), c = this.arrays.get(t.name) ?? (this.context.env[t.name] === void 0 ? [] : [this.context.env[t.name]]);
      return p < 0 && (p = c.length + p), c[p] = o(await e.expandToString(t.value), c[p] ?? ""), this.arrays.set(t.name, c), delete this.context.env[t.name], !1;
    }
    if (t.index === void 0 && (this.arrays.has(t.name) || this.assocArrays.has(t.name))) return await this.applyAssignment({
      ...t,
      index: "0"
    }, e, i);
    let r = await e.expandToString(t.value);
    if (t.name === "RANDOM" || t.name === "SHLVL" || t.name === "BASH_VERSION" || t.name === "BASH_VERSINFO") return this.environment.set(t.name, t.append ? (this.context.env[t.name] ?? "") + r : r), !1;
    if (this.integerNames.has(t.name)) try {
      let n = J(r, this.arithEnvForExpr(), this.arithArrayAccessExec()), l = t.append ? J(this.context.env[t.name] ?? "0", this.arithEnvForExpr(), this.arithArrayAccessExec()) : 0n;
      return this.context.env[t.name] = String(t.append ? l + n : n), !1;
    } catch (n) {
      return this.io.stderr(`shell: ${r}: ${n instanceof Error ? n.message.replace(/^arith: /, "") : "arithmetic syntax error"}
`), this.lastStatus = 1, !0;
    }
    let a = it(t.append ? (this.context.env[t.name] ?? "") + r : r, this.caseFoldNames.get(t.name));
    return this.context.env[t.name] = a, !1;
  }
  evalArithValue(t) {
    try {
      return J(t, this.arithEnvForExpr(), this.arithArrayAccessExec());
    } catch {
      return 0n;
    }
  }
  async spawnExternal(t, e, i, s, r, a) {
    let n = this.resolve(t);
    if (n === void 0) return s.stderr(`shell: ${t}: command not found
`), 127;
    let l = {
      code: n,
      args: [t, ...e],
      env: {
        ...this.context.env,
        ...i
      },
      cwd: this.context.cwd,
      captureStdout: !0,
      captureStderr: !0,
      fds: r ? { 0: r } : void 0,
      stdinStream: a
    };
    if (this.kernel.spawnStream) {
      let d = await this.kernel.spawnStream(l);
      d.stdout && await this.pumpToStdout(d.stdout, s);
      let { code: p } = await this.kernel.wait(d.pid);
      return await this.surfaceStderr(d.stderr, s), p;
    }
    let o = await this.kernel.spawn(l);
    o.stdout && await this.writeCaptured(o.stdout, s);
    let { code: h } = await this.kernel.wait(o.pid);
    return await this.surfaceStderr(o.stderr, s), h;
  }
  async surfaceStderr(t, e) {
    if (!t) return;
    let i;
    try {
      i = await t;
    } catch {
      return;
    }
    i.byteLength > 0 && e.stderr.writeBytes(i);
  }
  async pumpToStdout(t, e) {
    let i = t.getReader();
    try {
      for (; ; ) {
        let { value: s, done: r } = await i.read();
        if (r) break;
        s && s.byteLength > 0 && e.stdout.writeBytes(s);
      }
    } catch {
      try {
        await i.cancel();
      } catch {
      }
    } finally {
      i.releaseLock();
    }
  }
  async callFunction(t, e, i, s) {
    let r = this.functions.get(t), a = this.context.positional;
    this.context.positional = e, this.localScopes.push(/* @__PURE__ */ new Set()), this.localSaved.push(/* @__PURE__ */ new Map()), this.localSavedArrays.push(/* @__PURE__ */ new Map()), this.funcStack.unshift(t);
    let n = Object.keys(i), l = {};
    for (let h of n) l[h] = this.context.env[h], this.context.env[h] = i[h];
    let o = 0;
    try {
      o = await this.execList(r.body, s);
    } catch (h) {
      if (h instanceof at) o = h.code;
      else throw h;
    } finally {
      this.traps.has("RETURN") && await this.runTrap("RETURN"), this.funcStack.shift();
      let h = this.localScopes.pop(), d = this.localSaved.pop(), p = this.localSavedArrays.pop();
      for (let c of h) {
        let u = d.get(c);
        u === void 0 ? delete this.context.env[c] : this.context.env[c] = u;
        let f = p.get(c);
        f === void 0 || f.arr === void 0 ? this.arrays.delete(c) : this.arrays.set(c, f.arr), f === void 0 || f.assoc === void 0 ? this.assocArrays.delete(c) : this.assocArrays.set(c, f.assoc), f === void 0 || !f.integer ? this.integerNames.delete(c) : this.integerNames.add(c), f === void 0 || !f.readonly ? this.readonlyNames.delete(c) : this.readonlyNames.add(c), f === void 0 || f.caseFold === void 0 ? this.caseFoldNames.delete(c) : this.caseFoldNames.set(c, f.caseFold), f === void 0 || f.nameref === void 0 ? this.namerefs.delete(c) : this.namerefs.set(c, f.nameref), f === void 0 || f.declaredUnset === void 0 ? this.declaredUnset.delete(c) : this.declaredUnset.set(c, f.declaredUnset);
      }
      for (let c of n) l[c] === void 0 ? delete this.context.env[c] : this.context.env[c] = l[c];
      this.context.positional = a;
    }
    return o;
  }
  funcNameStack() {
    return this.funcStack;
  }
  declareP(t) {
    let e = /[\x00-\x1f\x7f]/, i = (h) => e.test(h) ? N(h) : '"' + h.replace(/[\\"$`]/g, (d) => "\\" + d) + '"', s = /^[A-Za-z0-9_./:=@%+,-]+$/, r = (h) => s.test(h) ? h : '"' + h.replace(/[\\"$`]/g, (d) => "\\" + d) + '"', a = (h) => {
      let d = "";
      this.assocArrays.has(h) ? d += "A" : this.arrays.has(h) && (d += "a"), this.integerNames.has(h) && (d += "i"), this.readonlyNames.has(h) && (d += "r"), this.exportedNames.has(h) && (d += "x");
      let p = this.caseFoldNames.get(h);
      return p === "lower" ? d += "l" : p === "upper" && (d += "u"), d;
    }, n = (h) => {
      let d = this.namerefs.get(h);
      if (d !== void 0) return `declare -n ${h}="${d.replace(/[\\"$`]/g, (u) => "\\" + u)}"`;
      if (this.declaredUnset.get(h) === "nameref") return `declare -n ${h}`;
      let p = a(h), c = p === "" ? "--" : "-" + p;
      if (this.declaredUnset.has(h)) return `declare ${c} ${h}`;
      if (this.assocArrays.has(h)) {
        let u = [...this.assocArrays.get(h).entries()].map(([f, g]) => `[${r(f)}]=${i(g)}`).join(" ");
        return `declare ${c} ${h}=(${u}${u === "" ? "" : " "})`;
      }
      if (this.arrays.has(h)) {
        let u = this.arrays.get(h);
        return `declare ${c} ${h}=(${u.map((f, g) => g in u ? `[${g}]=${i(f)}` : void 0).filter((f) => f !== void 0).join(" ")})`;
      }
      if (h in this.context.env) return `declare ${c} ${h}=${i(this.context.env[h])}`;
      if (this.readonlyNames.has(h) || this.integerNames.has(h) || this.caseFoldNames.has(h) || this.exportedNames.has(h)) return `declare ${c} ${h}`;
    };
    if (t.length === 0) {
      let h = /* @__PURE__ */ new Set([
        ...Object.keys(this.context.env),
        ...this.arrays.keys(),
        ...this.assocArrays.keys(),
        ...this.declaredUnset.keys(),
        ...this.exportedNames
      ]), d = [];
      for (let p of [...h].sort()) {
        let c = n(p);
        c !== void 0 && d.push(c);
      }
      return {
        lines: d,
        missing: []
      };
    }
    let l = [], o = [];
    for (let h of t) {
      let d = n(h);
      d === void 0 ? o.push(h) : l.push(d);
    }
    return {
      lines: l,
      missing: o
    };
  }
  declarePByAttr(t) {
    let e = (n, l) => {
      switch (l) {
        case "a":
          return this.arrays.has(n) && !this.assocArrays.has(n);
        case "A":
          return this.assocArrays.has(n);
        case "i":
          return this.integerNames.has(n);
        case "r":
          return this.readonlyNames.has(n);
        case "x":
          return this.exportedNames.has(n);
        case "l":
          return this.caseFoldNames.get(n) === "lower";
        case "u":
          return this.caseFoldNames.get(n) === "upper";
        case "n":
          return this.namerefs.has(n) || this.declaredUnset.get(n) === "nameref";
        default:
          return !0;
      }
    }, i = /* @__PURE__ */ new Set([
      ...Object.keys(this.context.env),
      ...this.arrays.keys(),
      ...this.assocArrays.keys(),
      ...this.declaredUnset.keys(),
      ...this.exportedNames,
      ...this.namerefs.keys(),
      ...this.readonlyNames,
      ...this.integerNames,
      ...this.caseFoldNames.keys()
    ]), s = [...t].filter((n) => n === "a" || n === "A"), r = [...t].filter((n) => "irxlun".includes(n)), a = [];
    for (let n of [...i].sort()) {
      if (!s.every((o) => e(n, o)) || r.length > 0 && !r.some((o) => e(n, o))) continue;
      let l = this.declareP([n]).lines[0];
      l !== void 0 && a.push(l);
    }
    return a;
  }
  async execBackground(t, e) {
    let i = this.jobControl.register(Me(t.stages ?? [])), s = this.deriveIo(e, {}, !0), r = this.kernel.spawnStream ? await this.backgroundExternal(t, s) : void 0;
    if (r && this.kernel.spawnStream) {
      let l;
      try {
        l = await this.applyRedirects(t.stages?.[0]?.redirects ?? [], s);
        let o = await this.kernel.spawnStream(r);
        i.pids = [o.pid], this.jobControl.setLastBgPid(o.pid);
        let h = o.stdout?.getReader(), d = h ? this.pumpReaderToSink(h, s.stdout) : Promise.resolve();
        return i.promise = this.kernel.wait(o.pid).then(async (p) => (i.state = "done", i.exitCode = p.code, await d.catch(() => {
        }), await this.surfaceStderr(o.stderr, s), p.code)).catch(() => (i.state = "done", i.exitCode = 1, h && h.cancel().catch(() => {
        }), 1)).finally(l), 0;
      } catch {
        l?.();
      }
    }
    let a = 1e5 + i.id;
    i.pids = [a], this.jobControl.setLastBgPid(a);
    let n = {
      ...t,
      background: !1
    };
    return i.promise = this.execStatement(n, s).then((l) => (i.state = "done", i.exitCode = l, l)).catch(() => (i.state = "done", i.exitCode = 1, 1)), 0;
  }
  async backgroundExternal(t, e) {
    if (t.type !== "Pipeline" || !t.stages || t.stages.length !== 1) return;
    let i = t.stages[0], s = this.expander(), { name: r, argv: a, env: n } = await this.expandCommand(i, s);
    if (r === "" || this.functions.has(r) || G(r) && _t(r, a)) return;
    let l = this.resolve(r);
    if (l === void 0) return;
    let o = await this.resolveStdinFd(i.redirects, e);
    return {
      code: l,
      args: [r, ...a],
      env: {
        ...this.context.env,
        ...n
      },
      cwd: this.context.cwd,
      fds: o ? { 0: o } : void 0,
      background: !0
    };
  }
  async pumpReaderToSink(t, e) {
    try {
      for (; ; ) {
        let { value: i, done: s } = await t.read();
        if (s) break;
        i && i.byteLength > 0 && e.writeBytes(i);
      }
    } catch {
    }
  }
  async execCoproc(t, e) {
    if (!this.kernel.spawnCoproc) return e.stderr(`shell: coproc: requires a transferable backend
`), 1;
    let i = this.extractSimpleCommand(t.coprocBody);
    if (!i) return e.stderr(`shell: coproc: only a single external command is supported
`), 1;
    let s = this.expander(), { name: r, argv: a, env: n } = await this.expandCommand(i, s), l = this.resolve(r);
    if (l === void 0) return e.stderr(`shell: ${r}: command not found
`), 127;
    let o;
    try {
      o = await this.kernel.spawnCoproc({
        code: l,
        args: [r, ...a],
        env: {
          ...this.context.env,
          ...n
        },
        cwd: this.context.cwd
      });
    } catch (u) {
      if (u.code === "ENOSYS") return e.stderr(`shell: coproc: requires a transferable backend
`), 1;
      throw u;
    }
    let h = this.allocCoprocFd(), d = this.allocCoprocFd();
    e.fdTable.set(h, {
      mode: "read",
      duplex: {
        readLine: () => o.readLine(),
        write: () => {
        },
        close: () => o.close()
      }
    }), e.fdTable.set(d, {
      mode: "write",
      sink: A((u) => {
        Promise.resolve(o.write(u));
      }),
      close: () => o.close()
    });
    let p = t.coprocName ?? "COPROC";
    this.arrays.set(p, [String(h), String(d)]), delete this.context.env[p], this.context.env[`${p}_PID`] = String(o.pid), this.jobControl.setLastBgPid(o.pid);
    let c = this.jobControl.register(`coproc ${p}`, [o.pid]);
    return c.promise = this.kernel.wait(o.pid).then((u) => (c.state = "done", c.exitCode = u.code, u.code)).catch(() => (c.state = "done", c.exitCode = 1, 1)), 0;
  }
  nextCoprocFd = 63;
  allocCoprocFd() {
    for (; this.fdTable.has(this.nextCoprocFd) && this.nextCoprocFd > 10; ) this.nextCoprocFd--;
    return this.nextCoprocFd--;
  }
  extractSimpleCommand(t) {
    if (t) {
      if (t.type === "Pipeline" && t.stages?.length === 1) return t.stages[0];
      if ((t.type === "Group" || t.type === "Subshell") && t.body?.length === 1) return this.extractSimpleCommand(t.body[0]);
    }
  }
  async expandCommand(t, e, i = !0) {
    let s = {};
    if (i) for (let l of t.assignments) l.array === void 0 && l.index === void 0 && !l.append && (s[l.name] = await e.expandToString(l.value));
    let r = t.name === "" ? [] : await e.expandWord(t.name), a = r[0] ?? "", n = [...r.slice(1)];
    for (let l of t.args) n.push(...await e.expandWord(l));
    return {
      name: a,
      argv: n,
      env: s
    };
  }
  async expandCommandName(t, e) {
    let i = {};
    for (let r of t.assignments) r.array === void 0 && r.index === void 0 && !r.append && (i[r.name] = await e.expandToString(r.value));
    let s = t.name === "" ? [] : await e.expandWord(t.name);
    return {
      name: s[0] ?? "",
      extraArgv: s.slice(1),
      env: i
    };
  }
  async expandCommandArgs(t, e) {
    let i = [];
    for (let s of t.args) i.push(...await e.expandWord(s));
    return i;
  }
  async dispatch(t, e, i, s = {}) {
    this.io = i;
    let r = s.stdin !== void 0 && s.stdin !== i.stdin;
    r && (i = this.deriveIo(i, { stdin: s.stdin }));
    let a = () => this.stdinReaderFor(i), n = {
      cwd: this.context.cwd,
      env: this.context.env,
      write: s.write ?? ((o) => i.stdout(o)),
      writeErr: (o) => i.stderr(o),
      writeBytes: (o) => i.stdout.writeBytes(o),
      stdin: i.stdin,
      lastStatus: this.lastStatus,
      exit: (o) => {
        this.exiting = o;
      },
      eval: (o) => this.run(this.parseSrc(o), !0),
      sourceFile: (o) => this.sourceFile(o),
      readFdLine: (o) => this.readFdLine(o, i),
      consumeFdLine: (o) => this.consumeFdLine(o, i),
      stdinFd: !r && this.stdinDupFds.has(0) && (() => {
        let o = i.fdTable.get(0);
        return !!(o && (o.duplex || o.input !== void 0));
      })() ? 0 : void 0,
      readStdinLine: (o) => this.readStdinLine(i, o),
      readStdinAll: () => {
        let o = a();
        return o ? o.readAll() : Promise.resolve(new Uint8Array());
      },
      readStdinPump: (o) => {
        let h = a();
        return h ? h.pumpTo(o) : Promise.resolve();
      },
      readStdinChunk: (o, h, d) => {
        let p = a();
        return p ? d ? p.readBytes(h ?? 2 ** 53 - 1).then((c) => c === "" ? void 0 : c) : p.readUntil(o ?? `
`, h) : Promise.resolve(void 0);
      },
      doBreak: (o) => {
        throw new W(o);
      },
      doContinue: (o) => {
        throw new T(o);
      },
      doReturn: (o) => {
        throw new at(o);
      },
      evalArith: (o) => J(o, this.arithEnvForExpr(), this.arithArrayAccessExec()),
      resolveExternal: (o) => this.resolveExternalPath(o),
      condTest: (o, h) => this.condFileTest(o, h),
      hasFs: !!this.fs?.fsStat,
      builtinAssignments: s.builtinAssignments,
      applyBuiltinAssignment: s.assignExpander ? (o, h) => this.applyAssignment(o, s.assignExpander, h) : void 0,
      state: this.shellState()
    }, l = await st(t, e, n);
    return this.context.cwd = n.cwd, l;
  }
  async writeCaptured(t, e) {
    let i = await t;
    i.byteLength > 0 && e.stdout.writeBytes(i);
  }
  deriveIo(t, e = {}, i = !1) {
    return {
      stdout: e.stdout ? A(e.stdout) : t.stdout,
      stderr: e.stderr ? A(e.stderr) : t.stderr,
      stdin: "stdin" in e ? e.stdin : t.stdin,
      fdTable: e.fdTable ?? (i ? new Map(t.fdTable) : t.fdTable)
    };
  }
  writeStdout(t) {
    this.io.stdout(t);
  }
  writeStderr(t) {
    this.io.stderr(t);
  }
};
function _t(t, e) {
  return t === "cat" ? e.length === 0 : !0;
}
function hs(t) {
  return {
    code: t.code,
    args: t.args,
    env: t.env,
    cwd: t.cwd,
    captureStdout: t.captureStdout,
    captureStderr: t.captureStderr,
    fds: t.fds
  };
}
function Me(t) {
  return t.map((e) => [e.name, ...e.args].filter((i) => i !== "").join(" ")).join(" | ");
}
function cs(t) {
  return t.type === "Pipeline" ? Me(t.stages ?? []) : t.type.toLowerCase();
}

// mithic/packages/shell/dist/ast.js
var ze = {};
