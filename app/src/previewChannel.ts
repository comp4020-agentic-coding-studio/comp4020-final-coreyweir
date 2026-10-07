import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ClaudePodController } from "./claudePod";

type PreviewRequest = {
  type: "request";
  requestId: string;
  generation: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

function storedCapability(key: string) {
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const capability = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  localStorage.setItem(key, capability);
  return capability;
}

export function previewRelayUrl(roomId: string, generation: number) {
  return `/room-preview/${encodeURIComponent(`riff-${roomId}`)}/${generation}/`;
}

function controlUrl(roomId: string) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/preview-control/${encodeURIComponent(`riff-${roomId}`)}`;
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export function usePreviewHostChannel(
  roomId: string,
  facilitator: boolean,
  controllerRef: RefObject<ClaudePodController | null>,
) {
  const socketRef = useRef<WebSocket | null>(null);
  const liveRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!facilitator) return;
    let active = true;
    let reconnectTimer = 0;
    const capability = storedCapability(`riff-preview-host:${roomId}`);

    function send(message: object) {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message));
    }

    function connect() {
      if (!active) return;
      const socket = new WebSocket(controlUrl(roomId));
      socketRef.current = socket;
      socket.addEventListener("open", () => send({ type: "hello", capability }));
      socket.addEventListener("message", async (event) => {
        const message = JSON.parse(String(event.data)) as PreviewRequest | { type: string };
        if (message.type === "host-accepted") {
          if (liveRef.current) send({ type: "preview-up", generation: generationRef.current });
          return;
        }
        if (message.type !== "request") return;

        const request = message as PreviewRequest;
        try {
          const response = await controllerRef.current?.requestPreview({
            method: request.method,
            path: request.path,
            headers: request.headers,
            body: request.body ? fromBase64(request.body) : null,
          });
          if (!response) throw new Error("Preview is offline");
          send({
            type: "response",
            requestId: request.requestId,
            status: response.status,
            headers: response.headers,
            body: toBase64(response.body),
          });
        } catch (cause) {
          const body = new TextEncoder().encode(cause instanceof Error ? cause.message : String(cause));
          send({
            type: "response",
            requestId: request.requestId,
            status: 502,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: toBase64(body),
          });
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (active) reconnectTimer = window.setTimeout(connect, 1200);
      });
    }

    connect();
    return () => {
      active = false;
      clearTimeout(reconnectTimer);
      if (liveRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "preview-down", generation: generationRef.current }));
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [controllerRef, facilitator, roomId]);

  return useCallback((live: boolean) => {
    liveRef.current = live;
    if (live) generationRef.current = Math.max(Date.now(), generationRef.current + 1);
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: live ? "preview-up" : "preview-down", generation: generationRef.current }));
    }
    return live ? generationRef.current : 0;
  }, []);
}
