// Colleagues (docs/adr/0008), for signed-in users only:
// - "recently worked together": GitHub users who were in a room with you,
//   worked out from room_members, so it fades as old rooms are pruned;
// - "colleagues": people you chose to keep. Private and one-way: adding
//   someone tells them nothing, and grants nothing (an invite still does
//   that). Logged, like everything else people do here.
import { GITHUB_LOGIN } from "./rooms.mjs";
import { HttpError, readJson, sameOrigin, sendJson } from "./http.mjs";

const listed = (row) => ({ githubId: row.github_id, login: row.login, avatarUrl: row.avatar_url ?? null });

export function createColleagues({ store, auth, audit, origin, githubLookup }) {
  const s = store.statements;

  function signedIn(request, what) {
    const current = auth.session(request);
    if (!current) {
      audit.record(null, "denied", { what, reason: "signed_out" });
      throw new HttpError(401, "signed_out");
    }
    return { userId: current.user.id, login: current.user.login };
  }

  function list(request, response) {
    const actor = signedIn(request, "colleagues.list");
    const colleagues = s.colleagues.all(actor.userId).map(listed);
    const kept = new Set(colleagues.map((row) => row.githubId));
    const recent = s.recentlyWorkedWith
      .all(actor.userId)
      .map((row) => ({ ...listed(row), lastRoomAt: row.last_room_at, colleague: kept.has(row.github_id) }));
    sendJson(response, 200, { colleagues, recent });
  }

  async function add(request, response) {
    const actor = signedIn(request, "colleague.add");
    const body = await readJson(request);
    const login = typeof body.login === "string" ? body.login.trim().replace(/^@/, "") : "";
    if (!GITHUB_LOGIN.test(login)) throw new HttpError(400, "bad_login");
    let account;
    try {
      account = await githubLookup(login);
    } catch (error) {
      console.error("[riff] GitHub user lookup failed", error);
      throw new HttpError(502, "github_unreachable");
    }
    if (!account) throw new HttpError(404, "no_such_github_user");
    const self = s.userById.get(actor.userId);
    if (account.id === self.github_id) throw new HttpError(400, "that_is_you");
    s.insertColleague.run(actor.userId, account.id, account.login, account.avatarUrl, Date.now());
    audit.record(actor, "colleague.add", { colleague: account.login, colleague_id: account.id });
    sendJson(response, 200, { colleague: { githubId: account.id, login: account.login, avatarUrl: account.avatarUrl } });
  }

  function remove(request, response, githubId) {
    const actor = signedIn(request, "colleague.remove");
    const row = s.colleagues.all(actor.userId).find((entry) => entry.github_id === githubId);
    if (!row) throw new HttpError(404, "no_such_colleague");
    s.deleteColleague.run(actor.userId, githubId);
    audit.record(actor, "colleague.remove", { colleague: row.login, colleague_id: githubId });
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  // Answers /api/me/colleagues…; false for anything else.
  async function handle(request, response, url) {
    const path = url.pathname;
    if (path !== "/api/me/colleagues" && !path.startsWith("/api/me/colleagues/")) return false;
    if (request.method !== "GET" && !sameOrigin(request, origin)) {
      audit.record(null, "denied", { what: "api", reason: "cross_origin" });
      throw new HttpError(403, "cross_origin");
    }
    let m;
    if (request.method === "GET" && path === "/api/me/colleagues") list(request, response);
    else if (request.method === "POST" && path === "/api/me/colleagues") await add(request, response);
    else if (request.method === "DELETE" && (m = /^\/api\/me\/colleagues\/(\d+)$/.exec(path))) remove(request, response, Number(m[1]));
    else throw new HttpError(404, "not_found");
    return true;
  }

  return { handle };
}
