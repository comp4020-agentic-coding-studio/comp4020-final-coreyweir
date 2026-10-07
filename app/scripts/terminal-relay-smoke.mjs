import assert from "node:assert/strict";
import { createServer } from "node:http";
import WebSocket from "ws";
import { createTerminalRelay } from "../server/terminalRelay.mjs";

const relay = createTerminalRelay();
const server = createServer();
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/terminal/")) return socket.destroy();
  relay.handleUpgrade(request, socket, head, decodeURIComponent(url.pathname.slice(10)));
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));

const { port } = server.address();
const clients = [];

function connect(room) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal/${room}`);
  socket.messages = [];
  socket.on("message", (raw) => socket.messages.push(JSON.parse(raw.toString())));
  clients.push(socket);
  return socket;
}

function waitFor(check, message, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 10);
  });
}

try {
  const host = connect("room-a");
  const participant = connect("room-a");
  const otherRoom = connect("room-b");
  await waitFor(() => clients.every((client) => client.readyState === WebSocket.OPEN), "Clients did not connect");

  host.send(JSON.stringify({ type: "hello", role: "host", capability: "host-capability-that-is-long-enough" }));
  participant.send(JSON.stringify({ type: "hello", role: "participant" }));
  otherRoom.send(JSON.stringify({ type: "hello", role: "participant" }));
  await waitFor(() => host.messages.some((message) => message.type === "host-accepted"), "Host was not accepted");

  host.send(JSON.stringify({ type: "snapshot", ansi: "\u001b[2JClaude ready", cols: 92, rows: 28 }));
  await waitFor(() => participant.messages.some((message) => message.type === "snapshot"), "Snapshot did not reach participant");
  const firstSnapshot = participant.messages.find((message) => message.type === "snapshot");
  assert.equal(firstSnapshot.ansi, "\u001b[2JClaude ready");
  assert.equal(firstSnapshot.sequence, 1);
  assert.equal(otherRoom.messages.some((message) => message.type === "snapshot"), false);

  host.send(JSON.stringify({ type: "data", data: " streamed-token", cols: 92, rows: 28 }));
  await waitFor(() => participant.messages.some((message) => message.type === "data"), "Live data did not reach participant");
  assert.deepEqual(participant.messages.find((message) => message.type === "data"), {
    type: "data",
    sequence: 2,
    data: " streamed-token",
    cols: 92,
    rows: 28,
  });
  assert.equal(otherRoom.messages.some((message) => message.type === "data"), false);

  participant.send(JSON.stringify({ type: "data", data: "unauthorized" }));
  await waitFor(() => participant.messages.some((message) => message.code === "host-only"), "Participant publication was not rejected");

  const lateParticipant = connect("room-a");
  await waitFor(() => lateParticipant.readyState === WebSocket.OPEN, "Late participant did not connect");
  lateParticipant.send(JSON.stringify({ type: "hello", role: "participant" }));
  await waitFor(() => lateParticipant.messages.some((message) => message.type === "snapshot"), "Late participant did not receive cached snapshot");
  await waitFor(() => lateParticipant.messages.some((message) => message.type === "data"), "Late participant did not receive snapshot tail");
  assert.equal(lateParticipant.messages.find((message) => message.type === "snapshot").ansi, "\u001b[2JClaude ready");
  assert.equal(lateParticipant.messages.find((message) => message.type === "data").data, " streamed-token");

  for (const client of clients) client.close();
  await waitFor(() => relay.rooms.size === 0, "Room cache was not released");
  console.log("Host-only live data, checkpoint tails, late join, and room isolation passed.");
} finally {
  for (const client of clients) client.terminate();
  relay.close();
  await new Promise((resolve) => server.close(resolve));
}
