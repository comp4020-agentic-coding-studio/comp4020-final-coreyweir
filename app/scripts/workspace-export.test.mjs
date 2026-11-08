// Workspace export (app/src/workspaceExport.ts): what goes into the zip
// comes back byte for byte, and what must not travel doesn't. Runs the
// module itself under node (type stripping) against an in-memory source.
// The browser smoke (`npm run test:workspace-export-browser`) does the same
// against a real pod; this one is fast, and can poke the corners.
//
// Not told apart here: whether a real pod's files look like these ones
// (the browser smoke's job), and whether Claude Code writes its
// transcripts where TRANSCRIPTS_DIR says.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync } from "fflate";
import {
  DEPENDENCY_DIRS,
  MANIFEST_NAME,
  TRANSCRIPTS_DIR,
  WORKSPACE_ROOT,
  exportWorkspace,
  overwriteSecrets,
  scrubGitConfig,
} from "../src/workspaceExport.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// A tiny filesystem: path -> { dir } | { file, mode } | { link }.
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
    nodes,
    async readdir(path) {
      if (!nodes.get(path)?.dir) throw new Error(`ENOTDIR ${path}`);
      return kids(path);
    },
    async lstat(path) {
      const n = nodes.get(path);
      if (!n) return null;
      if (n.dir) return { kind: "dir", size: 0, mode: 0o755, mtimeMs: Date.UTC(2026, 10, 8) };
      if (n.link !== undefined) return { kind: "symlink", size: n.link.length, mode: 0o777, mtimeMs: 0 };
      return { kind: "file", size: n.file.length, mode: n.mode ?? 0o644, mtimeMs: Date.UTC(2026, 10, 8) };
    },
    async readFile(path) { return nodes.get(path).file; },
    async readlink(path) { return nodes.get(path).link; },
  };
}

const R = WORKSPACE_ROOT;
const bytes256 = Uint8Array.from({ length: 256 }, (_, i) => i);
const random = (() => { let x = 12345; return Uint8Array.from({ length: 100_000 }, () => (x = (x * 1103515245 + 12345) & 0x7fffffff) >>> 16 & 0xff); })();
const file = (data, mode) => ({ file: typeof data === "string" ? enc.encode(data) : data, mode });

const MODEL = "sk-real-model-token-0123456789";
const GITHUB = "ghp_RealGithubToken0123456789abcdef";
const PLACEHOLDER = "riff-placeholder-model-0123456789abcdef0123456789abcdef";

function workspace(extra = {}) {
  return memorySource({
    [`${R}/.keep`]: file(""),
    [`${R}/README.md`]: file("# hi\n"),
    [`${R}/src/deep/er/main.ts`]: file("export const x = 1;\n"),
    [`${R}/src/ünï côde.txt`]: file("unicode name\n"),
    [`${R}/assets/all-bytes.bin`]: file(bytes256),
    [`${R}/assets/random.dat`]: file(random),
    [`${R}/assets/pic.png`]: file(random.slice(0, 5000)),
    [`${R}/bin/run.sh`]: file("#!/bin/sh\necho hi\n", 0o755),
    [`${R}/link-to-readme`]: { link: "README.md" },
    [`${R}/empty-dir/placeholder`]: file(""),
    [`${R}/.git/HEAD`]: file("ref: refs/heads/main\n"),
    [`${R}/.git/config`]: file("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/o/r.git\n"),
    [`${R}/.git/objects/store.json`]: file(JSON.stringify({ abc: { type: "blob", data: "unpushed work" } })),
    [`${R}/node_modules/left-pad/index.js`]: file("module.exports = 1;\n"),
    [`${R}/node_modules/.bin/tool`]: { link: "../tool/cli.js" },
    [`${R}/packages/a/node_modules/dep/index.js`]: file("nested dep\n"),
    [`${R}/.wasix-session/bin/git`]: file(random.slice(0, 20_000)),
    [`${R}/.wasix-session/ca.pem`]: file("-----BEGIN CERTIFICATE-----\n"),
    [`${R}/.git-credentials`]: file("https://user:tok@github.com\n"),
    [`${TRANSCRIPTS_DIR}/0b1c.jsonl`]: file('{"type":"user","message":"build a thing"}\n'),
    ...extra,
  });
}

async function run(source, options = {}) {
  const result = await exportWorkspace(source, { room: "K7MQ2P", now: new Date("2026-11-08T05:00:00Z"), ...options });
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  return { ...result, files };
}

