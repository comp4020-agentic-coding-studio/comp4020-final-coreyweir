// The browser's side of the rooms API and sign-in (server/rooms.mjs,
// server/auth.mjs). The server decides every role; this only carries
// credentials: a guest's room secret, or the session cookie it sends itself.

// `keep`: whether the server keeps the board after the room ends. `state`
// and `endsAt` follow the host: away rooms end at `endsAt` (docs/adr/0003).
// A room holds `limitBytes`; once a write would cross it the room is `full`
// and read-only for good. `pruned`: the server deleted an ended board to
// make space.
export type RoomState = "live" | "away" | "ended";
export type RoomInfo = {
  id: string;
  code: string;
  locked: boolean;
  keep: boolean;
  state: RoomState;
  endsAt: number | null;
  limitBytes: number | null;
  full: boolean;
  pruned: boolean;
};
// previewKey goes in the preview relay's path: the participant's iframe
// can't send the secret, so the relay checks this instead.
// modelKey (hosts only, when the server has Riff's own model key) lets the
// host's Claude Code use /api/model (docs/adr/0009).
export type MemberInfo = { id: number; name: string; host: boolean; previewKey: string; modelKey?: string; secret?: string };
export type User = { id: number; login: string; avatarUrl: string | null };
// Everything a page needs to be in a room: which room, who you are in it,
// and the guest secret (null for a signed-in member).
export type Access = { room: RoomInfo; member: MemberInfo; token: string | null };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const secretKey = (roomId: string) => `riff-member:${roomId}`;

export function storedSecret(roomId: string) {
  return localStorage.getItem(secretKey(roomId));
}

function remember(roomId: string, secret: string | undefined) {
  if (secret) localStorage.setItem(secretKey(roomId), secret);
}

export function forget(roomId: string) {
  localStorage.removeItem(secretKey(roomId));
}

async function call<T>(path: string, { method = "GET", body, token }: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, typeof json.error === "string" ? json.error : `http_${response.status}`);
  return json as T;
}

export async function currentUser() {
  const { user } = await call<{ user: User | null }>("/api/me");
  return user;
}

export function signInUrl(purpose: "identity" | "push" = "identity", back = location.pathname + location.search) {
  return `/auth/github/start?${new URLSearchParams({ purpose, return: back })}`;
}

export async function signOut() {
  forgetPushToken();
  await call("/api/signout", { method: "POST", body: {} });
}

function accessFrom({ room, member }: { room: RoomInfo; member: MemberInfo }): Access {
  remember(room.id, member.secret);
  return { room, member, token: member.secret ?? storedSecret(room.id) };
}

export async function createRoom(name: string, keep = true) {
  return accessFrom(await call("/api/rooms", { method: "POST", body: { name, keep } }));
}

export async function joinRoom(code: string, name: string) {
  return accessFrom(await call("/api/rooms/join", { method: "POST", body: { code, name } }));
}

export function roomByCode(code: string) {
  return call<RoomInfo>(`/api/rooms/by-code/${encodeURIComponent(code)}`);
}

// Am I already in this room? A stored guest secret first, then the
// session cookie. Null if neither makes this browser a member.
export async function enterRoom(roomId: string): Promise<Access | null> {
  const token = storedSecret(roomId);
  try {
    const result = await call<{ room: RoomInfo; member: MemberInfo }>(`/api/rooms/${encodeURIComponent(roomId)}/me`, { token });
    return { ...result, token };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    // A secret the server no longer accepts (removed, or an old room) is
    // worth nothing; try the cookie instead.
    if (token) {
      forget(roomId);
      return enterRoom(roomId);
    }
    return null;
  }
}

// Riff's own free models (docs/adr/0009): the server forwards the host's
// Claude Code to OpenRouter with Riff's key. Model ids are OpenRouter's
// Anthropic-format ones; "[1m]" tells Claude Code the context is 1M tokens.
// Every alias points at a free model: the key is limited to free models,
// so Claude Code's own default (a paid Haiku for small background calls)
// would be refused.
export const RIFF_MODEL = "anthropic/nvidia/nemotron-3-ultra-550b-a55b:free[1m]";
export const RIFF_SMALL_MODEL = "anthropic/nvidia/nemotron-3.5-lightning:free";
export const RIFF_MODEL_ENV: Record<string, string> = {
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  ANTHROPIC_MODEL: RIFF_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: RIFF_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: RIFF_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: RIFF_SMALL_MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: RIFF_SMALL_MODEL,
};

export function riffModelsUrl() {
  return `${location.origin}/api/model`;
}

export async function riffModelsAvailable() {
  try {
    return (await call<{ available: boolean }>("/api/model")).available === true;
  } catch {
    return false;
  }
}

export function rotateCode(access: Access) {
  return call<{ code: string }>(`/api/rooms/${access.room.id}/code`, { method: "POST", body: {}, token: access.token });
}

export function setLocked(access: Access, locked: boolean) {
  return call<{ locked: boolean }>(`/api/rooms/${access.room.id}/lock`, { method: "POST", body: { locked }, token: access.token });
}

