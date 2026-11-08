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
 * Give a served credential a new value (GitHub reconnected after a refusal).
 * The guest keeps its placeholder; the service worker forgets the value it
 * cached, so its next request asks the page and gets this one. Resolves once
 * the worker says the old value is gone (or there is no worker to have it).
 */
export async function replaceCredential(credential: Credential, value: string): Promise<void> {
  credential.value = value;
  const worker = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null;
  if (!worker) return;
  const channel = new MessageChannel();
  const forgotten = new Promise<void>((resolve) => {
    channel.port1.onmessage = () => resolve();
    // A worker that was stopped has no cache left to clear, and a stopped
    // worker wakes for this message anyway; the timer only bounds a hang.
    setTimeout(resolve, 2000);
  });
  worker.postMessage({ type: "riff-credential-forget", placeholders: [credential.placeholder] }, [channel.port2]);
  await forgotten;
  channel.port1.close();
}

/**
 * Answer the service worker's requests for these credentials until the
 * returned function is called. Only the service worker can post to
 * `navigator.serviceWorker`'s message event, so guest code (workers, preview
 * iframes) can't ask.
 */
export function serveCredentials(credentials: Credential[], onRefused?: (credential: Credential) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  const byPlaceholder = new Map(credentials.map((credential) => [credential.placeholder, credential]));
  const onMessage = (event: MessageEvent) => {
    // The service worker saw the endpoint answer 401 to a real value.
    if (event.data?.type === "riff-credential-refused") {
      for (const placeholder of event.data.placeholders ?? []) {
        const credential = byPlaceholder.get(placeholder);
        if (credential) onRefused?.(credential);
      }
      return;
    }
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
