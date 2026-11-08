// The GitHub sign-in callback against a stand-in GitHub, in-process: what
// the log records about each token GitHub grants. The scope GitHub actually
// granted is logged because GitHub decides it, not us: a flow that asks for
// no scope gets every scope the user already granted the app, which puts an
// identity token in the same user/app/scope set as push tokens, where only
// ten live at once (docs/adr/0005, "Why a push token stops working").
//
// npm run test:auth-callback
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/collaboration.mjs";
import { createStore } from "../server/store.mjs";
import { createAudit } from "../server/audit.mjs";
import { createAuth } from "../server/auth.mjs";

async function start(github) {
  const dir = mkdtempSync(join(tmpdir(), "riff-auth-"));
  const db = openDatabase(join(dir, "riff.sqlite"));
  const store = createStore(db);
  const audit = createAudit({ store, print: () => {} });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    return github(String(url), init);
  };
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = createAuth({ store, audit, origin, clientId: "client-id", clientSecret: "client-secret", sessionSecret: "test-secret", fetchImpl });
  server.on("request", async (request, response) => {
    if (!(await auth.handle(request, response, new URL(request.url, origin)))) {
      response.statusCode = 404;
      response.end();
    }
  });
  return {
    origin,
    calls,
    events: (action) => db.prepare("SELECT detail_json FROM events WHERE action = ? ORDER BY seq").all(action).map((row) => JSON.parse(row.detail_json)),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// One sign-in, the way a browser does it: start, then GitHub's redirect back.
async function signIn(app, purpose) {
  const started = await fetch(`${app.origin}/auth/github/start?purpose=${purpose}&return=/`, { redirect: "manual" });
  assert.equal(started.status, 302);
  const state = new URL(started.headers.get("location")).searchParams.get("state");
  const cookie = started.headers.get("set-cookie").split(";")[0];
  return fetch(`${app.origin}/auth?code=the-code&state=${state}`, { redirect: "manual", headers: { cookie } });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the sign-in log records the scope GitHub granted, for identity and push", async () => {
  let granted = "";
  const app = await start((url) => {
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: `gho_${granted || "none"}`, scope: granted, token_type: "bearer" });
    if (url === "https://api.github.com/user") return json({ id: 42, login: "wren", avatar_url: null });
    return json({ message: "Not Found" }, 404);
  });
  try {
    // An identity sign-in from a user who once granted `repo` gets `repo`.
    granted = "repo";
    assert.equal((await signIn(app, "identity")).status, 303);
    granted = "repo";
    assert.equal((await signIn(app, "push")).status, 303);
    granted = "";
    assert.equal((await signIn(app, "identity")).status, 303);
    assert.deepEqual(app.events("sign-in"), [
      { purpose: "identity", scope: "repo" },
      { purpose: "push", scope: "repo" },
      { purpose: "identity", scope: "" },
    ]);
  } finally {
    await app.close();
  }
});
