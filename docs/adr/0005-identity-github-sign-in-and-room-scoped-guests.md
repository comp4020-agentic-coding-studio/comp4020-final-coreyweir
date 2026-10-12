# 5. Identity: GitHub sign-in, and guests who exist only in their room

- Status: accepted, implemented 2026-10-12 except the push token in the client (see "Implementation" below)
- Date: 2026-10-12

## Context

Today the server can't tell anyone apart. A name is whatever a browser puts
in its awareness state. The facilitator is whoever opens the room with
`?host=1`. The terminal and preview relays trust whichever connection
claims the host capability first. Crit 10 needs the server to tell people
apart, check what each may do (ADR 0006), and log who did what.

Two things pull against each other:

- **Joining takes a name and a room code, nothing more** (README, ease of
  use). People in rotating crit groups won't all sign in, and they
  shouldn't have to.
- **Some features need a durable identity:** inviting a colleague by GitHub
  username, "boards you've been in" across devices, and pushing to GitHub
  as the host.

GitHub is the identity everyone in the course already has, and hosts need
it to push anyway. The device flow (`app/server/githubDeviceProxy.mjs`)
already gets a token into the page. Since `43f34f6` it uses Riff's own OAuth
app rather than GitHub CLI's client id. The course org's approval of that
app is pending; pulling from org repos already works.

## Options

1. **Guests as global users.** Every visitor gets a `users` row and a
   session cookie, signed in or not.
2. **Names only.** Guests have no credential; names are unique among the
   people connected right now.
3. **GitHub users are global; guests exist only inside the room they
   joined,** with a credential that works only there.

## Decision

**3.**

### GitHub users

- `users(id, github_id UNIQUE, login, avatar_url, created_at, last_seen)`.
  A row exists only after a completed GitHub sign-in.
- `sessions(token_hash PK, user_id, created_at, last_seen, expires_at)`.
  - The cookie is `__Host-riff-session`, 32 random bytes, `Secure`,
    `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 days sliding. `__Host-` is the
    browser-enforced prefix: the cookie is locked to our exact hostname and
    can't be set over plain http.
  - The table holds a hash of the cookie, so a leaked database doesn't leak
    sessions, and signing out really ends one.
  - Every sign-in issues a new session id.
- **Sign-in is the OAuth web flow, not the device flow.**
  - `GET /auth/github/start?purpose=identity|push&return=…` creates a
    `state` and a PKCE verifier. It keeps them in a signed `__Host-oauth`
    cookie (10 minutes, `SESSION_SECRET`), then redirects to GitHub.
  - `redirect_uri` is always sent explicitly, built from `RIFF_ORIGIN`
    (`https://comp4020-final-coreyweir.fly.dev`, or `http://127.0.0.1:8093`
    in dev), never from the request's Host header.
  - `GET /auth` checks `state` in constant time and exchanges the code
    (client secret, verifier, `redirect_uri`). It reads `GET /user` with the
    new token, upserts the user and starts a session.
  - Identity sign-in asks for no scopes, and its token is discarded.
- **Pushing is a second, explicit grant.** "Connect GitHub for pushing" in
  host setup runs the same flow with `repo` scope.
  - The server encrypts that token (AES-GCM) with a key derived from
    `SESSION_SECRET` and the session id. The page keeps only the ciphertext,
    in localStorage.
  - `POST /api/github/token/unwrap` returns the token to that session.
  - The server never stores the token.

### Guests

- **No `users` row.** Joining a room creates a `room_members` row (schema in
  ADR 0006) with a random secret. The browser keeps it in localStorage under
  `riff-member:<roomId>`. The server stores only its hash.
- **The secret travels the way the host capability does today:** as the
  Hocuspocus `token`, and in the relays' hello message.
- **Names are unique within a room,** compared case-insensitively after
  NFKC normalisation. A name held by a member who has disconnected can't be
  taken without that member's secret.
- **Guests can host.** Hosting is tied to the guest's secret, so it doesn't
  follow them to another browser.

### Around both

