// Workspace import (app/src/workspaceImport.ts): an export read back maps
// onto the same workspace, and a zip that isn't one, or that tries to put
// something where it shouldn't, is refused or cleaned. Runs the module
// under node (type stripping): real exports from workspaceExport.ts, and
// zips made by hand for the corners.
//
// Not told apart here: whether the pod restores these entries as given
// (the browser smoke, `npm run test:workspace-import-ui`, does that through
// OPFS and a reload).
import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { MANIFEST_NAME, TRANSCRIPTS_DIR, WORKSPACE_ROOT, exportWorkspace } from "../src/workspaceExport.ts";
import { MAX_IMPORT_BYTES, WorkspaceImportError, crc32, openWorkspaceExport } from "../src/workspaceImport.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const R = WORKSPACE_ROOT;

function memorySource(entries) {
  const nodes = new Map();
  const add = (path, node) => {
    nodes.set(path, node);
    for (let dir = path.slice(0, path.lastIndexOf("/")); dir; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      if (!nodes.has(dir)) nodes.set(dir, { dir: true });
    }
  };
  for (const [path, value] of Object.entries(entries)) add(path, value);
  const kids = (dir) => [...nodes.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1));
  return {
    async readdir(path) {
      if (!nodes.get(path)?.dir) throw new Error(`ENOTDIR ${path}`);
      return kids(path);
    },
    async lstat(path) {
      const n = nodes.get(path);
      if (!n) return null;
      if (n.dir) return { kind: "dir", size: 0, mode: 0o755, mtimeMs: Date.UTC(2026, 10, 8) };
      if (n.link !== undefined) return { kind: "symlink", size: n.link.length, mode: 0o777, mtimeMs: Date.UTC(2026, 10, 8) };
      return { kind: "file", size: n.file.length, mode: n.mode ?? 0o644, mtimeMs: Date.UTC(2026, 10, 8, 3, 4, 6) };
    },
    async readFile(path) { return nodes.get(path).file; },
    async readlink(path) { return nodes.get(path).link; },
  };
}
const file = (data, mode) => ({ file: typeof data === "string" ? enc.encode(data) : data, mode });
const bytes256 = Uint8Array.from({ length: 256 }, (_, i) => i);
const random = (() => { let x = 7; return Uint8Array.from({ length: 70_000 }, () => (x = (x * 1103515245 + 12345) & 0x7fffffff) >>> 16 & 0xff); })();

async function exported(entries, options = {}) {
  const result = await exportWorkspace(memorySource(entries), { room: "K7MQ2P", now: new Date(Date.UTC(2026, 10, 8)), ...options });
  return new Uint8Array(await result.blob.arrayBuffer());
}

function collect(archive, options) {
  const it = archive.entries(options);
  const entries = new Map();
  for (;;) {
    const step = it.next();
    if (step.done) return { entries, ...step.value };
    entries.set(step.value.path, step.value);
  }
}

const manifest = (extra = {}) => strToU8(JSON.stringify({ format: "riff-workspace", version: 1, exportedAt: "2026-11-08T00:00:00.000Z", room: "K7MQ2P", left: [], history: null, ...extra }));
const unix = (type, mode) => ({ os: 3, attrs: ((type | mode) << 16) >>> 0 });
// A zip made by hand: name -> bytes, or [bytes, attributes].
const handZip = (files) => zipSync({ [MANIFEST_NAME]: manifest(), ...files });
const refused = (zip, pattern) => assert.throws(() => openWorkspaceExport(zip), (error) => error instanceof WorkspaceImportError && pattern.test(error.message));

