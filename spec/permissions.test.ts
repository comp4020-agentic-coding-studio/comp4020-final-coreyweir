import { describe, expect, inject, it } from "vitest";
import {
  api,
  createRoom,
  docName,
  joinRoom,
  open,
  openPart,
  Refused,
  relayHello,
  servePreview,
  timeUntil,
  uniqueName,
  upgradeStatus,
} from "./riff";

// Crit 10: the server tells people apart and checks what each may see and
// change (ADR 0006). Each check is made from outside, as a client the server
// can't trust: a headless session with only what the API handed it.
//
// Limits: these run as guests. A GitHub user's credential is a session
// cookie only a real sign-in can mint, so that path is checked by hand. And
// "refused" here means refused by the server; a forged write still sits in
// the forger's own copy, which no check from outside can see.
const baseUrl = inject("baseUrl");

describe("who gets a socket", () => {
  it("refuses a socket from another origin, or with no Origin at all", async () => {
    expect(await upgradeStatus(baseUrl, "https://evil.example")).toBe(403);
    expect(await upgradeStatus(baseUrl, null)).toBe(403);
    // and the same check lets the app's own pages in
    expect(await upgradeStatus(baseUrl, new URL(baseUrl).origin)).toBe(101);
  }, 20_000);

  it("refuses a document to a session with no credential, or someone else's", async () => {
    const host = await createRoom(baseUrl);
    const elsewhere = await createRoom(baseUrl);

    await expect(open(baseUrl, docName(host.roomId, "shared"))).rejects.toBeInstanceOf(Refused);
    await expect(open(baseUrl, docName(host.roomId, "shared"), { token: "not-a-secret" })).rejects.toBeInstanceOf(Refused);
    // a real credential, for a different room
    await expect(open(baseUrl, docName(host.roomId, "control"), { token: elsewhere.secret })).rejects.toBeInstanceOf(Refused);
  });

  it("refuses documents that aren't a room's, like the old riff-<code> rooms", async () => {
    const host = await createRoom(baseUrl);
    await expect(open(baseUrl, `riff-${host.code}`, { token: host.secret })).rejects.toBeInstanceOf(Refused);
    await expect(open(baseUrl, `room/${host.roomId}/anything`, { token: host.secret })).rejects.toBeInstanceOf(Refused);
  });

  it("refuses API calls from another origin", async () => {
    const res = await api(baseUrl, "/api/rooms", { body: { name: uniqueName("host") }, origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("who may change what", () => {
  it("lets everyone in the room write the shared document", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const [hostShared, guestShared] = await Promise.all([openPart(baseUrl, host, "shared"), openPart(baseUrl, guest, "shared")]);
    try {
      const seen = timeUntil(hostShared.doc, () => hostShared.doc.getText("prompt").toString() === "from the guest", 5_000);
      guestShared.doc.getText("prompt").insert(0, "from the guest");
      await guestShared.saved();
      await seen;
    } finally {
      hostShared.leave();
      guestShared.leave();
    }
  }, 30_000);

  it("drops a participant's write to the control document, and keeps the host's", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const [hostControl, guestControl] = await Promise.all([openPart(baseUrl, host, "control"), openPart(baseUrl, guest, "control")]);
    try {
      guestControl.doc.getMap("spec").set("forged", "sent by a participant");
      await guestControl.refused();

      hostControl.doc.getMap("spec").set("real", "sent by the host");
      await hostControl.saved();
    } finally {
      hostControl.leave();
      guestControl.leave();
    }

    // Everyone has left, so the server reloads the document from disk. A
    // participant reads it fresh: the host's write is there, the forged one
    // never was.
    const later = await openPart(baseUrl, guest, "control");
    try {
      expect(later.doc.getMap("spec").get("real")).toBe("sent by the host");
      expect(later.doc.getMap("spec").has("forged")).toBe(false);
    } finally {
      later.leave();
    }
  }, 30_000);

  it("keeps room management to the host", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const asGuest = { secret: guest.secret };

    expect((await api(baseUrl, `/api/rooms/${host.roomId}/code`, { ...asGuest, body: {} })).status).toBe(403);
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/lock`, { ...asGuest, body: { locked: true } })).status).toBe(403);
    expect(
      (await api(baseUrl, `/api/rooms/${host.roomId}/members/${host.memberId}`, { ...asGuest, method: "DELETE" })).status,
    ).toBe(403);
    // with no credential at all
    expect((await api(baseUrl, `/api/rooms/${host.roomId}/code`, { body: {} })).status).toBe(401);
  });
});

describe("joining", () => {
  it("keeps names unique in a room, ignoring case", async () => {
    const host = await createRoom(baseUrl);
    const name = uniqueName("Ada");
    await joinRoom(baseUrl, host.code, name);
    const res = await api(baseUrl, "/api/rooms/join", { body: { code: host.code, name: name.toUpperCase() } });
    expect(res.status).toBe(409);
    // the host's name is taken too
    const hostsName = await api(baseUrl, "/api/rooms/join", { body: { code: host.code, name: host.name } });
    expect(hostsName.status).toBe(409);
  });

  it("finds a room by its code in any case", async () => {
    const host = await createRoom(baseUrl);
    const res = await api(baseUrl, `/api/rooms/by-code/${host.code.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(host.roomId);
    expect((await api(baseUrl, "/api/rooms/by-code/NOPE00")).status).toBe(404);
  });
});

describe("removing someone, and a leaked code", () => {
  it("shuts a removed member out, including a socket they already had open", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const session = await openPart(baseUrl, guest, "shared");
    try {
      const res = await api(baseUrl, `/api/rooms/${host.roomId}/members/${guest.memberId}`, {
        secret: host.secret,
        method: "DELETE",
      });
      expect(res.status).toBe(204);
      await expect(withTimeout(session.shutOut, 5_000)).resolves.toBeTypeOf("string");
    } finally {
      session.leave();
    }
    await expect(openPart(baseUrl, guest, "shared")).rejects.toBeInstanceOf(Refused);
  }, 30_000);

  it("stops resolving the old code after a rotate, and keeps members in", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);

    const res = await api(baseUrl, `/api/rooms/${host.roomId}/code`, { secret: host.secret, body: {} });
    expect(res.status).toBe(200);
    const { code } = await res.json();
    expect(code).not.toBe(host.code);

    expect((await api(baseUrl, `/api/rooms/by-code/${host.code}`)).status).toBe(404);
    expect((await api(baseUrl, "/api/rooms/join", { body: { code: host.code, name: uniqueName("late") } })).status).toBe(404);
    expect((await joinRoom(baseUrl, code)).roomId).toBe(host.roomId);

    const stillIn = await openPart(baseUrl, guest, "shared");
    stillIn.leave();
  }, 30_000);

  it("turns away new joins while locked, and lets members back in", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);

    const res = await api(baseUrl, `/api/rooms/${host.roomId}/lock`, { secret: host.secret, body: { locked: true } });
    expect(res.status).toBe(200);
    expect((await api(baseUrl, "/api/rooms/join", { body: { code: host.code, name: uniqueName("late") } })).status).toBe(423);

    const stillIn = await openPart(baseUrl, guest, "shared");
    stillIn.leave();
  }, 30_000);
});

