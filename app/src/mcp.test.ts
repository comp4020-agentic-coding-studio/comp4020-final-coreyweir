// npm run test:mcp
import assert from "node:assert/strict";
import test from "node:test";
import { customProblem, mcpServers, NO_MCP, type CustomMcp } from "./mcp.ts";

const entry = (over: Partial<CustomMcp> = {}): CustomMcp => ({ name: "Jina", url: "https://mcp.jina.ai/v1", header: "", value: "", ...over });

test("a custom server needs a free name, an https URL and, with a token, its header", () => {
  assert.equal(customProblem(entry(), []), null);
  assert.match(customProblem(entry({ name: " !! " }), []) ?? "", /Give it a name/);
  assert.match(customProblem(entry({ name: "GitHub" }), []) ?? "", /GitHub's own server/);
  assert.match(customProblem(entry(), [entry({ url: "https://other.example" })]) ?? "", /already a server called "jina"/);
  assert.match(customProblem(entry({ url: "http://mcp.example/v1" }), []) ?? "", /https/);
  assert.equal(customProblem(entry({ url: "http://192.168.1.2:9/mcp" }), [], true), null, "plain http only where the page is");
  assert.match(customProblem(entry({ url: "mcp.example" }), []) ?? "", /isn't a URL/);
  assert.match(customProblem(entry({ url: "https://me:pw@mcp.example" }), []) ?? "", /not in the URL/);
  assert.match(customProblem(entry({ value: "Bearer x" }), []) ?? "", /which header/);
  assert.match(customProblem(entry({ header: "Auth orization", value: "x" }), []) ?? "", /header name/);
  assert.match(customProblem(entry({ header: "Authorization" }), []) ?? "", /value/);
  assert.equal(customProblem(entry({ header: "Authorization", value: "Bearer x" }), []), null);
});

test("Claude's config gets the placeholder in the header, and nothing for an open server", () => {
  const servers = mcpServers({ ...NO_MCP, custom: [entry(), entry({ name: "Mine", url: "https://mine.example/mcp", header: "X-Key", value: "real-secret" })] }, null, () => "riff-placeholder-mcp-0123");
  assert.deepEqual(servers.jina, { type: "http", url: "https://mcp.jina.ai/v1" });
  assert.deepEqual(servers.mine, { type: "http", url: "https://mine.example/mcp", headers: { "X-Key": "riff-placeholder-mcp-0123" } });
  assert.equal(JSON.stringify(servers).includes("real-secret"), false);
});