test("an export comes back as the same workspace: bytes, modes, symlinks, empty dirs, the git store", async () => {
  const workspace = {
    [`${R}/notes.txt`]: file("never pushed\n"),
    [`${R}/bin/run.sh`]: file("#!/bin/sh\necho hi\n", 0o755),
    [`${R}/all-bytes.bin`]: file(bytes256),
    [`${R}/noise.bin`]: file(random),
    [`${R}/empty.txt`]: file(""),
    [`${R}/üñí/čode.md`]: file("unicode ✓"),
    [`${R}/link`]: { link: "notes.txt" },
    [`${R}/empty-dir`]: { dir: true },
    [`${R}/.git/HEAD`]: file("ref: refs/heads/main\n"),
    [`${R}/.git/refs/heads/main`]: file("abc\n"),
    [`${R}/.git/objects/store.json`]: file("{}"),
  };
  const archive = openWorkspaceExport(await exported(workspace));
  assert.equal(archive.summary.room, "K7MQ2P");
  assert.equal(archive.summary.exportedAt, "2026-11-08T00:00:00.000Z");
  const { entries, skipped, changed } = collect(archive);
  assert.deepEqual(skipped, []);
  assert.deepEqual(changed, []);
  for (const [path, node] of Object.entries(workspace)) {
    const entry = entries.get(path);
    assert.ok(entry, `${path} came back`);
    if (node.link !== undefined) {
      assert.equal(entry.kind, "symlink");
      assert.equal(entry.target, node.link);
    } else if (node.dir) {
      assert.equal(entry.kind, "dir");
    } else {
      assert.equal(entry.kind, "file", path);
      assert.deepEqual(entry.data, node.file, `${path}'s bytes`);
      assert.equal(entry.mode, node.mode ?? 0o644, `${path}'s mode`);
    }
  }
  assert.equal(entries.get(R).kind, "dir");
  // parents before children, so a restore can create them in order
  const order = [...entries.keys()];
  for (const path of order) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (entries.has(parent)) assert.ok(order.indexOf(parent) < order.indexOf(path), `${parent} before ${path}`);
  }
  // mtimes survive at the zip's two-second resolution
  assert.ok(Math.abs(entries.get(`${R}/notes.txt`).mtimeMs - Date.UTC(2026, 10, 8, 3, 4, 6)) < 2000);
  assert.equal(archive.summary.files, 9); // the symlink and dirs aren't files
});

test("transcripts come in only when chosen", async () => {
  const zip = await exported({ [`${R}/a.txt`]: file("a"), [`${TRANSCRIPTS_DIR}/s1.jsonl`]: file('{"type":"user"}\n') });
  const archive = openWorkspaceExport(zip);
  assert.equal(archive.hasTranscripts, true);
  assert.equal(archive.summary.transcriptFiles, 1);
  const without = collect(archive);
  assert.equal(without.entries.has(`${TRANSCRIPTS_DIR}/s1.jsonl`), false);
  assert.ok(without.skipped.some((s) => s.reason === "transcripts"));
  const withThem = collect(archive, { transcripts: true });
  assert.equal(dec.decode(withThem.entries.get(`${TRANSCRIPTS_DIR}/s1.jsonl`).data), '{"type":"user"}\n');
});

test("what the export left out is reported as workspace paths, for reinstalling", async () => {
  const zip = await exported({ [`${R}/a.txt`]: file("a"), [`${R}/node_modules/x/index.js`]: file("x"), [`${R}/py/.venv/lib.py`]: file("y") });
  const { leftOut } = openWorkspaceExport(zip).summary;
  assert.deepEqual(leftOut.map((left) => left.path).sort(), [`${R}/node_modules`, `${R}/py/.venv`]);
  assert.ok(leftOut.every((left) => left.reason === "dependencies" && left.files === 1));
});

test("Riff's session folder and credential files never come in", () => {
  const archive = openWorkspaceExport(handZip({
    "repo/a.txt": strToU8("a"),
    "repo/.wasix-session/bin/node": strToU8("stub"),
    "repo/sub/.git-credentials": strToU8("https://u:p@github.com"),
    "repo/.git/credentials": strToU8("secret"),
  }));
  const { entries, skipped } = collect(archive);
  assert.deepEqual([...entries.keys()].filter((p) => p !== R && !p.endsWith("/sub")).sort(), [`${R}/a.txt`]);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ["credentials", "credentials", "session"]);
});

test("a token Riff holds is overwritten, and .git/config loses credentials", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const archive = openWorkspaceExport(handZip({
    "repo/leak.txt": strToU8(`token=${token}\n`),
    "repo/.git/config": strToU8("[remote \"origin\"]\n\turl = https://x-access-token:abc@github.com/o/r.git\n\textraheader = AUTHORIZATION: basic Zm9v\n"),
  }));
  const { entries, changed } = collect(archive, { secrets: [token] });
  assert.equal(dec.decode(entries.get(`${R}/leak.txt`).data), `token=${"*".repeat(token.length)}\n`);
  const config = dec.decode(entries.get(`${R}/.git/config`).data);
  assert.match(config, /url = https:\/\/github\.com\/o\/r\.git/);
  assert.doesNotMatch(config, /extraheader|abc@/);
  assert.deepEqual(changed.map((c) => c.what).sort(), ["credential-bytes-overwritten", "header-removed", "url-credentials-removed"]);
});

