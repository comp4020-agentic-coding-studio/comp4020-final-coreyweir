// Your rooms, invites and colleagues (ADR 0008), for the paths spec/ can't
// reach: they need signed-in GitHub users, and a deployed app only gets
// those through GitHub. This runs the server in-process on a throwaway
// database, writes users and sessions straight into it, and stands in for
// GitHub's user lookup. It also shortens the host's grace period so a room
// can end inside a test.
//
// npm run test:rooms
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
import { hashToken, randomToken } from "../server/store.mjs";

// Yjs warns that it was imported twice (server and client copies); harmless,
// see audit-log.test.mjs.

// Stand-in for GET https://api.github.com/users/:login. "dee" has a GitHub
// account but has never signed in to Riff.
const GITHUB = new Map([
  ["ada", { id: 1, login: "ada" }],
  ["bo", { id: 2, login: "bo" }],
  ["cy", { id: 3, login: "cy" }],
  ["dee", { id: 4, login: "dee" }],
]);
const githubLookup = async (login) => {
  const account = GITHUB.get(login.toLowerCase());
  return account ? { ...account, avatarUrl: null } : null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start({ dir = mkdtempSync(join(tmpdir(), "riff-rooms-")), ...options } = {}) {
  const dbPath = join(dir, "riff.sqlite");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const riff = createRiff({ dbPath, origin, sessionSecret: "test", githubLookup, log: () => {}, ...options });
  server.on("request", (request, response) => riff.middleware(request, response, () => {
    response.statusCode = 404;
    response.end();
  }));
  server.on("upgrade", (request, socket, head) => {
    if (!riff.handleUpgrade(request, socket, head)) socket.destroy();
  });
  const db = new DatabaseSync(dbPath);
  let stopped = false;
  const app = {
    dir,
    origin,
    db,
    // A signed-in GitHub user, as /auth would leave them: a users row and a
    // session whose token is the cookie.
    signIn(login) {
      const { id } = GITHUB.get(login);
      const now = Date.now();
      db.prepare(`INSERT INTO users (github_id, login, avatar_url, created_at, last_seen) VALUES (?, ?, NULL, ?, ?)
        ON CONFLICT (github_id) DO UPDATE SET login = excluded.login`).run(id, login, now, now);
      const user = db.prepare("SELECT id FROM users WHERE github_id = ?").get(id);
      const token = randomToken();
      db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(hashToken(token), user.id, now, now, now + 86_400_000);
      return `__Host-riff-session=${token}`;
    },
    prune: () => riff.prune(),
    events: () =>
      db.prepare("SELECT room_id, member_id, user_id, action, detail_json FROM events ORDER BY seq").all()
        .map((row) => ({ ...row, detail: JSON.parse(row.detail_json ?? "{}") })),
    async stop({ keep = false } = {}) {
      if (stopped) return;
      stopped = true;
      db.close();
      riff.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
  return app;
}

async function call(app, path, { method = "POST", body, secret, cookie } = {}) {
  const headers = { origin: app.origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (cookie) headers.cookie = cookie;
  const response = await fetch(new URL(path, app.origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const get = (app, path, options = {}) => call(app, path, { ...options, method: "GET" });

class OriginSocket extends WebSocket {}

function socketClass(origin, cookie) {
  return class extends OriginSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { origin, ...(cookie ? { cookie } : {}) } });
    }
  };
}

// The rooms list as a browser sees it: /api/rooms/watch, with the guest
// secrets it holds and its session cookie.
function watch(app, { secrets = [], cookie } = {}) {
  const Socket = socketClass(app.origin, cookie);
  const ws = new Socket(`${app.origin.replace("http", "ws")}/api/rooms/watch`);
  let latest = null;
  const waiters = new Set();
  ws.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type !== "rooms") return;
    latest = message;
    for (const waiter of waiters) waiter();
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", secrets })));
  return {
    latest: () => latest,
    until(check, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const test = () => {
          if (latest && check(latest)) {
            clearTimeout(timer);
            waiters.delete(test);
            resolve(latest);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(test);
          reject(new Error(`watch never matched; last: ${JSON.stringify(latest)}`));
        }, timeoutMs);
        waiters.add(test);
        test();
      });
    },
    close: () => ws.close(),
  };
}

