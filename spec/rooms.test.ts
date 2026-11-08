import { describe, expect, inject, it } from "vitest";
import { api, createRoom, joinRoom, openPart, Refused, relayHello, timeUntil, upgradeStatus, watchRooms } from "./riff";

// "Your rooms" and the room's state (ADR 0008): a list of only the rooms
// you're in, live, and a room that ends when its host has gone.
//
// Limits: these run as guests. Invites and colleagues belong to GitHub
// users, whose session cookie only a real sign-in can mint, and an invite
// looks the username up on GitHub, which CI's container can't do reliably.
// Those paths are checked in-process by `npm run test:rooms` (in `app/`).
// The 5-minute grace is too long to wait for here, so ending is checked
// through the host's "End room", and the timer in-process.
const baseUrl = inject("baseUrl");

describe("your rooms", () => {
  it("lists the rooms a guest holds secrets for, and nothing else", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const other = await createRoom(baseUrl);

    const watch = await watchRooms(baseUrl, [
      { roomId: guest.roomId, secret: guest.secret },
      // a real secret, sent for a room it doesn't belong to
      { roomId: other.roomId, secret: guest.secret },
      { roomId: other.roomId, secret: "not-a-secret" },
    ]);
    try {
      const { rooms } = await watch.until((list) => list.rooms.length > 0);
      expect(rooms.map((room) => room.id)).toEqual([guest.roomId]);
      expect(rooms[0]).toMatchObject({ code: host.code, role: "participant", hostName: host.name });
    } finally {
      watch.close();
    }

    const hostWatch = await watchRooms(baseUrl, [{ roomId: host.roomId, secret: host.secret }]);
    try {
      const { rooms } = await hostWatch.until((list) => list.rooms.length > 0);
      expect(rooms[0]).toMatchObject({ id: host.roomId, role: "host" });
    } finally {
      hostWatch.close();
    }
  }, 30_000);

  it("refuses a watch from another origin", async () => {
    expect(await upgradeStatus(baseUrl, "https://evil.example", "/api/rooms/watch")).toBe(403);
    expect(await upgradeStatus(baseUrl, null, "/api/rooms/watch")).toBe(403);
  }, 20_000);

  it("shows the host arriving and leaving as it happens", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const watch = await watchRooms(baseUrl, [{ roomId: guest.roomId, secret: guest.secret }]);
    try {
      // made but never opened: the host isn't here
      await watch.until((list) => list.rooms[0]?.state === "away");
      const session = await openPart(baseUrl, host, "control");
      await watch.until((list) => list.rooms[0]?.state === "live", 3_000);
      session.leave();
      await watch.until((list) => list.rooms[0]?.state === "away", 3_000);
    } finally {
      watch.close();
    }
  }, 30_000);
});

