// Is the host's GitHub token still accepted? Asked of GitHub itself, from the
// host page (which holds the real token, docs/adr/0007), so a revoked token
// shows up before git fails on it (docs/adr/0005, "Why a push token stops
// working"). One `GET /user` per check: it counts against the host's 5,000
// requests an hour and also marks the token used, which keeps it from being
// the one GitHub retires when the app passes ten tokens.

export type GitHubTokenState = "ok" | "refused" | "unknown";

export async function checkGitHubToken(token: string, fetchImpl: typeof fetch = fetch): Promise<GitHubTokenState> {
  try {
    const response = await fetchImpl("https://api.github.com/user", {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    // 401 is GitHub's answer for a token it doesn't accept; anything else
    // (rate limits, outages, no network) says nothing about the token.
    if (response.status === 401) return "refused";
    return response.ok ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}

/** At most one check per `every` ms, however often it's asked for. */
export function throttled(check: () => void, every: number): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < every) return;
    last = now;
    check();
  };
}
