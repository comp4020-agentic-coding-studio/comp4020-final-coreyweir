import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import nodepod from "@scelar/nodepod/vite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// @ts-expect-error Shared with the production server, which is plain Node.js.
import { createRiff } from "./server/riff.mjs";

// The same server the deploy runs (server/riff.mjs), mounted on Vite's.
// Start Vite through `mise exec` so mise.local.toml supplies RIFF_ORIGIN,
// the GitHub OAuth app and SESSION_SECRET.
function riffServer(): Plugin {
  return {
    name: "riff-server",
    configureServer(server) {
      // Development uses the same SQLite store as production, in a
      // gitignored file under app/.data unless RIFF_DB says otherwise.
      const dbPath = process.env.RIFF_DB ?? ".data/riff.sqlite";
      mkdirSync(dirname(dbPath), { recursive: true });
      const riff = createRiff({
        dbPath,
        origin: process.env.RIFF_ORIGIN ?? "http://127.0.0.1:8093",
        githubClientId: process.env.GITHUB_CLIENT_ID,
        githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
        sessionSecret: process.env.SESSION_SECRET,
        // Riff's own free models for hosts (docs/adr/0009); unset, hosts bring their own
        openrouterKey: process.env.OPENROUTER_API_KEY,
      });
      server.middlewares.use(riff.middleware);
      server.httpServer?.on("upgrade", (request, socket, head) => {
        riff.handleUpgrade(request, socket, head);
      });
      server.httpServer?.once("close", () => riff.close());
    },
  };
}

export default defineConfig({
  plugins: [react(), riffServer(), nodepod()],
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
