import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGitHubDeviceProxy } from "../server/githubDeviceProxy.mjs";

const upstreamRequests = [];
const upstreamFetch = async (url, options) => {
  upstreamRequests.push({ url, options });
  if (url.endsWith("/device/code")) {
    return Response.json({
      device_code: "a".repeat(40),
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
  }
  return Response.json({ error: "authorization_pending" });
};

const middleware = createGitHubDeviceProxy({ clientId: "test-client", fetchImpl: upstreamFetch });
const server = createServer((request, response) => {
  middleware(request, response, () => {
    response.statusCode = 404;
    response.end("not found");
  });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const codeResponse = await fetch(`${baseUrl}/api/github/device/code`, { method: "POST" });
  assert.equal(codeResponse.status, 200);
  assert.equal(codeResponse.headers.get("cache-control"), "no-store");
  assert.equal((await codeResponse.json()).user_code, "ABCD-EFGH");

  const codeRequest = upstreamRequests[0];
  assert.equal(codeRequest.url, "https://github.com/login/device/code");
  assert.equal(codeRequest.options.body.get("client_id"), "test-client");
  assert.equal(codeRequest.options.body.get("scope"), "repo read:org");

  const tokenResponse = await fetch(`${baseUrl}/api/github/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode: "b".repeat(40) }),
  });
  assert.equal(tokenResponse.status, 200);
  assert.equal((await tokenResponse.json()).error, "authorization_pending");

  const tokenRequest = upstreamRequests[1];
  assert.equal(tokenRequest.url, "https://github.com/login/oauth/access_token");
  assert.equal(tokenRequest.options.body.get("client_id"), "test-client");
  assert.equal(tokenRequest.options.body.get("device_code"), "b".repeat(40));
  assert.equal(tokenRequest.options.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");

  const invalidResponse = await fetch(`${baseUrl}/api/github/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode: "short" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error, "invalid_device_code");

  const methodResponse = await fetch(`${baseUrl}/api/github/device/code`);
  assert.equal(methodResponse.status, 405);

  const unrelatedResponse = await fetch(`${baseUrl}/unrelated`);
  assert.equal(unrelatedResponse.status, 404);

  console.log("GitHub auth proxy smoke test passed");
} finally {
  server.close();
  await once(server, "close");
}
