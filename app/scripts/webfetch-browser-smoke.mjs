// What Claude Code's WebFetch can do in the host's browser (c764e16). The
// fake model calls WebFetch; the smoke reads what came back.
//
// - No domain preflight: Claude Code skips its claude.ai blocklist check
//   (skipWebFetchPreflight), which CORS refused from the browser, failing
//   every fetch.
// - The fetch leaves from the host's own browser (Nodepod's fetch, no
//   proxy), so CORS decides: a site that allows any origin is read and its
//   text reaches the model; one that doesn't is a "Network Error".
// - Jina Reader (r.jina.ai) allows any origin, so a page fetched through it
//   is read whatever the site's own CORS.
//
// Needs the internet (raw.githubusercontent.com, example.com, r.jina.ai).
// http:// URLs can't be faked locally: WebFetch upgrades them to https.
//
// RIFF_URL=http://127.0.0.1:8096 npm run test:webfetch-browser
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const fake = await startFakeAnthropic();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requested = [];

async function until(check, what, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  const page = await browser.newPage();
  page.on("request", (request) => requested.push(request.url()));
  await page.goto(`${baseUrl}/?poc=blank`, { waitUntil: "networkidle0" });
  await page.evaluate(async (model) => {
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const target = document.createElement("div");
    target.style.cssText = "width:1000px;height:600px";
    document.body.append(target);
    const controller = new ClaudePodController({ baseUrl: model, token: "fake-token", repo: "" }, () => {});
    window.__screen = () => {
      const buffer = controller.terminal.xterm.buffer.active;
      const lines = [];
      for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true));
      return lines.join("\n");
    };
    window.__controller = controller;
    await controller.boot();
    controller.attach(target);
    await controller.startClaude();
  }, fake.url);
  const screen = () => page.evaluate(() => window.__screen());
  await until(async () => /Bypass Permissions mode|❯/.test(await screen()), "Claude's prompt", 180_000);
  if (/Bypass Permissions mode/i.test(await screen())) {
    await page.evaluate(() => window.__controller.process.write("\x1b[B"));
    await sleep(300);
    await page.evaluate(() => window.__controller.process.write("\r"));
  }
  await until(async () => /bypass permissions on/.test(await screen()), "Claude ready", 60_000);

  // The tool result the model got back for one WebFetch, and the side
  // request (no tools) where Claude Code hands the page to the small model.
  async function webFetch(url) {
    const before = fake.requests.length;
    assert.equal(await page.evaluate((prompt) => window.__controller.sendPrompt(prompt), `webfetch ${url}`), true);
    let result;
    await until(() => {
      for (const request of fake.requests.slice(before)) {
        const messages = JSON.parse(request.text);
        const last = messages.at(-1)?.content;
        const block = Array.isArray(last) ? last.find((item) => item.type === "tool_result") : null;
        if (block) result = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      }
      return result !== undefined;
    }, `WebFetch's result for ${url}`);
    const pageText = fake.requests.slice(before).filter((request) => request.tools.length === 0).map((request) => request.text).join("\n");
    return { result, pageText };
  }

  const open = await webFetch("https://raw.githubusercontent.com/anthropics/claude-code/main/README.md");
  assert.doesNotMatch(open.result, /Network Error|check failed|Unable to verify/i, `a site allowing any origin: ${open.result}`);
  assert.match(open.pageText, /Claude Code/, "the page's text reached the small model");

  const closed = await webFetch("https://example.com/");
  assert.match(closed.result, /Network Error/, `a site without CORS: ${closed.result}`);

  const reader = await webFetch("https://r.jina.ai/https://example.com/");
  assert.doesNotMatch(reader.result, /Network Error/, `through Jina Reader: ${reader.result}`);
  assert.match(reader.pageText, /Example Domain/, "example.com's text, through Jina Reader, reached the small model");

  const preflight = requested.filter((url) => /domain_info|claude\.ai\/api\/web/.test(url));
  assert.deepEqual(preflight, [], "WebFetch asked claude.ai about the domain");
  assert(requested.includes("https://example.com/"), "the fetch itself left from the browser");
  await page.evaluate(() => window.__controller.dispose());
  console.log("WebFetch: no preflight; CORS-open sites and Jina Reader are read, others fail with Network Error.");
} finally {
  await browser.close();
  await fake.close();
}