function connect(app, roomId, part, { secret, cookie } = {}) {
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({
    url: `${app.origin.replace("http", "ws")}/collaboration`,
    WebSocketPolyfill: socketClass(app.origin, cookie),
  });
  let refused = () => {};
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `room/${roomId}/${part}`,
    document: doc,
    token: secret ?? "",
    onAuthenticationFailed: ({ reason }) => refused(reason),
  });
  provider.attach();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`room/${roomId}/${part} never synced`)), 5000);
    refused = (reason) => {
      clearTimeout(timer);
      provider.destroy();
      socket.destroy();
      reject(new Error(`refused: ${reason}`));
    };
    provider.on("synced", ({ state }) => {
      if (!state) return;
      clearTimeout(timer);
      resolve({
        doc,
        leave() {
          provider.destroy();
          socket.destroy();
        },
      });
    });
  });
}

const by = (action) => (row) => row.action === action;

test("an invite reaches only the invitee, live, and lets them in past the lock", async () => {
  const app = await start();
  const watches = [];
  try {
    const ada = app.signIn("ada");
    const bo = app.signIn("bo");
    const cy = app.signIn("cy");
    const created = await call(app, "/api/rooms", { body: { name: "Ada" }, cookie: ada });
    assert.equal(created.status, 201);
    const roomId = created.body.room.id;
    const hostSecret = created.body.member.secret;
    const host = hostSecret ? { secret: hostSecret } : { cookie: ada };

    const boWatch = watch(app, { cookie: bo });
    const cyWatch = watch(app, { cookie: cy });
    const adaWatch = watch(app, { cookie: ada });
    watches.push(boWatch, cyWatch, adaWatch);
    await Promise.all([boWatch.until(() => true), cyWatch.until(() => true)]);

    // the reply is the same whether or not the account has used Riff
    const toBo = await call(app, `/api/rooms/${roomId}/invites`, { body: { login: "@Bo" }, ...host });
    const toDee = await call(app, `/api/rooms/${roomId}/invites`, { body: { login: "dee" }, ...host });
    assert.equal(toBo.status, 200);
    assert.equal(toDee.status, 200);
    assert.deepEqual(Object.keys(toBo.body.invited).sort(), Object.keys(toDee.body.invited).sort());
    assert.equal((await call(app, `/api/rooms/${roomId}/invites`, { body: { login: "nobody" }, ...host })).status, 404);

    const boList = await boWatch.until((list) => list.invites.length === 1);
    assert.equal(boList.invites[0].roomId, roomId);
    assert.equal(boList.invites[0].invitedBy, "Ada");
    await sleep(200);
    assert.deepEqual(cyWatch.latest().invites, [], "Cy sees nothing of Bo's invite");

    // the host's list carries the pending invites; nobody else's does
    const adaList = await adaWatch.until((list) => list.rooms[0]?.invites?.length === 2);
    assert.equal(adaList.rooms[0].role, "host");

    // locked to codes, open to invites
    assert.equal((await call(app, `/api/rooms/${roomId}/lock`, { body: { locked: true }, ...host })).status, 200);
    assert.equal((await call(app, "/api/rooms/join", { body: { code: created.body.room.code, name: "Cy" }, cookie: cy })).status, 423);
    const accepted = await call(app, `/api/invites/${roomId}/accept`, { body: {}, cookie: bo });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.member.name, "bo");
    const joined = await boWatch.until((list) => list.invites.length === 0 && list.rooms.length === 1);
    assert.equal(joined.rooms[0].role, "participant");
    assert.equal(joined.rooms[0].invites, undefined, "a participant doesn't see who else is invited");
    assert.equal((await call(app, `/api/invites/${roomId}/accept`, { body: {}, cookie: bo })).status, 404, "an invite is used once");

    // Bo is a member by account, so his sockets need no secret
    const boShared = await connect(app, roomId, "shared", { cookie: bo });
    boShared.leave();

    // declining clears it for the invitee and the host
    await call(app, `/api/rooms/${roomId}/invites`, { body: { login: "cy" }, ...host });
    await cyWatch.until((list) => list.invites.length === 1);
    assert.equal((await call(app, `/api/invites/${roomId}/decline`, { body: {}, cookie: cy })).status, 204);
    await cyWatch.until((list) => list.invites.length === 0);
    await adaWatch.until((list) => list.rooms[0]?.invites?.every((i) => i.login !== "cy"));

    // the host can cancel; a removed member can be invited back
    assert.equal((await call(app, `/api/rooms/${roomId}/invites/4`, { method: "DELETE", ...host })).status, 204);
    assert.equal((await call(app, `/api/rooms/${roomId}/invites/4`, { method: "DELETE", ...host })).status, 404);
    const boMember = accepted.body.member.id;
    assert.equal((await call(app, `/api/rooms/${roomId}/members/${boMember}`, { method: "DELETE", ...host })).status, 204);
    await assert.rejects(connect(app, roomId, "shared", { cookie: bo }), /refused/);
    await call(app, `/api/rooms/${roomId}/invites`, { body: { login: "bo" }, ...host });
    assert.equal((await call(app, `/api/invites/${roomId}/accept`, { body: {}, cookie: bo })).status, 200);
    (await connect(app, roomId, "shared", { cookie: bo })).leave();

    const events = app.events();
    assert.equal(events.filter(by("invite.add")).length, 4);
    assert.equal(events.filter(by("invite.accept")).length, 2);
    assert.equal(events.filter(by("invite.decline")).length, 1);
    assert.equal(events.filter(by("invite.cancel")).length, 1);
    assert.ok(events.filter(by("invite.add")).every((row) => row.room_id === roomId && row.detail.github_login));
  } finally {
    watches.forEach((w) => w.close());
    await app.stop();
  }
});

