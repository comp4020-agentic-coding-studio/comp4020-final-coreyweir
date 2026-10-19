// Riff's own models (ADR 0009), for what spec/ can't see from outside: what
// reaches OpenRouter, whether a reply streams, and what the log says. The
// server runs in-process on a throwaway database with a stand-in OpenRouter
// in place of fetch, which records every request it gets.
//
// npm run test:models
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRiff } from "../server/riff.mjs";

const REAL_KEY = "sk-or-v1-the-real-one";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Answers like OpenRouter would: a model list, a reply streamed in pieces
// 150 ms apart, or a 429 when the prompt asks for one.
function standIn() {
  const seen = [];
  const fetch = async (url, init) => {
    const body = init.body ? await new Response(init.body).text() : null;
    const request = { url, method: init.method, headers: init.headers, body, aborted: false };
    seen.push(request);
    init.signal?.addEventListener("abort", () => (request.aborted = true));
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "nvidia/nemotron-3-ultra-550b-a55b:free" }] });
    if (body?.includes("too many")) {
      return Response.json({ error: { code: 429, message: "Rate limit exceeded" } }, { status: 429, headers: { "retry-after": "7" } });
    }
    const pieces = ["event: one\n\n", "event: two\n\n", "event: three\n\n"];
    const stream = new ReadableStream({
      async pull(controller) {
        if (init.signal?.aborted) return controller.close();
        const piece = pieces.shift();
        if (!piece) return controller.close();
        await sleep(150);
        controller.enqueue(new TextEncoder().encode(piece));
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "x-something-else": "dropped" } });
  };
  return { seen, fetch };
}

async function start(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "riff-models-"));
  const dbPath = join(dir, "riff.sqlite");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const upstream = standIn();
  const riff = createRiff({
    dbPath,
    origin,
    sessionSecret: "test",
    githubLookup: async () => null,
    log: () => {},
    openrouterKey: REAL_KEY,
    modelFetch: upstream.fetch,
    ...options,
  });
  server.on("request", (request, response) =>
    riff.middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    }),
  );
  return {
    origin,
    upstream,
    async call(path, { method = "POST", body, secret } = {}) {
      const headers = { origin, "content-type": "application/json" };
      if (secret) headers.authorization = `Bearer ${secret}`;
      return fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    model(path, key, init = {}) {
      return fetch(`${origin}/api/model${path}`, {
        ...init,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers ?? {}) },
      });
    },
    // The log, read after the server has flushed its tallies.
    async stop() {
      riff.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const db = new DatabaseSync(dbPath);
      const events = db.prepare("SELECT member_id, action, detail_json FROM events ORDER BY seq").all()
        .map((row) => ({ ...row, detail: JSON.parse(row.detail_json) }));
      db.close();
      rmSync(dir, { recursive: true, force: true });
      return events;
    },
  };
}

async function room(app) {
  const host = await (await app.call("/api/rooms", { body: { name: "Ada" } })).json();
  const guest = await (await app.call("/api/rooms/join", { body: { code: host.room.code, name: "Bo" } })).json();
  return { host, guest };
}