- **Every WebSocket upgrade and every POST must carry an Origin header that
  matches `RIFF_ORIGIN`.** Browsers send cookies when a page on another site
  opens a WebSocket to ours, so without this check another site could act
  with a visitor's session.
- **A sweeper** runs at startup and hourly. It deletes expired sessions,
  and later does ADR 0003's pruning. Lookups also treat an expired session as
  missing, so nothing depends on the sweeper running on time.

## Consequences

- **The log can name everyone:** a GitHub user by login, a guest by member
  id and name within the room. ADR 0006 defines the log.
- **Rows grow only with real use.** Test runs and junk joins create member
  rows in rooms that get pruned, not global users. Room creation and joining
  are rate-limited per IP, because rooms are the one thing anyone can
  create.
- **A guest who clears their storage, or switches browser, is a new guest.**
  They join under a new name.
- **Losing the push token is cheap.** After a sign-out, an expired session
  or a reload in another browser, the host clicks "Connect GitHub" again.
  GitHub skips the consent screen for an app it has already approved, so
  it's one redirect.
- **Code running on our own origin can still get the push token** by
  calling unwrap with the host's cookie. Storing plaintext would have handed
  it the token directly. The host's preview frame is such code: Claude
  writes it, and it isn't sandboxed (`App.tsx:214`). That risk is accepted
  for now; it's in PLAN.md's open questions. The token also reaches the
  guest's environment until the API proxy (PLAN P1.6) keeps it out.
- **Old rooms aren't migrated.** Links to `riff-<code>` documents get a
  "this room predates sign-in" page.
- **Two flows until the web flow covers pushing.** Then the device flow and
  `githubDeviceProxy.mjs` go.

## The case for the options we didn't pick

**Guests as global users.** "One kind of identity is simpler, and every
guest gets a session like everyone else." Our answer: a guest's identity
only has to mean something inside one room. Global rows for every visit
fill the database with people who never come back, and give anyone a cheap
way to make it grow. The secret already exists per room (the host
capability works this way today), so the room-scoped version adds less than
the global one.

**Names only.** "Just make names unique per room; that's already enough to
tell guests apart." Our answer: it's enough for one moment, not for a log.
If Ada leaves and someone else joins as Ada, the log can't tell the two
apart. The room-scoped secret is what makes the name hers.

**Plaintext token in localStorage.** "The page needs it anyway, and an
attacker on our origin gets it either way." Our answer: true for code on our
origin. But the ciphertext dies with the session, while a plaintext token
in localStorage lives until someone revokes it on GitHub. The encryption
costs one endpoint.

**Token stored on the server.** "Then the host never reconnects." Our
answer: the server would hold push access to every host's repositories,
which is the worst thing a breach of this server could leak.

## Implementation (2026-10-12)

Server in `389ffff` (`app/server/store.mjs`, `auth.mjs`, `rooms.mjs`,
assembled by `riff.mjs`), client in `4acb32b` (`app/src/api.ts`, the
landing page in `App.tsx`). Where it differs from the plan above, or stops
short of it:

- **The push token is sealed but not yet used.** `/auth/github/start?purpose=push`
  asks for `repo`, and the callback returns the token AES-GCM-sealed (key by
  HKDF from `SESSION_SECRET` and the session's hash) in the URL fragment,
  `#push=…`, which never reaches a server or a log. `POST
  /api/github/token/unwrap` opens it for that session only. The host page
  doesn't read the fragment yet: pushing still goes through the device flow
  (`githubDeviceProxy.mjs`, on our own client id), which stays until it does.
- **`events` has a `user_id` column** beside `member_id`, because sign-in
  and sign-out happen outside any room.
- **Names stay taken after removal.** `UNIQUE (room_id, name_key)` covers
  removed members too, so the log's names stay unambiguous within a room.
- **A signed-in member who joins again gets their existing membership**
  back (200, not 201), whatever name they type.
- **Checked:** `spec/sign-in.test.ts` (the redirect's parameters, the
  signed state cookie, open-redirect `return` values, a bad, missing or
  tampered state rejected before GitHub is contacted) against the live app;
  turning the state check off turns three of them red. **Not checked from
  outside:** the path of a real GitHub user, which needs a real sign-in.