test("a room whose host stays away ends after the grace period, and its invites go with it", async () => {
  const app = await start({ hostGraceMs: 300, stateCheckMs: 50 });
  try {
    const ada = app.signIn("ada");
    const bo = app.signIn("bo");
    const created = await call(app, "/api/rooms", { body: { name: "Ada" }, cookie: ada });
    const roomId = created.body.room.id;
    const boWatch = watch(app, { cookie: bo });
    const hostControl = await connect(app, roomId, "control", { cookie: ada });
    await call(app, `/api/rooms/${roomId}/invites`, { body: { login: "bo" }, cookie: ada });
    await boWatch.until((list) => list.invites.length === 1);

    // present, the host keeps the room live however long it runs
    await sleep(500);
    assert.equal((await get(app, `/api/rooms/by-code/${created.body.room.code}`)).status, 200);

    hostControl.leave();
    await boWatch.until((list) => list.invites.length === 0, 3000);
    assert.equal((await get(app, `/api/rooms/by-code/${created.body.room.code}`)).status, 404);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE room_id = ?").get(roomId).n, 0);
    assert.equal(app.db.prepare("SELECT state FROM rooms WHERE id = ?").get(roomId).state, "ended");

    const events = app.events().filter((row) => row.room_id === roomId);
    const order = events.map((row) => row.action).filter((a) => a.startsWith("room."));
    assert.deepEqual(order, ["room.create", "room.away", "room.end"]);
    const end = events.find(by("room.end"));
    assert.equal(end.detail.reason, "host_away");
    assert.equal(end.detail.invites_dropped, 1);
    boWatch.close();
  } finally {
    await app.stop();
  }
});

