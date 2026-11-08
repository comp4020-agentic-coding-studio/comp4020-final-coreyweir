import { useEffect, useRef, useState, type RefObject } from "react";
import type { ClaudePodController } from "./claudePod";

/* The host's own preview frame, served from this page's Nodepod instead of
 * the relay (docs/adr/0011, "2b"). The frame stays on the room's preview
 * origin; a service worker there forwards its requests over a MessagePort to
 * this page, which answers them from the active preview only, exactly what
 * the relay would reach. WebSockets to the dev server (Vite's hot reload)
 * come the same way and go on through Nodepod's socket bridge. If the
 * bridge isn't up in a few seconds, the frame loads the relay URL, as
 * before. The bridge's own pages are in app/server/previewBridge.mjs. */

const READY_MS = 8000;
const STRIPPED = new Set(["authorization", "cookie", "host", "proxy-authorization", "connection", "content-length"]);

/** Off by default until it has been checked on live (docs/adr/0011, 2b);
 * a browser turns it on with `localStorage["riff-preview-bridge"] = "on"`
 * (or off with "off"), so it can be tried without a deploy. */
export function previewBridgeEnabled() {
  let choice: string | null = null;
  try {
    choice = localStorage.getItem("riff-preview-bridge");
  } catch {
    // no storage: the default
  }
  if (typeof MessageChannel !== "function") return false;
  return choice === "on" ? true : choice === "off" ? false : PREVIEW_BRIDGE_DEFAULT;
}

export const PREVIEW_BRIDGE_DEFAULT = false;

let podRef: RefObject<ClaudePodController | null> | null = null;

/** The host page's pod, for the bridge (set by usePreviewHostChannel). */
export function setPreviewPod(ref: RefObject<ClaudePodController | null> | null) {
  podRef = ref;
}

type BridgeRequest = { type: "request"; id: number; method: string; path: string; headers: Record<string, string>; body: ArrayBuffer | null };
type SocketMessage = { kind: "ws-connect" | "ws-send" | "ws-close"; uid: string; [key: string]: unknown };

/** Answers one port from the frame until it closes. */
function serve(port: MessagePort) {
  const uids = new Set<string>();
  let channel: BroadcastChannel | null = null;
  const sockets = () => {
    if (channel) return channel;
    channel = new BroadcastChannel("nodepod-ws");
    channel.onmessage = (event) => {
      const data = event.data as { uid?: string; kind?: string } | null;
      if (!data?.uid || !uids.has(data.uid) || !String(data.kind).startsWith("ws-")) return;
      if (data.kind === "ws-closed" || data.kind === "ws-error") uids.delete(data.uid);
      port.postMessage(data);
    };
    return channel;
  };

  port.onmessage = async (event) => {
    const data = event.data as BridgeRequest | SocketMessage;
    if ("kind" in data) {
      if (typeof data.uid !== "string" || !/^riff-[\w-]+$/.test(data.uid)) return;
      const target = podRef?.current?.previewSocketTarget();
      if (!target) {
        if (data.kind === "ws-connect") port.postMessage({ kind: "ws-error", uid: data.uid });
        return;
      }
      if (data.kind === "ws-connect") uids.add(data.uid);
      else if (!uids.has(data.uid)) return;
      sockets().postMessage({ ...data, instanceId: target.instanceId, token: target.token, port: target.port });
      return;
    }
    if (data.type !== "request") return;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(data.headers ?? {})) if (!STRIPPED.has(name.toLowerCase())) headers[name] = value;
    try {
      const controller = podRef?.current;
      if (!controller) throw new Error("Preview is offline");
      const response = await controller.requestPreview({
        method: data.method,
        path: data.path.startsWith("/") ? data.path : `/${data.path}`,
        headers,
        body: data.body ? new Uint8Array(data.body) : null,
      });
      const body = response.body.slice().buffer;
      port.postMessage({ id: data.id, status: response.status, headers: response.headers, body }, [body]);
    } catch (cause) {
      const body = new TextEncoder().encode(cause instanceof Error ? cause.message : String(cause)).buffer;
      port.postMessage({ id: data.id, status: 502, headers: { "content-type": "text/plain; charset=utf-8" }, body }, [body]);
    }
  };
  return () => {
    port.close();
    channel?.close();
  };
}

/** The host's frame source: the bridge page while it may still come up,
 * the relay URL once it has failed. `key` changes on each load (Refresh, a
 * new generation), which tries the bridge again. */
export function useHostPreviewSource({ enabled, previewOrigin, relayUrl, frameRef, key }: {
  enabled: boolean;
  previewOrigin: string;
  relayUrl: string | null;
  frameRef: RefObject<HTMLIFrameElement | null>;
  key: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const closers = useRef<Array<() => void>>([]);
  const use = enabled && relayUrl !== null && failed !== key;

  useEffect(() => {
    if (!use) return;
    setConnected(false);
    let up = false;
    const timer = window.setTimeout(() => { if (!up) setFailed(key); }, READY_MS);
    const listener = (event: MessageEvent) => {
      // Only our own preview frame, from the room's preview origin.
      if (event.origin !== previewOrigin || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string } | null;
      if (data?.type === "riff-preview-fallback") {
        setFailed(key);
        return;
      }
      if (data?.type !== "riff-preview-port" || !event.ports[0]) return;
      if (!up) {
        up = true;
        setConnected(true);
        clearTimeout(timer);
      }
      closers.current.push(serve(event.ports[0]));
    };
    window.addEventListener("message", listener);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", listener);
      closers.current.forEach((close) => close());
      closers.current = [];
    };
  }, [use, key, previewOrigin, frameRef]);

  if (!relayUrl) return { source: null, viaPod: false };
  return use
    ? { source: `${previewOrigin}/__riff_preview__/host.html`, viaPod: connected }
    : { source: relayUrl, viaPod: false };
}
