import { probeBridgeRpc } from "./wasixBridgeRpcProbe.ts";

self.onmessage = async () => {
  try {
    const result = await probeBridgeRpc();
    self.postMessage({ kind: "done", result });
  } catch (error) {
    self.postMessage({ kind: "error", error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
};