describe("a room that has ended", () => {
  it("lets only the host end it", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: guest.secret, body: {} })).status).toBe(403);
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/end`, { body: {} })).status).toBe(401);
  });

  it("goes read-only, leaves the list and turns away new joins, until the host revives it", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const watch = await watchRooms(baseUrl, [{ roomId: guest.roomId, secret: guest.secret }]);
    const open = await openPart(baseUrl, guest, "shared");
    // A second socket that doesn't try to write while the room is ended. The
    // first one can't show the revival: its refused write is never acked, so
    // it stays unsynced, and its later edits build on what the server lacks.
    const idle = await openPart(baseUrl, guest, "shared");
    try {
      await watch.until((list) => list.rooms.length === 1);
      open.doc.getText("prompt").insert(0, "before it ended");
      await open.saved();

      const res = await api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} });
      expect(res.status).toBe(200);
      await watch.until((list) => list.rooms.length === 0, 3_000);

      // the socket the guest already had can no longer write
      open.doc.getText("prompt").insert(0, "x");
      await open.refused();

      expect((await api(baseUrl, `/api/rooms/by-code/${host.code}`)).status).toBe(404);
      expect((await api(baseUrl, "/api/rooms/join", { body: { code: host.code, name: "late" } })).status).toBe(404);

      // a member can still open the board, read-only
      const later = await openPart(baseUrl, guest, "shared");
      try {
        expect(later.doc.getText("prompt").toString()).toBe("before it ended");
        later.doc.getText("prompt").insert(0, "y");
        await later.refused();
      } finally {
        later.leave();
      }

      // the host opening the room revives it, and a socket already open can write again
      const hostSession = await openPart(baseUrl, host, "shared");
      try {
        await watch.until((list) => list.rooms.length === 1, 3_000);
        idle.doc.getText("after").insert(0, "after the revival");
        await idle.saved();
      } finally {
        hostSession.leave();
      }
      const reread = await openPart(baseUrl, guest, "shared");
      try {
        expect(reread.doc.getText("after").toString()).toBe("after the revival");
      } finally {
        reread.leave();
      }
    } finally {
      open.leave();
      idle.leave();
      watch.close();
    }
  }, 45_000);

  it("says it has ended, and keeps the terminal mirror from its members", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    await api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} });

    const res = await api(baseUrl, `/api/rooms/${host.roomId}/me`, { secret: guest.secret });
    expect(res.status).toBe(200);
    expect((await res.json()).room.state).toBe("ended");

    const heard = await relayHello(baseUrl, "terminal", host.roomId, { type: "hello", role: "participant", token: guest.secret });
    expect(heard.filter((message) => !message.startsWith("closed:"))).toEqual(["error:room-ended"]);
  }, 30_000);
});

// Reopening (ADR 0003): an ended room stays in its host's list, and only
// its host can bring it back. Limit: as guests, so a signed-in host's list
// (by account rather than by secret) is checked in-process by
// `npm run test:rooms`.
describe("reopening an ended room", () => {
  const reopen = (roomId: string, secret?: string) => api(baseUrl, `/api/rooms/${roomId}/reopen`, { secret, body: {} });
  const stateOf = async (roomId: string, secret: string) =>
    (await (await api(baseUrl, `/api/rooms/${roomId}/me`, { secret })).json()).room.state;

  it("lists it for its host alone, as ended, and lets only the host reopen it", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const other = await createRoom(baseUrl);
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} })).status).toBe(200);

    const hostWatch = await watchRooms(baseUrl, [{ roomId: host.roomId, secret: host.secret }]);
    const guestWatch = await watchRooms(baseUrl, [{ roomId: guest.roomId, secret: guest.secret }]);
    try {
      const { rooms } = await hostWatch.until((list) => list.rooms.length > 0);
      expect(rooms).toEqual([expect.objectContaining({ id: host.roomId, code: host.code, role: "host", state: "ended", boardGone: false })]);
      // a participant's list doesn't offer it
      expect((await guestWatch.until(() => true)).rooms).toEqual([]);

      // nobody else can reopen it, and trying leaves it ended
      expect((await reopen(host.roomId, guest.secret)).status).toBe(403);
      expect((await reopen(host.roomId, other.secret)).status).toBe(401);
      expect((await reopen(host.roomId)).status).toBe(401);
      expect(await stateOf(host.roomId, guest.secret)).toBe("ended");
      expect((await api(baseUrl, `/api/rooms/by-code/${host.code}`)).status).toBe(404);

      const res = await reopen(host.roomId, host.secret);
      expect(res.status).toBe(200);
      expect((await res.json()).room).toMatchObject({ id: host.roomId, code: host.code, state: "away" });
      // back for its members, under the same code
      await guestWatch.until((list) => list.rooms[0]?.id === host.roomId && list.rooms[0].state === "away", 3_000);
      await hostWatch.until((list) => list.rooms[0]?.state === "away", 3_000);
      expect((await api(baseUrl, `/api/rooms/by-code/${host.code}`)).status).toBe(200);
      // reopening a room that hasn't ended changes nothing
      expect((await reopen(host.roomId, host.secret)).status).toBe(200);
      expect(await stateOf(host.roomId, guest.secret)).toBe("away");
    } finally {
      hostWatch.close();
      guestWatch.close();
    }
  }, 30_000);

  it("tells its host when the server no longer has the board", async () => {
    const host = await createRoom(baseUrl, undefined, { keep: false });
    await api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} });
    const watch = await watchRooms(baseUrl, [{ roomId: host.roomId, secret: host.secret }]);
    try {
      const { rooms } = await watch.until((list) => list.rooms.length > 0);
      expect(rooms[0]).toMatchObject({ state: "ended", keep: false, boardGone: true });
    } finally {
      watch.close();
    }
    expect((await reopen(host.roomId, host.secret)).status).toBe(200);
  }, 30_000);
});

// Leaving and deleting (ADR 0003 and 0008): a member drops their own place;
// the host deletes the whole room from the server. Guests here; a GitHub
// member coming back by code or invite is `npm run test:rooms`.
describe("leaving a room", () => {
  const leave = (roomId: string, secret?: string) => api(baseUrl, `/api/rooms/${roomId}/leave`, { secret, body: {} });

  it("lets a member drop only their own place, and come back by code", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const stays = await joinRoom(baseUrl, host.code);
    const watch = await watchRooms(baseUrl, [{ roomId: guest.roomId, secret: guest.secret }]);
    const open = await openPart(baseUrl, guest, "shared");
    try {
      await watch.until((list) => list.rooms.length === 1);
      expect((await leave(host.roomId, host.secret)).status).toBe(400);
      expect((await leave(host.roomId)).status).toBe(401);
      expect((await leave(host.roomId, guest.secret)).status).toBe(204);
      const told = await Promise.race([open.shutOut, new Promise((resolve) => setTimeout(resolve, 5_000, "never told"))]);
      expect(told).toBe("left");
      await watch.until((list) => list.rooms.length === 0, 3_000);
      expect((await api(baseUrl, `/api/rooms/${host.roomId}/me`, { secret: guest.secret })).status).toBe(401);
      await expect(openPart(baseUrl, guest, "shared")).rejects.toThrow(Refused);
      // nobody else's place changed
      expect((await api(baseUrl, `/api/rooms/${host.roomId}/me`, { secret: stays.secret })).status).toBe(200);
      expect((await api(baseUrl, `/api/rooms/${host.roomId}/me`, { secret: host.secret })).status).toBe(200);
      // the name is free again, so the same person can come back under it
      expect((await joinRoom(baseUrl, host.code, guest.name)).roomId).toBe(host.roomId);
    } finally {
      open.leave();
      watch.close();
    }
  }, 30_000);
});

describe("deleting a room", () => {
  const remove = (roomId: string, secret?: string) => api(baseUrl, `/api/rooms/${roomId}`, { method: "DELETE", secret });

  it("lets only the host delete it, and then turns it away everywhere, for good", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const other = await createRoom(baseUrl);
    const open = await openPart(baseUrl, guest, "shared");
    const hostOpen = await openPart(baseUrl, host, "shared");
    try {
      open.doc.getText("prompt").insert(0, "on the board");
      await open.saved();
      expect((await remove(host.roomId, guest.secret)).status).toBe(403);
      expect((await remove(host.roomId, other.secret)).status).toBe(401);
      expect((await remove(host.roomId)).status).toBe(401);
      expect((await api(baseUrl, `/api/rooms/${host.roomId}/me`, { secret: guest.secret })).status).toBe(200);

      // the host's terminal is told in-band, like everyone's documents
      const heard = await relayHello(baseUrl, "terminal", host.roomId, { type: "hello", role: "host", token: host.secret }, 1_000, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect((await remove(host.roomId, host.secret)).status).toBe(204);
      });
      expect(heard).toContain("error:room-deleted");
      const never = new Promise((resolve) => setTimeout(resolve, 5_000, "never told"));
      expect(await Promise.race([open.shutOut, never])).toBe("room-deleted");
      expect(await Promise.race([hostOpen.shutOut, never])).toBe("room-deleted");
    } finally {
      open.leave();
      hostOpen.leave();
    }

    for (const who of [host, guest]) {
      expect((await api(baseUrl, `/api/rooms/${host.roomId}/me`, { secret: who.secret })).status).toBe(401);
      await expect(openPart(baseUrl, who, "shared")).rejects.toThrow(Refused);
      const relay = await relayHello(baseUrl, "terminal", host.roomId, { type: "hello", role: "participant", token: who.secret });
      expect(relay[0]).toBe("error:not-a-member");
    }
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/reopen`, { secret: host.secret, body: {} })).status).toBe(401);
    expect((await api(baseUrl, `/api/rooms/by-code/${host.code}`)).status).toBe(404);
    expect((await api(baseUrl, "/api/rooms/join", { body: { code: host.code, name: "late" } })).status).toBe(404);
    const watch = await watchRooms(baseUrl, [{ roomId: host.roomId, secret: host.secret }, { roomId: other.roomId, secret: other.secret }]);
    try {
      expect((await watch.until((list) => list.rooms.length > 0)).rooms.map((room) => room.id)).toEqual([other.roomId]);
    } finally {
      watch.close();
    }
    // the other room is untouched
    expect((await api(baseUrl, `/api/rooms/${other.roomId}/me`, { secret: other.secret })).status).toBe(200);
  }, 45_000);
});

