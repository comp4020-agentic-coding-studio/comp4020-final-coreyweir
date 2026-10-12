import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import nodepod from "@scelar/nodepod/vite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// @ts-expect-error Shared with the production server, which is plain Node.js.
import { createCollaboration } from "./server/collaboration.mjs";
// @ts-expect-error The relay is shared with its plain Node.js smoke test.
import { createTerminalRelay } from "./server/terminalRelay.mjs";
// @ts-expect-error The relay is shared with its plain Node.js smoke test.
import { createPreviewRelay } from "./server/previewRelay.mjs";
// @ts-expect-error The OAuth proxy is plain JavaScript so its smoke test can import it directly.
import { createGitHubDeviceProxy } from "./server/githubDeviceProxy.mjs";

function collaborationRelay(): Plugin {
  return {
    name: "riff-collaboration-relay",
    configureServer(server) {
      // Development uses the same SQLite store as production, in a
      // gitignored file under app/.data unless RIFF_DB says otherwise.
      const dbPath = process.env.RIFF_DB ?? ".data/riff.sqlite";
      mkdirSync(dirname(dbPath), { recursive: true });
      const collaboration = createCollaboration({ dbPath });
      const terminalRelay = createTerminalRelay();
      const previewRelay = createPreviewRelay();

      server.middlewares.use(previewRelay.middleware);
      // Riff's own OAuth app; run the dev server through `mise exec` so
      // mise.local.toml supplies it.
      server.middlewares.use(createGitHubDeviceProxy({ clientId: process.env.GITHUB_CLIENT_ID }));

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
        collaboration.handleUpgrade(request, socket, head);
      });
      server.httpServer?.once("close", () => {
        previewRelay.close();
        terminalRelay.close();
        collaboration.close();
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
