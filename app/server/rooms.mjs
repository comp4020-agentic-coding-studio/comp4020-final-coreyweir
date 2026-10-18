// Rooms and who is in them (docs/adr/0006): the API that creates and joins
// rooms, the host's controls, and `resolve`, which every socket and request
// uses to turn a credential into a role. The browser never claims a role.
import { createHmac, timingSafeEqual } from "node:crypto";
import { hashToken, normaliseCode, normaliseName } from "./store.mjs";
import { clientAddress, createRateLimit, HttpError, parseCookies, readJson, sameOrigin, sendJson } from "./http.mjs";

const MINUTE = 60 * 1000;

const PREVIEW_KEY = /^(\d{1,15})\.([\w-]{22})$/;

// What GitHub accepts as a username: letters, digits and single hyphens
// between them, at most 39 characters. Anything else never reaches GitHub.
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function createRooms({
  store,
  auth,
  audit,
  origin,
  previewSecret,
  // (login) => {id, login, avatarUrl} | null; throws if GitHub can't be asked
  githubLookup,
  // ADR 0003: how long a room waits for its host before it ends
  hostGraceMs = 5 * MINUTE,
  now = () => Date.now(),
  onRoomChanged = () => {},
  onRemoved = () => {},
  // the room's state or invites changed: "your rooms" lists need resending
  onListsChanged = () => {},
  // the room ended or came back: open connections change what they may do
  onEnded = () => {},
  onRevived = () => {},
  log = () => {},
}) {
  if (!previewSecret) throw new Error("createRooms needs a previewSecret");
  if (typeof githubLookup !== "function") throw new Error("createRooms needs githubLookup");
  const s = store.statements;

  // After a restart nobody is connected yet (docs/adr/0008).
  const restarted = s.liveToAway.run(now()).changes;
  if (restarted) log(`${restarted} live rooms are away until their hosts reconnect`);
  // Rooms are the one thing anyone can create, so creating, joining and
  // looking up codes are limited per address. A full spec run makes about
  // fifteen rooms.
  const limits = {
    create: createRateLimit({ limit: 60, windowMs: 10 * MINUTE }),
    join: createRateLimit({ limit: 120, windowMs: 10 * MINUTE }),
    lookup: createRateLimit({ limit: 240, windowMs: 10 * MINUTE }),
    // each invite is a GitHub API call on the app's 5000-an-hour allowance
    invite: createRateLimit({ limit: 120, windowMs: 10 * MINUTE }),
  };

  function limit(name, request) {
    const retry = limits[name](clientAddress(request));
    if (retry) throw new HttpError(429, "slow_down", { headers: { "retry-after": String(retry) } });
  }

  function who(room, member) {
    const login = member.user_id ? s.userById.get(member.user_id)?.login : undefined;
    return {
      roomId: room.id,
      code: room.code,
      memberId: member.id,
      userId: member.user_id ?? undefined,
      name: member.name,
      login,
      role: member.is_host ? "host" : "participant",
    };
  }

  // A credential for one room: a guest's secret, or the GitHub session
  // cookie of a user who is a member. Null for anything else, including a
  // removed member or a secret for another room. A member of an ended room
  // still resolves, with `state: "ended"`, so they can read the board
  // (ADR 0008); the host resolving revives it, unless `revive` is false.
  function resolve(roomId, { token, cookie }, { revive = true } = {}) {
    let room = typeof roomId === "string" ? s.roomById.get(roomId) : undefined;
    if (!room) return null;
    let member;
    if (token) {
      member = s.memberBySecret.get(hashToken(token));
      if (member && member.room_id !== room.id) member = undefined;
    } else if (cookie) {
      const current = auth.session({ headers: { cookie } });
      if (current) member = s.memberByUser.get(room.id, current.user.id);
    }
    if (!member || member.removed_at !== null) return null;
    if (room.state === "ended" && member.is_host && revive) {
      reviveRoom(room, member);
      room = s.roomById.get(room.id);
    }
    return { ...who(room, member), state: room.state };
  }

  // ---- the room's state (ADR 0008; the server half of ADR 0003) ----

  // The host's first socket arriving, and their last one going.
  function presence(actor, action) {
    if (actor?.role !== "host") return;
    if (action === "connect") s.hostArrived.run(now(), actor.roomId);
    else if (s.hostLeft.run(now(), actor.roomId).changes) audit.record(actor, "room.away");
    onRoomChanged(actor.roomId);
  }

  function endRoom(roomId, reason, actor) {
    if (!s.endRoom.run(now(), roomId).changes) return false;
    const invites = s.deleteRoomInvites.run(roomId).changes;
    const room = s.roomById.get(roomId);
    audit.record(actor ?? { roomId, code: room.code }, "room.end", { reason, invites_dropped: invites || undefined });
    onEnded(roomId);
    onRoomChanged(roomId);
    return true;
  }

  function reviveRoom(room, hostMember) {
    if (!s.reviveRoom.run(now(), room.id).changes) return;
    audit.record(who(room, hostMember), "room.revive");
    onRevived(room.id);
    onRoomChanged(room.id);
  }

  // Ends every room whose host has been away longer than the grace period.
  // The state is in SQLite, so a restart doesn't reset anyone's clock.
  function endOverdue() {
    let ended = 0;
    for (const { id } of s.overdueRooms.all(now() - hostGraceMs)) if (endRoom(id, "host_away")) ended += 1;
    return ended;
  }

  // The preview loads in an iframe, which can't send a secret or (sandboxed
  // into an opaque origin) be relied on for cookies, so each member gets a
  // key for the preview's path: their member id and a MAC over the room and
  // that id. Nothing to store; removal or the room ending turns it away,
  // because resolvePreview checks the member like any other credential.
  function previewMac(roomId, memberId) {
    return createHmac("sha256", previewSecret)
      .update(`riff preview v1\0${roomId}\0${memberId}`)
      .digest("base64url")
      .slice(0, 22);
  }

  const previewKey = (member) => `${member.id}.${previewMac(member.room_id, member.id)}`;

  function resolvePreview(roomId, key) {
    const match = PREVIEW_KEY.exec(typeof key === "string" ? key : "");
    const room = typeof roomId === "string" ? s.roomById.get(roomId) : undefined;
    if (!match || !room || room.state === "ended") return null;
    const expected = Buffer.from(previewMac(room.id, Number(match[1])));
    const given = Buffer.from(match[2]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const member = s.memberById.get(Number(match[1]));
    if (!member || member.room_id !== room.id || member.removed_at !== null) return null;
    return who(room, member);
  }

  function bearer(request) {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
    return match ? match[1] : undefined;
  }

  function hasCredential(request) {
    return Boolean(bearer(request)) || parseCookies(request.headers.cookie).has("__Host-riff-session");
  }

  function memberOf(request, roomId) {
    return resolve(roomId, { token: bearer(request), cookie: request.headers.cookie });
  }

  function hostOf(request, roomId, action) {
    const actor = memberOf(request, roomId);
    if (!actor) {
      audit.record(null, "denied", { what: action, reason: hasCredential(request) ? "not_a_member" : "no_credential" });
      throw new HttpError(401, "not_a_member");
    }
    if (actor.role !== "host") {
      audit.record(actor, "denied", { what: action, reason: "host_only" });
      throw new HttpError(403, "host_only");
    }
    return actor;
  }

  function name(body, fallback) {
    const value = body.name === undefined || body.name === "" ? fallback : body.name;
    const normalised = normaliseName(value);
    if (!normalised) throw new HttpError(400, "bad_name");
    return normalised;
  }

  const memberJson = (member, secret) => ({
    id: member.id,
    name: member.name,
    host: Boolean(member.is_host),
    previewKey: previewKey(member),
    ...(secret ? { secret } : {}),
  });
  // endsAt: when an away room ends unless its host comes back.
  const roomJson = (room) => ({
    id: room.id,
    code: room.code,
    locked: Boolean(room.locked),
    state: room.state,
    endsAt: room.state === "away" ? room.host_last_seen + hostGraceMs : null,
  });

  async function create(request, response) {
    limit("create", request);
    const body = await readJson(request);
    const current = auth.session(request);
    const chosen = name(body, current?.user.login);
    const { room, member, secret } = store.createRoom({ name: chosen, userId: current?.user.id });
    audit.record(who(room, member), "room.create");
    onRoomChanged(room.id);
    sendJson(response, 201, { room: roomJson(room), member: memberJson(member, secret) });
  }

  async function join(request, response) {
    limit("join", request);
    const body = await readJson(request);
    const code = normaliseCode(body.code);
    const room = code ? s.roomByCode.get(code) : undefined;
    if (!room) throw new HttpError(404, "no_such_room");
    const current = auth.session(request);

    if (current) {
      const existing = s.memberByUser.get(room.id, current.user.id);
      if (existing && existing.removed_at !== null) {
        audit.record(who(room, existing), "denied", { what: "room.join", reason: "removed" });
        throw new HttpError(403, "removed");
      }
      if (existing) return sendJson(response, 200, { room: roomJson(room), member: memberJson(existing) });
    }
    if (room.locked) {
      audit.record({ roomId: room.id, code: room.code }, "denied", { what: "room.join", reason: "locked" });
      throw new HttpError(423, "locked");
    }
    const chosen = name(body, current?.user.login);
    if (s.memberByNameKey.get(room.id, chosen.key)) throw new HttpError(409, "name_taken");
    let added;
    try {
      added = store.addMember({ roomId: room.id, name: chosen, userId: current?.user.id });
    } catch (error) {
      // two people claiming the same name at the same moment
      if (/UNIQUE/.test(String(error?.message))) throw new HttpError(409, "name_taken");
      throw error;
    }
    audit.record(who(room, added.member), "room.join");
    onRoomChanged(room.id);
    sendJson(response, 201, { room: roomJson(room), member: memberJson(added.member, added.secret) });
  }

  function byCode(request, response, raw) {
    limit("lookup", request);
    const code = normaliseCode(raw);
    const room = code ? s.roomByCode.get(code) : undefined;
    if (!room) throw new HttpError(404, "no_such_room");
    sendJson(response, 200, roomJson(room));
  }

  function me(request, response, roomId) {
    const actor = memberOf(request, roomId);
    if (!actor) throw new HttpError(401, "not_a_member");
    const room = s.roomById.get(roomId);
    sendJson(response, 200, { room: roomJson(room), member: memberJson(s.memberById.get(actor.memberId)) });
  }

  function rotate(request, response, roomId) {
    const actor = hostOf(request, roomId, "code.rotate");
    const code = store.rotateCode(roomId);
    audit.record({ ...actor, code }, "code.rotate", { old: actor.code });
    onRoomChanged(roomId);
    sendJson(response, 200, { code });
  }

  async function lock(request, response, roomId) {
    const actor = hostOf(request, roomId, "room.lock");
    const body = await readJson(request);
    if (typeof body.locked !== "boolean") throw new HttpError(400, "bad_lock");
    s.setLocked.run(body.locked ? 1 : 0, roomId);
    audit.record(actor, body.locked ? "room.lock" : "room.unlock");
    onRoomChanged(roomId);
    sendJson(response, 200, { locked: body.locked });
  }

  function remove(request, response, roomId, memberId) {
    const actor = hostOf(request, roomId, "member.remove");
    const target = s.memberById.get(memberId);
    if (!target || target.room_id !== roomId) throw new HttpError(404, "no_such_member");
    if (target.id === actor.memberId) throw new HttpError(400, "cannot_remove_host");
    s.removeMember.run(Date.now(), target.id);
    audit.record(actor, "member.remove", { target: target.id, target_name: target.name });
    onRemoved(roomId, target.id);
    onRoomChanged(roomId);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  function end(request, response, roomId) {
    const actor = hostOf(request, roomId, "room.end");
    endRoom(roomId, "host", actor);
    sendJson(response, 200, { state: "ended" });
  }

  // ---- invites (ADR 0008) ----

  async function invite(request, response, roomId) {
    const actor = hostOf(request, roomId, "invite.add");
    const body = await readJson(request);
    const login = typeof body.login === "string" ? body.login.trim().replace(/^@/, "") : "";
    if (!GITHUB_LOGIN.test(login)) throw new HttpError(400, "bad_login");
    limit("invite", request);
    let account;
    try {
      account = await githubLookup(login);
    } catch (error) {
      console.error("[riff] GitHub user lookup failed", error);
      throw new HttpError(502, "github_unreachable");
    }
    // Whether a GitHub account exists is public; whether it uses Riff isn't,
    // so the answer below is the same either way.
    if (!account) throw new HttpError(404, "no_such_github_user");
    s.insertInvite.run(roomId, account.id, account.login, actor.memberId, now());
    audit.record(actor, "invite.add", { github_id: account.id, github_login: account.login });
    onListsChanged(roomId);
    sendJson(response, 200, { invited: { githubId: account.id, login: account.login } });
  }

  function cancelInvite(request, response, roomId, githubId) {
    const actor = hostOf(request, roomId, "invite.cancel");
    if (!s.deleteInvite.run(roomId, githubId).changes) throw new HttpError(404, "no_such_invite");
    audit.record(actor, "invite.cancel", { github_id: githubId });
    onListsChanged(roomId);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  function signedIn(request, what) {
    const current = auth.session(request);
    if (!current) {
      audit.record(null, "denied", { what, reason: "signed_out" });
      throw new HttpError(401, "signed_out");
    }
    return current.user;
  }

  function invitedTo(request, roomId, what) {
    const user = signedIn(request, what);
    const account = s.userById.get(user.id);
    const room = s.roomById.get(roomId);
    const row = room && room.state !== "ended" ? s.invite.get(roomId, account.github_id) : undefined;
    if (!row) throw new HttpError(404, "no_such_invite");
    return { user, account, room };
  }

  // An invite gets you in past a lock, and brings back a removed GitHub user
  // (ADR 0006): the host asked for exactly that person.
  async function accept(request, response, roomId) {
    const { user, account, room } = invitedTo(request, roomId, "invite.accept");
    const body = await readJson(request);
    let member = s.memberByUser.get(roomId, user.id);
    let status = 200;
    if (member && member.removed_at !== null) s.restoreMember.run(member.id);
    else if (!member) {
      const chosen = name(body, account.login);
      if (s.memberByNameKey.get(roomId, chosen.key)) throw new HttpError(409, "name_taken");
      try {
        member = store.addMember({ roomId, name: chosen, userId: user.id }).member;
      } catch (error) {
        if (/UNIQUE/.test(String(error?.message))) throw new HttpError(409, "name_taken");
        throw error;
      }
      status = 201;
    }
    member = s.memberById.get(member.id);
    s.deleteInvite.run(roomId, account.github_id);
    audit.record(who(room, member), "invite.accept", { github_id: account.github_id });
    onRoomChanged(roomId);
    onListsChanged(roomId);
    sendJson(response, status, { room: roomJson(room), member: memberJson(member) });
  }

  function decline(request, response, roomId) {
    const { user, account, room } = invitedTo(request, roomId, "invite.decline");
    s.deleteInvite.run(roomId, account.github_id);
    audit.record({ roomId, code: room.code, userId: user.id, login: account.login }, "invite.decline", {
      github_id: account.github_id,
    });
    onListsChanged(roomId);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  // ---- "your rooms" (ADR 0008) ----

  // The member ids a browser's secrets stand for. Wrong or foreign secrets
  // are dropped without a word, so a watch can't be used to test them.
  function membersForSecrets(secrets) {
    const ids = new Set();
    if (!Array.isArray(secrets)) return ids;
    for (const entry of secrets.slice(0, 100)) {
      if (typeof entry?.roomId !== "string" || typeof entry?.secret !== "string") continue;
      const member = s.memberBySecret.get(hashToken(entry.secret));
      if (member && member.room_id === entry.roomId) ids.add(member.id);
    }
    return ids;
  }

  // What one person's list shows: the live rooms they're in (by GitHub user
  // and by this browser's secrets) and the invites waiting for them.
  // Recomputed from the tables every time, so it can't drift from them.
  function listFor({ userId, memberIds }) {
    const rooms = new Map();
    const add = (room, isHost) => {
      if (rooms.has(room.id) || room.state === "ended") return;
      const host = s.hostOf.get(room.id);
      rooms.set(room.id, {
        id: room.id,
        code: room.code,
        role: isHost ? "host" : "participant",
        state: room.state,
        hostName: host?.name ?? null,
        hostLastSeen: room.host_last_seen,
        endsAt: roomJson(room).endsAt,
        locked: Boolean(room.locked),
        ...(isHost
          ? { invites: s.invitesOfRoom.all(room.id).map((row) => ({ githubId: row.github_id, login: row.login })) }
          : {}),
      });
    };
    if (userId) for (const row of s.roomsOfUser.all(userId)) add(row, Boolean(row.is_host));
    for (const id of memberIds ?? []) {
      const member = s.memberById.get(id);
      if (!member || member.removed_at !== null) continue;
      const room = s.roomById.get(member.room_id);
      if (room) add(room, Boolean(member.is_host));
    }
    const account = userId ? s.userById.get(userId) : undefined;
    const invites = account
      ? s.invitesFor.all(account.github_id).map((row) => ({
          roomId: row.room_id,
          code: row.code,
          invitedBy: row.invited_by,
          at: row.created_at,
        }))
      : [];
    return { rooms: [...rooms.values()], invites };
  }

  // Answers /api/rooms… and /api/invites…; false for anything else.
  async function handle(request, response, url) {
    const path = url.pathname;
    if (!path.startsWith("/api/rooms") && !path.startsWith("/api/invites/")) return false;
    if (request.method !== "GET" && !sameOrigin(request, origin)) {
      audit.record(null, "denied", { what: "api", reason: "cross_origin" });
      throw new HttpError(403, "cross_origin");
    }
    let m;
    if (request.method === "POST" && path === "/api/rooms") await create(request, response);
    else if (request.method === "POST" && path === "/api/rooms/join") await join(request, response);
    else if (request.method === "GET" && (m = /^\/api\/rooms\/by-code\/([^/]+)$/.exec(path))) byCode(request, response, decodeURIComponent(m[1]));
    else if (request.method === "GET" && (m = /^\/api\/rooms\/([\w-]+)\/me$/.exec(path))) me(request, response, m[1]);
    else if (request.method === "POST" && (m = /^\/api\/rooms\/([\w-]+)\/code$/.exec(path))) rotate(request, response, m[1]);
    else if (request.method === "POST" && (m = /^\/api\/rooms\/([\w-]+)\/lock$/.exec(path))) await lock(request, response, m[1]);
    else if (request.method === "DELETE" && (m = /^\/api\/rooms\/([\w-]+)\/members\/(\d+)$/.exec(path))) remove(request, response, m[1], Number(m[2]));
    else if (request.method === "POST" && (m = /^\/api\/rooms\/([\w-]+)\/end$/.exec(path))) end(request, response, m[1]);
    else if (request.method === "POST" && (m = /^\/api\/rooms\/([\w-]+)\/invites$/.exec(path))) await invite(request, response, m[1]);
    else if (request.method === "DELETE" && (m = /^\/api\/rooms\/([\w-]+)\/invites\/(\d+)$/.exec(path))) cancelInvite(request, response, m[1], Number(m[2]));
    else if (request.method === "POST" && (m = /^\/api\/invites\/([\w-]+)\/accept$/.exec(path))) await accept(request, response, m[1]);
    else if (request.method === "POST" && (m = /^\/api\/invites\/([\w-]+)\/decline$/.exec(path))) decline(request, response, m[1]);
    else throw new HttpError(404, "not_found");
    return true;
  }

  // What the room sees about itself (the code, whether it's locked, who's
  // in it), written by the server so nobody can fake a name or a badge.
  function summary(roomId) {
    const room = s.roomById.get(roomId);
    const members = s.members.all(roomId).map((row) => ({
      id: row.id,
      name: row.name,
      host: Boolean(row.is_host),
      login: row.login ?? null,
      removed: row.removed_at !== null,
    }));
    return { room: roomJson(room), members };
  }

  return { handle, resolve, resolvePreview, summary, presence, endOverdue, membersForSecrets, listFor };
}
