import { expect, inject, it } from "vitest";

// Headers the host's browser depends on, checked on the page and on a script
// it loads (workers take their policy from their own response, not the page's).
//
// - COOP + COEP make the page cross-origin isolated. Without them there's no
//   SharedArrayBuffer and the host can't start Claude Code.
// - CSP `upgrade-insecure-requests` lets the guest's plain-http requests
//   through: the network gateway re-issues them with the page's fetch(), and
//   an https page blocks plain-http fetches as mixed content. With the
//   directive, the browser sends them over https instead.
//
// What this can't tell apart: a header being present from the browser acting
// on it. The upgrade itself was checked in Chromium against the live origin
// (httpbin reported serving https:// for an http:// fetch).
const baseUrl = inject("baseUrl");

async function headersOf(path: string): Promise<Headers> {
  const res = await fetch(new URL(path, baseUrl));
  expect(res.status, path).toBe(200);
  return res.headers;
}

async function aScriptPath(): Promise<string> {
  const html = await (await fetch(new URL("/", baseUrl))).text();
  const src = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  expect(src, "no script tag on /").toBeTruthy();
  return src!;
}

for (const [label, path] of [
  ["the page", async () => "/"],
  ["a room link", async () => "/?room=spec-headers"],
  ["a script it loads", aScriptPath],
] as const) {
  it(`${label} is cross-origin isolated and upgrades insecure requests`, async () => {
    const headers = await headersOf(await path());
    expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(headers.get("content-security-policy") ?? "").toMatch(/(^|;)\s*upgrade-insecure-requests\s*(;|$)/);
  });
}
