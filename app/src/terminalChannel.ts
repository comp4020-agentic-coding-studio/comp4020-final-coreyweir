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
// Each connection to the relay starts its own numbering: a redeploy, or the
// room emptying for a moment, starts the relay's sequence again at 1. So a
// listener hears "connected" and starts counting afresh.
export type TerminalChannelEvent = TerminalEvent | { type: "connected" };

function terminalUrl(roomId: string) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/terminal/${encodeURIComponent(roomId)}`;
}

// `token` is a guest's room secret; a signed-in member sends none and the
// server reads the session cookie. The server, not this hello, decides
// whether the socket is the host's (docs/adr/0006).
export function useTerminalChannel(roomId: string, token: string | null, facilitator: boolean) {
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<(event: TerminalChannelEvent) => void>());
  const [connected, setConnected] = useState(false);
  const [hostConnected, setHostConnected] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counts the relay accepting this page as host. A relay that restarted has
  // no snapshot, so each acceptance tells the host to send one even if its
  // screen hasn't changed (docs/adr/0001, the redeploy gap).
  const [hostAccepted, setHostAccepted] = useState(0);

  useEffect(() => {
    let active = true;
    let reconnectTimer = 0;
    // The relay's refusals are final: asking again gets the same answer.
    let refused = false;

    function connect() {
      if (!active) return;
      const socket = new WebSocket(terminalUrl(roomId));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setConnected(true);
        setError(null);
        for (const listener of listenersRef.current) listener({ type: "connected" });
        socket.send(JSON.stringify({
          type: "hello",
          role: facilitator ? "host" : "participant",
          ...(token ? { token } : {}),
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
          setHostAccepted((count) => count + 1);
        } else if (message.type === "error") {
          const code = String(message.code ?? "terminal-relay-error");
          if (code === "room-ended" || code === "not-a-member") refused = true;
          setError(code);
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        setConnected(false);
        if (facilitator) setHostConnected(false);
        if (active && !refused) reconnectTimer = window.setTimeout(connect, 1200);
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
  }, [facilitator, roomId, token]);

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

  const subscribe = useCallback((listener: (event: TerminalChannelEvent) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return { connected, error, hasData, hostAccepted, hostConnected, publish, publishData, snapshot, subscribe };
}
