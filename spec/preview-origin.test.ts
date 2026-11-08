import { describe, expect, inject, it } from "vitest";
import { api, createRoom, joinRoom, originOf, servePreview, upgradeStatus } from "./riff";

// ADR 0011: a room's preview is served from its own origin, never Riff's.
// The preview is a page Claude wrote; on Riff's origin it could read the
// host's stored tokens, reach the host's page and call the API as them.
//
// What these can't tell apart: what a browser does with the headers (that
// the frame loads in Riff's isolated page, that storage works in it, that
// it can't reach its parent). `npm run test:preview-origin-browser` (in
// app/) checks those in Chromium.
const baseUrl = inject("baseUrl");

const page = '<html><head></head><body><a href="/next">next</a></body></html>';

describe("the preview's own origin", () => {
  it("is one per room, shared by its members, and not the app's", async () => {
    const host = await createRoom(baseUrl);
    const guest = await joinRoom(baseUrl, host.code);
    const other = await createRoom(baseUrl);
    const origin = new URL(host.previewOrigin);

    expect(host.previewOrigin).toBe(origin.origin);
    expect(guest.previewOrigin).toBe(host.previewOrigin);
    expect(other.previewOrigin).not.toBe(host.previewOrigin);
    expect(origin.origin).not.toBe(originOf(baseUrl));
    // a DNS label: lowercase, and not the (case-sensitive) room id
    const label = origin.hostname.split(".")[0];
    expect(label).toMatch(/^[a-z0-9]{1,63}$/);
    expect(label).not.toBe(host.roomId.toLowerCase());
    // not under the app's host, so it can't share the app's cookies
    expect(origin.hostname.endsWith(`.${new URL(baseUrl).hostname}`)).toBe(false);
  });

  it("serves the relay and nothing of the app's", async () => {
    const host = await createRoom(baseUrl);
    const html = await (await fetch(new URL("/", baseUrl))).text();
    const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    expect(script, "no script tag on /").toBeTruthy();
    // each of these answers on the app's origin...
    for (const path of ["/", "/api/me", script!]) {
      expect((await fetch(new URL(path, baseUrl))).status, `app ${path}`).toBe(200);
    }
    // ...and is refused on the preview's
    for (const path of ["/", "/api/me", "/readme/", script!, "/index.html", "/riff-sw.js", "/auth/github/start"]) {
      const res = await fetch(new URL(path, host.previewOrigin), { redirect: "manual" });
      expect(res.status, `preview ${path}`).toBe(404);
      expect(await res.text(), `preview ${path}`).not.toMatch(/<html|riff/i);
    }
    const create = await fetch(new URL("/api/rooms", host.previewOrigin), {
      method: "POST",
      headers: { origin: host.previewOrigin, "content-type": "application/json" },
      body: JSON.stringify({ name: "from-preview" }),
    });
    expect(create.status).toBe(404);
    // and no socket of the app's opens there, even with the app's Origin
    for (const path of ["/collaboration", "/api/rooms/watch", `/terminal/${host.roomId}`, `/preview-control/${host.roomId}`]) {
      expect(await upgradeStatus(host.previewOrigin, originOf(baseUrl), path), `socket ${path}`).toBe(404);
    }
  }, 30_000);

  it("is the only place the preview answers", async () => {
    const host = await createRoom(baseUrl);
    const other = await createRoom(baseUrl);
    const preview = await servePreview(baseUrl, host, page);
    try {
      const path = `/room-preview/${host.roomId}/${host.previewKey}/${preview.generation}/`;
      // the app's origin never serves a preview document, nor another room's origin
      const onApp = await fetch(new URL(path, baseUrl));
      expect(onApp.status).toBe(404);
      expect(await onApp.text()).not.toContain("next");
      expect((await fetch(new URL(path, other.previewOrigin))).status).toBe(404);
      expect(preview.requests).toEqual([]);

      const res = await fetch(new URL(path, host.previewOrigin));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`href="${path}next"`);
      // what lets Riff's cross-origin isolated page frame it
      expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(preview.requests).toEqual(["/"]);
    } finally {
      preview.close();
    }
  }, 30_000);

  it("serves the host's pod bridge on the preview origin only (ADR 0011, 2b)", async () => {
    const host = await createRoom(baseUrl);
    const worker = await fetch(new URL("/__riff_preview__/sw.js", host.previewOrigin));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(worker.headers.get("set-cookie")).toBeNull();
    expect(await worker.text()).toContain("riff-port");
    // never on the app's origin, where a worker would control Riff itself
    for (const path of ["/__riff_preview__/sw.js", "/__riff_preview__/host.html", "/__riff_preview__/helper.js"]) {
      const onApp = await fetch(new URL(path, baseUrl));
      expect(await onApp.text(), path).not.toContain("riff-port");
    }
  });

  it("can't act as anyone on the app's API", async () => {
    const host = await createRoom(baseUrl);
    // a page on the preview origin posting to the app with the host's
    // credential is refused for its Origin
    const res = await api(baseUrl, `/api/rooms/${host.roomId}/code`, { method: "POST", body: {}, secret: host.secret, origin: host.previewOrigin });
    expect(res.status).toBe(403);
    expect(await upgradeStatus(baseUrl, host.previewOrigin)).toBe(403);
  });
});
