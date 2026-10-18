// The host page's half of keeping credentials out of the guest
// (docs/adr/0007). The guest gets a placeholder; `public/riff-sw.js` swaps
// it for the real value on requests to the credential's own origins, asking
// this page for the value over a channel only the service worker can open.

export type Credential = {
  /** What the guest sees, e.g. in `env`. Random per boot. */
  placeholder: string;
  value: string;
  /** The only origins the real value is ever sent to. */
  origins: string[];
};

export const GITHUB_ORIGINS = ["https://api.github.com", "https://github.com", "https://uploads.github.com"];

export function makePlaceholder(kind: "model" | "github") {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `riff-placeholder-${kind}-${hex}`;
}

export function credentialFor(kind: "model" | "github", value: string, origins: string[]): Credential {
  return { placeholder: makePlaceholder(kind), value, origins };
}

/**
 * Answer the service worker's requests for these credentials until the
 * returned function is called. Only the service worker can post to
 * `navigator.serviceWorker`'s message event, so guest code (workers, preview
 * iframes) can't ask.
 */
export function serveCredentials(credentials: Credential[]): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const byPlaceholder = new Map(credentials.map((credential) => [credential.placeholder, credential]));
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type !== "riff-credential-request") return;
    const port = event.ports[0];
    if (!port) return;
    const credential = byPlaceholder.get(event.data.placeholder);
    port.postMessage(credential ? { value: credential.value, origins: credential.origins } : null);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => {
    navigator.serviceWorker.removeEventListener("message", onMessage);
    navigator.serviceWorker.controller?.postMessage({
      type: "riff-credential-forget",
      placeholders: [...byPlaceholder.keys()],
    });
  };
}
