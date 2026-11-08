// "Export files" from the landing page (app/src/savedWorkspaceSource.ts):
// a saved workspace's OPFS manifest and blobs, zipped by workspaceExport.ts,
// gives the same zip contents as the same files read from a live filesystem.
// Under node, with the manifest made here the way workspace.ts writes it.
//
// Not told apart here: whether a real manifest looks like this one (the
// browser smoke, `npm run test:workspace-export-files-ui`, compares the row's
// zip with the in-room Export of the same workspace).
import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { exportWorkspace } from "../src/workspaceExport.ts";
import { savedWorkspaceSource } from "../src/savedWorkspaceSource.ts";

const enc = new TextEncoder();
const T = Date.UTC(2026, 10, 8, 1, 2, 4);

// path -> manifest entry and bytes, as workspace.ts saves them
function saved(tree) {
  const entries = {};
  const files = new Map();
  let blob = 1;
  for (const [path, node] of Object.entries(tree)) {
    if (node === "dir") entries[path] = ["d", 0o755, T];
    else if (node.link) entries[path] = ["l", 0o777, T, 0, node.link];
    else {
      const name = (blob++).toString(36);
      const data = typeof node.data === "string" ? enc.encode(node.data) : node.data;
      entries[path] = ["f", node.mode ?? 0o644, T, data.length, name];
      if (!node.missing) files.set(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
  }
  const manifest = { format: "riff-workspace-1", room: "r", seq: 3, savedAt: T, next: blob, files: files.size, bytes: 0, entries };
  return { manifest, files };
}

// The same tree as a live filesystem would show it.
function live(tree) {
  const nodes = new Map();
  const add = (path, node) => {
    nodes.set(path, node);
    for (let dir = path.slice(0, path.lastIndexOf("/")); dir; dir = dir.slice(0, dir.lastIndexOf("/"))) if (!nodes.has(dir)) nodes.set(dir, "dir");
  };
  for (const [path, node] of Object.entries(tree)) add(path, node);
  return {
    async readdir(path) { return [...nodes.keys()].filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")).map((p) => p.slice(path.length + 1)); },
    async lstat(path) {
      const n = nodes.get(path);
      if (!n) return null;
      if (n === "dir") return { kind: "dir", size: 0, mode: 0o755, mtimeMs: T };
      if (n.link) return { kind: "symlink", size: n.link.length, mode: 0o777, mtimeMs: T };
      const data = typeof n.data === "string" ? enc.encode(n.data) : n.data;
      return { kind: "file", size: data.length, mode: n.mode ?? 0o644, mtimeMs: T };
    },
    async readFile(path) { const n = nodes.get(path); return typeof n.data === "string" ? enc.encode(n.data) : n.data; },
    async readlink(path) { return nodes.get(path).link; },
  };
}

const tree = {
  "/work/repo/notes.txt": { data: "unpushed\n" },
  "/work/repo/bin/run.sh": { data: "#!/bin/sh\n", mode: 0o755 },
  "/work/repo/bytes.bin": { data: Uint8Array.of(0, 1, 254, 255) },
  "/work/repo/link": { link: "notes.txt" },
  "/work/repo/empty-dir": "dir",
  "/work/repo/.git/HEAD": { data: "ref: refs/heads/main\n" },
  "/work/repo/.git/objects/store.json": { data: "{}" },
  "/work/repo/node_modules/x/index.js": { data: "dep" },
  "/home/user/.claude/projects/-work-repo/s.jsonl": { data: "{}\n" },
  "/home/user/.bash_history": { data: "ls\n" },
};

const zipOf = async (source, options) => {
  const result = await exportWorkspace(source, { room: "K7MQ2P", now: new Date(T), ...options });
  return { files: unzipSync(new Uint8Array(await result.blob.arrayBuffer())), manifest: result.manifest };
};

for (const options of [{}, { transcripts: false, dependencies: true }]) {
  test(`a saved workspace zips the same as the live one ${JSON.stringify(options)}`, async () => {
    const { manifest, files } = saved(tree);
    const fromSaved = await zipOf(savedWorkspaceSource(manifest, files), options);
    const fromLive = await zipOf(live(tree), options);
    assert.deepEqual(Object.keys(fromSaved.files).sort(), Object.keys(fromLive.files).sort());
    for (const name of Object.keys(fromLive.files)) {
      if (name === "riff-workspace.json") continue;
      assert.deepEqual(fromSaved.files[name], fromLive.files[name], name);
    }
    assert.deepEqual(fromSaved.manifest.left, fromLive.manifest.left);
    assert.equal(fromSaved.manifest.files, fromLive.manifest.files);
  });
}

test("a file whose saved copy went missing is reported as unreadable, not dropped silently", async () => {
  const { manifest, files } = saved({ ...tree, "/work/repo/lost.txt": { data: "gone", missing: true } });
  const { files: zipped, manifest: m } = await zipOf(savedWorkspaceSource(manifest, files));
  assert.equal("repo/lost.txt" in zipped, false);
  assert.ok(m.left.some((left) => left.path === "repo/lost.txt" && left.reason === "unreadable"));
});