const names = (files) => Object.keys(files).sort();
const has = (files, prefix) => Object.keys(files).some((n) => n === prefix || n.startsWith(`${prefix}/`));

test("every file in the workspace comes back byte for byte", async () => {
  const source = workspace();
  const { files, manifest } = await run(source);
  for (const [path, node] of source.nodes) {
    if (!path.startsWith(`${R}/`) || node.dir || node.link !== undefined) continue;
    const rel = path.slice(R.length + 1);
    if (/(^|\/)(node_modules|\.wasix-session)\//.test(`${rel}/`) || rel === ".git-credentials" || rel === ".git/config") continue;
    assert.ok(files[`repo/${rel}`], `repo/${rel} is in the zip`);
    assert.deepEqual(files[`repo/${rel}`], node.file, `repo/${rel} is the same bytes`);
  }
  assert.equal(files["repo/assets/random.dat"].length, 100_000);
  assert.equal(dec.decode(files["repo/src/ünï côde.txt"]), "unicode name\n");
  assert.equal(dec.decode(files["repo/link-to-readme"]), "README.md", "a symlink is stored as its target");
  assert.ok("repo/empty-dir/" in files && "repo/" in files, "directories are entries");
  assert.equal(manifest.format, "riff-workspace");
  assert.equal(manifest.room, "K7MQ2P");
  assert.deepEqual(JSON.parse(dec.decode(files[MANIFEST_NAME])), manifest);
});

test("the zip says unix modes and symlinks, so unzip restores them", async () => {
  const { blob } = await run(workspace());
  const zip = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(zip.buffer);
  let eocd = zip.length - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let at = view.getUint32(eocd + 16, true);
  const modes = {};
  for (let i = 0, n = view.getUint16(eocd + 10, true); i < n; i++) {
    const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const name = dec.decode(zip.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint8(at + 5), 3, `${name} was made on unix`);
    modes[name] = view.getUint32(at + 38, true) >>> 16;
    at += 46 + nameLength + extra + comment;
  }
  assert.equal(modes["repo/bin/run.sh"] & 0o777, 0o755);
  assert.equal(modes["repo/link-to-readme"] & 0o170000, 0o120000, "the link is marked as a link");
  assert.equal(modes["repo/README.md"] & 0o170000, 0o100000);
  assert.equal(modes["repo/src/"] & 0o170000, 0o040000);
});

test("dependency folders, at any depth, stay out by default and are counted", async () => {
  const { files, manifest } = await run(workspace());
  assert.equal(has(files, "repo/node_modules"), false);
  assert.equal(has(files, "repo/packages/a/node_modules"), false);
  const left = Object.fromEntries(manifest.left.map((e) => [e.path, e]));
  assert.equal(left["repo/node_modules"].reason, "dependencies");
  assert.equal(left["repo/node_modules"].files, 1 + 1, "its file and its link");
  assert.equal(left["repo/packages/a/node_modules"].files, 1);
  assert.ok(DEPENDENCY_DIRS.includes("node_modules"));
});

test("asked for, dependencies come too, and session files and credential files still don't", async () => {
  const { files, manifest } = await run(workspace(), { dependencies: true });
  assert.equal(dec.decode(files["repo/node_modules/left-pad/index.js"]), "module.exports = 1;\n");
  assert.equal(dec.decode(files["repo/packages/a/node_modules/dep/index.js"]), "nested dep\n");
  assert.equal(manifest.includes.dependencies, true);
  assert.equal(has(files, "repo/.wasix-session"), false, "Riff's session folder never travels");
  assert.equal(has(files, "repo/.git-credentials"), false);
  assert.ok(manifest.left.some((e) => e.path === "repo/.wasix-session" && e.reason === "session" && e.files === 2));
});

test("a credentials file inside .git stays out", async () => {
  const { files, manifest } = await run(workspace({ [`${R}/.git/credentials`]: file("https://u:t@github.com\n") }));
  assert.equal("repo/.git/credentials" in files, false);
  assert.ok(manifest.left.some((e) => e.path === "repo/.git/credentials" && e.reason === "credentials"));
  assert.ok("repo/.git/HEAD" in files, "the rest of .git stays: unpushed commits are the point");
});

test("transcripts come by default, under claude/, and the checkbox's off leaves them out and says so", async () => {
  const off = await run(workspace(), { transcripts: false });
  assert.equal(has(off.files, "claude"), false);
  assert.equal(off.manifest.includes.transcripts, false);
  assert.ok(off.manifest.left.some((e) => e.reason === "transcripts" && e.files === 1));
  const on = await run(workspace());
  assert.equal(on.manifest.includes.transcripts, true);
  assert.equal(dec.decode(on.files["claude/projects/-work-repo/0b1c.jsonl"]), '{"type":"user","message":"build a thing"}\n');
  assert.equal(on.manifest.transcriptFiles, 1);
  assert.equal(on.manifest.files, off.manifest.files, "the file count is the repo's alone");
  assert.equal(on.manifest.left.some((e) => e.reason === "transcripts"), false);
});

test("a real credential is overwritten wherever it turns up, in text, binary, .git and transcripts", async () => {
  const source = workspace({
    [`${R}/notes.txt`]: file(`token is ${MODEL} and again ${MODEL}\nplaceholder ${PLACEHOLDER}\n`),
    [`${R}/assets/blob.bin`]: file(Uint8Array.from([0, 255, 1, ...enc.encode(GITHUB), 2, 254])),
    [`${R}/.git/objects/store.json`]: file(JSON.stringify({ x: { type: "blob", data: `const t = "${GITHUB}"` } })),
    [`${TRANSCRIPTS_DIR}/0b1c.jsonl`]: file(`{"tool_result":"${MODEL}"}\n`),
  });
  const { files, manifest } = await run(source, { secrets: [MODEL, GITHUB, "short"] });
  const notes = dec.decode(files["repo/notes.txt"]);
  assert.equal(notes, `token is ${"*".repeat(MODEL.length)} and again ${"*".repeat(MODEL.length)}\nplaceholder ${PLACEHOLDER}\n`, "same length; a placeholder is left alone");
  const blob = files["repo/assets/blob.bin"];
  assert.equal(blob.length, 3 + GITHUB.length + 2, "binary offsets hold");
  assert.deepEqual([...blob.slice(0, 3)], [0, 255, 1]);
  assert.deepEqual([...blob.slice(-2)], [2, 254]);
  for (const [name, data] of Object.entries(files)) {
    const text = Buffer.from(data).toString("latin1");
    assert.equal(text.includes(MODEL), false, `${name} has no model token`);
    assert.equal(text.includes(GITHUB), false, `${name} has no GitHub token`);
  }
  assert.ok(JSON.parse(dec.decode(files["repo/.git/objects/store.json"])), ".git's store is still valid JSON");
  const changed = manifest.changed.filter((e) => e.what === "credential-bytes-overwritten").map((e) => e.path).sort();
  assert.deepEqual(changed, ["claude/projects/-work-repo/0b1c.jsonl", "repo/.git/objects/store.json", "repo/assets/blob.bin", "repo/notes.txt"]);
  assert.equal(JSON.stringify(manifest).includes(MODEL), false, "the manifest names files, never values");
  assert.equal(notes.includes("short"), false);
});

test("a short 'secret' is ignored rather than mangling ordinary text", () => {
  const out = overwriteSecrets(enc.encode("a short word"), [enc.encode("short")]);
  assert.equal(out.found, false);
});

test("a remote's user:token and an extraheader are taken out of .git/config, the rest is kept", async () => {
  const config = [
    "[core]", "\tbare = false", "[user]", "\tname = A", "[remote \"origin\"]",
    "\turl = https://x-access-token:SECRET123@github.com/o/r.git", "\tpushurl = https://oauth2:abc@github.com/o/r.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*", "[http]", "\textraheader = AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46U0VDUkVU", "",
  ].join("\n");
  const { files, manifest } = await run(workspace({ [`${R}/.git/config`]: file(config) }));
  const out = dec.decode(files["repo/.git/config"]);
  assert.equal(out.includes("SECRET123"), false);
  assert.equal(out.includes("oauth2"), false);
  assert.equal(out.includes("eC1hY2Nlc3MtdG9rZW46U0VDUkVU"), false);
  assert.match(out, /url = https:\/\/github\.com\/o\/r\.git/);
  assert.match(out, /pushurl = https:\/\/github\.com\/o\/r\.git/);
  assert.match(out, /name = A/);
  assert.match(out, /fetch = \+refs/);
  assert.deepEqual(manifest.changed.filter((e) => e.path === "repo/.git/config").map((e) => e.what).sort(), ["header-removed", "url-credentials-removed"]);
});

test("a plain config is left exactly as it was", () => {
  const text = "[remote \"origin\"]\n\turl = git@github.com:o/r.git\n\turl = https://github.com/o/r.git\n";
  assert.deepEqual(scrubGitConfig(text), { text, urls: 0, headers: 0 });
});

test("with no workspace there's nothing to export, and it says so", async () => {
  await assert.rejects(() => exportWorkspace(memorySource({ "/tmp/x": file("hi") })), /no workspace/i);
});

test("a file that can't be read is named, not silently dropped, and doesn't stop the rest", async () => {
  const source = workspace();
  const real = source.readFile;
  source.readFile = async (path) => { if (path.endsWith("README.md")) throw new Error("EIO"); return real(path); };
  const { files, manifest } = await run(source);
  assert.equal("repo/README.md" in files, false);
  assert.ok(manifest.left.some((e) => e.path === "repo/README.md" && e.reason === "unreadable"));
  assert.ok("repo/src/deep/er/main.ts" in files);
});

test("the zip's own listing has nothing outside repo/, claude/ and the manifest", async () => {
  const { files } = await run(workspace());
  for (const name of names(files)) assert.match(name, /^(repo\/|claude\/|riff-workspace\.json$)/);
});

// Nodepod's store: hash -> {type, data}; a commit's data is JSON.
function store(commits) {
  const objects = {};
  for (const [hash, parent, message, timestamp, author = "A <a@b.c>"] of commits) {
    objects[hash] = { type: "commit", data: JSON.stringify({ tree: "t", parent, author, committer: author, timestamp, message }) };
  }
  return JSON.stringify(objects);
}

test("the manifest lists the commits and marks the ones no remote branch reaches", async () => {
  const T = Date.UTC(2026, 10, 8, 1);
  const { manifest } = await run(workspace({
    [`${R}/.git/objects/store.json`]: file(store([
      ["aaaaaaa1", null, "first", T], ["aaaaaaa2", "aaaaaaa1", "cloned tip", T + 1000], ["aaaaaaa3", "aaaaaaa2", "unpushed one", T + 2000], ["aaaaaaa4", "aaaaaaa3", `unpushed two ${MODEL}`, T + 3000],
      ["bbbbbbb1", "aaaaaaa1", "on another branch", T + 500],
    ])),
    [`${R}/.git/refs/heads/main`]: file("aaaaaaa4\n"),
    [`${R}/.git/refs/heads/feature/x`]: file("bbbbbbb1\n"),
    [`${R}/.git/refs/remotes/origin/main`]: file("aaaaaaa2\n"),
  }), { secrets: [MODEL] });
  const history = manifest.history;
  assert.equal(history.branch, "main");
  assert.equal(history.head, "aaaaaaa4");
  assert.deepEqual(history.branches, { main: "aaaaaaa4", "feature/x": "bbbbbbb1" });
  assert.deepEqual(history.remotes, { "origin/main": "aaaaaaa2" });
  const by = Object.fromEntries(history.commits.map((c) => [c.hash, c]));
  assert.deepEqual(history.commits.map((c) => c.hash), ["aaaaaaa4", "aaaaaaa3", "aaaaaaa2", "bbbbbbb1", "aaaaaaa1"]);
  assert.deepEqual([by.aaaaaaa1.unpushed, by.aaaaaaa2.unpushed, by.aaaaaaa3.unpushed, by.aaaaaaa4.unpushed, by.bbbbbbb1.unpushed], [false, false, true, true, true]);
  assert.equal(history.unpushed, 3);
  assert.equal(by.aaaaaaa3.at, "2026-11-08T01:00:02.000Z");
  assert.equal(by.aaaaaaa3.author, "A <a@b.c>");
  assert.equal(by.aaaaaaa4.message.includes(MODEL), false, "a token in a commit message is overwritten in the manifest too");
});

test("no remote branches means every commit is unpushed, and a repo-less workspace has no history", async () => {
  const withRepo = await run(workspace({
    [`${R}/.git/objects/store.json`]: file(store([["aaaaaaa1", null, "x", 1000]])),
    [`${R}/.git/refs/heads/main`]: file("aaaaaaa1\n"),
  }));
  assert.equal(withRepo.manifest.history.unpushed, 1);
  const noRepo = await run(memorySource({ [`${R}/a.txt`]: file("hi") }));
  assert.equal(noRepo.manifest.history, null);
  const broken = await run(workspace({ [`${R}/.git/objects/store.json`]: file("{not json") }));
  assert.equal(broken.manifest.history, null, "a store that won't parse doesn't stop the export");
  assert.ok("repo/.git/objects/store.json" in broken.files, "and it's still carried as it was");
});
