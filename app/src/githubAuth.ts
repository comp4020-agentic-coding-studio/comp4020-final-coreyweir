export type GitHubDeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export type GitHubUser = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
};

type DeviceTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | string;
  error_description?: string;
};

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error_description?: string };
  if (!response.ok) throw new Error(body.error_description || `Request failed (${response.status})`);
  return body;
}

export async function startGitHubDeviceAuthorization(signal: AbortSignal) {
  const response = await fetch("/api/github/device/code", { method: "POST", signal });
  return jsonResponse<GitHubDeviceAuthorization>(response);
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForGitHubDeviceToken(
  authorization: GitHubDeviceAuthorization,
  signal: AbortSignal,
  onSlowDown: () => void,
) {
  let interval = Math.max(authorization.interval, 1) * 1000;
  const expiresAt = Date.now() + authorization.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await wait(interval, signal);
    const response = await fetch("/api/github/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: authorization.device_code }),
      signal,
    });
    const result = await jsonResponse<DeviceTokenResponse>(response);
    if (result.access_token) return result.access_token;
    if (result.error === "authorization_pending") continue;
    if (result.error === "slow_down") {
      interval += 5000;
      onSlowDown();
      continue;
    }
    throw new Error(result.error_description || result.error || "GitHub authorization failed");
  }
  throw new Error("The GitHub sign-in code expired. Start again to receive a new code.");
}

export async function verifyGitHubToken(token: string, signal: AbortSignal) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal,
  });
  return jsonResponse<GitHubUser>(response);
}
