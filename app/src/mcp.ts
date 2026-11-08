// MCP servers for the host's Claude (docs/adr/0012). The host turns them on
// per room, in this browser; the settings live in localStorage, never in the
// workspace or an export. What reaches the guest is Claude's own config
// (`mcpServers` in ~/.claude.json) with a placeholder where each token goes:
// public/riff-sw.js swaps it for the real value, only on requests to that
// server's own origin (docs/adr/0007).

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const GITHUB_MCP_ORIGIN = new URL(GITHUB_MCP_URL).origin;

// GitHub's MCP server groups its tools into toolsets (X-MCP-Toolsets). The
// first five are its own default. Measured 9 Nov 2026: all of them 117
// tools; the default 49, 29 of them read-only.
export const GITHUB_TOOLSETS: { id: string; label: string }[] = [
  { id: "context", label: "Context (who you are)" },
  { id: "repos", label: "Repositories" },
  { id: "issues", label: "Issues" },
  { id: "pull_requests", label: "Pull requests" },
  { id: "users", label: "Users" },
  { id: "actions", label: "Actions" },
  { id: "code_security", label: "Code scanning" },
  { id: "dependabot", label: "Dependabot" },
  { id: "discussions", label: "Discussions" },
  { id: "gists", label: "Gists" },
  { id: "git", label: "Git trees" },
  { id: "labels", label: "Labels" },
  { id: "notifications", label: "Notifications" },
  { id: "orgs", label: "Organisations" },
  { id: "projects", label: "Projects" },
  { id: "secret_protection", label: "Secret scanning" },
  { id: "security_advisories", label: "Security advisories" },
  { id: "stargazers", label: "Stars" },
  { id: "copilot", label: "Copilot" },
];
export const DEFAULT_TOOLSETS = ["context", "repos", "issues", "pull_requests", "users"];

export type GithubMcp = { on: boolean; readOnly: boolean; toolsets: string[] };
export type CustomMcp = {
  name: string;
  url: string;
  /** A header carrying a token, e.g. Authorization; none for open servers. */
  header: string;
  value: string;
};
export type McpSettings = { github: GithubMcp; custom: CustomMcp[] };

export const NO_MCP: McpSettings = { github: { on: false, readOnly: true, toolsets: DEFAULT_TOOLSETS }, custom: [] };

const key = (roomId: string) => `riff-mcp:${roomId}`;

function cleanCustom(value: unknown): CustomMcp | null {
  if (!value || typeof value !== "object") return null;
  const { name, url, header, value: secret } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof url !== "string") return null;
  return { name, url, header: typeof header === "string" ? header : "", value: typeof secret === "string" ? secret : "" };
}

export function loadMcp(roomId: string): McpSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(key(roomId)) ?? "null") as Partial<McpSettings> | null;
    if (!saved) return NO_MCP;
    const github = saved.github;
    return {
      github: {
        on: github?.on === true,
        readOnly: github?.readOnly !== false,
        toolsets: Array.isArray(github?.toolsets) ? github.toolsets.filter((id) => GITHUB_TOOLSETS.some((set) => set.id === id)) : DEFAULT_TOOLSETS,
      },
      custom: Array.isArray(saved.custom) ? saved.custom.map(cleanCustom).filter((entry): entry is CustomMcp => entry !== null) : [],
    };
  } catch {
    return NO_MCP;
  }
}

export function saveMcp(roomId: string, settings: McpSettings) {
  try {
    localStorage.setItem(key(roomId), JSON.stringify(settings));
  } catch {
    // kept for this page only
  }
}

export function forgetMcp(roomId: string) {
  try {
    localStorage.removeItem(key(roomId));
  } catch {
    // nothing stored
  }
}

/** A name Claude accepts for a server: letters, digits, - and _. */
export function serverName(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export type McpServerEntry = { type: "http"; url: string; headers?: Record<string, string> };

/**
 * Claude's `mcpServers` for these settings. `placeholder(origin, value)`
 * makes the stand-in for a token that may only go to `origin`.
 */
export function mcpServers(settings: McpSettings, github: { placeholder: string } | null, placeholderFor: (entry: CustomMcp) => string | null) {
  const servers: Record<string, McpServerEntry> = {};
  if (settings.github.on && github) {
    servers.github = {
      type: "http",
      url: GITHUB_MCP_URL,
      headers: {
        Authorization: `Bearer ${github.placeholder}`,
        "X-MCP-Toolsets": settings.github.toolsets.join(","),
        ...(settings.github.readOnly ? { "X-MCP-Readonly": "true" } : {}),
      },
    };
  }
  for (const entry of settings.custom) {
    const name = serverName(entry.name);
    if (!name || servers[name]) continue;
    const placeholder = entry.header && entry.value ? placeholderFor(entry) : null;
    servers[name] = { type: "http", url: entry.url, ...(placeholder ? { headers: { [entry.header]: placeholder } } : {}) };
  }
  return servers;
}