// Whether the server keeps a room's board after it ends (ADR 0003): the
// host's choice when creating it, keep by default, shown to everyone.
describe("keeping the board", () => {
  const keepOf = async (code: string) => (await (await api(baseUrl, `/api/rooms/by-code/${code}`)).json()).keep;
  const setKeep = (roomId: string, keep: unknown, secret?: string) =>
    api(baseUrl, `/api/rooms/${roomId}/keep`, { secret, body: { keep } });

  it("keeps it unless the host says otherwise, and tells people before they join", async () => {
    const kept = await createRoom(baseUrl);
    expect(await keepOf(kept.code)).toBe(true);

    const notKept = await createRoom(baseUrl, undefined, { keep: false });
    expect(await keepOf(notKept.code)).toBe(false);
    const guest = await joinRoom(baseUrl, notKept.code);
    const control = await openPart(baseUrl, guest, "control");
    try {
      await timeUntil(control.doc, () => control.doc.getMap("room").get("keep") === false, 3_000);
    } finally {
      control.leave();
    }
  }, 30_000);

  it("lets only the host change it, and never back to keeping once someone else is in", async () => {
    const host = await createRoom(baseUrl, undefined, { keep: false });
    // nobody else has joined: changing their mind costs nobody anything
    expect((await setKeep(host.roomId, true, host.secret)).status).toBe(200);
    expect((await setKeep(host.roomId, "yes", host.secret)).status).toBe(400);

    const guest = await joinRoom(baseUrl, host.code);
    expect((await setKeep(host.roomId, false, guest.secret)).status).toBe(403);
    expect((await setKeep(host.roomId, false)).status).toBe(401);
    expect(await keepOf(host.code)).toBe(true);

    expect((await setKeep(host.roomId, false, host.secret)).status).toBe(200);
    expect(await keepOf(host.code)).toBe(false);
    // the guest drew on the understanding that the server wouldn't keep it
    expect((await setKeep(host.roomId, true, host.secret)).status).toBe(409);
    expect(await keepOf(host.code)).toBe(false);
  }, 30_000);

  it("deletes a board it doesn't keep when the room ends, and turns its members away", async () => {
    const host = await createRoom(baseUrl, undefined, { keep: false });
    const guest = await joinRoom(baseUrl, host.code);
    const open = await openPart(baseUrl, guest, "shared");
    try {
      open.doc.getText("prompt").insert(0, "drawn here");
      await open.saved();

      expect((await api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} })).status).toBe(200);
      // The socket the guest had open is told, not just left read-only.
      // Limit: a reconnect refused with the same reason also passes this, so
      // it can't show the server said so in-band. That matters behind fly's
      // proxy, which holds a closed socket open for seconds (CLAUDE.md).
      const reason = await Promise.race([open.shutOut, new Promise((resolve) => setTimeout(resolve, 5_000, "never told"))]);
      expect(reason).toBe("room-ended");
    } finally {
      open.leave();
    }

    const res = await api(baseUrl, `/api/rooms/${host.roomId}/me`, { secret: guest.secret });
    expect((await res.json()).room).toMatchObject({ state: "ended", keep: false });
    await expect(openPart(baseUrl, guest, "shared")).rejects.toThrow(Refused);

    // The host reopening revives the room, with nothing left on the server:
    // a fresh session has no local copy to bring back.
    const hostSession = await openPart(baseUrl, host, "shared");
    try {
      expect(hostSession.doc.getText("prompt").toString()).toBe("");
    } finally {
      hostSession.leave();
    }
  }, 45_000);

  it("stops the host's own writes too when the room ends", async () => {
    const host = await createRoom(baseUrl);
    const session = await openPart(baseUrl, host, "shared");
    try {
      session.doc.getText("prompt").insert(0, "before");
      await session.saved();
      await api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} });
      session.doc.getText("prompt").insert(0, "after");
      await session.refused();
    } finally {
      session.leave();
    }
  }, 30_000);
});

