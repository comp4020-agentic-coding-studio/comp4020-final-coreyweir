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
  const response = await fetch(request.url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
    mode: "cors",
    credentials: "omit",
    redirect: request.redirect,
    referrerPolicy: "no-referrer",
    signal: request.signal,
  });
  // The endpoint refused the real value (expired or revoked). Tell the host's
  // page, which owns it, so the host hears it from Riff and not only as a
  // failing command in the terminal. Only the placeholder goes out.
  if (response.status === 401) void tellRefused(placeholders);
  return response;
}

async function tellRefused(placeholders) {
  const pages = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(isRiffPage);
  for (const page of pages) page.postMessage({ type: "riff-credential-refused", placeholders });
}

self.addEventListener("message", (event) => {
  // A host tab that stops (dispose, sign-out) drops its values here too, and
  // so does one whose value changed (GitHub reconnected): the next request
  // asks the page again. The reply says the old value is gone.
  if (event.data?.type !== "riff-credential-forget") return;
  event.stopImmediatePropagation();
  for (const placeholder of event.data.placeholders ?? []) credentials.delete(placeholder);
  event.ports[0]?.postMessage(true);
});

// Registered before Nodepod's handler, so it runs first. Requests without a
// placeholder fall through untouched.
self.addEventListener("fetch", (event) => {
  const placeholders = placeholdersIn(event.request.headers);
  if (placeholders.length === 0) return;
  event.stopImmediatePropagation();
  event.respondWith(forward(event.request, placeholders));
});

// A page Claude wrote never runs as a document on Riff's origin, where it
// could read the host's stored tokens, reach the host page and act as the
// host (docs/adr/0011). Nodepod's worker would serve one to a navigation
// under /__virtual__/ or /__preview__/, and to a frame navigating to a path
// a preview claimed; Riff frames previews from their own origin instead,
// so no navigation here is handed to the pod. Registered before Nodepod's
// handler, so it runs first.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.stopImmediatePropagation();
  if (/^\/__(?:virtual|preview)__\//.test(new URL(event.request.url).pathname)) {
    event.respondWith(new Response("Previews open on their own origin.", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // or Riff's isolated page shows Chrome's error page instead
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
      },
    }));
  }
  // Anything else goes to the network, as if no worker were here.
});

importScripts("/__sw__.js");
