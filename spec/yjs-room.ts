import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";

// A headless session in a Riff room: the same Yjs document over the same
// /collaboration/ socket and Hocuspocus protocol the browser client uses,
// minus the UI. Room names map to documents the way app/src/room.ts does.
export type RoomSession = {
  doc: Y.Doc;
  // Resolves once the server has acknowledged every local change so far.
  saved: () => Promise<void>;
  leave: () => void;
};

export function collaborationUrl(baseUrl: string, room: string) {
  const url = new URL(`/collaboration/${encodeURIComponent(room)}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function uniqueRoom(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function joinRoom(baseUrl: string, room: string): Promise<RoomSession> {
  const doc = new Y.Doc();
  const url = collaborationUrl(baseUrl, room);
  const provider = new HocuspocusProvider({ url, name: room, document: doc });
  const leave = () => {
    provider.destroy();
    doc.destroy();
  };
  const saved = () =>
    new Promise<void>((resolve, reject) => {
      if (!provider.hasUnsyncedChanges) return resolve();
      const timer = setTimeout(() => {
        provider.off("unsyncedChanges", onChange);
        reject(new Error(`server never acknowledged changes in ${room}`));
      }, 10_000);
      function onChange({ number }: { number: number }) {
        if (number > 0) return;
        clearTimeout(timer);
        provider.off("unsyncedChanges", onChange);
        resolve();
      }
      provider.on("unsyncedChanges", onChange);
    });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      leave();
      reject(new Error(`room ${room} never synced with ${url}`));
    }, 10_000);
    provider.on("synced", ({ state }: { state: boolean }) => {
      if (!state) return;
      clearTimeout(timer);
      resolve({ doc, saved, leave });
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
