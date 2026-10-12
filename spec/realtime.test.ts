import { expect, inject, it } from "vitest";
import * as Y from "yjs";
import { createRoom, joinRoom, openPart, timeUntil } from "./riff";

// Crit 9 / A3 real-time: a change one person makes reaches every other open
// session within about a second, with no action by the viewer. Two headless
// sessions share a room; one writes, and the clock runs until the other's
// document holds the change.
//
// Limits: this times the sync path (client -> server -> client) from wherever
// the check runs, not the React re-render, and not from a phone on a slow
// network. Against the live URL from Canberra it includes the round trip to
// fly's syd region, which is the realistic case for a crit room.
const baseUrl = inject("baseUrl");
const BUDGET_MS = 1_000;

// A host and a guest, each with a session on the room's shared document.
async function twoPeople() {
  const host = await createRoom(baseUrl);
  const guest = await joinRoom(baseUrl, host.code);
  return Promise.all([openPart(baseUrl, host, "shared"), openPart(baseUrl, guest, "shared")]);
}

it("a change in one session reaches another within a second", async () => {
  const [writer, viewer] = await twoPeople();
  try {
    const marker = `staged at ${new Date().toISOString()}`;
    const arrived = timeUntil(viewer.doc, () => viewer.doc.getMap("spec").get("marker") === marker, 5_000);
    writer.doc.getMap("spec").set("marker", marker);
    expect(await arrived).toBeLessThan(BUDGET_MS);
  } finally {
    writer.leave();
    viewer.leave();
  }
}, 30_000);

// Two people typing into the same shared prompt at the same moment: neither
// edit is lost, and both sessions settle on the same text without a reload.
// This is the "two people acting at once" case the top band asks about.
it("simultaneous edits to one prompt merge, and both sessions converge", async () => {
  const [alice, bob] = await twoPeople();
  try {
    const seeded = timeUntil(bob.doc, () => bob.doc.getText("prompt").toString() === "make the header ", 5_000);
    alice.doc.getText("prompt").insert(0, "make the header ");
    await seeded;

    // Both edit before either has seen the other's change.
    const aliceText = alice.doc.getText("prompt");
    const bobText = bob.doc.getText("prompt");
    aliceText.insert(aliceText.length, "blue");
    bobText.insert(0, "please ");

    const converged = (doc: Y.Doc) => {
      const text = doc.getText("prompt").toString();
      return text.includes("please ") && text.includes("blue");
    };
    await Promise.all([timeUntil(alice.doc, () => converged(alice.doc), 5_000), timeUntil(bob.doc, () => converged(bob.doc), 5_000)]);
    expect(aliceText.toString()).toBe(bobText.toString());
    expect(aliceText.toString()).toBe("please make the header blue");
  } finally {
    alice.leave();
    bob.leave();
  }
}, 30_000);
