import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import nodepod from "@scelar/nodepod/vite";
import { WebSocketServer } from "ws";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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

/**
 * The Claude bundle is derived in the browser from the published npm tarball
 * (src/claudeBundle.ts), so Riff must not serve or ship a prebuilt copy. The
 * shared publicDir belongs to nodepod_wasm_wip, whose own demo still loads
 * these files, so they are excluded from this site rather than deleted.
 */
function excludeClaudeBundle(): Plugin {
  const isBundleArtifact = (name: string) => name.startsWith("claude-booted");
  let outDir = "dist";
  return {
    name: "riff-exclude-claude-bundle",
    configResolved(config) {
      outDir = isAbsolute(config.build.outDir) ? config.build.outDir : resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        if (!path.startsWith("/claude/") || !isBundleArtifact(path.slice("/claude/".length))) return next();
        response.statusCode = 404;
        response.end("claude-booted is derived in the browser; see src/claudeBundle.ts\n");
      });
    },
    // publicDir is copied during the write phase, so prune afterwards.
    async closeBundle() {
      const dir = join(outDir, "claude");
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (isBundleArtifact(name)) await rm(join(dir, name), { force: true });
      }
    },
  };
}

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
  publicDir: fileURLToPath(new URL("../../nodepod_wasm_wip/browser/public", import.meta.url)),
  plugins: [react(), excludeClaudeBundle(), collaborationRelay(), nodepod()],
  optimizeDeps: { exclude: ["@scelar/nodepod", "@wasmer/sdk"] },
  build: { modulePreload: { polyfill: false } },
  worker: { format: "es" },
  server: {
    fs: {
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
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
