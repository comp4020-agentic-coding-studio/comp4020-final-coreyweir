// The browser's side of the rooms API and sign-in (server/rooms.mjs,
// server/auth.mjs). The server decides every role; this only carries
// credentials: a guest's room secret, or the session cookie it sends itself.

export type RoomInfo = { id: string; code: string; locked: boolean };
// previewKey goes in the preview relay's path: the participant's iframe
// can't send the secret, so the relay checks this instead.
export type MemberInfo = { id: number; name: string; host: boolean; previewKey: string; secret?: string };
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

export async function createRoom(name: string) {
  return accessFrom(await call("/api/rooms", { method: "POST", body: { name } }));
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

export function rotateCode(access: Access) {
  return call<{ code: string }>(`/api/rooms/${access.room.id}/code`, { method: "POST", body: {}, token: access.token });
}

export function setLocked(access: Access, locked: boolean) {
  return call<{ locked: boolean }>(`/api/rooms/${access.room.id}/lock`, { method: "POST", body: { locked }, token: access.token });
}

export function removeMember(access: Access, memberId: number) {
  return call<void>(`/api/rooms/${access.room.id}/members/${memberId}`, { method: "DELETE", token: access.token });
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
