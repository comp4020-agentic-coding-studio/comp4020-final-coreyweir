/**
 * Runs the claude-booted derivation inside a real browser: cross-origin fetch
 * under COEP require-corp, DecompressionStream, and the Cache Storage round
 * trip. The Node smoke covers the parsing; this one covers the platform.
 *
 *   npm run test:claude-bundle-browser            # replays a local fixture
 *   CLAUDE_BUNDLE_LIVE=1 npm run test:claude-bundle-browser   # hits npm
 *
 * The fixture is served from a separate loopback origin with
 * `access-control-allow-origin: *`, exactly like registry.npmjs.org, so the
 * cross-origin isolation path is still the one under test.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const live = process.env.CLAUDE_BUNDLE_LIVE === "1";
const FIXTURE = fileURLToPath(new URL("../.cache/claude-code-darwin-x64.tgz", import.meta.url));

async function serveFixture() {
  const size = (await stat(FIXTURE).catch(() => null))?.size;
  // No fixture yet (fresh checkout): fall back to the real registry, which is
  // what the browser does anyway.
  if (!size) return null;
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    });
    createReadStream(FIXTURE).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/claude.tgz`, close: () => server.close() };
}

const fixture = (live ? null : await serveFixture()) ?? { url: null, close: () => {} };
console.log(fixture.url ? `replaying fixture ${FIXTURE}` : "fetching registry.npmjs.org");
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  protocolTimeout: 600_000,
});

try {
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async (tarballUrl) => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const module = await import("/src/claudeBundle.ts");
    const options = tarballUrl ? { tarballUrl } : {};
    const statuses = [];
    const report = (status) => {
      if (statuses[statuses.length - 1] !== status) statuses.push(status);
    };

    for (const name of await caches.keys()) {
      if (name.startsWith("riff-claude-bundle")) await caches.delete(name);
    }

    const coldStarted = performance.now();
    const cold = await module.loadClaudeBundle({ ...options, report });
    const coldMs = performance.now() - coldStarted;

    const warmStarted = performance.now();
    const warm = await module.loadClaudeBundle({ ...options, report: () => {} });
    const warmMs = performance.now() - warmStarted;

    const cacheNames = (await caches.keys()).filter((name) => name.startsWith("riff-claude-bundle"));
    const entries = cacheNames.length ? (await (await caches.open(cacheNames[0])).keys()).length : 0;
    const source = new TextDecoder().decode(cold);

    return {
      expectedSha256: module.CLAUDE_BUNDLE_SHA256,
      coldSha256: await module.digestHex(cold),
      warmSha256: await module.digestHex(warm),
      byteLength: cold.byteLength,
      coldMs: Math.round(coldMs),
      warmMs: Math.round(warmMs),
      cacheNames,
      entries,
      statuses: statuses.slice(0, 3).concat(statuses.slice(-2)),
      bootPatched: source.includes("ZhS();})(exports, require, module, __filename, __dirname);"),
      sourcePatched:
        source.includes("NODEPOD_SHELL_TIMEOUT_PATCHED") &&
        source.includes("NODEPOD_BASH_PIPE_OUTPUT_PATCHED") &&
        source.includes("Uxu.__nodepodSetMaxListenersPatched") &&
        !source.includes("preserveTrailingWhitespace:o"),
    };
  }, fixture.url);

  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(result.coldSha256, result.expectedSha256, "cold derivation digest mismatch");
  assert.equal(result.warmSha256, result.expectedSha256, "cached bundle digest mismatch");
  assert.equal(result.bootPatched, true, "boot patch missing");
  assert.equal(result.sourcePatched, true, "source patches missing");
  assert.equal(result.entries, 1, `expected one cached bundle, found ${result.entries}`);
  assert.ok(result.warmMs < result.coldMs / 4, `cache did not help: cold ${result.coldMs}ms warm ${result.warmMs}ms`);
  console.log("claude-bundle browser smoke passed");
} finally {
  await browser.close();
  fixture.close();
}
