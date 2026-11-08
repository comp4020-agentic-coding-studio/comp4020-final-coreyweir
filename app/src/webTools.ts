// Web access for the host's Claude Code. Its own WebFetch fetches from the
// host's browser, where CORS refuses most sites, and its WebSearch is a
// server tool the model's provider runs. Riff adds a small stdio MCP server
// (public/claude/web-mcp.mjs, run by Nodepod's node) whose `search` and
// `fetch` read DuckDuckGo and pages through Jina Reader, which allows any
// origin. Each is an ordinary tool call, so the room sees it in the terminal.

export const WEB_MCP_SOURCE = "/claude/web-mcp.mjs";
export const WEB_MCP_PATH = "/opt/claude/web-mcp.mjs";

/** The built-in server's name; a host's own server can't take it. */
export const WEB_MCP_NAME = "web";

/** ~/.claude.json's user-scoped MCP servers (no approval prompt). */
export function webMcpServers() {
  return { [WEB_MCP_NAME]: { type: "stdio", command: "node", args: [WEB_MCP_PATH, "--stdio"], env: {} } };
}

/**
 * Claude's mcpServers: the host's (docs/adr/0012) plus the built-in web
 * server, which a host server named "web" can't shadow or remove.
 */
export function withWebMcp<T>(hostServers: Record<string, T>) {
  return { ...hostServers, ...webMcpServers() };
}

/**
 * Tools to take away. On Riff's free models (the server forwards to
 * OpenRouter with a key that can't pay for anything) WebSearch's server tool
 * would be refused or billed, so Claude doesn't get it and uses the web
 * server's search instead.
 */
export function deniedWebTools(baseUrl: string, riffModelsUrl: string) {
  return baseUrl.replace(/\/+$/, "") === riffModelsUrl.replace(/\/+$/, "") ? ["WebSearch"] : [];
}