test("the host's request reaches OpenRouter with Riff's key, and nothing else of the host's", async () => {
  const app = await start();
  const { host } = await room(app);
  const res = await app.model("/v1/messages?beta=true", host.member.modelKey, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "x", "x-stainless-os": "Linux", cookie: "a=b" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  assert.equal(res.headers.get("x-something-else"), null);
  await res.text();

  assert.equal(app.upstream.seen.length, 1);
  const [sent] = app.upstream.seen;
  assert.equal(sent.url, "https://openrouter.ai/api/v1/messages?beta=true");
  assert.equal(sent.headers.authorization, `Bearer ${REAL_KEY}`);
  assert.equal(sent.headers["anthropic-version"], "2023-06-01");
  assert.equal(sent.headers["anthropic-beta"], "x");
  assert.equal(sent.headers.cookie, undefined);
  assert.equal(sent.headers["x-stainless-os"], undefined);
  assert.ok(!JSON.stringify(sent.headers).includes(host.member.modelKey), "the host's model key went upstream");
  assert.deepEqual(JSON.parse(sent.body).messages, [{ role: "user", content: "hi" }]);
  await app.stop();
});

test("a reply streams through as it arrives", async () => {
  const app = await start();
  const { host } = await room(app);
  const res = await app.model("/v1/messages", host.member.modelKey, { method: "POST", body: "{}" });
  const reader = res.body.getReader();
  const arrived = [];
  const begun = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrived.push([Date.now() - begun, new TextDecoder().decode(value)]);
  }
  assert.equal(arrived.map(([, text]) => text).join(""), "event: one\n\nevent: two\n\nevent: three\n\n");
  assert.ok(arrived.length >= 3, `arrived in ${arrived.length} pieces`);
  assert.ok(arrived.at(-1)[0] - arrived[0][0] >= 250, `pieces ${arrived.map(([at]) => at)} ms apart`);
  await app.stop();
});

test("nothing refused reaches OpenRouter, and the log says who tried", async () => {
  const app = await start();
  const { host, guest } = await room(app);
  const [roomId, hostId, mac] = host.member.modelKey.split(".");

  assert.equal((await app.model("/v1/models")).status, 401);
  assert.equal((await app.model("/v1/models", "made-up")).status, 401);
  assert.equal((await app.model("/v1/models", `${roomId}.${guest.member.id}.${mac}`)).status, 401);
  assert.equal((await app.model("/v1/models", guest.member.secret)).status, 401);
  assert.equal((await app.model("/v1/key", host.member.modelKey)).status, 404);
  assert.equal((await app.model("/v1/messages", host.member.modelKey)).status, 404, "GET on a POST route");
  assert.equal(guest.member.modelKey, undefined);
  assert.equal(app.upstream.seen.length, 0);

  // a 429 comes back as it is, with when to retry
  const limited = await app.model("/v1/messages", host.member.modelKey, { method: "POST", body: '{"too many":1}' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "7");
  await limited.text();

  // the room ends: the host's key stops, before reaching OpenRouter
  assert.equal((await app.call(`/api/rooms/${roomId}/end`, { secret: host.member.secret, body: {} })).status, 200);
  assert.equal((await app.model("/v1/models", host.member.modelKey)).status, 403);
  assert.equal(app.upstream.seen.length, 1);

  const events = await app.stop();
  const model = events.filter((event) => event.action === "model.request");
  assert.deepEqual(model.map((event) => [event.member_id, event.detail.status, event.detail.requests]), [[Number(hostId), 429, 1]]);
  const denied = events.filter((event) => event.action === "denied" && event.detail.what === "model");
  assert.deepEqual(
    denied.map((event) => [event.member_id, event.detail.reason, event.detail.times]).sort(),
    [[null, "bad_model_key", 3], [null, "no_credential", 1], [Number(hostId), "room_ended", 1]].sort(),
  );
  assert.ok(!JSON.stringify(events).includes("too many"), "the log holds what was asked");
});

test("a host who goes away stops the request upstream", async () => {
  const app = await start();
  const { host } = await room(app);
  const controller = new AbortController();
  const res = await app.model("/v1/messages", host.member.modelKey, { method: "POST", body: "{}", signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  await sleep(300);
  assert.equal(app.upstream.seen[0].aborted, true);
  await app.stop();
});

test("without a key there are no models, and hosts aren't given a key for them", async () => {
  const app = await start({ openrouterKey: undefined });
  assert.deepEqual(await (await app.call("/api/model", { method: "GET" })).json(), { available: false });
  const { host } = await room(app);
  assert.equal(host.member.modelKey, undefined);
  assert.equal((await app.model("/v1/models", "anything")).status, 503);
  await app.stop();
});
