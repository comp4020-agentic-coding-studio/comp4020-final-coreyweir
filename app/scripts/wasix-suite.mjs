// Aggregate runner for the WASIX suite.
//
// The browser smokes once had no runner, so "still green" was a chore rather
// than one command. Keep the maintained shared-store coverage in one command.
//
//   npm run test:wasix                 # everything, starting a dev server if needed
//   npm run test:wasix -- --only bridge
//   npm run test:wasix -- --list
//   npm run test:wasix -- --no-server  # a dev server is already up
//
// Suites run cheapest-first so a typecheck or unit failure surfaces in seconds
// rather than after twenty minutes of cold WASM starts. A failing suite does
// not stop the run; the summary at the end is the point.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.RIFF_PORT ?? 8093);
const BASE_URL = process.env.RIFF_URL ?? `http://127.0.0.1:${PORT}`;
const SUITE_TIMEOUT_MS = Number(process.env.RIFF_SUITE_TIMEOUT_MS ?? 900_000);

/** @type {{ name: string, script: string, browser: boolean }[]} */
const SUITES = [
  // No browser. Seconds. Run first.
  { name: "typecheck", script: "typecheck", browser: false },
  { name: "osc133", script: "test:osc133", browser: false },
  { name: "bridge-unit", script: "test:wasix-bridge-unit", browser: false },
  { name: "net-gateway", script: "test:net-gateway", browser: false },
  { name: "net-gateway-browser", script: "test:net-gateway-browser", browser: false },
  // Downloads the 82 MB Claude tarball into .cache/ the first time, then
  // replays it. Pins the in-browser derivation against the published release.
  { name: "claude-bundle", script: "test:claude-bundle", browser: false },

  // Browser, roughly ascending cost.
  { name: "claude-bundle-browser", script: "test:claude-bundle-browser", browser: true },
  { name: "session", script: "test:wasix-session-browser", browser: true },
  { name: "overlay-session", script: "test:wasix-overlay-session-browser", browser: true },
  // Overlapping Bash tool calls are Claude Code's normal shape; this pins that
  // they run, keep separate bridge channels, and survive each other's aborts.
  { name: "concurrent-bash", script: "test:wasix-concurrent-bash-browser", browser: true },
  { name: "s1", script: "test:wasix-s1-browser", browser: true },
  { name: "bash-fork", script: "test:wasix-bash-fork", browser: true },
  { name: "bash-external", script: "test:wasix-bash-external-browser", browser: true },
  { name: "bash-mount-matrix", script: "test:wasix-bash-mount-matrix", browser: true },
  { name: "fpipe", script: "test:wasix-fpipe-browser", browser: true },
  { name: "pipe-write", script: "test:wasix-pipe-write-browser", browser: true },
  { name: "stub-spawn", script: "test:wasix-stub-spawn-browser", browser: true },
  { name: "bridge-rpc", script: "test:wasix-bridge-rpc-browser", browser: true },
  { name: "bridge-session", script: "test:wasix-bridge-session-browser", browser: true },
  { name: "bridge-e2e", script: "test:wasix-bridge-e2e-browser", browser: true },
  { name: "stream", script: "test:wasix-stream-browser", browser: true },
  { name: "terminal-tail", script: "test:wasix-terminal-tail-browser", browser: true },
  { name: "claude-bash", script: "test:wasix-claude-bash-browser", browser: true },
  { name: "shared-store", script: "test:wasix-shared-store-browser", browser: true },
  { name: "bridge-ctrl-c", script: "test:wasix-bridge-ctrl-c-browser", browser: true },
  { name: "bridge-endurance", script: "test:wasix-bridge-endurance-browser", browser: true },
  { name: "watcher", script: "test:wasix-watcher-browser", browser: true },
  { name: "mixed-interrupt", script: "test:wasix-mixed-interrupt-browser", browser: true },
  { name: "terminal", script: "test:wasix-terminal-browser", browser: true },
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const valueOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

if (flag("list")) {
  for (const s of SUITES) console.log(`${s.browser ? "browser" : "   node"}  ${s.name.padEnd(20)} npm run ${s.script}`);
  process.exit(0);
}

const only = valueOf("only");
const selected = only ? SUITES.filter((s) => s.name.includes(only) || s.script.includes(only)) : SUITES;
if (selected.length === 0) {
  console.error(`No suite matches --only ${only}. Use --list.`);
  process.exit(2);
}

function run(command, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, cmdArgs, { stdio: opts.quiet ? "ignore" : "inherit", ...opts });
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, timedOut: true });
      }, opts.timeoutMs);
    }
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, timedOut: false });
    });
  });
}

async function serverIsUp() {
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

let devServer = null;
async function ensureServer() {
  if (!selected.some((s) => s.browser)) return true;
  if (await serverIsUp()) {
    console.log(`[suite] using the dev server already at ${BASE_URL}`);
    return true;
  }
  if (flag("no-server")) {
    console.error(`[suite] --no-server given but nothing is serving ${BASE_URL}`);
    return false;
  }
  console.log(`[suite] starting a dev server on port ${PORT}`);
  // Bind 127.0.0.1 explicitly: vite's default `localhost` can resolve to ::1
  // only, and every smoke's default RIFF_URL is http://127.0.0.1:<port>.
  devServer = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    stdio: "ignore",
    detached: false,
  });
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    if (await serverIsUp()) {
      console.log(`[suite] dev server ready at ${BASE_URL}`);
      return true;
    }
  }
  console.error("[suite] dev server did not become ready within 60s");
  return false;
}

function stopServer() {
  if (!devServer) return;
  devServer.kill("SIGTERM");
  devServer = null;
}

process.on("SIGINT", () => { stopServer(); process.exit(130); });

if (!(await ensureServer())) {
  stopServer();
  process.exit(1);
}

const results = [];
const startedAll = Date.now();

for (const suite of selected) {
  process.stdout.write(`\n\x1b[1m[suite] ${suite.name}\x1b[0m (npm run ${suite.script})\n`);
  const started = Date.now();
  const { code, timedOut } = await run("npm", ["run", "--silent", suite.script], {
    timeoutMs: SUITE_TIMEOUT_MS,
    env: { ...process.env, RIFF_URL: BASE_URL },
  });
  const ms = Date.now() - started;
  results.push({ ...suite, code, timedOut, ms });
  const status = timedOut ? "TIMEOUT" : code === 0 ? "pass" : `FAIL (${code})`;
  process.stdout.write(`[suite] ${suite.name}: ${status} in ${(ms / 1000).toFixed(1)}s\n`);
}

stopServer();

const failed = results.filter((r) => r.code !== 0 || r.timedOut);
console.log("\n" + "=".repeat(64));
for (const r of results) {
  const status = r.timedOut ? "TIMEOUT" : r.code === 0 ? "pass   " : "FAIL   ";
  console.log(`  ${status} ${r.name.padEnd(20)} ${(r.ms / 1000).toFixed(1)}s`);
}
console.log("=".repeat(64));
console.log(
  `${results.length - failed.length}/${results.length} passed in ${((Date.now() - startedAll) / 1000 / 60).toFixed(1)} min`,
);
if (failed.length > 0) console.log(`failed: ${failed.map((f) => f.name).join(", ")}`);

process.exit(failed.length === 0 ? 0 : 1);
