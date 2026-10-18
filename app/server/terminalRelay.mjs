import { WebSocket, WebSocketServer } from "ws";
import { hangUp } from "./sockets.mjs";

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// `authorize(roomName, hello, request)` returns who the socket belongs to,
// with a server-resolved role ("host" or "participant"), or null. It may
// instead return `{ refused: code }` to say why (an ended room).
export function createTerminalRelay({ authorize, onRefused } = {}) {
  if (typeof authorize !== "function") throw new Error("createTerminalRelay needs authorize");
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_SNAPSHOT_BYTES });
  const rooms = new Map();

  function roomFor(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { clients: new Set(), host: null, latest: null, tail: [], tailBytes: 0, sequence: 0 };
      rooms.set(name, room);
    }
    return room;
  }

  function broadcast(room, message) {
    for (const client of room.clients) send(client, message);
  }

  socketServer.on("connection", (socket, request, roomName) => {
    const room = roomFor(roomName);
    socket.role = "participant";

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", code: "invalid-json" });
        return;
      }

      // The first message must be a hello carrying the member's credential
      // (docs/adr/0006). Until then the socket hears nothing from the room.
      if (message.type === "hello") {
        if (socket.who) return;
        const who = authorize(roomName, message, request);
        if (!who || who.refused) {
          const code = who?.refused ?? "not-a-member";
          onRefused?.(roomName, "terminal", null, code);
          send(socket, { type: "error", code });
          hangUp(socket, 4401, code);
          return;
        }
        socket.who = who;
        room.clients.add(socket);
        if (message.role === "host" && who.role === "host") {
          // The same host again (a reload) replaces the old socket.
          if (room.host && room.host !== socket) {
            send(room.host, { type: "error", code: "host-replaced" });
            hangUp(room.host, 4409, "replaced");
          }
          room.host = socket;
          socket.role = "host";
          send(socket, { type: "host-accepted" });
          broadcast(room, { type: "host-status", connected: true });
        } else {
          if (message.role === "host") {
            onRefused?.(roomName, "terminal.host", who);
            send(socket, { type: "error", code: "host-rejected" });
          }
          send(socket, { type: "host-status", connected: room.host !== null });
        }
        if (room.latest) send(socket, room.latest);
        for (const event of room.tail) send(socket, event);
        return;
      }
      if (!socket.who) {
        send(socket, { type: "error", code: "hello-first" });
        return;
      }

      if (message.type !== "snapshot" && message.type !== "data") return;
      if (room.host !== socket || socket.role !== "host") {
        send(socket, { type: "error", code: "host-only" });
        return;
      }
      if (message.type === "data") {
        if (typeof message.data !== "string" || Buffer.byteLength(message.data, "utf8") > MAX_SNAPSHOT_BYTES) {
          send(socket, { type: "error", code: "data-too-large" });
          return;
        }
        const event = {
          type: "data",
          sequence: ++room.sequence,
          data: message.data,
          cols: Math.max(20, Math.min(240, Number(message.cols) || 80)),
          rows: Math.max(8, Math.min(120, Number(message.rows) || 24)),
        };
        room.tail.push(event);
        room.tailBytes += Buffer.byteLength(message.data, "utf8");
        while (room.tailBytes > MAX_TAIL_BYTES && room.tail.length > 0) {
          const removed = room.tail.shift();
          room.tailBytes -= Buffer.byteLength(removed.data, "utf8");
        }
        broadcast(room, event);
        return;
      }
      if (typeof message.ansi !== "string" || Buffer.byteLength(message.ansi, "utf8") > MAX_SNAPSHOT_BYTES) {
        send(socket, { type: "error", code: "snapshot-too-large" });
        return;
      }

      room.latest = {
        type: "snapshot",
        sequence: ++room.sequence,
        ansi: message.ansi,
        cols: Math.max(20, Math.min(240, Number(message.cols) || 80)),
        rows: Math.max(8, Math.min(120, Number(message.rows) || 24)),
      };
      room.tail = [];
      room.tailBytes = 0;
      broadcast(room, room.latest);
    });

    socket.on("close", () => {
      room.clients.delete(socket);
      if (room.host === socket) {
        room.host = null;
        broadcast(room, { type: "host-status", connected: false });
      }
      if (room.clients.size === 0) rooms.delete(roomName);
    });
  });

  return {
    rooms,
    disconnectMember(roomName, memberId) {
      for (const client of rooms.get(roomName)?.clients ?? []) {
        if (client.who?.memberId === memberId) hangUp(client, 4403, "removed");
      }
    },
    // The room ended: its audience is told and let go. The host's socket
    // stays; their page is leaving, and a reconnect would revive the room.
    endRoom(roomName) {
      for (const client of rooms.get(roomName)?.clients ?? []) {
        if (client === rooms.get(roomName).host) continue;
        send(client, { type: "error", code: "room-ended" });
        hangUp(client, 4410, "room-ended");
      }
    },
    handleUpgrade(request, socket, head, roomName) {
      socketServer.handleUpgrade(request, socket, head, (websocket) => {
        socketServer.emit("connection", websocket, request, roomName);
      });
    },
    close() {
      for (const client of socketServer.clients) client.terminate();
      rooms.clear();
      socketServer.close();
    },
  };
}
