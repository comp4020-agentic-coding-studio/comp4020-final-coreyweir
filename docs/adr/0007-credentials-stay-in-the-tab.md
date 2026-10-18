# 7. Credentials stay in the host's page; the guest holds placeholders

- Status: accepted, implemented 2026-10-18
- Date: 2026-10-18

## Context

Until now the host's model token and GitHub token were in the guest's
environment (`claudePod.ts`: `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`,
`GITHUB_TOKEN`, `GH_TOKEN`). The guest is everything Claude Code can touch:
its own process, its shells, their environment and files. If Claude ran
`env`, or a prompt talked it into printing its configuration, both tokens
went out through the terminal mirror to everyone in the room (ADR 0001
names this). A prompt can come from any participant, so this is about who
can see what in a shared room.

PLAN P1.6 settled what should happen: the guest holds a placeholder, and
the real value is added outside the guest, where Claude and bash can't read
it. It assumed the in-tab network gateway would do this, as it already
terminates the guest's TLS for curl.

Measuring where the traffic goes changed the plan. Claude Code's calls to
the model are the browser's own `fetch`, made from the Nodepod worker it
runs in, as is Nodepod's `git` (it pushes through GitHub's REST API). Only
WASIX programs (curl, and bash's network use) pass through the gateway.

## Options

1. **A proxy on our server.** The guest calls `/api/model/...` on fly; the
   server adds the token and forwards.
2. **The net gateway**, as PLAN assumed.
3. **A change to Nodepod**, so its workers hand requests to the page,
   which adds the credential and streams the reply back.
4. **An interceptor inside the guest**, as `nodepod_poc`'s `run.cjs` did.
5. **A service worker.** Every request from the page and its workers passes
   through the origin's service worker. Ours wraps Nodepod's and swaps a
   placeholder for the real value on the way out.

## Decision

Option 5.

- The pod's environment holds `riff-placeholder-model-<hex>` and
  `riff-placeholder-github-<hex>`, new on every boot. `env` shows only
  those.
- Nodepod boots with `swUrl: "/riff-sw.js"`. That script registers its own
  fetch handler and then `importScripts("/__sw__.js")`, so Nodepod's
  handler still serves previews and virtual servers.
- A request carrying a placeholder in a header (also inside HTTP Basic,
  where git puts the token) is answered by the service worker. It fetches
  the request itself with the real value and returns the response as is,
  so a streamed reply stays streamed.
- Each credential has a fixed set of origins: the model token only goes to
  the configured endpoint's origin, the GitHub token only to
  `api.github.com`, `github.com` and `uploads.github.com`. A placeholder
  headed anywhere else gets a 403 from the service worker and the request
  isn't sent.
- The real values stay in the host's page (`src/credentials.ts`). The
  service worker asks for one the first time it sees its placeholder. It
  asks only top-level Riff pages, never a preview, over a channel it opens
  itself. A browser may stop an idle service worker at any time, which
  empties its cache; the next request asks again. When the pod is disposed,
  the page stops answering and tells the service worker to forget.
- If no page answers, the request gets a 401 and isn't sent. If the
  service worker isn't running at all, the request goes out with the
  placeholder and the endpoint refuses it. Both fail closed: nothing leaks.

## Consequences

- **The terminal can't show the tokens.** Nothing in the guest has them. A
  placeholder copied out of the terminal is just a string anywhere but the
  host's open tab.
- **Claude can still use them.** Through the placeholder it can call the
  model and GitHub with the host's access, as it must to work and push.
  Hiding a token is not limiting what it can do.
- **This is not a sandbox.** Guest code is JavaScript running on our
  origin. It can't reach the page's memory, its localStorage or the service
  worker's cache. But the host's preview frame is a same-origin window that
  isn't sandboxed (`App.tsx`), and code there could read the page's stored
  host config. That was already an open risk (PLAN, "Still open"); this
  decision doesn't change it.
- **One more moving part on every request.** Requests without a placeholder
  fall through to Nodepod's handler untouched. Ours costs a header scan.
- **A tab still controlled by Nodepod's old worker moves over** when the
  pod boots, since registering a different script at the same scope
  replaces it, and the new one activates at once (Nodepod's install handler
  skips waiting). Measured: the first request after boot already arrived
  with the real value.
- **Checked** by `npm run test:credentials-browser`: placeholders in the
  node and bash environments and no real token; the real value arrives
  upstream from node's `fetch`, node's `http` module, a Basic credential
  and WASIX curl through the gateway; a reply streamed in five pieces 400 ms
  apart arrives in five pieces; both tokens are refused for other origins;
  a stopped service worker asks again; a disposed pod's placeholder gets a
  401; a tab on Nodepod's old worker moves over. Switching off the origin
  check, or the swap, turns it red. Claude Code itself was run against a
  mock endpoint: its `POST /v1/messages` arrived with the real token, and
  the streamed reply showed in the terminal.

## The case for the options we didn't pick

1. **Server proxy.** Simplest to reason about: one place, plain node, and
   it would work even where service workers don't. Against it: the server
   would hold every host's tokens in memory, where ADR 0005 keeps it from
   ever holding a GitHub token; model traffic would leave from fly's
   address, and course endpoints may only answer some networks; and every
   streamed token would cost us egress.
2. **Net gateway.** Already terminates TLS in the tab and could add the
   header there. It would cover curl and nothing else, because Claude's
   and git's requests never reach it.
3. **Change Nodepod.** The most direct: the worker's `fetch` could ask the
   page. It needs a new streaming message type through nested workers, in
   a fork we'd then have to carry. The service worker gets the same result
   with no fork change.
4. **Interceptor in the guest.** Works, and `nodepod_poc` used it. The
   credential sits in the guest, where Claude can read it, which is the
   problem.