test("a board the server doesn't keep is deleted from disk when its room ends; a kept one stays", async () => {
  const app = await start({ hostGraceMs: 300, stateCheckMs: 50 });
  const rows = (roomId) =>
    app.db.prepare("SELECT COUNT(*) AS n FROM doc_updates WHERE doc IN (?, ?)").get(`room/${roomId}/shared`, `room/${roomId}/control`).n;
  try {
    const rooms = {};
    for (const which of ["kept", "unkept"]) {
      const created = await call(app, "/api/rooms", { body: { name: "Ada" } });
      const room = { id: created.body.room.id, code: created.body.room.code, host: created.body.member.secret };
      // the unkept one is switched before anyone joins, so the log shows both ways in
      if (which === "unkept") assert.equal((await call(app, `/api/rooms/${room.id}/keep`, { body: { keep: false }, secret: room.host })).status, 200);
      const joined = (await call(app, "/api/rooms/join", { body: { code: room.code, name: "Bo" } })).body.member;
      room.guest = joined.secret;
      room.guestId = joined.id;
      const session = await connect(app, room.id, "shared", { secret: room.host });
      session.doc.getText("board").insert(0, `drawn in the ${which} room`);
      for (let i = 0; i < 100 && rows(room.id) < 2; i++) await sleep(10);
      session.leave();
      rooms[which] = room;
    }
    assert.ok(rows(rooms.kept.id) > 0 && rows(rooms.unkept.id) > 0, "both boards were stored");

    // the host stays away past the grace period: both end
    for (let i = 0; i < 100; i++) {
      const ended = app.events().filter(by("room.end")).length;
      if (ended === 2) break;
      await sleep(20);
    }
    assert.equal(rows(rooms.unkept.id), 0, "the unkept board's rows are gone");
    assert.ok(rows(rooms.kept.id) > 0, "the kept board's rows stay");

    await assert.rejects(connect(app, rooms.unkept.id, "shared", { secret: rooms.unkept.guest }), /refused: room-ended/);
    const reading = await connect(app, rooms.kept.id, "shared", { secret: rooms.kept.guest });
    assert.equal(reading.doc.getText("board").toString(), "drawn in the kept room");
    reading.leave();

    // the kept room's guest asks for the terminal: refused, and the log
    // says whose refusal it was
    const Socket = socketClass(app.origin);
    const relay = new Socket(`${app.origin.replace("http", "ws")}/terminal/${rooms.kept.id}`);
    relay.on("open", () => relay.send(JSON.stringify({ type: "hello", role: "participant", token: rooms.kept.guest })));
    const heard = await new Promise((resolve) => relay.on("message", (data) => resolve(JSON.parse(String(data)))));
    assert.deepEqual(heard, { type: "error", code: "room-ended" });
    relay.close();

    const events = app.events();
    assert.ok(events.some((row) => row.action === "denied" && row.detail.what === "terminal" && row.detail.reason === "room_ended" && row.member_id === rooms.kept.guestId));
    const ends = Object.fromEntries(events.filter(by("room.end")).map((row) => [row.room_id, row.detail]));
    assert.deepEqual(ends[rooms.kept.id], { reason: "host_away", board: "kept" });
    assert.deepEqual(ends[rooms.unkept.id], { reason: "host_away", board: "deleted" });
    assert.deepEqual(events.filter(by("room.keep")).map((row) => [row.room_id, row.detail.board]), [[rooms.unkept.id, "not_kept"]]);
  } finally {
    await app.stop();
  }
});

