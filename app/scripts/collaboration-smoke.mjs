import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const Y = require("yjs");
const { WebsocketProvider } = require("y-websocket");
const relay = require("y-websocket/bin/utils");
const { setupWSConnection } = relay;
const localServer = process.env.RIFF_RELAY_URL ? null : new WebSocketServer({ port: 0 });

if (localServer) {
  localServer.on("connection", (socket, request) => setupWSConnection(socket, request));
  await new Promise((resolve) => localServer.once("listening", resolve));
}

const localAddress = localServer?.address();
const url = process.env.RIFF_RELAY_URL ?? `ws://127.0.0.1:${localAddress.port}`;
const room = `smoke-${Date.now()}`;
const first = new Y.Doc();
const second = new Y.Doc();
const firstProvider = new WebsocketProvider(url, room, first, { WebSocketPolyfill: WebSocket });
const secondProvider = new WebsocketProvider(url, room, second, { WebSocketPolyfill: WebSocket });

function waitFor(check, message, timeout = 5000) {
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
    }, 20);
  });
}

try {
  await waitFor(
    () => firstProvider.wsconnected && secondProvider.wsconnected,
    "Both clients did not connect to the room relay",
  );

  const prompt = new Y.Map();
  prompt.set("status", "staged");
  prompt.set("text", new Y.Text("Try a less uniform project rhythm."));
  first.getMap("prompts").set("prompt-1", prompt);
  first.getMap("boardRecords").set("shape-1", {
    id: "shape-1",
    typeName: "shape",
    type: "note",
    x: 120,
    y: 80,
    rot: 0,
    z: 1,
    props: { text: "More space here" },
  });
  first.getMap("roomState").set("previewLive", true);

  await waitFor(
    () => second.getMap("prompts").has("prompt-1") && second.getMap("boardRecords").has("shape-1") && second.getMap("roomState").get("previewLive") === true,
    "Prompt, board, and room state did not reach the second client",
  );

  const remotePrompt = second.getMap("prompts").get("prompt-1");
  assert.equal(remotePrompt.get("text").toString(), "Try a less uniform project rhythm.");
  assert.equal(second.getMap("boardRecords").get("shape-1").props.text, "More space here");
  console.log("Two-client prompt and board synchronization passed.");
} finally {
  firstProvider.destroy();
  secondProvider.destroy();
  first.destroy();
  second.destroy();
  if (localServer) {
    localServer.clients.forEach((client) => client.terminate());
    relay.docs.forEach((doc) => doc.destroy());
    relay.docs.clear();
    await new Promise((resolve) => localServer.close(resolve));
  }
}
