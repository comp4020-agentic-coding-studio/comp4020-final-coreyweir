import { describe, expect, inject, it } from "vitest";
import { api, createRoom, joinRoom } from "./riff";

// ADR 0009: a room's host can use Riff's own free models through the
// server, which adds Riff's OpenRouter key. Nobody else can, and the key
// never reaches a browser.
//
// Every check here lists models, which costs none of the daily allowance.
// A refused request getting no further than our server, and the streamed
// reply, are checked in-process (`npm run test:models` in app/), where a
// stand-in OpenRouter can count what reached it.
//
// The app under test needs OPENROUTER_API_KEY. Without it, the first check
// fails and says so, rather than every other check passing for nothing.
const baseUrl = inject("baseUrl");

const models = (key?: string, path = "/api/model/v1/models") =>
  fetch(new URL(path, baseUrl), { headers: key ? { authorization: `Bearer ${key}` } : {} });

describe("Riff's own models", () => {
  it("says whether it has them, and gives the host of a room a key for them", async () => {
    const offered = await (await fetch(new URL("/api/model", baseUrl))).json();
    expect(offered, "the server has no OPENROUTER_API_KEY").toEqual({ available: true });

    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    expect(host.modelKey).toMatch(/^[\w-]+\.\d+\.[\w-]{22}$/);
    expect(guest.modelKey).toBeUndefined();

    // the host's own view of the room hands it back, a participant's doesn't
    const me = async (secret: string) => (await (await api(baseUrl, `/api/rooms/${host.roomId}/me`, { secret })).json()).member;
    expect((await me(host.secret)).modelKey).toBe(host.modelKey);
    expect((await me(guest.secret)).modelKey).toBeUndefined();
  });

  it("lists the allowed models for the host's key", async () => {
    const host = await createRoom(baseUrl);
    const res = await models(host.modelKey);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  }, 30_000);

  it("turns away no key, a made-up one, and a participant forging the host's", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const outsider = await createRoom(baseUrl);
    const [roomId, memberId, mac] = host.modelKey!.split(".");
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");

    expect((await models()).status).toBe(401);
    expect((await models("sk-or-v1-0000")).status).toBe(401);
    expect((await models(`${roomId}.${memberId}.${flipped}`)).status).toBe(401);
    expect((await models(`${roomId}.${guest.memberId}.${mac}`)).status).toBe(401);
    expect((await models(`${outsider.roomId}.${memberId}.${mac}`)).status).toBe(401);
    // a key for one room is still only that room's
    expect((await models(`${roomId}.${outsider.memberId}.${outsider.modelKey!.split(".")[2]}`)).status).toBe(401);
    // and Riff's key isn't anybody's to send: it's added by the server
    expect((await models(guest.secret)).status).toBe(401);
  });

  it("forwards only the model API, nothing else under OpenRouter", async () => {
    const host = await createRoom(baseUrl);
    expect((await models(host.modelKey, "/api/model/v1/credits")).status).toBe(404);
    expect((await models(host.modelKey, "/api/model/v1/key")).status).toBe(404);
    expect((await models(host.modelKey, "/api/model/v1/models/../key")).status).toBe(404);
  });

  it("stops the host's key working once the room ends", async () => {
    const host = await createRoom(baseUrl, undefined, { keep: false });
    expect((await models(host.modelKey)).status).toBe(200);
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/end`, { method: "POST", secret: host.secret, body: {} })).status).toBe(200);
    expect((await models(host.modelKey)).status).toBe(403);
  }, 30_000);
});
