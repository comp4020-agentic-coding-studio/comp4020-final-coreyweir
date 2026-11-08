// Riff's web MCP server (public/claude/web-mcp.mjs) in the host's browser:
// Claude Code starts it from ~/.claude.json, the model's tool calls reach
// it, and its search and fetch go out through Jina Reader from the browser
// and come back as tool results. On Riff's free models WebSearch is denied,
// so Claude isn't offered a server tool the key can't pay for.
//
// - A controller booted for Riff's models (/api/model) writes deny
//   ["WebSearch"]; one booted for the fake (an own endpoint) writes none.
// - Claude runs with the free-model settings (copied from the first pod),
//   against the fake: its tool list has mcp__web__search and
//   mcp__web__fetch and no WebSearch; a search returns real DuckDuckGo
//   results and a fetch returns example.com's text, both through r.jina.ai.
//
// Needs the internet (r.jina.ai, DuckDuckGo through it). Can't tell apart:
// a Jina outage from a broken server (both fail the search).
//
// RIFF_URL=http://127.0.0.1:8096 npm run test:web-mcp-browser
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

  // What a free-model host's pod is given, without starting Claude.
  const free = await page.evaluate(async () => {
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const controller = new ClaudePodController({ baseUrl: `${location.origin}/api/model`, token: "unused", repo: "" }, () => {});
    await controller.boot();
    const read = (path) => controller.pod.volume.readFileSync(path, "utf8");
    const out = { settings: read("/home/user/.claude/settings.json"), config: read("/home/user/.claude.json"), server: read("/opt/claude/web-mcp.mjs").length };
    controller.dispose();
    return out;
  });
  assert.deepEqual(JSON.parse(free.settings).permissions.deny, ["WebSearch"], "free models: WebSearch denied");
  assert.deepEqual(JSON.parse(free.config).mcpServers.web.args, ["/opt/claude/web-mcp.mjs", "--stdio"]);
  assert(free.server > 1000, "the web MCP server is in the pod");

  const own = await page.evaluate(async (model, freeSettings) => {
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
    const settingsPath = "/home/user/.claude/settings.json";
    const ownDeny = JSON.parse(controller.pod.volume.readFileSync(settingsPath, "utf8")).permissions.deny;
    // Run as a free-model host would, against the fake.
    controller.pod.volume.writeFileSync(settingsPath, freeSettings);
    controller.attach(target);
    await controller.startClaude();
    return { ownDeny };
  }, fake.url, free.settings);
  assert.deepEqual(own.ownDeny, [], "an own endpoint keeps WebSearch");

  const screen = () => page.evaluate(() => window.__screen());
  await until(async () => /Bypass Permissions mode|❯/.test(await screen()), "Claude's prompt", 180_000);
  if (/Bypass Permissions mode/i.test(await screen())) {
    await page.evaluate(() => window.__controller.process.write("\x1b[B"));
    await sleep(300);
    await page.evaluate(() => window.__controller.process.write("\r"));
  }
  await until(async () => /bypass permissions on/.test(await screen()), "Claude ready", 60_000);

  async function call(prompt) {
    const before = fake.requests.length;
    assert.equal(await page.evaluate((text) => window.__controller.sendPrompt(text), prompt), true);
    let result;
    let tools = [];
    await until(() => {
      for (const request of fake.requests.slice(before)) {
        if (request.tools.length) tools = request.tools;
        const last = JSON.parse(request.text).at(-1)?.content;
        const block = Array.isArray(last) ? last.find((item) => item.type === "tool_result") : null;
        if (block) result = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      }
      return result !== undefined;
    }, `the tool result for ${prompt}`, 90_000);
    return { result, tools };
  }

  // Claude Code connects MCP servers in the background: a turn sent before
  // the server is up isn't offered its tools. Wait for a turn that is.
  const ready = Date.now();
  let offered = [];
  for (let attempt = 0; attempt < 20 && !offered.includes("mcp__web__search"); attempt += 1) {
    const before = fake.requests.length;
    assert.equal(await page.evaluate(() => window.__controller.sendPrompt("hello")), true);
    await until(() => fake.requests.slice(before).some((request) => request.tools.length), "a turn");
    offered = fake.requests.slice(before).find((request) => request.tools.length).tools;
    await sleep(1_000);
    if (!offered.includes("mcp__web__search")) await sleep(2_000);
  }
  console.log(`web tools offered ${Date.now() - ready} ms after Claude was ready`);

  const searched = await call("mcpsearch claude+code+nodepod");
  assert(searched.tools.includes("mcp__web__search") && searched.tools.includes("mcp__web__fetch"), `web tools offered: ${searched.tools}`);
  assert(!searched.tools.includes("WebSearch"), "WebSearch isn't offered on the free models");
  assert(searched.tools.includes("WebFetch"), "WebFetch stays (CORS-open sites work)");
  const results = JSON.parse(JSON.parse(searched.result)[0]?.text ?? searched.result).results ?? [];
  assert(results.length > 0 && results.every((item) => /^https?:\/\//.test(item.link)), `search results: ${searched.result.slice(0, 300)}`);
  assert(!results.some((item) => item.link.includes("duckduckgo.com/l/")), "redirect links resolved");

  const fetched = await call("mcpfetch https://example.com/");
  assert.match(fetched.result, /Example Domain/, `fetch result: ${fetched.result.slice(0, 300)}`);

  assert(requested.some((url) => url.startsWith("https://r.jina.ai/https://html.duckduckgo.com/html?q=claude+code+nodepod")), "the search left from the browser through Jina");
  assert(requested.some((url) => url === "https://r.jina.ai/https://example.com/"), "the fetch left from the browser through Jina");
  assert.match(await screen(), /web - (search|fetch)|mcp__web/i, "the room sees the tool call");
  await page.evaluate(() => window.__controller.dispose());
  console.log(`web MCP: ${results.length} search results, example.com fetched, both through Jina from the browser; WebSearch denied on the free models.`);
} finally {
  await browser.close();
  await fake.close();
}
