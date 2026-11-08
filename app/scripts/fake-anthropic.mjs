// A stand-in for the Anthropic Messages API, for smokes that need Claude
// Code to finish real turns. It streams a short reply to every streamed
// request and records each turn's prompt: the text blocks of the last user
// message, which is what reached the model. A prompt containing "slow"
// gets its reply after SLOW_MS, so a smoke can send while Claude is busy;
// one containing "fail" gets a 400, so a turn ends in an API error. One
// containing "webfetch <url>" or "websearch <query>" gets that tool call. Image
// blocks reaching the model are recorded per turn. It also answers Claude Code's
// remote-session web routes (`/v1/code/sessions/<id>/worker/web-fetch` and
// `web-search`) with a canned page or result, recorded in `workerCalls`.
//
// It listens on this machine's first non-loopback address: Nodepod keeps
// 127.0.0.0/8 inside the guest.
import http from "node:http";
import os from "node:os";

export const SLOW_MS = 4_000;

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  throw new Error("No non-loopback IPv4 address for the fake Anthropic API");
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*, authorization, x-api-key",
  "access-control-allow-methods": "*",
};

// Image blocks in a message, including inside tool results (the Read tool
// returns an image as one), as "media_type widthxheight", the size read
// from a PNG's header (0x0 for other types).
function imageBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === "image") {
      const bytes = Buffer.from(block.source?.data ?? "", "base64");
      const png = bytes.length > 24 && bytes.toString("latin1", 12, 16) === "IHDR";
      return [`${block.source?.media_type} ${png ? bytes.readUInt32BE(16) : 0}x${png ? bytes.readUInt32BE(20) : 0}`];
    }
    if (block?.type === "tool_result") return imageBlocks(block.content);
    return [];
  });
}

function textBlocks(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text);
}

export async function startFakeAnthropic({ reply = "Done." } = {}) {
  const turns = [];
  const requests = [];
  const workerCalls = [];
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* not JSON */ }
      const path = new URL(req.url, "http://x").pathname;
      if (path.endsWith("/count_tokens")) {
        res.writeHead(200, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      // Claude Code's remote-session web tools: with
      // CLAUDE_CODE_WEB{FETCH,SEARCH}_USE_CCR_PROXY and a session id it asks
      // `<base>/v1/code/sessions/<id>/worker/web-fetch|web-search` instead of
      // fetching from the browser.
      const worker = /\/v1\/code\/sessions\/([^/]+)\/worker\/(web-fetch|web-search)$/.exec(path);
      if (worker) {
        workerCalls.push({ at: Date.now(), session: decodeURIComponent(worker[1]), route: worker[2], authorization: req.headers.authorization ?? null, body });
        res.writeHead(200, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify(worker[2] === "web-fetch"
          ? { url: body.url, destination_url: body.url, title: "Fake page", text: `The worker read ${body.url}: Riff worker page`, content_type: "text/plain" }
          : { results: [{ title: "Riff worker result", url: "https://example.com/riff-worker-result", snippet: `found for ${body.query}` }] }));
        return;
      }
      if (!path.endsWith("/v1/messages")) {
        res.writeHead(404, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not here" } }));
        return;
      }
      const message = {
        id: `msg_${turns.length}_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: body.model ?? "claude-fake",
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      };
      // Every request, side requests included: which model, which tools (a
      // server tool shows as its type), and the conversation it carried.
      requests.push({ at: Date.now(), model: body.model, tools: (body.tools ?? []).map((tool) => tool.type && tool.type !== "custom" ? tool.type : tool.name), text: JSON.stringify(body.messages ?? []) });
      if (!body.stream) {
        res.writeHead(200, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify(message));
        return;
      }
      const lastUser = [...(body.messages ?? [])].reverse().find((entry) => entry.role === "user");
      const blocks = textBlocks(lastUser?.content);
      // Claude Code also streams side requests (a title, a topic); only a
      // request that carries tools is a turn of the conversation.
      const isTurn = Array.isArray(body.tools) && body.tools.length > 0;
      if (isTurn) turns.push({ at: Date.now(), blocks, images: imageBlocks(lastUser?.content), toolResult: Array.isArray(lastUser?.content) && lastUser.content.some((block) => block?.type === "tool_result"), messages: (body.messages ?? []).length });
      if (isTurn && blocks.some((text) => text.includes("fail"))) {
        res.writeHead(400, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "the fake API refuses prompts containing fail" } }));
        return;
      }
      // A prompt containing "tool" gets a Bash tool call first (sleep 3),
      // so a smoke can send while Claude is mid-turn between tool calls.
      const answered = Array.isArray(lastUser?.content) && lastUser.content.some((block) => block?.type === "tool_result");
      if (isTurn && !answered && blocks.some((text) => text.includes("tool"))) {
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" });
        send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name: "Bash", input: {} } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 3", description: "Wait" }) } });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
        send("message_stop", { type: "message_stop" });
        res.end();
        return;
      }
      // "webfetch <url>" and "websearch <query>" get that tool call first.
      const webCall = isTurn && !answered && blocks.map((text) => /\bweb(fetch|search) (\S+)/.exec(text)).find(Boolean);
      if (webCall) {
        const [name, input] = webCall[1] === "fetch"
          ? ["WebFetch", { url: webCall[2], prompt: "What is this page's title?" }]
          : ["WebSearch", { query: webCall[2] }];
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" });
        send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name, input: {} } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
        send("message_stop", { type: "message_stop" });
        res.end();
        return;
      }
      const slow = isTurn && blocks.some((text) => text.includes("slow"));
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" });
      send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      setTimeout(() => {
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
        send("message_stop", { type: "message_stop" });
        res.end();
      }, slow ? SLOW_MS : 50);
    });
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  return {
    url: `http://${lanAddress()}:${server.address().port}`,
    turns,
    requests,
    workerCalls,
    /** How many turns carried exactly this prompt as one of their text blocks. */
    count: (prompt) => turns.filter((turn) => turn.blocks.includes(prompt)).length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