describe("the room's state, inside the room", () => {
  it("tells members when an away room will end, and that it has", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const control = await openPart(baseUrl, guest, "control");
    try {
      const info = control.doc.getMap("room");
      const hostSession = await openPart(baseUrl, host, "control");
      await timeUntil(control.doc, () => info.get("state") === "live", 3_000);
      const left = Date.now();
      hostSession.leave();
      await timeUntil(control.doc, () => info.get("state") === "away", 3_000);
      // five minutes from when the host left, give or take the two clocks
      const endsAt = info.get("endsAt") as number;
      expect(Math.abs(endsAt - (left + 5 * 60_000))).toBeLessThan(60_000);

      await api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} });
      await timeUntil(control.doc, () => info.get("state") === "ended", 3_000);
      expect(info.get("endsAt")).toBeNull();
    } finally {
      control.leave();
    }
  }, 30_000);

  it("tells the terminal mirror's audience at once when the host ends the room", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const heard = await relayHello(baseUrl, "terminal", host.roomId, { type: "hello", role: "participant", token: guest.secret }, 2_000, () =>
      api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} }),
    );
    expect(heard).toContain("error:room-ended");
  }, 30_000);
});

describe("invites, from outside", () => {
  it("keeps inviting and cancelling to the host", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/invites`, { secret: guest.secret, body: { login: "octocat" } })).status).toBe(403);
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/invites/583231`, { secret: guest.secret, method: "DELETE" })).status).toBe(403);
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/invites`, { body: { login: "octocat" } })).status).toBe(401);
  });

  it("rejects a username GitHub couldn't have issued, without asking GitHub", async () => {
    const host = await createRoom(baseUrl);
    for (const login of ["-ada", "ada-", "a b", "ada!", "a".repeat(40), ""]) {
      const res = await api(baseUrl, `/api/rooms/${host.roomId}/invites`, { secret: host.secret, body: { login } });
      expect(res.status, login).toBe(400);
    }
  });

  it("needs a GitHub sign-in to accept or decline", async () => {
    const host = await createRoom(baseUrl);
    expect((await api(baseUrl, `/api/invites/${host.roomId}/accept`, { body: {} })).status).toBe(401);
    expect((await api(baseUrl, `/api/invites/${host.roomId}/decline`, { body: {} })).status).toBe(401);
    expect((await api(baseUrl, "/api/me/colleagues")).status).toBe(401);
  });
});
