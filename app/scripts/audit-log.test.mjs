// The who-did-what log, read back from the events table. The spec/ checks
// talk to a deployed app and can't read its log, so this runs the server
// in-process on a throwaway database: a host and a guest share a room, and
// every row has to name the right member and action. Ids only, never text.
//
// npm run test:audit-log
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { createRiff } from "../server/riff.mjs";

// Yjs warns that it was imported twice: the server's copy lives in
// app/server/node_modules, this client's in app/node_modules. The two never
// share a document object, only bytes over the socket, so it's harmless.

const SECRET_TEXT = "please make the header blue";

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "riff-audit-"));
  const dbPath = join(dir, "riff.sqlite");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const riff = createRiff({ dbPath, origin, sessionSecret: "test", log: () => {} });
  server.on("request", (request, response) => riff.middleware(request, response, () => {
    response.statusCode = 404;
    response.end();
  }));
  server.on("upgrade", (request, socket, head) => {
    if (!riff.handleUpgrade(request, socket, head)) socket.destroy();
  });
  return {
    origin,
    async stop() {
      riff.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare("SELECT member_id, action, detail_json FROM events ORDER BY seq").all();
      db.close();
      rmSync(dir, { recursive: true, force: true });
      return rows.map((row) => ({ member: row.member_id, action: row.action, detail: JSON.parse(row.detail_json ?? "{}") }));
    },
  };
}

async function post(origin, path, body, secret) {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
}

function connect(origin, roomId, part, secret) {
  class Socket extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { origin } });
    }
  }
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: `${origin.replace("http", "ws")}/collaboration`, WebSocketPolyfill: Socket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: `room/${roomId}/${part}`, document: doc, token: secret });
  provider.attach();
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
  const synced = new Promise((resolve) => provider.on("synced", ({ state }) => state && resolve()));
  return synced.then(() => ({
    doc,
    saved,
    leave() {
      provider.destroy();
      socket.destroy();
    },
  }));
}

test("the log names who staged, queued, sent and removed each prompt", async () => {
  const app = await start();
  let rows;
  try {
    const created = await post(app.origin, "/api/rooms", { name: "Ada" });
    const roomId = created.room.id;
    const host = created.member;
    const guest = (await post(app.origin, "/api/rooms/join", { code: created.room.code, name: "Bo" })).member;

    const guestShared = await connect(app.origin, roomId, "shared", guest.secret);
    const hostShared = await connect(app.origin, roomId, "shared", host.secret);
    const hostControl = await connect(app.origin, roomId, "control", host.secret);

    // Bo stages two prompts, the way the client does: a map per prompt.
    const stage = (id) => {
      const prompt = new Y.Map();
      const text = new Y.Text();
      text.insert(0, SECRET_TEXT);
      prompt.set("text", text);
      guestShared.doc.getMap("prompts").set(id, prompt);
    };
    stage("p-sent");
    stage("p-removed");
    await guestShared.saved();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Ada queues both (room.ts queuePrompt), loads one (sendQueued) and
    // removes the other.
    const queue = hostControl.doc.getMap("queue");
    const roomState = hostControl.doc.getMap("roomState");
    for (const id of ["p-sent", "p-removed"]) {
      hostControl.doc.transact(() => queue.set(id, { id, author: "Bo", text: SECRET_TEXT, rank: Date.now() }));
      hostShared.doc.getMap("prompts").delete(id);
    }
    await Promise.all([hostControl.saved(), hostShared.saved()]);
    hostControl.doc.transact(() => {
      roomState.set("lastSent", "p-sent");
      queue.delete("p-sent");
    });
    queue.delete("p-removed");
    await hostControl.saved();

    guestShared.leave();
    hostShared.leave();
    hostControl.leave();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    rows = await app.stop();
  }

  const said = (member, action, id) => rows.some((row) => row.member === member && row.action === action && (id === undefined || row.detail.id === id));
  const ada = rows.find((row) => row.action === "room.create")?.member;
  const bo = rows.find((row) => row.action === "room.join")?.member;
  assert.ok(ada && bo && ada !== bo, "room.create and room.join name two members");

  assert.ok(said(bo, "prompt.add", "p-sent") && said(bo, "prompt.add", "p-removed"), "Bo staged both");
  assert.ok(said(ada, "queue.add", "p-sent") && said(ada, "queue.add", "p-removed"), "Ada queued both");
  assert.ok(said(ada, "prompt.delete", "p-sent"), "queueing takes the prompt out of staging");
  assert.ok(said(ada, "queue.send", "p-sent"), "loading is logged as a send");
  assert.ok(!said(ada, "queue.delete", "p-sent"), "a sent prompt isn't also logged as removed");
  assert.ok(said(ada, "queue.delete", "p-removed"), "removing is logged as a delete");
  assert.ok(!said(ada, "queue.send", "p-removed"), "a removed prompt isn't logged as sent");
  assert.ok(said(bo, "connect") && said(bo, "disconnect"), "Bo's presence is logged");
  assert.ok(said(bo, "shared.edit"), "Bo's edits are tallied");
  assert.ok(!JSON.stringify(rows).includes("header blue"), "no prompt text in the log");
});
