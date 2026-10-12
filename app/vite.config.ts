import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import nodepod from "@scelar/nodepod/vite";
import { WebSocketServer } from "ws";
import { createRequire } from "node:module";
// @ts-expect-error The relay is shared with its plain Node.js smoke test.
import { createTerminalRelay } from "./server/terminalRelay.mjs";
// @ts-expect-error The relay is shared with its plain Node.js smoke test.
import { createPreviewRelay } from "./server/previewRelay.mjs";
// @ts-expect-error The OAuth proxy is plain JavaScript so its smoke test can import it directly.
import { createGitHubDeviceProxy } from "./server/githubDeviceProxy.mjs";

// Temporary public client identity used only by the isolated OAuth PoC.
const GITHUB_CLI_CLIENT_ID = "178c6fc778ccc68e1d6a";

const require = createRequire(import.meta.url);
const { setupWSConnection } = require("y-websocket/bin/utils") as {
  setupWSConnection: (socket: unknown, request: unknown, options: { docName: string; gc: boolean }) => void;
};

function collaborationRelay(): Plugin {
  return {
    name: "riff-collaboration-relay",
    configureServer(server) {
      const socketServer = new WebSocketServer({ noServer: true });
      const terminalRelay = createTerminalRelay();
      const previewRelay = createPreviewRelay();

      server.middlewares.use(previewRelay.middleware);
      server.middlewares.use(createGitHubDeviceProxy({
        clientId: process.env.GITHUB_OAUTH_CLIENT_ID || GITHUB_CLI_CLIENT_ID,
      }));

      server.httpServer?.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname.startsWith("/terminal/")) {
          const roomName = decodeURIComponent(url.pathname.slice("/terminal/".length));
          terminalRelay.handleUpgrade(request, socket, head, roomName);
          return;
        }
        if (url.pathname.startsWith("/preview-control/")) {
          let roomName;
          try {
            roomName = decodeURIComponent(url.pathname.slice("/preview-control/".length));
          } catch {
            socket.destroy();
            return;
          }
          previewRelay.handleUpgrade(request, socket, head, roomName);
          return;
        }
        if (!url.pathname.startsWith("/collaboration/")) return;

        socketServer.handleUpgrade(request, socket, head, (websocket) => {
          const roomName = decodeURIComponent(url.pathname.slice("/collaboration/".length));
          setupWSConnection(websocket as never, request, { docName: roomName, gc: true });
        });
      });
      server.httpServer?.once("close", () => {
        previewRelay.close();
        terminalRelay.close();
        socketServer.close();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), collaborationRelay(), nodepod()],
  optimizeDeps: { exclude: ["@scelar/nodepod", "@wasmer/sdk"] },
  build: { modulePreload: { polyfill: false } },
  worker: { format: "es" },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
