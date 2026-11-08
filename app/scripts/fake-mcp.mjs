// A minimal MCP server (streamable HTTP, JSON replies) for the MCP smokes
// (docs/adr/0012). One tool, riff_echo. With `secret`, it answers 401
// unless the request carries `header: secret`, and records what each
// request carried, so a smoke can tell the placeholder was swapped on the
// way out (and only for this server). Listens on the LAN address, like the
// fake Anthropic API: Nodepod keeps 127.0.0.0/8 inside the guest.
import http from "node:http";
import { lanAddress } from "./fake-anthropic.mjs";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*, authorization, content-type, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
};

export async function startFakeMcp({ secret = null, header = "authorization" } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors).end();
      return;
    }
    const carried = request.headers[header.toLowerCase()] ?? null;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let message = null;
      try { message = body ? JSON.parse(body) : null; } catch { /* not JSON */ }
      seen.push({ method: request.method, rpc: message?.method ?? null, carried });
      if (secret && carried !== secret) {
        response.writeHead(401, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, cors).end();
        return;
      }
      if (!message || message.id === undefined) {
        response.writeHead(202, cors).end();
        return;
      }
      const reply = (result) => response.writeHead(200, { ...cors, "content-type": "application/json", "mcp-session-id": "fake-mcp-session" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") {
        reply({ protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "riff-fake-mcp", version: "1.0.0" } });
      } else if (message.method === "tools/list") {
        reply({ tools: [{ name: "riff_echo", description: "Echoes its text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
      } else if (message.method === "tools/call") {
        reply({ content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] });
      } else {
        reply({});
      }
    });
  });
  const host = lanAddress();
  await new Promise((resolve) => server.listen(0, host, resolve));
  const url = `http://${host}:${server.address().port}/mcp`;
  return { url, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}
