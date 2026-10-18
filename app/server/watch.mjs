// "Your rooms", live (docs/adr/0008): a websocket at /api/rooms/watch. The
// page says hello with the member secrets this browser holds; a signed-in
// user's session cookie comes with the upgrade. The server sends the whole
// list on connect and again whenever it may have changed.
//
// Nothing here is stored. "May have changed" is coarse on purpose: any
// change to any room's state, members or invites recomputes every open
// watcher's list from the tables, and sends it only if it differs from what
// that watcher last got. That is a few queries per watcher, which is
// nothing at the scale of a course's rooms, and it can't miss a case.
import { WebSocket, WebSocketServer } from "ws";
import { hangUp } from "./sockets.mjs";

const HELLO_TIMEOUT_MS = 5_000;
const PING_MS = 25_000;
const SETTLE_MS = 50;

export function createWatch({ rooms, auth, log = () => {} }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const watchers = new Set();
  let pending = null;

  function send(watcher) {
    const text = JSON.stringify({ type: "rooms", ...rooms.listFor(watcher) });
    if (text === watcher.last || watcher.socket.readyState !== WebSocket.OPEN) return;
    watcher.last = text;
    watcher.socket.send(text);
  }

  // Several changes in one moment (a room ending drops its invites and its
  // members' rooms at once) make one round of lists.
  function changed() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      for (const watcher of watchers) {
        try {
          send(watcher);
        } catch (error) {
          console.error("[riff] sending a room list failed", error);
        }
      }
    }, SETTLE_MS);
    pending.unref?.();
  }

  server.on("connection", (socket, request) => {
    const current = auth.session({ headers: { cookie: request.headers.cookie } });
    const watcher = { socket, userId: current?.user.id, memberIds: new Set(), last: null };
    const helloTimer = setTimeout(() => hangUp(socket, 4400, "no hello"), HELLO_TIMEOUT_MS);
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_MS);
    socket.on("pong", () => (alive = true));

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return hangUp(socket, 4400, "invalid json");
      }
      if (message?.type !== "hello" || watchers.has(watcher)) return;
      clearTimeout(helloTimer);
      watcher.memberIds = rooms.membersForSecrets(message.secrets);
      watchers.add(watcher);
      send(watcher);
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(ping);
      watchers.delete(watcher);
    });
    socket.on("error", (error) => log(`watch socket error: ${error.message}`));
  });

  function handleUpgrade(request, socket, head) {
    server.handleUpgrade(request, socket, head, (websocket) => server.emit("connection", websocket, request));
  }

  function close() {
    clearTimeout(pending);
    for (const watcher of watchers) watcher.socket.terminate();
    server.close();
  }

  return { handleUpgrade, changed, close, count: () => watchers.size };
}
