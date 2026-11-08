import { createHmac } from "node:crypto";

// Every room's preview lives on its own origin (docs/adr/0011): a hostname
// made from the template RIFF_PREVIEW_ORIGIN, e.g.
// `https://{room}.preview.airiff.tech`, so a page Claude wrote never runs
// on Riff's origin, and one room's preview can't read another's storage.
//
// The label is a MAC over the room id, not the id itself: room ids are
// case-sensitive base64url (not a DNS label), and a hostname travels in the
// clear (DNS, SNI), where the room id has no business being. The member's
// preview key in the path stays the credential (docs/adr/0006); the label
// only says which room the origin belongs to.
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const LABEL_LENGTH = 20; // 100 bits

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Development's default: Chrome resolves every *.localhost name to
// loopback and treats it as a secure context, and it is a different site
// from 127.0.0.1, where the dev server's Riff page lives.
export function devPreviewTemplate(origin) {
  const url = new URL(origin);
  return `${url.protocol}//{room}.preview.localhost${url.port ? `:${url.port}` : ""}`;
}

export function createPreviewOrigins({ template, secret, riffOrigin }) {
  if (typeof template !== "string" || !template) throw new Error("createPreviewOrigins needs a template");
  if (!secret) throw new Error("createPreviewOrigins needs a secret");
  const match = /^(https?):\/\/\{room\}\.([a-z0-9.-]+(?::\d+)?)$/i.exec(template);
  if (!match) throw new Error(`RIFF_PREVIEW_ORIGIN must look like https://{room}.preview.example.com, not ${template}`);
  const [, scheme, parentHost] = match;
  const parent = parentHost.toLowerCase();
  if (riffOrigin && new URL(riffOrigin).host.toLowerCase().endsWith(`.${parent}`)) {
    throw new Error("Riff's own origin can't sit under the preview domain");
  }
  // Any single label under the parent is a preview host, so a mistyped or
  // made-up label is refused like a wrong one, never served as Riff.
  const host = new RegExp(`^([^.]+)\\.${escapeRegExp(parent)}$`);

  function labelFor(roomId) {
    const mac = createHmac("sha256", secret).update(`riff preview origin v1\0${roomId}`).digest();
    return base32(mac).slice(0, LABEL_LENGTH);
  }

  return {
    labelFor,
    originFor: (roomId) => `${scheme.toLowerCase()}://${labelFor(roomId)}.${parent}`,
    /** The label a request's Host names, or null when it isn't a preview host. */
    labelOf(request) {
      const value = request.headers.host;
      if (typeof value !== "string") return null;
      return host.exec(value.toLowerCase())?.[1] ?? null;
    },
  };
}
