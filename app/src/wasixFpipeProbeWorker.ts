import { probeHostPipe } from "./wasixFpipeProbe.ts";

self.onmessage = async () => {
  try {
    const result = await probeHostPipe();
    self.postMessage({ kind: "done", result });
  } catch (error) {
    self.postMessage({ kind: "error", error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
};
