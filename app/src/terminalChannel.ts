import { useCallback, useEffect, useRef, useState } from "react";

export type TerminalSnapshot = {
  sequence: number;
  ansi: string;
  cols: number;
  rows: number;
};

export type TerminalData = {
  sequence: number;
  data: string;
  cols: number;
  rows: number;
};

export type TerminalEvent = TerminalSnapshot & { type: "snapshot" } | TerminalData & { type: "data" };

function terminalUrl(roomId: string) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/terminal/riff-${roomId}`;
}

function hostCapability(roomId: string) {
  const key = `riff-host-capability:${roomId}`;
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const capability = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  localStorage.setItem(key, capability);
  return capability;
}

export function useTerminalChannel(roomId: string, facilitator: boolean) {
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<(event: TerminalEvent) => void>());
  const [connected, setConnected] = useState(false);
  const [hostConnected, setHostConnected] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let reconnectTimer = 0;
    const capability = facilitator ? hostCapability(roomId) : null;

    function connect() {
      if (!active) return;
      const socket = new WebSocket(terminalUrl(roomId));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setConnected(true);
        setError(null);
        socket.send(JSON.stringify({
          type: "hello",
          role: facilitator ? "host" : "participant",
          ...(capability ? { capability } : {}),
        }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "snapshot") {
          setSnapshot((current) => current && current.sequence >= message.sequence ? current : message);
          for (const listener of listenersRef.current) listener(message);
        } else if (message.type === "data") {
          setHasData(true);
          for (const listener of listenersRef.current) listener(message);
        } else if (message.type === "host-status") {
          setHostConnected(message.connected === true);
        } else if (message.type === "host-accepted") {
          setHostConnected(true);
        } else if (message.type === "error") {
          setError(String(message.code ?? "terminal-relay-error"));
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        setConnected(false);
        if (facilitator) setHostConnected(false);
        if (active) reconnectTimer = window.setTimeout(connect, 1200);
      });
      socket.addEventListener("error", () => setError("connection-error"));
    }

    connect();
    return () => {
      active = false;
      clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [facilitator, roomId]);

  const publish = useCallback((next: Omit<TerminalSnapshot, "sequence">) => {
    const socket = socketRef.current;
    if (!facilitator || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "snapshot", ...next }));
  }, [facilitator]);

  const publishData = useCallback((data: string, cols: number, rows: number) => {
    const socket = socketRef.current;
    if (!facilitator || !data || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "data", data, cols, rows }));
  }, [facilitator]);

  const subscribe = useCallback((listener: (event: TerminalEvent) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return { connected, error, hasData, hostConnected, publish, publishData, snapshot, subscribe };
}