test("anything outside repo/ and the transcripts folder is skipped", () => {
  const { entries, skipped } = collect(openWorkspaceExport(handZip({ "repo/a.txt": strToU8("a"), "elsewhere/b.txt": strToU8("b"), "claude/settings.json": strToU8("{}") })));
  assert.deepEqual([...entries.keys()].sort(), [`${R}/a.txt`]);
  assert.deepEqual(skipped.map((s) => s.path).sort(), ["claude/settings.json", "elsewhere/b.txt"]);
});

test("names that would land outside the workspace refuse the whole file", () => {
  refused(handZip({ "repo/../../etc/passwd": strToU8("x") }), /outside the workspace/);
  refused(handZip({ "/home/user/.bashrc": strToU8("x") }), /outside the workspace/);
  refused(handZip({ "repo/./a": strToU8("x") }), /outside the workspace/);
  refused(handZip({ "repo\\..\\a": strToU8("x") }), /outside the workspace/);
});

test("an entry inside a symlink refuses the whole file", () => {
  refused(handZip({ "repo/out": [strToU8("/opt/riff"), unix(0o120000, 0o777)], "repo/out/x": strToU8("x") }), /inside a symlink/);
});

test("only a Riff export, version 1, is read", () => {
  refused(zipSync({ "repo/a.txt": strToU8("a") }), /no riff-workspace\.json/);
  refused(zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify({ format: "something-else", version: 1 })) }), /isn't a Riff workspace export/);
  refused(zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify({ format: "riff-workspace", version: 2 })) }), /version 2; this Riff reads version 1/);
  refused(zipSync({ [MANIFEST_NAME]: strToU8("{not json") }), /isn't JSON/);
  refused(strToU8("plain text, not a zip at all"), /isn't a zip/);
});

// Find the central directory record for a name, to tamper with it.
function centralRecord(zip, name) {
  const target = enc.encode(name);
  for (let at = 0; at < zip.length - 46; at++) {
    if (zip[at] === 0x50 && zip[at + 1] === 0x4b && zip[at + 2] === 1 && zip[at + 3] === 2) {
      const length = zip[at + 28] | (zip[at + 29] << 8);
      if (length === target.length && dec.decode(zip.subarray(at + 46, at + 46 + length)) === name) return at;
    }
  }
  throw new Error(`no central record for ${name}`);
}

test("a zip that says it holds more than the limit is refused before anything is inflated", () => {
  const zip = handZip({ "repo/big.bin": new Uint8Array(1000) });
  const view = new DataView(zip.buffer, zip.byteOffset);
  view.setUint32(centralRecord(zip, "repo/big.bin") + 24, MAX_IMPORT_BYTES + 1, true);
  refused(zip, /an import takes up to 512 MB/);
});

test("a damaged or lying entry refuses, never comes in short or long", () => {
  const zip = handZip({ "repo/a.txt": strToU8("hello hello hello hello") });
  const crcAt = centralRecord(zip, "repo/a.txt") + 16;
  const damaged = zip.slice();
  new DataView(damaged.buffer).setUint32(crcAt, (crc32(strToU8("hello hello hello hello")) ^ 1) >>> 0, true);
  assert.throws(() => collect(openWorkspaceExport(damaged)), /damaged/);
  // claims fewer bytes than it inflates to
  const short = zip.slice();
  new DataView(short.buffer).setUint32(centralRecord(short, "repo/a.txt") + 24, 5, true);
  assert.throws(() => collect(openWorkspaceExport(short)), /damaged/);
});

test("a name twice refuses", () => {
  // fflate won't write a duplicate, so rename one entry in place
  const zip = handZip({ "repo/a.txt": strToU8("a"), "repo/b.txt": strToU8("b") });
  const at = centralRecord(zip, "repo/b.txt");
  zip[at + 46 + "repo/".length] = "a".charCodeAt(0);
  refused(zip, /twice/);
});
