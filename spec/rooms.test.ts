import { describe, expect, inject, it } from "vitest";
import { api, createRoom, joinRoom, openPart, relayHello, upgradeStatus, watchRooms } from "./riff";

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
