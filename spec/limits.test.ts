// How big a room may get (docs/adr/0003, amendment of 18 October). A 16 MB
// board ran the live server out of memory, so a room holds at most 4 MB and
// a full room is read-only for everyone; one websocket message is at most
// 8 MB. These rooms aren't kept, so ending them deletes what they wrote.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, inject, it } from "vitest";
import { api, createRoom, joinRoom, openPart, type Member, type Session } from "./riff";

const baseUrl = inject("baseUrl");
const MB = 1024 * 1024;

// Incompressible, like the JPEG in a pasted screenshot's data URL.
const image = (bytes: number) => "data:image/jpeg;base64," + randomBytes(Math.floor((bytes * 3) / 4)).toString("base64");

const me = async (who: Member) => (await (await api(baseUrl, `/api/rooms/${who.roomId}/me`, { secret: who.secret })).json()).room;

// A write either comes back acknowledged or refused; register both first,
// since the answer can arrive before the next line runs.
async function outcome(session: Session, write: () => void): Promise<"saved" | "refused"> {
  const refused = session.refused().then(() => "refused" as const);
  const saved = session.saved().then(() => "saved" as const);
  write();
  return Promise.race([refused, saved]);
}

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const endLater = (host: Member) =>
  cleanup.push(() => api(baseUrl, `/api/rooms/${host.roomId}/end`, { secret: host.secret, body: {} }));

describe("how big a room may get", () => {
  it("refuses the write that would take a room past 4 MB, and then the room is read-only for everyone", async () => {
    const host = await createRoom(baseUrl, undefined, { keep: false });
    endLater(host);
    const guest = await joinRoom(baseUrl, host.code);
    expect((await me(host)).limitBytes).toBe(4 * MB);
    expect((await me(host)).full).toBe(false);

    const board = await openPart(baseUrl, host, "shared");
    cleanup.push(() => board.leave());
    let accepted = 0;
    let result: "saved" | "refused" = "saved";
    for (let i = 0; i < 12 && result === "saved"; i++) {
      result = await outcome(board, () => board.doc.getMap("assets").set(`image-${i}`, image(512 * 1024)));
      if (result === "saved") accepted += 1;
    }
    expect(result).toBe("refused");
    // Everything acknowledged fits under the limit; the one that didn't fit
    // was refused rather than stored past it.
    expect(accepted).toBeGreaterThanOrEqual(6);
    expect(accepted * 512 * 1024).toBeLessThanOrEqual(4 * MB);

    expect((await me(host)).full).toBe(true);
    expect((await me(guest)).full).toBe(true);

    // Read-only for everyone: the host's next write, a guest's, and the
    // host's control document.
    expect(await outcome(board, () => board.doc.getText("prompt").insert(0, "one more line"))).toBe("refused");
    const guestBoard = await openPart(baseUrl, guest, "shared");
    cleanup.push(() => guestBoard.leave());
    expect(guestBoard.doc.getMap("assets").size).toBe(accepted);
    expect(await outcome(guestBoard, () => guestBoard.doc.getText("prompt").insert(0, "from the guest"))).toBe("refused");
    const control = await openPart(baseUrl, host, "control");
    cleanup.push(() => control.leave());
    expect(control.doc.getMap("room").get("full")).toBe(true);
    expect(await outcome(control, () => control.doc.getMap("roomState").set("note", "x"))).toBe("refused");
  }, 120_000);

  it("closes a socket that sends one message over 8 MB, and stores none of it", async () => {
    const host = await createRoom(baseUrl, undefined, { keep: false });
    endLater(host);
    const board = await openPart(baseUrl, host, "shared");
    cleanup.push(() => board.leave());
    board.doc.getMap("assets").set("huge", image(9 * MB));
    const started = Date.now();
    while (!board.closeCodes().includes(1009) && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(board.closeCodes()).toContain(1009);
    board.leave();

    const fresh = await openPart(baseUrl, host, "shared");
    cleanup.push(() => fresh.leave());
    expect(fresh.doc.getMap("assets").has("huge")).toBe(false);
    // Never reached the document, so the room isn't full either.
    expect((await me(host)).full).toBe(false);
  }, 60_000);
});