describe("the terminal mirror and the preview", () => {
  it("lets only the host publish the terminal, and only members watch it", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);

    expect(await relayHello(baseUrl, "terminal", host.roomId, { type: "hello", role: "host", token: host.secret }))
      .toContain("host-accepted");
    // a participant asking to host is told no, and stays a viewer
    const pretender = await relayHello(baseUrl, "terminal", host.roomId, { type: "hello", role: "host", token: guest.secret });
    expect(pretender).toContain("error:host-rejected");
    expect(pretender).not.toContain("host-accepted");
    // no credential: told no, and nothing from the room. (The server hangs
    // up too, but fly's proxy can take seconds to pass that on.)
    const stranger = await relayHello(baseUrl, "terminal", host.roomId, { type: "hello", role: "participant" });
    expect(heard(stranger)).toEqual(["error:not-a-member"]);
  }, 30_000);

  it("lets only the host serve the preview", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);

    expect(await relayHello(baseUrl, "preview-control", host.roomId, { type: "hello", token: host.secret }))
      .toContain("host-accepted");
    expect(await relayHello(baseUrl, "preview-control", host.roomId, { type: "hello", token: guest.secret })
      .then(heard)).toEqual(["error:host-rejected"]);
  }, 30_000);

  // The preview loads in an iframe, which can't send a secret, so each
  // member gets a key for the path. Anyone with the code can learn the room
  // id, and a removed member keeps it: the id alone must not be enough.
  it("serves the preview only to members, by their own key", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const outsider = await createRoom(baseUrl);
    const preview = await servePreview(baseUrl, host, '<html><head></head><body><a href="/next">next</a></body></html>');
    try {
      const at = (key: string) => new URL(`/room-preview/${host.roomId}/${key}/${preview.generation}/`, baseUrl);
      const status = async (key: string) => (await fetch(at(key))).status;

      // a member's key gets the page, with its links kept under that key
      const page = await fetch(at(guest.previewKey));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(`href="/room-preview/${host.roomId}/${guest.previewKey}/${preview.generation}/next"`);
      expect(await status(host.previewKey)).toBe(200);

      // the room id alone, someone else's room, and forged keys
      expect((await fetch(new URL(`/room-preview/${host.roomId}/${preview.generation}/`, baseUrl))).status).toBe(403);
      expect(await status(outsider.previewKey)).toBe(403);
      const [memberId, mac] = guest.previewKey.split(".");
      const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
      expect(await status(`${memberId}.${flipped}`)).toBe(403);
      expect(await status(`${host.memberId}.${mac}`)).toBe(403);

      // removal takes the key with it, from the next request
      expect((await api(baseUrl, `/api/rooms/${host.roomId}/members/${guest.memberId}`, { method: "DELETE", secret: host.secret })).status).toBe(204);
      expect(await status(guest.previewKey)).toBe(403);
      expect(await status(host.previewKey)).toBe(200);

      // nothing refused ever reached the host's browser
      expect(preview.requests).toHaveLength(3);
    } finally {
      preview.close();
    }
  }, 30_000);
});

// What a relay said, leaving out whether the hang-up arrived in time.
const heard = (messages: string[]) => messages.filter((message) => !message.startsWith("closed:"));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`nothing within ${ms}ms`)), ms)),
  ]);
}
