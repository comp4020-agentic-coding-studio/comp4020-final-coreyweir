const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function requestGitHub(fetchImpl, url, fields) {
  const upstream = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
  const body = await upstream.json();
  return { status: upstream.ok ? 200 : upstream.status, body };
}

// clientId is Riff's own OAuth app (GITHUB_CLIENT_ID). Without one the routes
// answer 503 rather than the server refusing to start: CI runs the image with
// no secrets, and nothing else depends on GitHub.
export function createGitHubDeviceProxy({ clientId, fetchImpl = fetch }) {

  return async function githubDeviceProxy(request, response, next) {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/api/github/device/code" && pathname !== "/api/github/device/token") {
      next();
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    if (!clientId) {
      sendJson(response, 503, {
        error: "github_sign_in_unavailable",
        error_description: "This server has no GitHub client id configured (GITHUB_CLIENT_ID).",
      });
      return;
    }

    try {
      if (pathname === "/api/github/device/code") {
        const result = await requestGitHub(fetchImpl, DEVICE_CODE_URL, {
          client_id: clientId,
          scope: "repo read:org",
        });
        sendJson(response, result.status, result.body);
        return;
      }

      const { deviceCode } = await readJson(request);
      if (typeof deviceCode !== "string" || !/^[a-zA-Z0-9_-]{20,200}$/.test(deviceCode)) {
        sendJson(response, 400, { error: "invalid_device_code" });
        return;
      }
      const result = await requestGitHub(fetchImpl, ACCESS_TOKEN_URL, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, 502, {
        error: "github_oauth_unavailable",
        error_description: error instanceof Error ? error.message : "GitHub OAuth request failed",
      });
    }
  };
}