// ADR 0003's amendment. spec/limits.test.ts checks the cap on a deployed
// app; this checks what it can't: that a full room stays full across a
// restart, and pruning, which needs a nearly full volume (stood in for).
test("the limit counts what the room holds, not edits since undone", async () => {
  const app = await start({ roomLimitBytes: 4000 });
  try {
    const created = await call(app, "/api/rooms", { body: { name: "Ada" } });
    const room = { id: created.body.room.id, host: created.body.member.secret };
    const board = await connect(app, room.id, "shared", { secret: room.host });
    const text = board.doc.getText("board");
    const me = async () => (await get(app, `/api/rooms/${room.id}/me`, { secret: room.host })).body.room;
    const stored = () => app.db.prepare("SELECT COUNT(*) AS n FROM doc_updates WHERE doc = ?").get(`room/${room.id}/shared`).n;
    // 2.5 kB written and deleted, then 2.5 kB more: 5 kB of rows, 2.5 kB of board
    text.insert(0, "a".repeat(2500));
    for (let i = 0; i < 100 && stored() < 1; i++) await sleep(10);
    text.delete(0, 2500);
    for (let i = 0; i < 100 && stored() < 2; i++) await sleep(10);
    text.insert(0, "b".repeat(2500));
    for (let i = 0; i < 100 && stored() < 2; i++) await sleep(10);
    await sleep(100);
    assert.equal((await me()).full, false);
    board.leave();
    const reread = await connect(app, room.id, "shared", { secret: room.host });
    assert.equal(reread.doc.getText("board").toString(), "b".repeat(2500));
    reread.leave();
  } finally {
    await app.stop();
  }
});

test("a full room stays full after a restart", async () => {
  let app = await start({ roomLimitBytes: 4000 });
  const dir = app.dir;
  const rows = (roomId) => app.db.prepare("SELECT COUNT(*) AS n FROM doc_updates WHERE doc = ?").get(`room/${roomId}/shared`).n;
  let room;
  try {
    const created = await call(app, "/api/rooms", { body: { name: "Ada" } });
    room = { id: created.body.room.id, host: created.body.member.secret };
    assert.equal(created.body.room.limitBytes, 4000);
    const board = await connect(app, room.id, "shared", { secret: room.host });
    board.doc.getText("board").insert(0, "a".repeat(2500));
    for (let i = 0; i < 100 && rows(room.id) < 1; i++) await sleep(10);
    board.doc.getText("board").insert(0, "b".repeat(2500));
    for (let i = 0; i < 100 && !(await get(app, `/api/rooms/${room.id}/me`, { secret: room.host })).body.room.full; i++) await sleep(10);
    assert.equal(rows(room.id), 1, "the write that didn't fit wasn't stored");
    board.leave();
  } finally {
    await app.stop({ keep: true });
  }
  app = await start({ dir, roomLimitBytes: 4000 });
  try {
    assert.equal((await get(app, `/api/rooms/${room.id}/me`, { secret: room.host })).body.room.full, true);
    const board = await connect(app, room.id, "shared", { secret: room.host });
    assert.equal(board.doc.getText("board").toString(), "a".repeat(2500));
    board.doc.getText("board").insert(0, "c");
    await sleep(300);
    assert.equal(rows(room.id), 1, "a full room takes nothing more, even a byte");
    board.leave();
    const full = app.events().filter(by("room.full"));
    assert.equal(full.length, 1);
    assert.ok(full[0].detail.stored_bytes > 2500 && full[0].detail.refused_bytes > 2500);
  } finally {
    await app.stop();
  }
});

