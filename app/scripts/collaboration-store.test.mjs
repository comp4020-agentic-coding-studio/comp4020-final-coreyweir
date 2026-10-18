// The room store survives the process being killed (docs/adr/0002): every
// update the server acknowledged is in SQLite, including across compaction.
// The server runs in a child process so it can be SIGKILLed, the crash a
// clean shutdown hook can't cover. A fresh process and a fresh client read
// the room back, so nothing can come from memory.
//
// Run from app/: npm run test:collaboration. It needs --test-force-exit: a
// HocuspocusProvider (4.7.0) destroyed after its server died keeps a
// reconnect timer alive, and the writer is meant to be connected when the
// server is killed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

const moduleUrl = new URL("../server/collaboration.mjs", import.meta.url).href;
const dir = mkdtempSync(join(tmpdir(), "riff-collaboration-"));
const dbPath = join(dir, "riff.sqlite");
after(() => rmSync(dir, { recursive: true, force: true }));

const serverSource = `
  import { createServer } from "node:http";
  import { createCollaboration } from ${JSON.stringify(moduleUrl)};
  const collaboration = createCollaboration({
    dbPath: process.env.RIFF_DB,
    compactMinBytes: Number(process.env.COMPACT_MIN_BYTES),
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => collaboration.handleUpgrade(request, socket, head));
  server.listen(0, "127.0.0.1", () => console.log("[riff] port " + server.address().port));
`;

function startServer() {
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", serverSource], {
    env: { ...process.env, RIFF_DB: dbPath, COMPACT_MIN_BYTES: String(64 * 1024) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = [];
  const port = new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`server exited early (${code})`)));
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        lines.push(line);
        const match = /^\[riff\] port (\d+)$/.exec(line);
        if (match) resolve(Number(match[1]));
      }
    });
  });
  const killed = () =>
    new Promise((resolve) => {
      child.once("exit", (_code, signal) => resolve(signal));
      child.kill("SIGKILL");
    });
  return { port, lines, killed };
}

function joinRoom(port, name) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collaboration/${name}`, name, document: doc });
  const synced = new Promise((resolve) => provider.on("synced", ({ state }) => state && resolve()));
  const saved = () =>
    new Promise((resolve) => {
      if (!provider.hasUnsyncedChanges) return resolve();
      const onChange = ({ number }) => {
        if (number > 0) return;
        provider.off("unsyncedChanges", onChange);
        resolve();
      };
      provider.on("unsyncedChanges", onChange);
    });
  return { doc, provider, synced, saved, leave: () => (provider.destroy(), doc.destroy()) };
}

test("acknowledged edits survive SIGKILL, before and after compaction", { timeout: 30_000 }, async () => {
  const room = "riff-kill-test";
  // 40 entries of ~8 KB: several compactions at a 64 KB threshold.
  const chunk = (i) => `${i}:`.padEnd(8 * 1024, String.fromCharCode(97 + (i % 26)));
  const expected = new Map();

  const first = startServer();
  const writer = joinRoom(await first.port, room);
  await writer.synced;
  const entries = writer.doc.getMap("entries");
  for (let i = 0; i < 40; i += 1) {
    entries.set(`big-${i}`, chunk(i));
    expected.set(`big-${i}`, chunk(i));
    await writer.saved();
  }
  // Let any scheduled compaction run, then make edits that only exist as
  // rows after the last snapshot.
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 5; i += 1) {
    entries.set(`small-${i}`, `after compaction ${i}`);
    expected.set(`small-${i}`, `after compaction ${i}`);
  }
  await writer.saved();
  assert.equal(await first.killed(), "SIGKILL");
  writer.leave();

  assert.ok(first.lines.some((line) => line.includes(`doc ${room} compacted`)), "compaction never ran");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("SELECT snapshot, length(data) AS bytes FROM doc_updates WHERE doc = ? ORDER BY seq").all(room);
  db.close();
  assert.ok(rows.some((row) => row.snapshot === 1), "no snapshot row on disk");
  assert.ok(rows.length < 45, `compaction should have dropped rows, found ${rows.length}`);
  assert.equal(rows.at(-1).snapshot, 0, "the post-compaction edits should still be rows");

  const second = startServer();
  const reader = joinRoom(await second.port, room);
  await reader.synced;
  try {
    const got = reader.doc.getMap("entries");
    assert.equal(got.size, expected.size);
    for (const [key, value] of expected) assert.equal(got.get(key), value, key);
    assert.ok(second.lines.some((line) => line.includes(`doc ${room} loaded: ${rows.length} rows`)));
  } finally {
    // Kill first: a client closing towards a live server waits on a close
    // handshake that the kill would leave hanging.
    await second.killed();
    reader.leave();
  }
});


// Hocuspocus 4.7.0 unloads a document twice when a server write (a direct
// connection) ends: once at once, and again from a timer. The timer's unload
// goes by name, so if a newer copy of the document loaded in between, it
// takes that copy out of the server's map: whoever is attached to it stops
// receiving the server's later writes. Seen as the host's member list going
// stale. The check runs in-process, against the module itself (it prints
// "Yjs was already imported": the server's yjs is a second copy, harmless
// here because only the server's documents are touched).
test("a server write doesn't cut off a copy of the document opened just after it", async () => {
  const { createCollaboration } = await import(moduleUrl);
  const collaboration = createCollaboration({ dbPath: join(dir, "unload.sqlite") });
  const { hocuspocus, change } = collaboration;
  const name = "room/unload-race/control";
  try {
    await change(name, (document) => document.getMap("members").set("1", "Ada"));
    const reader = await hocuspocus.openDirectConnection(name);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hocuspocus.documents.get(name), reader.document, "the open copy is still the server's copy");
    await change(name, (document) => document.getMap("members").set("2", "Bo"));
    assert.equal(reader.document.getMap("members").get("2"), "Bo", "the next server write reaches it");
    await reader.disconnect();
  } finally {
    collaboration.close();
  }
});