export function removeMember(access: Access, memberId: number) {
  return call<void>(`/api/rooms/${access.room.id}/members/${memberId}`, { method: "DELETE", token: access.token });
}

// Host only. Stopping keeping is always allowed; starting again answers
// 409 others_joined once anyone else has been in the room.
export function setKeep(access: Access, keep: boolean) {
  return call<{ keep: boolean }>(`/api/rooms/${access.room.id}/keep`, { method: "POST", body: { keep }, token: access.token });
}

// Host only. The host's page must leave the room afterwards: the host
// opening it again revives it.
export function endRoom(access: Access) {
  return call<{ state: "ended" }>(`/api/rooms/${access.room.id}/end`, { method: "POST", body: {}, token: access.token });
}

// Your rooms, invites and colleagues (docs/adr/0008).

export type PendingInvite = { githubId: number; login: string };
export type ListedRoom = {
  id: string;
  code: string;
  role: "host" | "participant";
  state: "live" | "away";
  keep: boolean;
  hostName: string;
  hostLastSeen: number | null;
  endsAt: number | null;
  locked: boolean;
  // Only in the host's own entry.
  invites?: PendingInvite[];
};
export type Invitation = { roomId: string; code: string; invitedBy: string; at: number };
export type RoomList = { rooms: ListedRoom[]; invites: Invitation[] };
export type Colleague = { githubId: number; login: string; avatarUrl: string | null };
export type Colleagues = { colleagues: Colleague[]; recent: (Colleague & { lastRoomAt: number; colleague: boolean })[] };

// Every room this browser holds a guest secret for. The server ignores
// secrets it doesn't accept, so a stale one costs nothing.
export function storedSecrets() {
  const secrets: { roomId: string; secret: string }[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index) ?? "";
    if (!key.startsWith("riff-member:")) continue;
    const secret = localStorage.getItem(key);
    if (secret) secrets.push({ roomId: key.slice("riff-member:".length), secret });
  }
  return secrets;
}

// The list as the server keeps it, live: a websocket that receives the
// whole list each time it changes. The secrets go in the first message,
// not the URL, so they stay out of logs. Reconnects until closed.
export function watchRooms(onList: (list: RoomList) => void) {
  let socket: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;

  function connect() {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/rooms/watch`);
    socket.onopen = () => {
      delay = 1000;
      socket?.send(JSON.stringify({ type: "hello", secrets: storedSecrets() }));
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "rooms") onList({ rooms: message.rooms ?? [], invites: message.invites ?? [] });
      } catch {
        // Not ours; ignore.
      }
    };
    socket.onclose = () => {
      if (closed) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  }

  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
  };
}

export function inviteToRoom(access: Access, login: string) {
  return call<{ invited: PendingInvite }>(`/api/rooms/${access.room.id}/invites`, { method: "POST", body: { login }, token: access.token });
}

export function cancelInvite(access: Access, githubId: number) {
  return call<void>(`/api/rooms/${access.room.id}/invites/${githubId}`, { method: "DELETE", token: access.token });
}

export async function acceptInvite(roomId: string, name?: string) {
  return accessFrom(await call(`/api/invites/${encodeURIComponent(roomId)}/accept`, { method: "POST", body: name ? { name } : {} }));
}

export function declineInvite(roomId: string) {
  return call<void>(`/api/invites/${encodeURIComponent(roomId)}/decline`, { method: "POST", body: {} });
}

export function listColleagues() {
  return call<Colleagues>("/api/me/colleagues");
}

export function addColleague(login: string) {
  return call<{ colleague: Colleague }>("/api/me/colleagues", { method: "POST", body: { login } });
}

export function removeColleague(githubId: number) {
  return call<void>(`/api/me/colleagues/${githubId}`, { method: "DELETE" });
}

// GitHub for pushing (docs/adr/0005). The browser keeps only what the
// server sealed with a key from this session: after a push sign-in it
// arrives in the URL fragment, and a pasted token is sealed on request.
// Only the same session can open it again, so signing out kills it.
const PUSH_KEY = "riff-github-push";

export function takePushFromLocation() {
  const match = /^#push=([\w-]+)$/.exec(location.hash);
  if (!match) return;
  localStorage.setItem(PUSH_KEY, match[1]);
  history.replaceState(history.state, "", location.pathname + location.search);
}

export function hasPushToken() {
  return localStorage.getItem(PUSH_KEY) !== null;
}

export function forgetPushToken() {
  localStorage.removeItem(PUSH_KEY);
}

export async function sealPastedToken(token: string) {
  const { ciphertext } = await call<{ ciphertext: string }>("/api/github/token/seal", { method: "POST", body: { token } });
  localStorage.setItem(PUSH_KEY, ciphertext);
}

// The token itself, for the host's pod; null if none is stored or the
// session that sealed it has ended (and then the stale copy is dropped).
export async function unwrapPushToken() {
  const ciphertext = localStorage.getItem(PUSH_KEY);
  if (!ciphertext) return null;
  try {
    const { token } = await call<{ token: string }>("/api/github/token/unwrap", { method: "POST", body: { ciphertext } });
    return token;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 400 || error.status === 401)) {
      forgetPushToken();
      return null;
    }
    throw error;
  }
}
