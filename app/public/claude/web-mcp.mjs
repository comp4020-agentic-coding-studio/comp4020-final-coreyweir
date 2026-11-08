// Riff's web tools for the host's Claude Code: a stdio MCP server that runs
// inside the host's browser pod (`node /opt/claude/web-mcp.mjs --stdio`).
//
// Claude Code's own WebFetch fetches from the host's browser, so CORS refuses
// most sites, and its WebSearch is a server tool the model's provider has to
// run (and charge for). Jina Reader (r.jina.ai) allows any origin, so these
// two tools go through it: `fetch` reads a page as text, and `search` reads
// DuckDuckGo's HTML results page through it. Both are ordinary tool calls,
// so the room sees each one, and its URL or query, in the terminal.
//
// A JavaScript port of Corey's duckduckgo-jina-mcp (Python, FastMCP), with no
// dependencies, so it runs in Nodepod without a Python download.
// What leaves the browser: the URL or query, to Jina (and through Jina to
// DuckDuckGo for a search).

export const JINA = "https://r.jina.ai";
export const DDG_HTML = "https://html.duckduckgo.com/html";
export const MAX_CONTENT_CHARS = 12000;
const SEARCH_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_MS = 60_000;

const H2_LINK = /^## \[([^\]]+)\]\((.+?)\)$/;
const SNIPPET = /^\[([^\]]+)\]\((.+?)\)$/;

export function searchUrl(query) {
  const target = `${DDG_HTML}?q=${encodeURIComponent(query).replace(/%20/g, "+")}`;
  return `${JINA}/${target}`;
}

export function fetchUrl(url) {
  const trimmed = url.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("URL must start with http:// or https://");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL must start with http:// or https://");
  return `${JINA}/${trimmed}`;
}

/** The destination of a duckduckgo.com/l/ redirect link. */
export function resolveRedirect(url) {
  if (!url.includes("duckduckgo.com/l/")) return url;
  try {
    const params = new URL(url, "https://duckduckgo.com").searchParams;
    for (const key of ["uddg", "u3", "u"]) {
      const value = params.get(key);
      if (value) return value;
    }
  } catch { /* not a URL: keep it */ }
  return url;
}

export function isAd(title, url) {
  const lower = `${title} ${url}`.toLowerCase();
  return lower.includes("duckduckgo.com/y.js") || lower.includes("ad_domain=") || lower.includes("bing.com/aclick") || title.trim().toLowerCase() === "ad";
}

/** Results from Jina's markdown of a DuckDuckGo HTML results page. */
export function parseResults(text, maxResults = 10) {
  const results = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
    const match = H2_LINK.exec(lines[i]);
    if (!match) continue;
    const title = match[1].trim();
    const url = match[2].trim();
    if (!url.startsWith("http") || isAd(title, url)) continue;
    let snippet = "";
    for (let j = i + 1; j < lines.length && j < i + 6; j += 1) {
      const next = lines[j].trim();
      if (!next) continue;
      if (next === "Ad" || next.startsWith("## ")) break;
      const found = SNIPPET.exec(next);
      if (found && found[1].length > 40) {
        snippet = found[1].trim();
        break;
      }
    }
    const link = resolveRedirect(url);
    if (isAd(title, link)) continue;
    results.push({ title, link: link.trim(), snippet });
  }
  return results;
}

export function isBlocked(text) {
  return ["bots use DuckDuckGo", "anomaly-modal", "confirm this search was made by a human", "Warning: Target URL returned error"]
    .some((marker) => text.includes(marker));
}

async function getText(url, timeout, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: "text/plain" }, signal: AbortSignal.timeout(timeout) });
  return { status: response.status, text: await response.text() };
}

