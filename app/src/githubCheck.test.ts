import test from "node:test";
import assert from "node:assert/strict";
import { checkGitHubToken, throttled } from "./githubCheck.ts";

const answering = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

test("only a 401 means GitHub refused the token", async () => {
  assert.equal(await checkGitHubToken("gho_x", answering(200)), "ok");
  assert.equal(await checkGitHubToken("gho_x", answering(401)), "refused");
  // A rate limit, an org restriction or an outage says nothing about the token.
  for (const status of [403, 404, 429, 500, 502]) assert.equal(await checkGitHubToken("gho_x", answering(status)), "unknown", String(status));
  const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  assert.equal(await checkGitHubToken("gho_x", offline), "unknown");
});

test("the check asks GitHub who the token belongs to, with the token", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const spy = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get("authorization") };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await checkGitHubToken("gho_abc", spy);
  assert.deepEqual(seen, { url: "https://api.github.com/user", auth: "Bearer gho_abc" });
});

test("throttled runs at most once per interval", () => {
  let runs = 0;
  const check = throttled(() => { runs += 1; }, 60_000);
  check();
  check();
  check();
  assert.equal(runs, 1);
});
