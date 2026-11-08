# 11. The preview gets its own origin

- Status: accepted (2a built; 2b next)
- Date: 2026-11-08

## Context

The preview is a page Claude wrote: whatever the dev server in the host's
workspace serves. Until now the host's preview frame loaded it from
`/__virtual__/<pod>/<port>` on Riff's own origin, served by Nodepod's
service worker, with no sandbox (`App.tsx`, PreviewView). Code there could:

- read Riff's `localStorage`: `riff-host-config` holds the host's own model
  token in plaintext, `riff-github-push` the sealed GitHub token, which
  `POST /api/github/token/unwrap` opens with the host's cookie, and guests'
  room secrets;
- reach `window.parent`, the host page, and its memory, which holds the
  real tokens ADR 0007 keeps out of the guest;
- call `/api` as the host, since its requests carry Riff's Origin and cookie.

ADRs 0005, 0006 and 0007 each named this and left it open (PLAN, "Still
open"). Participants' frames were safe only because a sandbox without
`allow-same-origin` gave them an opaque origin, which in turn broke
`localStorage`, cookies and IndexedDB for any app in the preview.

## Options

1. **Relay the host's preview too, sandboxed into an opaque origin.**
   Closes the hole with no new infrastructure. Rejected with Corey: it
   breaks what works for the host today (the app's storage, and Nodepod's
   WebSocket shim, which reaches the pod over a `BroadcastChannel`
   (`nodepod-ws`) that an opaque origin doesn't share, so hot reload and
   the app's own sockets), and adds the server round trip.
2. **a. Serve every preview, host's and participants', from a per-room
   origin through the existing relay.** The frames keep
   `allow-same-origin`, which is safe on a foreign origin, so storage
   works, and Riff's origin stops serving preview documents. Costs a
   wildcard DNS name and certificate, and the host round-trips through
   the server like participants (see "What 2a costs the host").
   **b. Then a service worker on the preview origin that forwards the
   frame's requests by `postMessage` to the host page's Nodepod**
   (StackBlitz's approach): the host's preview is local again, fast, with
   hot reload, while staying off Riff's origin.

## Decision

Corey, 8 November: **2a now, 2b next.** 2a is built so 2b slots in: the
URL a member's frame loads is one function (`previewFrameUrl`,
`app/src/previewChannel.ts`).

- **Where.** `RIFF_PREVIEW_ORIGIN` is a template,
  `https://{room}.preview.airiff.tech` in `fly.toml`: a Cloudflare
  wildcard CNAME to the fly app (DNS only) and a fly-managed wildcard
  certificate, on the same app and machine. Development defaults to
  `http://{room}.preview.localhost:<dev port>`: Chrome (and Node) resolve
  every `*.localhost` name to loopback, Chrome treats it as a secure
  context, and it is a different site from `127.0.0.1`, where the dev
  server's Riff page is.
- **The label** is a MAC over the room id under the server's secret,
  base32, 20 characters (100 bits): room ids are case-sensitive base64url,
  not DNS labels, and a hostname travels in the clear (DNS, SNI), where
  the room id has no business being. It isn't guessable, and the wildcard
  certificate keeps labels out of certificate transparency logs, but it
  isn't the credential: the member's preview key in the path still is
  (ADR 0006). One origin per room, shared by its members, so one room's
  preview can't read another's storage, and a room's preview keeps its
  storage in each browser across sessions. The member responses carry it
  as `member.previewOrigin`.
- **What a preview host reaches.** The node server answers the preview
  relay on a preview host and refuses everything else with a plain 404:
  no app files, API, sign-in or sockets. nginx sends every preview host to
  node (`deploy/nginx.conf`), so node is the one place that decides, and
  dev behaves like production.
- **Riff's host no longer serves relay documents.** `/room-preview/…`
  there answers 404, and a room's preview answers only on that room's
  origin. Riff's service worker (`app/public/riff-sw.js`) also refuses
  every navigation under `/__virtual__/` and `/__preview__/` before
  Nodepod's handler would serve the pod's page there, so no Claude-written
  page can be top-level or framed on Riff's origin even by a typed URL.
- **The frames.** Both roles load the preview origin, sandboxed
  `allow-scripts allow-forms allow-modals allow-same-origin`. Nothing
  measured needed popups or downloads; add them if something does. The
  host's "Open in new tab" opens the preview-origin URL.
- **Headers.** The relay already sends `Cross-Origin-Embedder-Policy:
  require-corp` and `Cross-Origin-Resource-Policy: cross-origin` on every
  response, which is what Riff's cross-origin isolated page needs to frame
  it; checked in Chromium, not by reading.
- **The Origin check.** The relay never checked Origin and still doesn't
  (a page's own form POST carries the preview origin). Riff's API and
  sockets accept only `RIFF_ORIGIN`, so a request from the preview origin
  is refused there; on a preview host they aren't reachable at all.
- **Rewriting stays** for now: the path still carries the room id, key and
  generation, and the relay still rewrites root-relative URLs under it.
  The hostname carrying the room could later remove that.

### What 2a costs the host (measured 8 Nov, before the change)

On the dev server, with Vite 6 in the pod (`npm install vite@6`, about
3 s) on port 5173 and the host's frame at `/__virtual__/…`:

- **Hot reload worked.** Editing `main.js` (with `import.meta.hot.accept`)
  logged `[vite] hot updated: /main.js` and changed the page with no
  reload. Also from a non-localhost hostname, as on live: Vite's socket to
  the page's own host failed (400), then its "direct websocket connection
  fallback" to `127.0.0.1:5173` went through Nodepod's shim.
- **An app's own WebSocket worked when it addressed localhost**
  (`ws://127.0.0.1:4400`), at both hostnames. One built from
  `location.host` worked only on `127.0.0.1`: the shim intercepts
  localhost names only, so on live it went to Riff's server instead.
- Vite 5's CLI doesn't start in Nodepod at all ("Cannot destructure
  property 'createServer'"), unrelated to this.

With 2a the host's frame is cross-origin and goes through the relay,
which has no WebSocket and shares no `BroadcastChannel` with the host
page, so **the host loses hot reload and the app's sockets until 2b**
(edits show on Refresh), plus the round trip on every request.
Participants never had either.

## Consequences

- Storage, cookies and IndexedDB now work in every member's preview, on
  the room's origin.
- The host's preview is slower (every request crosses the server) and has
  no hot reload until 2b.
- The preview origin is a different site from Riff's today
  (`airiff.tech` vs `fly.dev`), so Riff's `SameSite=Lax` session cookie
  isn't sent on a preview's requests either. If Riff itself moves under
  `airiff.tech`, previews become same-site: the cookie stays host-only (no
  `Domain`), but SameSite stops helping, and the Origin checks are what
  remain. Keep Riff's own origin out of `.preview.airiff.tech`; the server
  refuses to start with it there.
- Preview documents still require CORP (or CORS) on their cross-origin
  subresources, as participants' always did and the host's did under
  Nodepod's worker.
- The key is still in the URL (ADR 0006's cost), now on another origin.

## Checks

- `spec/preview-origin.test.ts` (dev and live): one origin per room,
  shared by its members, not the app's and not under it; on a preview host
  `/`, `/api/me`, `/readme/`, an app script, `/index.html`,
  `/riff-sw.js`, sign-in and a POST to `/api/rooms` get 404, and
  `/collaboration`, the rooms watch, terminal and preview-control sockets
  are refused (404) even with the app's Origin; the app's origin and
  another room's origin don't serve the preview, and nothing reaches the
  host's browser from those; the preview origin serves it with COEP and
  CORP and no cookie; a POST to the API from the preview origin with the
  host's credential is refused (403), and so is a socket.
  `spec/permissions.test.ts` checks the member key on the preview origin.
- `npm run test:preview-relay`: the relay serves a room's preview on its
  own label only (not the server's host, another room's label or a
  made-up one).
- `npm run test:preview-origin-browser` (dev): a hostile preview in the
  real room UI, host and participant at 1920×1080 and 390×844: its origin
  is the room's; `parent.document`, `parent.localStorage`, `parent.fetch`
  and `top.location` throw; `document.cookie` is empty; credentialed
  fetches of `/api/github/token/unwrap` and `/api/me` fail (CORS) and
  Riff's socket is refused; its stylesheet, module import and
  `localStorage` work (kept across a Refresh), and so do a form POST and
  a clicked link. Riff's origin refuses `/__virtual__/` and
  `/__preview__/` navigations.
  `npm run test:preview-participant` and `npm run test:preview-browser`
  are updated for the new origin and the worker's refusal.
- Mutations that turned them red: the frame without `allow-same-origin`;
  Riff's worker guard off (Nodepod answered `/__virtual__/` on Riff's
  origin); the relay's label check off; a preview host falling through to
  the app; a preview host's sockets accepted. Equivalent, so not caught on
  its own: dropping the "not a preview host" refusal, since a missing
  label never matches a room's.
- Can't tell apart: whether Riff's session cookie would ride on the
  preview's credentialed fetch (the smoke's host is a guest, and CORS hides
  the answer either way); the server's Origin check and the cookie's
  SameSite cover it.