test("pruning deletes the ended boards opened longest ago until the volume is below 60%, never a live one", async () => {
  // A 10 kB volume, 75% used, and boards of about 1 kB: two have to go.
  let used = 7_500;
  const app = await start({ diskUsage: () => ({ total: 10_000, used }) });
  const rows = (roomId) =>
    app.db.prepare("SELECT COUNT(*) AS n FROM doc_updates WHERE doc IN (?, ?)").get(`room/${roomId}/shared`, `room/${roomId}/control`).n;
  try {
    const rooms = {};
    for (const name of ["a", "b", "c", "live"]) {
      const created = await call(app, "/api/rooms", { body: { name: "Ada" } });
      const room = { id: created.body.room.id, code: created.body.room.code, host: created.body.member.secret };
      room.guest = (await call(app, "/api/rooms/join", { body: { code: room.code, name: "Bo" } })).body.member.secret;
      const board = await connect(app, room.id, "shared", { secret: room.host });
      board.doc.getText("board").insert(0, name.repeat(1000 / name.length));
      for (let i = 0; i < 100 && rows(room.id) < 1; i++) await sleep(10);
      board.leave();
      if (name !== "live") assert.equal((await call(app, `/api/rooms/${room.id}/end`, { body: {}, secret: room.host })).status, 200);
      rooms[name] = room;
      await sleep(5);
    }
    // a was opened again after it ended, so b and c are the oldest
    (await connect(app, rooms.a.id, "shared", { secret: rooms.a.guest })).leave();

    assert.equal(app.prune(), 2);
    assert.ok(rows(rooms.a.id) > 0, "the board opened most recently stays");
    assert.equal(rows(rooms.b.id), 0);
    assert.equal(rows(rooms.c.id), 0);
    assert.ok(rows(rooms.live.id) > 0, "a room that hasn't ended is never pruned");

    // to its members, a pruned board is like one the server didn't keep
    await assert.rejects(connect(app, rooms.b.id, "shared", { secret: rooms.b.guest }), /refused: board-pruned/);
    assert.equal((await get(app, `/api/rooms/${rooms.b.id}/me`, { secret: rooms.b.guest })).body.room.pruned, true);
    const pruned = app.events().filter(by("room.prune"));
    assert.deepEqual(pruned.map((row) => row.room_id).sort(), [rooms.b.id, rooms.c.id].sort());
    assert.ok(pruned.every((row) => row.detail.freed_bytes > 1000));

    // its host opening it brings it back, from their own copy
    const revived = await connect(app, rooms.b.id, "shared", { secret: rooms.b.host });
    assert.equal(revived.doc.getText("board").toString(), "", "the server has nothing left of it");
    revived.doc.getText("board").insert(0, "from the host's copy");
    for (let i = 0; i < 100 && rows(rooms.b.id) < 1; i++) await sleep(10);
    revived.leave();
    const me = (await get(app, `/api/rooms/${rooms.b.id}/me`, { secret: rooms.b.guest })).body.room;
    assert.equal(me.pruned, false);
    assert.notEqual(me.state, "ended");
    assert.ok(rows(rooms.b.id) > 0);

    // below 70% nothing is pruned
    used = 6_500;
    assert.equal(app.prune(), 0);
    assert.ok(rows(rooms.a.id) > 0);
  } finally {
    await app.stop();
  }
});

test("after a restart, live rooms count as away with a fresh grace period", async () => {
  let app = await start();
  const dir = app.dir;
  let roomId;
  let code;
  try {
    const created = await call(app, "/api/rooms", { body: { name: "Ada" } });
    roomId = created.body.room.id;
    code = created.body.room.code;
    // as if the machine died with the host connected an hour ago
    app.db.prepare("UPDATE rooms SET state = 'live', host_last_seen = ? WHERE id = ?").run(Date.now() - 3_600_000, roomId);
  } finally {
    await app.stop({ keep: true });
  }
  app = await start({ dir, hostGraceMs: 400, stateCheckMs: 50 });
  try {
    const row = app.db.prepare("SELECT state, host_last_seen FROM rooms WHERE id = ?").get(roomId);
    assert.equal(row.state, "away");
    assert.ok(Date.now() - row.host_last_seen < 1000, "the grace period starts at the restart");
    assert.equal((await get(app, `/api/rooms/by-code/${code}`)).status, 200);
    await sleep(800);
    assert.equal((await get(app, `/api/rooms/by-code/${code}`)).status, 404);
  } finally {
    await app.stop();
  }
});

