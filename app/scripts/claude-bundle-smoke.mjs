/**
 * Proves the browser pipeline in src/claudeBundle.ts reproduces the patched
 * bundle byte for byte from the published npm tarball.
 *
 *   node scripts/claude-bundle-smoke.mjs
 *
 * The tarball is 82 MB, so it is cached under .cache/ between runs and replayed
 * from a loopback server. Set CLAUDE_BUNDLE_LIVE=1 to fetch registry.npmjs.org
 * directly instead (this is what the browser does).
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_BUNDLE_SHA256,
  CLAUDE_TARBALL_URL,
  deriveClaudeBundle,
  digestHex,
} from "../src/claudeBundle.ts";

const FIXTURE = fileURLToPath(new URL("../.cache/claude-code-darwin-x64.tgz", import.meta.url));

async function ensureFixture() {
  await mkdir(fileURLToPath(new URL("../.cache/", import.meta.url)), { recursive: true });
  const existing = await stat(FIXTURE).catch(() => null);
  if (existing?.size) return existing.size;

  process.stdout.write(`downloading ${CLAUDE_TARBALL_URL}\n`);
  const response = await fetch(CLAUDE_TARBALL_URL);
  if (!response.ok) throw new Error(`fixture download failed (${response.status})`);
  const handle = await open(FIXTURE, "w");
  try {
    await response.body.pipeTo(
      new WritableStream({ write: (chunk) => handle.write(chunk).then(() => undefined) }),
    );
  } finally {
    await handle.close();
  }
  return (await stat(FIXTURE)).size;
}

/** Serve the fixture so the pipeline still exercises fetch + a real body stream. */
async function serveFixture(size) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
    createReadStream(FIXTURE).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/claude-code-darwin-x64.tgz`, close: () => server.close() };
}

async function main() {
  const live = process.env.CLAUDE_BUNDLE_LIVE === "1";
  let tarballUrl = CLAUDE_TARBALL_URL;
  let close = () => {};
  if (!live) {
    const size = await ensureFixture();
    ({ url: tarballUrl, close } = await serveFixture(size));
  }

  const started = Date.now();
  let bytes;
  try {
    bytes = await deriveClaudeBundle({
      tarballUrl,
      report: (status) => process.stdout.write(`  ${status}\n`),
    });
  } finally {
    close();
  }

  const digest = await digestHex(bytes);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`derived ${bytes.byteLength} bytes in ${elapsed}s\nsha256 ${digest}\n`);

  const source = new TextDecoder().decode(bytes);
  const expectations = [
    ["boot IIFE invoked", "ZhS();})(exports, require, module, __filename, __dirname);"],
    ["setMaxListeners shim", "Uxu.__nodepodSetMaxListenersPatched"],
    ["trailing whitespace preserved", "preserveTrailingWhitespace:1"],
    ["wrap-ansi sentinel", 'measureWrappedText(){let NPW="x"'],
    ["cursor flush", "[,NPF]=$Yp.useReducer"],
    ["bash pipe output", "NODEPOD_BASH_PIPE_OUTPUT_PATCHED"],
    ["shell probe timeout", "NODEPOD_SHELL_TIMEOUT_PATCHED"],
  ];
  const missing = expectations.filter(([, needle]) => !source.includes(needle)).map(([label]) => label);
  if (missing.length) throw new Error(`patches did not apply: ${missing.join(", ")}`);
  if (source.includes("preserveTrailingWhitespace:o")) throw new Error("preserveTrailingWhitespace:o still present");

  if (digest !== CLAUDE_BUNDLE_SHA256) {
    throw new Error(`digest mismatch: expected ${CLAUDE_BUNDLE_SHA256}, got ${digest}`);
  }
  process.stdout.write("claude-bundle smoke passed\n");
}

main().catch((error) => {
  process.stderr.write(`claude-bundle smoke failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
