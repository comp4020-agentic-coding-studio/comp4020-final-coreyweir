// Looking up a GitHub account by username, for invites and colleagues
// (docs/adr/0008). Authenticated with the OAuth app's own client id and
// secret, which GitHub allows 5000 requests an hour (measured 18 Oct;
// unauthenticated is 60, shared by everything behind the same address).

export function createGithubLookup({ clientId, clientSecret, fetch = globalThis.fetch }) {
  const authorization =
    clientId && clientSecret ? `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` : undefined;

  // {id, login, avatarUrl} for an account that exists, null for one that
  // doesn't; throws if GitHub couldn't be asked.
  return async function lookup(login) {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "riff",
        ...(authorization ? { authorization } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for a user lookup`);
    const body = await response.json();
    if (typeof body.id !== "number" || typeof body.login !== "string") throw new Error("GitHub sent a user without an id");
    // Organisations have usernames too, but can't sign in or be invited.
    if (body.type && body.type !== "User") return null;
    return { id: body.id, login: body.login, avatarUrl: typeof body.avatar_url === "string" ? body.avatar_url : null };
  };
}