export async function search({ query, max_results: maxResults = 10 } = {}, fetchImpl = globalThis.fetch) {
  if (!query || typeof query !== "string") return { results: [], error: "query is required" };
  let reply;
  try {
    reply = await getText(searchUrl(query), SEARCH_TIMEOUT_MS, fetchImpl);
  } catch (error) {
    return { results: [], error: String(error?.message ?? error) };
  }
  if (reply.status !== 200) return { results: [], error: `Jina returned HTTP ${reply.status}: ${reply.text.slice(0, 200)}` };
  if (isBlocked(reply.text)) return { results: [], error: "DuckDuckGo results were blocked or unavailable via Jina. Try again later." };
  const results = parseResults(reply.text, Math.max(1, Math.min(Number(maxResults) || 10, 30)));
  if (!results.length) return { results: [], error: "No search results parsed from Jina response." };
  return { results };
}

export async function fetchPage({ url } = {}, fetchImpl = globalThis.fetch) {
  const wanted = typeof url === "string" ? url.trim() : "";
  if (!wanted) return { content: "", error: "url is required" };
  let target;
  try {
    target = fetchUrl(wanted);
  } catch (error) {
    return { url: wanted, content: "", error: error.message };
  }
  let reply;
  try {
    reply = await getText(target, FETCH_TIMEOUT_MS, fetchImpl);
  } catch (error) {
    return { url: wanted, content: "", error: String(error?.message ?? error) };
  }
  if (reply.status !== 200) return { url: wanted, content: "", error: `Jina HTTP ${reply.status}: ${reply.text.slice(0, 200)}` };
  if (reply.text.slice(0, 500).includes("Warning: Target URL returned error")) return { url: wanted, content: "", error: "Target page returned an error." };
  const content = reply.text.length > MAX_CONTENT_CHARS ? `${reply.text.slice(0, MAX_CONTENT_CHARS)}\n\n... (truncated)` : reply.text;
  return { url: wanted, content };
}

export const SERVER_NAME = "web";
export const INSTRUCTIONS =
  "Web access from this browser workspace. Claude Code's WebFetch runs in the host's browser, where most sites refuse it (CORS), " +
  "so read pages with this server's fetch and search the web with its search. Both go through Jina Reader (r.jina.ai); searches read DuckDuckGo.";

export const TOOLS = [
  {
    name: "search",
    description: "Search the web (DuckDuckGo, read through Jina Reader). Returns titles, links and snippets. Use instead of WebSearch.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        max_results: { type: "integer", description: "Maximum number of results (default 10).", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description: `Read a web page (or PDF) as text through Jina Reader, up to ${MAX_CONTENT_CHARS} characters. Use instead of WebFetch, which most sites refuse from this browser.`,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Full http(s) URL." } },
      required: ["url"],
    },
  },
];

/**
 * What the model (and, in verbose mode, everyone watching the terminal)
 * reads: plain text, not escaped JSON.
 */
export function asText(out) {
  if (out.error) return `Error: ${out.error}`;
  if (out.results) {
    return out.results.map((item, index) => `${index + 1}. ${item.title}\n   ${item.link}${item.snippet ? `\n   ${item.snippet}` : ""}`).join("\n\n");
  }
  return out.content;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** One JSON-RPC message in, its reply out (undefined for a notification). */
export async function handle(message, fetchImpl = globalThis.fetch) {
  const { id, method, params } = message ?? {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (id === undefined || id === null) return undefined;
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const args = params?.arguments ?? {};
      const run = params?.name === "search" ? search : params?.name === "fetch" ? fetchPage : null;
      if (!run) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
      const out = await run(args, fetchImpl);
      return reply({ content: [{ type: "text", text: asText(out) }], isError: Boolean(out.error) });
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** Newline-delimited JSON-RPC on stdin/stdout (MCP's stdio transport). */
export function serve(input = process.stdin, output = process.stdout) {
  let buffer = "";
  input.setEncoding?.("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
        continue;
      }
      handle(message).then((answer) => {
        if (answer) output.write(`${JSON.stringify(answer)}\n`);
      }, (error) => {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } })}\n`);
      });
    }
  });
  input.on("end", () => process.exit(0));
}

if (typeof process !== "undefined" && process.argv?.includes("--stdio")) serve();
