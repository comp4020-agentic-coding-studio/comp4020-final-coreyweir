// Rooms and who is in them (docs/adr/0006): the API that creates and joins
// rooms, the host's controls, and `resolve`, which every socket and request
// uses to turn a credential into a role. The browser never claims a role.
import { hashToken, normaliseCode, normaliseName } from "./store.mjs";
import { clientAddress, createRateLimit, HttpError, parseCookies, readJson, sameOrigin, sendJson } from "./http.mjs";

const MINUTE = 60 * 1000;

export function createRooms({ store, auth, audit, origin, onMembersChanged = () => {}, onRemoved = () => {} }) {
  const s = store.statements;
  // Rooms are the one thing anyone can create, so creating, joining and
  // looking up codes are limited per address. A full spec run makes about
  // fifteen rooms.
  const limits = {
    create: createRateLimit({ limit: 60, windowMs: 10 * MINUTE }),
    join: createRateLimit({ limit: 120, windowMs: 10 * MINUTE }),
    lookup: createRateLimit({ limit: 240, windowMs: 10 * MINUTE }),
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
  // removed member, a secret for another room, or an ended room.
  function resolve(roomId, { token, cookie }) {
    const room = typeof roomId === "string" ? s.roomById.get(roomId) : undefined;
    if (!room || room.state === "ended") return null;
    let member;
    if (token) {
      member = s.memberBySecret.get(hashToken(token));
      if (member && member.room_id !== room.id) member = undefined;
    } else if (cookie) {
      const current = auth.session({ headers: { cookie } });
      if (current) member = s.memberByUser.get(room.id, current.user.id);
    }
    if (!member || member.removed_at !== null) return null;
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
    ...(secret ? { secret } : {}),
  });
  const roomJson = (room) => ({ id: room.id, code: room.code, locked: Boolean(room.locked) });

  async function create(request, response) {
    limit("create", request);
    const body = await readJson(request);
    const current = auth.session(request);
    const chosen = name(body, current?.user.login);
    const { room, member, secret } = store.createRoom({ name: chosen, userId: current?.user.id });
    audit.record(who(room, member), "room.create");
    onMembersChanged(room.id);
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
    onMembersChanged(room.id);
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
    sendJson(response, 200, { code });
  }

  async function lock(request, response, roomId) {
    const actor = hostOf(request, roomId, "room.lock");
    const body = await readJson(request);
    if (typeof body.locked !== "boolean") throw new HttpError(400, "bad_lock");
    s.setLocked.run(body.locked ? 1 : 0, roomId);
    audit.record(actor, body.locked ? "room.lock" : "room.unlock");
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
    onMembersChanged(roomId);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  // Answers /api/rooms…; false for anything else.
  async function handle(request, response, url) {
    const path = url.pathname;
    if (!path.startsWith("/api/rooms")) return false;
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
    else throw new HttpError(404, "not_found");
    return true;
  }

  // The member list the room sees, written by the server so nobody can
  // fake a name or a "verified" badge.
  function memberList(roomId) {
    return s.members.all(roomId).map((row) => ({
      id: row.id,
      name: row.name,
      host: Boolean(row.is_host),
      login: row.login ?? null,
      removed: row.removed_at !== null,
    }));
  }

  return { handle, resolve, memberList };
}
