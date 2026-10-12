import { expect, inject, it } from "vitest";
import { createRoom, joinRoom, openPart } from "./riff";

// Crit 8: a stranger's trace is still there when they come back. A room's
// shared state is a Yjs document synced through /collaboration, so the
// contract is: what one person writes, someone else joining later (after the
// first has left) reads back from the server, not from anything a client kept.
//
// The server (Hocuspocus) unloads a document as soon as its last client
// leaves, so the second session's copy is loaded from SQLite. Limit: from
// outside, this can't tell that apart from a server that kept the document in
// memory. Surviving a crash, restart or redeploy is checked separately: the
// kill test in app/scripts/collaboration-store.test.mjs, and by hand with
// `flyctl machine restart` against the live app.
const baseUrl = inject("baseUrl");

it("a room's state survives everyone leaving and someone new joining", async () => {
  const host = await createRoom(baseUrl);
  const trace = `left by the host at ${new Date().toISOString()}`;

  const first = await openPart(baseUrl, host, "shared");
  first.doc.getMap("spec").set("trace", trace);
  // the server has applied (and stored) the update before it acknowledges it
  await first.saved();
  first.leave();

  const guest = await joinRoom(baseUrl, host.code);
  const second = await openPart(baseUrl, guest, "shared");
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