test("the signed-in list follows the account; a guest's follows the secrets it holds", async () => {
  const app = await start();
  try {
    const ada = app.signIn("ada");
    const adaElsewhere = app.signIn("ada");
    const created = await call(app, "/api/rooms", { body: { name: "Ada" }, cookie: ada });
    const guest = await call(app, "/api/rooms/join", { body: { code: created.body.room.code, name: "Gil" } });

    const fromAnotherBrowser = watch(app, { cookie: adaElsewhere });
    const list = await fromAnotherBrowser.until((l) => l.rooms.length === 1);
    assert.equal(list.rooms[0].id, created.body.room.id);
    assert.equal(list.rooms[0].role, "host");
    fromAnotherBrowser.close();

    const guestBrowser = watch(app, { secrets: [{ roomId: created.body.room.id, secret: guest.body.member.secret }] });
    assert.equal((await guestBrowser.until((l) => l.rooms.length === 1)).rooms[0].role, "participant");
    guestBrowser.close();

    const stranger = watch(app);
    assert.deepEqual((await stranger.until(() => true)).rooms, []);
    stranger.close();
  } finally {
    await app.stop();
  }
});

test("colleagues: recently worked with, an explicit list that's private and one-way, and logged", async () => {
  const app = await start();
  try {
    const ada = app.signIn("ada");
    const bo = app.signIn("bo");
    const created = await call(app, "/api/rooms", { body: { name: "Ada" }, cookie: ada });
    assert.equal((await call(app, "/api/rooms/join", { body: { code: created.body.room.code, name: "Bo" }, cookie: bo })).status, 201);
    // a guest in the same room isn't someone you can find again
    await call(app, "/api/rooms/join", { body: { code: created.body.room.code, name: "Gil" } });

    let mine = (await get(app, "/api/me/colleagues", { cookie: ada })).body;
    assert.deepEqual(mine.colleagues, []);
    assert.deepEqual(mine.recent.map((r) => r.login), ["bo"]);
    assert.equal(mine.recent[0].colleague, false);

    assert.equal((await call(app, "/api/me/colleagues", { body: { login: "bo" }, cookie: ada })).status, 200);
    assert.equal((await call(app, "/api/me/colleagues", { body: { login: "dee" }, cookie: ada })).status, 200, "someone you haven't met yet");
    assert.equal((await call(app, "/api/me/colleagues", { body: { login: "Ada" }, cookie: ada })).status, 400);
    assert.equal((await call(app, "/api/me/colleagues", { body: { login: "nobody" }, cookie: ada })).status, 404);
    mine = (await get(app, "/api/me/colleagues", { cookie: ada })).body;
    assert.deepEqual(mine.colleagues.map((c) => c.login).sort(), ["bo", "dee"]);
    assert.equal(mine.recent[0].colleague, true);

    const bos = (await get(app, "/api/me/colleagues", { cookie: bo })).body;
    assert.deepEqual(bos.colleagues, [], "adding someone doesn't add you to theirs");
    assert.deepEqual(bos.recent.map((r) => r.login), ["ada"]);

    assert.equal((await call(app, "/api/me/colleagues/2", { method: "DELETE", cookie: ada })).status, 204);
    assert.equal((await call(app, "/api/me/colleagues/2", { method: "DELETE", cookie: ada })).status, 404);
    assert.deepEqual((await get(app, "/api/me/colleagues", { cookie: ada })).body.colleagues.map((c) => c.login), ["dee"]);

    const events = app.events();
    const adds = events.filter(by("colleague.add"));
    assert.equal(adds.length, 2);
    assert.ok(adds.every((row) => row.room_id === null && row.user_id !== null));
    assert.deepEqual(adds.map((row) => row.detail.colleague).sort(), ["bo", "dee"]);
    assert.equal(events.filter(by("colleague.remove")).length, 1);
  } finally {
    await app.stop();
  }
});
