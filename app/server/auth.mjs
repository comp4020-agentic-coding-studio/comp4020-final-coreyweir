// GitHub sign-in (docs/adr/0005): the OAuth web flow with state and PKCE,
// server-side sessions for GitHub users, and the push token, which the
// server encrypts for the browser to hold and never stores.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { DAY_MS, hashToken, randomToken } from "./store.mjs";
import { clearCookie, cookie, HttpError, parseCookies, readJson, sameOrigin, sendJson, sendText } from "./http.mjs";

export const SESSION_COOKIE = "__Host-riff-session";
const OAUTH_COOKIE = "__Host-oauth";
const SESSION_DAYS = 30;
const OAUTH_MAX_AGE_S = 600;
// Sliding expiry, written at most this often per session.
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const SCOPES = { identity: "", push: "repo" };

const sha256url = (text) => createHash("sha256").update(text).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// `return` must lead back into Riff: a path on our own origin, nothing a
// browser could read as another host ("//evil", "/\evil").
function safeReturn(value, origin) {
  if (value === null || value === undefined || value === "") return "/";
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

export function createAuth({ store, audit, origin, clientId, clientSecret, sessionSecret, fetchImpl = fetch }) {
  const s = store.statements;
  const redirectUri = origin ? `${origin}/auth` : null;

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = createHmac("sha256", sessionSecret).update(`oauth.${body}`).digest("base64url");
    return `${body}.${mac}`;
  }

  function verify(value) {
    if (typeof value !== "string") return null;
    const [body, mac] = value.split(".");
    if (!body || !mac) return null;
    const expected = createHmac("sha256", sessionSecret).update(`oauth.${body}`).digest("base64url");
    if (!safeEqual(mac, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return payload.exp > Date.now() ? payload : null;
    } catch {
      return null;
    }
  }

  // The push token, sealed with a key only this server and this session can
  // derive. The page keeps the ciphertext; signing out or a new secret
  // makes it useless.
  function pushKey(tokenHash) {
    return Buffer.from(hkdfSync("sha256", sessionSecret, tokenHash, "riff push token v1", 32));
  }

  function seal(token, tokenHash) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", pushKey(tokenHash), iv);
    const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
  }

  function unseal(ciphertext, tokenHash) {
    const bytes = Buffer.from(ciphertext, "base64url");
    if (bytes.length < 12 + 16 + 1) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", pushKey(tokenHash), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  // The signed-in GitHub user behind a request, or null. An expired session
  // is simply absent, so nothing depends on the sweeper being on time.
  function session(request, now = Date.now()) {
    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const row = s.sessionByHash.get(tokenHash, now);
    if (!row) return null;
    const user = s.userById.get(row.user_id);
    if (!user) return null;
    let renewed = false;
    if (now - row.last_seen > TOUCH_EVERY_MS) {
      s.touchSession.run(now, now + SESSION_DAYS * DAY_MS, tokenHash);
      renewed = true;
    }
    return { user, tokenHash, token, renewed };
  }

  const sessionCookie = (token) => cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 24 * 60 * 60 });

  function start(request, response, url) {
    const purpose = url.searchParams.get("purpose") ?? "identity";
    const back = safeReturn(url.searchParams.get("return"), origin);
    if (!(purpose in SCOPES) || back === null) return sendText(response, 400, "Bad sign-in request");
    if (!clientId || !sessionSecret || !origin) return sendText(response, 503, "GitHub sign-in isn't set up on this server");

    const state = randomToken();
    const verifier = randomToken();
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", SCOPES[purpose]);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", sha256url(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("allow_signup", "true");
    const flow = sign({ state, verifier, purpose, back, exp: Date.now() + OAUTH_MAX_AGE_S * 1000 });
    response.writeHead(302, {
      location: authorize.href,
      "set-cookie": cookie(OAUTH_COOKIE, flow, { maxAge: OAUTH_MAX_AGE_S }),
      "cache-control": "no-store",
    });
    response.end();
  }

  async function callback(request, response, url) {
    const clear = clearCookie(OAUTH_COOKIE);
    const flow = sessionSecret ? verify(parseCookies(request.headers.cookie).get(OAUTH_COOKIE)) : null;
    const state = url.searchParams.get("state");
    // Checked before anything goes to GitHub: a callback this browser
    // didn't start is someone else's code being pushed onto it.
    if (!flow || !state || !safeEqual(state, flow.state)) {
      audit.record(null, "denied", { what: "sign-in", reason: "bad_state" });
      return sendText(response, 400, "This sign-in link has expired or wasn't started here. Try signing in again.", { "set-cookie": clear });
    }
    if (url.searchParams.get("error")) {
      response.writeHead(303, { location: flow.back, "set-cookie": clear, "cache-control": "no-store" });
      return response.end();
    }
    if (!clientId || !clientSecret) return sendText(response, 503, "GitHub sign-in isn't set up on this server", { "set-cookie": clear });

    const exchange = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: url.searchParams.get("code") ?? "",
        redirect_uri: redirectUri,
        code_verifier: flow.verifier,
      }),
    });
    const grant = exchange.ok ? await exchange.json().catch(() => ({})) : {};
    if (!grant.access_token) {
      audit.record(null, "denied", { what: "sign-in", reason: grant.error ?? `github_${exchange.status}` });
      return sendText(response, 403, "GitHub didn't accept that sign-in. Try again.", { "set-cookie": clear });
    }

    // Who the token belongs to, asked of GitHub with the token itself.
    const me = await fetchImpl("https://api.github.com/user", {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${grant.access_token}`, "user-agent": "riff" },
    });
    if (!me.ok) return sendText(response, 502, "Couldn't reach GitHub. Try again.", { "set-cookie": clear });
    const profile = await me.json();
    const now = Date.now();
    const user = s.upsertUser.get(profile.id, profile.login, profile.avatar_url ?? null, now, now);

    // A new session id at every sign-in; the old one, if any, ends.
    const previous = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (previous) s.deleteSession.run(hashToken(previous));
    const token = randomToken();
    const tokenHash = hashToken(token);
    s.insertSession.run(tokenHash, user.id, now, now, now + SESSION_DAYS * DAY_MS);
    audit.record({ userId: user.id, login: user.login }, "sign-in", { purpose: flow.purpose });

    // The identity token is dropped here. A push token goes back sealed, in
    // the fragment, which never reaches a server or a log.
    let location = flow.back;
    if (flow.purpose === "push") location += `#push=${seal(grant.access_token, tokenHash)}`;
    response.writeHead(303, {
      location,
      "set-cookie": [clear, sessionCookie(token)],
      "cache-control": "no-store",
    });
    response.end();
  }

  // Answers the sign-in routes; false for anything else.
  async function handle(request, response, url) {
    const path = url.pathname;
    if (request.method === "GET" && path === "/auth/github/start") {
      start(request, response, url);
      return true;
    }
    if (request.method === "GET" && path === "/auth") {
      await callback(request, response, url);
      return true;
    }
    if (request.method === "GET" && path === "/api/me") {
      const current = session(request);
      const headers = current?.renewed ? { "set-cookie": sessionCookie(current.token) } : {};
      const user = current ? { id: current.user.id, login: current.user.login, avatarUrl: current.user.avatar_url } : null;
      sendJson(response, 200, { user }, headers);
      return true;
    }
    if (request.method !== "POST" || (path !== "/api/signout" && path !== "/api/github/token/unwrap")) return false;
    if (!sameOrigin(request, origin)) throw new HttpError(403, "cross_origin");
    const current = session(request);
    if (path === "/api/signout") {
      if (current) {
        s.deleteSession.run(current.tokenHash);
        audit.record({ userId: current.user.id, login: current.user.login }, "sign-out");
      }
      sendJson(response, 200, { user: null }, { "set-cookie": clearCookie(SESSION_COOKIE) });
      return true;
    }
    if (!current) throw new HttpError(401, "signed_out");
    const { ciphertext } = await readJson(request);
    const token = typeof ciphertext === "string" ? unseal(ciphertext, current.tokenHash) : null;
    if (!token) throw new HttpError(400, "stale_token");
    sendJson(response, 200, { token });
    return true;
  }

  return { session, handle };
}
