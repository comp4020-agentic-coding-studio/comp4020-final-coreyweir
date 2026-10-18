// Riff's service worker: Nodepod's, plus one job of its own.
//
// The host's model token and GitHub token never enter the guest (Claude
// Code, its shells, their environment and files). The guest holds
// placeholders instead (`riff-placeholder-<kind>-<hex>`), and every request
// that leaves this origin's pages and workers passes through here. When a
// request carries a placeholder, this worker swaps in the real value, but
// only for the origins that credential belongs to, and fetches it itself.
// The response streams straight back, so Claude's streamed replies stay
// streamed.
//
// The real values live in the host's page. This worker asks for one the
// first time it sees its placeholder, and only asks top-level Riff pages
// (never a preview of the guest's own dev server), over a MessageChannel it
// opens itself. It never sends a value anywhere but upstream. A browser can
// stop an idle service worker at any time, which empties the cache below;
// the next request just asks again.
//
// See docs/adr/0007-credentials-stay-in-the-tab.md.

const PLACEHOLDER = /riff-placeholder-[a-z]+-[0-9a-f]{32}/g;
const ASK_TIMEOUT_MS = 3000;

/** placeholder -> { value, origins: Set<string> } */
const credentials = new Map();

function isRiffPage(client) {
  if (client.type !== "window" || client.frameType !== "top-level") return false;
  try {
    const url = new URL(client.url);
    return url.origin === self.location.origin && !/^\/__(virtual|preview)__\//.test(url.pathname);
  } catch {
    return false;
  }
}

async function ask(placeholder) {
  const pages = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(isRiffPage);
  const answers = pages.map((page) => new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      const answer = event.data;
      if (answer && typeof answer.value === "string" && Array.isArray(answer.origins)) {
        resolve({ value: answer.value, origins: new Set(answer.origins) });
      } else {
        resolve(null);
      }
    };
    page.postMessage({ type: "riff-credential-request", placeholder }, [channel.port2]);
  }));
  for (const answer of await Promise.all(answers)) {
    if (answer) {
      credentials.set(placeholder, answer);
      return answer;
    }
  }
  return null;
}

/** Header values, with HTTP Basic credentials decoded (git puts the token in the password). */
function placeholdersIn(headers) {
  const found = new Set();
  for (const [, value] of headers) {
    for (const match of value.matchAll(PLACEHOLDER)) found.add(match[0]);
    const basic = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(value);
    if (basic) {
      let decoded = "";
      try { decoded = atob(basic[1]); } catch { /* not base64 */ }
      for (const match of decoded.matchAll(PLACEHOLDER)) found.add(match[0]);
    }
  }
  return [...found];
}

function substitute(value, swaps) {
  let next = value;
  for (const [placeholder, real] of swaps) next = next.split(placeholder).join(real);
  const basic = /^(basic\s+)([A-Za-z0-9+/=]+)\s*$/i.exec(next);
  if (basic) {
    try {
      const decoded = atob(basic[2]);
      let swapped = decoded;
      for (const [placeholder, real] of swaps) swapped = swapped.split(placeholder).join(real);
      if (swapped !== decoded) next = basic[1] + btoa(swapped);
    } catch { /* not base64 */ }
  }
  return next;
}

function refuse(status, error, message) {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function forward(request, placeholders) {
  const origin = new URL(request.url).origin;
  const swaps = [];
  for (const placeholder of placeholders) {
    const credential = credentials.get(placeholder) ?? await ask(placeholder);
    if (!credential) {
      return refuse(401, "riff_credential_unavailable",
        "Riff: the page that owns this credential isn't open, so the request wasn't sent.");
    }
    if (!credential.origins.has(origin)) {
      return refuse(403, "riff_credential_wrong_origin",
        `Riff: this credential is only sent to ${[...credential.origins].join(", ")}.`);
    }
    swaps.push([placeholder, credential.value]);
  }
  const headers = new Headers();
  for (const [name, value] of request.headers) headers.set(name, substitute(value, swaps));
  const method = request.method.toUpperCase();
  return fetch(request.url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
    mode: "cors",
    credentials: "omit",
    redirect: request.redirect,
    referrerPolicy: "no-referrer",
    signal: request.signal,
  });
}

self.addEventListener("message", (event) => {
  // A host tab that stops (dispose, sign-out) drops its values here too.
  if (event.data?.type !== "riff-credential-forget") return;
  event.stopImmediatePropagation();
  for (const placeholder of event.data.placeholders ?? []) credentials.delete(placeholder);
});

// Registered before Nodepod's handler, so it runs first. Requests without a
// placeholder fall through untouched.
self.addEventListener("fetch", (event) => {
  const placeholders = placeholdersIn(event.request.headers);
  if (placeholders.length === 0) return;
  event.stopImmediatePropagation();
  event.respondWith(forward(event.request, placeholders));
});

importScripts("/__sw__.js");
