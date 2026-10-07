import { WebSocket, WebSocketServer } from "ws";

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export function createTerminalRelay() {
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_SNAPSHOT_BYTES });
  const rooms = new Map();

  function roomFor(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { clients: new Set(), capability: null, host: null, latest: null, tail: [], tailBytes: 0, sequence: 0 };
      rooms.set(name, room);
    }
    return room;
  }

  function broadcast(room, message) {
    for (const client of room.clients) send(client, message);
  }

  socketServer.on("connection", (socket, _request, roomName) => {
    const room = roomFor(roomName);
    room.clients.add(socket);
    socket.role = "participant";

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", code: "invalid-json" });
        return;
      }

      if (message.type === "hello") {
        if (message.role === "host" && typeof message.capability === "string" && message.capability.length >= 24) {
          if (room.capability === null) room.capability = message.capability;
          if (room.capability === message.capability && (room.host === null || room.host === socket)) {
            room.host = socket;
            socket.role = "host";
            send(socket, { type: "host-accepted" });
            broadcast(room, { type: "host-status", connected: true });
          } else {
            send(socket, { type: "error", code: "host-rejected" });
          }
        } else {
          send(socket, { type: "host-status", connected: room.host !== null });
        }
        if (room.latest) send(socket, room.latest);
        for (const event of room.tail) send(socket, event);
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
