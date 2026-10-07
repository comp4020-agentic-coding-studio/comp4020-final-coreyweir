'use strict';

// Bun polyfill for Claude Code under plain Node / Nodepod.
// Ported from ../nanovm_poc/claude-node/shim.mjs to CommonJS so the VFS
// entrypoint can `require()` it before loading the booted Claude bundle.

function loadOptional(name) {
  try {
    const mod = require(name);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

const _stringWidth = loadOptional('string-width');
const _wrapAnsi = loadOptional('wrap-ansi');
const _stripAnsi = loadOptional('strip-ansi');

function fallbackStringWidth(s) {
  const str = String(s ?? '');
  // Rough ANSI-stripped width; good enough if deps aren't installed yet.
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function fallbackWrapAnsi(s, width) {
  const str = String(s ?? '');
  const w = Math.max(1, Number(width) || 80);
  const out = [];
  for (let i = 0; i < str.length; i += w) out.push(str.slice(i, i + w));
  return out.join('\n');
}

function fallbackStripAnsi(s) {
  return String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

const stringWidth = _stringWidth || fallbackStringWidth;
const wrapAnsi = _wrapAnsi || fallbackWrapAnsi;
const stripAnsi = _stripAnsi || fallbackStripAnsi;

function notShimmed(name) {
  return () => {
    throw new Error(`Bun.${name} is not shimmed under node/nodepod`);
  };
}

globalThis.Bun = {
  version: '1.3.14',
  revision: 'nodepod-shim',
  isMainThread: true,
  stringWidth: (s) => stringWidth(s),
  wrapAnsi: (s, w) => wrapAnsi(s, w),
  stripANSI: (s) => stripAnsi(s),
  gc: () => {},
  hash: (input, seed) => {
    const str = typeof input === 'string' ? input : JSON.stringify(input) ?? String(input);
    let h1 = 0xdeadbeef ^ (seed ?? 0);
    let h2 = 0x41c6ce57 ^ (seed ?? 0);
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  },
  deepEquals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  which: (cmd) => {
    try {
      return require('child_process').execFileSync('which', [cmd]).toString().trim();
    } catch {
      return null;
    }
  },
  inspect: (x) => require('util').inspect(x, { depth: 5 }),
  nanoseconds: () => {
    if (typeof process.hrtime?.bigint === 'function') return Number(process.hrtime.bigint());
    return Date.now() * 1e6;
  },
  spawn: notShimmed('spawn'),
  spawnSync: notShimmed('spawnSync'),
  file: notShimmed('file'),
  write: notShimmed('write'),
  read: notShimmed('read'),
  glob: notShimmed('glob'),
  semver: notShimmed('semver'),
  YAML: { parse: notShimmed('YAML.parse'), stringify: notShimmed('YAML.stringify') },
  TOML: { parse: notShimmed('TOML.parse') },
  Terminal: notShimmed('Terminal'),
  Transpiler: notShimmed('Transpiler'),
  WebView: notShimmed('WebView'),
  SQL: notShimmed('SQL'),
};
