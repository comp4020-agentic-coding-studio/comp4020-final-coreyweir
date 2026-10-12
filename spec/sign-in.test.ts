import { describe, expect, inject, it } from "vitest";
import { api, originOf } from "./riff";

// GitHub sign-in is the OAuth web flow with state and PKCE (ADR 0005). These
// checks stop at GitHub's door: what Riff sends there, and what it does with
// a callback it didn't start. A completed sign-in needs a real GitHub
// account at a real browser, so that half is checked by hand.
//
// The app must be told its own origin (RIFF_ORIGIN) and the OAuth app's
// client id (GITHUB_CLIENT_ID); CI passes both to the container.
const baseUrl = inject("baseUrl");

function start(query: string) {
  return api(baseUrl, `/auth/github/start?${query}`);
}

function cookieNamed(res: Response, name: string) {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

describe("starting a sign-in", () => {
  it("sends you to GitHub with state, PKCE and our exact callback, asking for nothing", async () => {
    const res = await start("purpose=identity&return=/");
    expect(res.status).toBe(302);

    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    const q = to.searchParams;
    expect(q.get("client_id")).toBeTruthy();
    // built from the configured origin, never the request's Host header
    expect(q.get("redirect_uri")).toBe(`${originOf(baseUrl)}/auth`);
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope") ?? "").toBe("");

    const cookie = cookieNamed(res, "__Host-oauth");
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Path=\/(;|$)/i);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    // the verifier stays on our side; GitHub only ever sees its hash
    expect(cookie).not.toContain(q.get("code_challenge"));
  });

  it("uses a fresh state every time", async () => {
    const [a, b] = await Promise.all([start("purpose=identity&return=/"), start("purpose=identity&return=/")]);
    const state = (res: Response) => new URL(res.headers.get("location") ?? "").searchParams.get("state");
    expect(state(a)).not.toBe(state(b));
  });

  it("asks for repo access only when connecting for pushing", async () => {
    const res = await start("purpose=push&return=/");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("scope")).toBe("repo");
  });

  it("won't send you anywhere but back to Riff afterwards", async () => {
    for (const away of ["https://evil.example/", "//evil.example/", "/\\evil.example"]) {
      expect((await start(`purpose=identity&return=${encodeURIComponent(away)}`)).status).toBe(400);
    }
    expect((await start("purpose=admin&return=/")).status).toBe(400);
  });
});

// A bad state is a 400, answered before Riff contacts GitHub. GitHub turning
// down the code is a 403, and an app with no client secret a 503, so the
// rejections below can't pass because of something further along.
describe("the callback", () => {
  it("gets past the state check when the state is right (the control for the checks below)", async () => {
    const started = await start("purpose=identity&return=/");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
    const oauth = cookieNamed(started, "__Host-oauth")!.split(";")[0];

    const res = await api(baseUrl, `/auth?code=not-a-real-code&state=${state}`, { cookie: oauth });
    expect([403, 503]).toContain(res.status);
    expect(cookieNamed(res, "__Host-riff-session")).toBeUndefined();
  });

  it("rejects a callback whose state doesn't match the one it set, and starts no session", async () => {
    const started = await start("purpose=identity&return=/");
    const oauth = cookieNamed(started, "__Host-oauth")!.split(";")[0];

    const forged = await api(baseUrl, "/auth?code=anything&state=not-the-state", { cookie: oauth });
    expect(forged.status).toBe(400);
    expect(cookieNamed(forged, "__Host-riff-session")).toBeUndefined();
  });

  it("rejects a callback it never started", async () => {
    const res = await api(baseUrl, "/auth?code=anything&state=anything");
    expect(res.status).toBe(400);
    expect(cookieNamed(res, "__Host-riff-session")).toBeUndefined();
  });

  it("rejects a tampered state cookie", async () => {
    const started = await start("purpose=identity&return=/");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
    const oauth = cookieNamed(started, "__Host-oauth")!.split(";")[0];
    const tampered = oauth.slice(0, -2) + (oauth.endsWith("AA") ? "BB" : "AA");

    const res = await api(baseUrl, `/auth?code=anything&state=${state}`, { cookie: tampered });
    expect(res.status).toBe(400);
    expect(cookieNamed(res, "__Host-riff-session")).toBeUndefined();
  });
});

describe("who am I", () => {
  it("is nobody without a session, or with a made-up one", async () => {
    for (const cookie of [undefined, "__Host-riff-session=made-up"]) {
      const res = await api(baseUrl, "/api/me", { cookie });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: null });
    }
  });
});
