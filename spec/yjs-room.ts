import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

// A headless session in a Riff room: the same Yjs document over the same
// /collaboration/ socket the browser client uses, minus the UI.
export type RoomSession = { doc: Y.Doc; leave: () => void };

export function collaborationUrl(baseUrl: string) {
  const url = new URL("/collaboration", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function uniqueRoom(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function joinRoom(baseUrl: string, room: string): Promise<RoomSession> {
  const doc = new Y.Doc();
  const url = collaborationUrl(baseUrl);
  const provider = new WebsocketProvider(url, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    connect: true,
  });
  const leave = () => {
    provider.destroy();
    doc.destroy();
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      leave();
      reject(new Error(`room ${room} never synced with ${url}`));
    }, 10_000);
    provider.on("sync", (synced: boolean) => {
      if (!synced) return;
      clearTimeout(timer);
      resolve({ doc, leave });
    });
  });
}

// Resolves with how long it took (ms) for `check` to become true on `doc`,
// driven by the document's own update events rather than polling.
export function timeUntil(doc: Y.Doc, check: () => boolean, timeoutMs: number): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    if (check()) return resolve(0);
    const timer = setTimeout(() => {
      doc.off("update", onUpdate);
      reject(new Error(`condition not met within ${timeoutMs}ms`));
    }, timeoutMs);
    function onUpdate() {
      if (!check()) return;
      clearTimeout(timer);
      doc.off("update", onUpdate);
      resolve(performance.now() - started);
    }
    doc.on("update", onUpdate);
  });
}
