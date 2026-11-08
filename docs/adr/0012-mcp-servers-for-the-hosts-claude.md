# 12. MCP servers for the host's Claude

- Status: accepted (built 9 Nov: GitHub's MCP, then custom servers)
- Date: 2026-11-09

## Context

Claude in a room has git and the web, but no GitHub beyond git: WASIX has
no `gh`, so it can't open an issue, read a pull request or comment. MCP
servers add tools like these, and many are remote HTTP servers that allow
CORS, so Claude can reach them from the host's browser through the same
fetch path as the model API. Measured 8-9 Nov on Claude Code 2.1.221 in
Nodepod: a server in `mcpServers` of `~/.claude.json` connects
(`api.githubcopilot.com/mcp/`, 49 tools with the default toolsets; Jina's
`mcp.jina.ai/v1`, 12 tools, no auth).

## Decision (Corey, 9 Nov)

- **The host opts in, per room.** An "MCPs" button in the host's terminal
  controls opens a dialog: GitHub's MCP server (on or off, read only or
  read and write through `X-MCP-Readonly`, toolsets through
  `X-MCP-Toolsets`), and custom servers (name, https URL, optionally one
  header and its value). Participants don't see it; what Claude does with
  the tools shows in the terminal everyone already watches.
- **Applying restarts a running Claude on the same conversation.** Claude
  reads its MCP servers only when it starts: a server written into
  `~/.claude.json` while it runs never appears in `/mcp` (measured). So
  Apply writes the config and, if Claude is running, exits it as `/exit`
  does and starts it with `--continue`, which brings the conversation
  back (6 s on dev; the next turn carries the earlier ones). The queue
  sees Claude exit and start, as when the host restarts it by hand. Apply
  waits while Claude is working, since a restart would cut the turn off.
- **Tokens stay in the tab (ADR 0007).** GitHub's MCP uses the token the
  host connected for pushing (no new OAuth scope), served as its own
  credential: a placeholder of kind `mcp`, sent only to
  `https://api.githubcopilot.com`. A custom server's value is a credential
  of its own, sent only to that server's origin, and only in the header the
  host named; Claude's MCP OAuth flow isn't supported. The service worker
  swaps placeholders in headers only.
- **A refusal is the MCP server's news.** A 401 to an MCP credential shows
  as an MCP error in the terminal's footer. It never starts the "GitHub no
  longer accepts the token" flow, which stays keyed to the `github`
  credential and Riff's own `GET /user` check, even though GitHub's MCP
  carries the same token.
- **What persists, and where.** The settings, custom tokens included, are
  kept per room in the host's browser (`localStorage`, `riff-mcp:<room>`),
  like the host's model token, and forgotten with the browser's place in
  the room. `~/.claude.json` holds only placeholders and is written fresh
  at every boot; it's outside the saved workspace (ADR 0010) and never in
  an export.

- **Custom servers are checked before they're added.** A name Claude
  accepts and that isn't taken ("github" is GitHub's own), an https URL
  (plain http only when the page itself is, i.e. the dev server), no
  credentials in the URL, and a header name whenever there's a value. The
  form says that Riff only swaps the token into that header for that
  server, that the server must allow CORS, and that OAuth servers won't
  connect.

## What leaves the room

With an MCP server on, Claude sends that server whatever its tool calls
carry: for GitHub, as the host's GitHub account, within the scope of the
host's token (`repo`); read only limits it to GitHub's read tools. A custom
server is trusted as far as the host trusts it. The board, prompts and
terminal don't go anywhere they didn't before, except through Claude's own
tool calls, which everyone in the room can watch.

## Costs

- Turning a server on mid-crit costs a restart of Claude, a few seconds.
- A server that doesn't allow CORS from Riff's origin, or needs OAuth,
  can't be used.
- The host's GitHub token now reaches one more GitHub origin.

## Implementation (9 Nov)

Built in `25f7cbf` (GitHub's MCP), `395e666` (Apply on a Claude still
starting), `6c3fafb` (custom servers) and `f4df1d7` (built-in entries).

- `app/src/mcp.ts` holds the settings, the form's rules and the servers
  as Claude's config sees them; `app/src/McpSettings.tsx` is the dialog;
  `app/src/credentials.ts` adds the `mcp` placeholder kind, one credential
  per server; `ClaudePodController` in `app/src/claudePod.ts` writes
  `mcpServers` into `~/.claude.json` and restarts Claude on Apply.
- Claude drops an `/exit` typed while it is still drawing its first
  screen, so Apply straight after a start hung once; it now asks again,
  then stops Claude.
- Names the host can't take: `github`, and `web`, kept for a built-in web
  server that isn't on main yet. Apply keeps any entry the host didn't
  set, so a built-in server isn't wiped by the host's changes.

**Checked:** `npm run test:mcp` (the form's rules and the config) and
`npm run test:mcp-browser` (dev, needs the network): the placeholder in
Claude's config, the refusal shown as an MCP notice, Apply on a running
Claude keeping the conversation, a local mock server getting its own
token (and no placeholder leaving the browser), one that refuses its
token, Jina's open server when reachable, a planted built-in entry
surviving Apply, and the dialog at W x H. With `GITHUB_TOKEN` set,
GitHub's tools are listed. **Not recorded:** a run on live.
