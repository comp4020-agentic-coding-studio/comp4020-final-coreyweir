// Riff's web MCP server (public/claude/web-mcp.mjs) without a browser or the
// network: the DuckDuckGo-through-Jina parsing, the URLs it asks for, the
// MCP replies, and which hosts lose WebSearch.
// npm run test:web-mcp
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { fetchPage, fetchUrl, handle, parseResults, resolveRedirect, search, searchUrl, serve, MAX_CONTENT_CHARS } from "../public/claude/web-mcp.mjs";
import { deniedWebTools } from "../src/webTools.ts";

// The shape Jina Reader gives a DuckDuckGo HTML results page (abridged).
const PAGE = [
  "Title: claude code at DuckDuckGo",
  "",
  "## [Ad](https://duckduckgo.com/y.js?ad_domain=example.com&u3=https%3A%2F%2Fbing.com%2Faclick)",
  "[Buy things now, a very long advert snippet that goes on and on](https://duckduckgo.com/y.js?x)",
  "",
  "## [Sponsored thing](https://duckduckgo.com/y.js?u3=https%3A%2F%2Fshop.example)",
  "",
  "## [Claude Code overview](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.claude.com%2Fclaude-code&rut=abc)",
  "",
  "[docs.claude.com/claude-code](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.claude.com%2Fclaude-code)",
  "[Claude Code is an agentic coding tool that lives in your terminal and understands your codebase.](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.claude.com%2Fclaude-code)",
  "",
  "## [Second result](https://example.org/second)",
  "short",
  "## [Third](https://example.net/third)",
].join("\n");

const reply = (status, text) => async () => ({ status, text: async () => text });

test("results skip adverts, resolve DuckDuckGo's redirect links and take a long snippet", () => {
  const results = parseResults(PAGE, 10);
  assert.deepEqual(results.map((item) => item.link), ["https://docs.claude.com/claude-code", "https://example.org/second", "https://example.net/third"]);
  assert.match(results[0].snippet, /^Claude Code is an agentic coding tool/);
  assert.equal(results[1].snippet, "", "a short line isn't a snippet");
  assert.equal(parseResults(PAGE, 1).length, 1, "max results");
});

test("redirect links keep their destination; other links are left alone", () => {
  assert.equal(resolveRedirect("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx%3Fy%3D1"), "https://a.example/x?y=1");
  assert.equal(resolveRedirect("https://a.example/"), "https://a.example/");
});

test("search and fetch go through Jina Reader", () => {
  assert.equal(searchUrl("claude code"), "https://r.jina.ai/https://html.duckduckgo.com/html?q=claude+code");
  assert.equal(fetchUrl(" https://example.com/a?b=1 "), "https://r.jina.ai/https://example.com/a?b=1");
  assert.throws(() => fetchUrl("file:///etc/passwd"), /http/);
  assert.throws(() => fetchUrl("not a url"), /http/);
});

test("a search says why it found nothing", async () => {
  assert.match((await search({ query: "" })).error, /required/);
  const unavailable = /^Web search is unavailable right now\. Don't retry the search: read a page you know with fetch instead/;
  assert.match((await search({ query: "x" }, reply(429, "slow down"))).error, /HTTP 429, too many requests/);
  assert.match((await search({ query: "x" }, reply(429, "slow down"))).error, unavailable);
  // What Jina answered on 9 Nov, for hours: someone else's abuse got DuckDuckGo blocked.
  const refused = (await search({ query: "x" }, reply(403, "AbuseAlleviationError: Anonymous access to domain html.duckduckgo.com blocked until Sun Nov 08 2026 19:23:08 GMT+0000 (Coordinated Universal Time) due to previous abuse found on https://html.duckduckgo.com/html/?q=x: Suspicious action: Domain resolve"))).error;
  assert.match(refused, unavailable);
  assert.match(refused, /Jina Reader is refusing DuckDuckGo until Sun Nov 08 2026 19:23:08 UTC, because of others' abuse/);
  assert.match((await search({ query: "x" }, reply(200, "<div class=anomaly-modal>"))).error, /bot check/);
  assert.match((await search({ query: "x" }, reply(200, "nothing here"))).error, /^No results for that query/);
  assert.equal((await search({ query: "x" }, reply(200, PAGE))).results.length, 3);
  assert.match((await search({ query: "x" }, async () => { throw new TypeError("Failed to fetch"); })).error, /Jina Reader didn't answer: Failed to fetch/);
});

test("a fetch returns the page's text, cut at the limit", async () => {
  const long = "a".repeat(MAX_CONTENT_CHARS + 50);
  const page = await fetchPage({ url: "https://example.com/" }, reply(200, long));
  assert.equal(page.content.length, MAX_CONTENT_CHARS + "\n\n... (truncated)".length);
  assert(page.content.endsWith("\n\n... (truncated)"));
  assert.match((await fetchPage({ url: "https://example.com/" }, reply(200, "Warning: Target URL returned error 404"))).error, /error/);
  assert.match((await fetchPage({ url: "ftp://x" })).error, /http/);
});

test("MCP: initialize, tools/list, tools/call, unknown method; notifications get no reply", async () => {
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.match(init.result.instructions, /WebFetch/);
  assert.deepEqual((await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.map((tool) => tool.name), ["search", "fetch"]);
  const called = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fetch", arguments: { url: "https://example.com/" } } }, reply(200, "Example Domain"));
  assert.equal(called.result.isError, false);
  assert.equal(called.result.content[0].text, "Example Domain", "the page's text, not JSON");
  const searched = await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search", arguments: { query: "x", max_results: 2 } } }, reply(200, PAGE));
  assert.equal(searched.result.content[0].text, "1. Claude Code overview\n   https://docs.claude.com/claude-code\n   Claude Code is an agentic coding tool that lives in your terminal and understands your codebase.\n\n2. Second result\n   https://example.org/second");
  const failed = await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search", arguments: { query: "x" } } }, reply(503, "down"));
  assert.deepEqual([failed.result.isError, failed.result.content[0].text], [true, "Error: Web search is unavailable right now. Don't retry the search: read a page you know with fetch instead (the project's docs, its GitHub repository, its npm or PyPI page), or ask the user for a link. (Jina Reader answered HTTP 503.)"]);
  assert.equal((await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } })).error.code, -32602);
  assert.equal((await handle({ jsonrpc: "2.0", id: 5, method: "resources/list" })).error.code, -32601);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
});

test("stdio: one JSON message per line, split across chunks", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serve(input, output);
  const lines = [];
  output.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
  input.write('{"jsonrpc":"2.0","id":1,"meth');
  input.write('od":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    { jsonrpc: "2.0", id: 1, result: {} },
  ], "the bad line answers at once; the ping after its async handler");
});

test("only Riff's own models lose WebSearch", () => {
  assert.deepEqual(deniedWebTools("https://airiff.tech/api/model", "https://airiff.tech/api/model/"), ["WebSearch"]);
  assert.deepEqual(deniedWebTools("https://litellm.example/v1", "https://airiff.tech/api/model"), []);
  assert.deepEqual(deniedWebTools("https://api.anthropic.com", "https://airiff.tech/api/model"), []);
});
