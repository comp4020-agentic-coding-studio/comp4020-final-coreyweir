import { expect, inject, it } from "vitest";
import { joinRoom as joinShared, uniqueRoom } from "./yjs-room";

// Crit 8: a stranger's trace is still there when they come back. A room's
// shared state is a Yjs document synced through /collaboration/, so the
// contract is: what one session writes, a later session (after the first has
// left) reads back from the server, not from anything the client kept.
//
// Limit: y-websocket without persistence also keeps an empty room in memory,
// so this passes against a server that would lose everything on restart.
// Surviving a restart/redeploy (y-leveldb on the fly volume) is checked by
// hand: write, `flyctl machine restart`, read back.
const baseUrl = inject("baseUrl");
const joinRoom = (room: string) => joinShared(baseUrl, room);

it("a room's state survives everyone leaving and a new session joining", async () => {
  const room = uniqueRoom("spec-persistence");
  const trace = `left by the first visitor at ${new Date().toISOString()}`;

  const first = await joinRoom(room);
  first.doc.getMap("spec").set("trace", trace);
  // give the update time to reach the server before the socket closes
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  first.leave();
  // the server drops an empty room from memory; what comes back must be stored
  await new Promise((resolve) => setTimeout(resolve, 1_000));

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
