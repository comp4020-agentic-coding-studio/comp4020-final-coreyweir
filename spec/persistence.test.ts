import { expect, inject, it } from "vitest";
import { joinRoom as joinShared, uniqueRoom } from "./yjs-room";

// Crit 8: a stranger's trace is still there when they come back. A room's
// shared state is a Yjs document synced through /collaboration/, so the
// contract is: what one session writes, a later session (after the first has
// left) reads back from the server, not from anything the client kept.
//
// The server (Hocuspocus) unloads a document as soon as its last client
// leaves, so the second session's copy is loaded from SQLite. Limit: from
// outside, this can't tell that apart from a server that kept the document in
// memory. Surviving a crash, restart or redeploy is checked separately: the
// kill test in app/server/collaboration.test.mjs, and by hand with
// `flyctl machine restart` against the live app.
const baseUrl = inject("baseUrl");
const joinRoom = (room: string) => joinShared(baseUrl, room);

it("a room's state survives everyone leaving and a new session joining", async () => {
  const room = uniqueRoom("spec-persistence");
  const trace = `left by the first visitor at ${new Date().toISOString()}`;

  const first = await joinRoom(room);
  first.doc.getMap("spec").set("trace", trace);
  // the server has applied (and stored) the update before it acknowledges it
  await first.saved();
  first.leave();

  const second = await joinRoom(room);
  try {
    expect(second.doc.getMap("spec").get("trace")).toBe(trace);
  } finally {
    second.leave();
  }
}, 30_000);

// Nodepod (Claude Code in the browser) needs SharedArrayBuffer, which only
// exists on a cross-origin-isolated page. Without these headers the core
// thing (a host running the agent for the room) can't start.
it("serves the app cross-origin isolated", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
});
