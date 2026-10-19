// The who-did-what log (docs/adr/0006): a row in `events` for every action,
// and the same event on stdout as logfmt, so `flyctl logs` reads it live.
// Details are flat scalars (ids, counts, bytes, setting names, reasons),
// never content: prompts and the board can hold secrets.

const EDIT_FLUSH_MS = 10_000;

function logfmtValue(value) {
  const text = String(value);
  return /^[A-Za-z0-9_.:/@+-]+$/.test(text) ? text : JSON.stringify(text);
}

// Who, as the log names them: a GitHub user by login, a guest by name.
// `who` comes from rooms.mjs: { roomId, code, memberId, name, login, role }.
function describe(who) {
  if (!who) return [];
  const parts = [];
  if (who.code) parts.push(["room", who.code]);
  if (who.memberId) parts.push(["member", who.memberId]);
  if (who.login) parts.push(["github", who.login]);
  else if (who.name) parts.push(["guest", who.name]);
  if (who.role) parts.push(["role", who.role]);
  return parts;
}

const COUNTED_AS = { denied: "times", "model.request": "requests" };

export function createAudit({ store, print = (line) => console.log(line), now = () => Date.now() }) {
  const edits = new Map();

  // record(who, action, detail): who may be null (an anonymous denial) or
  // carry only a userId (sign-in).
  function record(who, action, detail = {}) {
    const flat = {};
    for (const [key, value] of Object.entries(detail)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "object") throw new Error(`audit detail ${key} must be a scalar`);
      flat[key] = value;
    }
    store.statements.insertEvent.run(
      now(),
      who?.roomId ?? null,
      who?.memberId ?? null,
      who?.userId ?? null,
      action,
      JSON.stringify(flat),
    );
    // A `who` can outlive a code rotation (a socket keeps the one it
    // connected with), so name the room by its code as it is now.
    const code = who?.roomId ? store.statements.roomById.get(who.roomId)?.code : undefined;
    const named = code && code !== who.code ? { ...who, code } : who;
    const fields = [...describe(named), ["action", action], ...Object.entries(flat)];
    print(`[audit] ${fields.map(([k, v]) => `${k}=${logfmtValue(v)}`).join(" ")}`);
  }

  // Edits arrive many times a second, and so can a forger's refused
  // writes. One line per person, action and ten seconds says who was doing
  // what without drowning the log.
  function tally(who, action, fixed = {}, bytes = 0) {
    const key = `${who?.memberId}:${action}:${JSON.stringify(fixed)}`;
    let entry = edits.get(key);
    if (!entry) {
      entry = { who, action, fixed, updates: 0, bytes: 0 };
      entry.timer = setTimeout(() => flush(key), EDIT_FLUSH_MS);
      entry.timer.unref?.();
      edits.set(key, entry);
    }
    entry.updates += 1;
    entry.bytes += bytes;
  }

  function flush(key) {
    const entry = edits.get(key);
    if (!entry) return;
    edits.delete(key);
    clearTimeout(entry.timer);
    // An edit tally counts updates, a denial tally attempts, a model tally
    // requests.
    const count = COUNTED_AS[entry.action] ?? "updates";
    record(entry.who, entry.action, { ...entry.fixed, [count]: entry.updates, bytes: entry.bytes || undefined });
  }

  function close() {
    for (const key of [...edits.keys()]) flush(key);
  }

  return { record, tally, close };
}
