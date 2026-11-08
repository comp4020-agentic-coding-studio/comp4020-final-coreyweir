// Loading a workspace export back (docs/adr/0003, "Amendment (2026-11-08):
// workspace export", and its implementation of import): the other half of
// "no lock-in" for the filesystem Claude works in.
//
// The host picks an export on the host form; this reads it before any room
// exists, and the new room's workspace (docs/adr/0010) is seeded from it, so
// the pod boots from it as from any saved workspace. Only into a new room's
// empty workspace, never over one.
//
// The zip is read by its own small reader rather than a general unzip, for
// what a general one doesn't give: each entry's unix mode and symlink bit,
// and the sizes it claims before a byte is inflated. Only Riff exports are
// accepted (riff-workspace.json, format "riff-workspace", version 1), and
// from those only what an export puts there:
// - `repo/…` becomes /work/repo/…, `.git` included.
// - `claude/projects/-work-repo/…` becomes Claude's transcripts, only when
//   the host ticks the box for them (they become Claude's own history).
// - Anything else in the zip is skipped and listed.
// Never brought in, whatever the zip holds: Riff's session folder
// (`.wasix-session`), credential files (`.git-credentials`,
// `.git/credentials`), and the bytes of a token Riff holds (overwritten
// with `*`, as export does: no real credential goes into the guest,
// docs/adr/0007). `.git/config` loses user:token@ in URLs and extraheader
// lines. A name that isn't a plain relative path (`..`, a leading `/`, a
// backslash), a name twice, an entry beneath a symlink, or a zip past the
// size limits refuses the whole file: a Riff export never has one.
//
// No DOM and no React: `npm run test:workspace-import` runs it under node.
import { inflateSync } from "fflate";
import {
  CREDENTIAL_FILES, MANIFEST_NAME, SESSION_DIR, TRANSCRIPTS_DIR, WORKSPACE_FORMAT, WORKSPACE_ROOT, WORKSPACE_VERSION,
  overwriteSecrets, scrubGitConfig, type Changed,
} from "./workspaceExport.ts";

/** The zip itself, as picked. */
export const MAX_ZIP_BYTES = 512 * 1024 * 1024;
/** Everything in it, inflated: the pod holds its filesystem in memory. */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRIES = 200_000;

export class WorkspaceImportError extends Error {}

export type ImportEntry =
  | { path: string; kind: "dir"; mode: number; mtimeMs: number }
  | { path: string; kind: "file"; mode: number; mtimeMs: number; data: Uint8Array }
  | { path: string; kind: "symlink"; mode: number; mtimeMs: number; target: string };

export type Skipped = { path: string; reason: "session" | "credentials" | "transcripts" | "not-in-a-workspace" | "special" };

/** What the export says it left out (its `left`), as workspace paths. */
export type LeftOut = { path: string; reason: string; files: number; bytes: number };

export type ImportSummary = {
  exportedAt: string | null;
  room: string | null;
  /** In the repo (and transcripts, if chosen): files and their bytes. */
  files: number;
  bytes: number;
  transcriptFiles: number;
  transcriptBytes: number;
  /** From the export's own commit list. */
  branch: string | null;
  commits: number;
  unpushed: number;
  leftOut: LeftOut[];
};

type Raw = {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  unixMode: number | null;
  mtimeMs: number;
};

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

const REPO_PREFIX = "repo/";
const TRANSCRIPTS_PREFIX = "claude/projects/-work-repo/";

// ---- the zip's own records ----

function u16(bytes: Uint8Array, at: number) {
  return bytes[at] | (bytes[at + 1] << 8);
}
function u32(bytes: Uint8Array, at: number) {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function dosTime(date: number, time: number) {
  if (!date) return Date.now();
  // local time, as fflate writes it
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function centralDirectory(zip: Uint8Array): Raw[] {
  const notZip = () => new WorkspaceImportError("That isn't a zip file.");
  // The end record sits in the last 22 bytes plus a comment of up to 64 KB.
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (u32(zip, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw notZip();
  const count = u16(zip, end + 10);
  const size = u32(zip, end + 12);
  const offset = u32(zip, end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new WorkspaceImportError("That zip is larger than a Riff export can be (zip64).");
  if (count > MAX_ENTRIES) throw new WorkspaceImportError(`That zip has ${count.toLocaleString()} entries; an import takes up to ${MAX_ENTRIES.toLocaleString()}.`);
  if (offset + size > end) throw notZip();
  const entries: Raw[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(zip, at) !== 0x02014b50) throw notZip();
    const madeBy = u16(zip, at + 4) >> 8;
    const flags = u16(zip, at + 8);
    const method = u16(zip, at + 10);
    const time = u16(zip, at + 12);
    const date = u16(zip, at + 14);
    const crc = u32(zip, at + 16);
    const compressedSize = u32(zip, at + 20);
    const uncompressed = u32(zip, at + 24);
    const nameLength = u16(zip, at + 28);
    const extraLength = u16(zip, at + 30);
    const commentLength = u16(zip, at + 32);
    const external = u32(zip, at + 38);
    const localOffset = u32(zip, at + 42);
    let name: string;
    try {
      name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    } catch {
      throw new WorkspaceImportError("That zip has a file name that isn't UTF-8; a Riff export never does.");
    }
    entries.push({
      name, method, flags, crc, compressedSize, size: uncompressed, localOffset,
      unixMode: madeBy === 3 ? external >>> 16 : null,
      mtimeMs: dosTime(date, time),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function inflate(zip: Uint8Array, raw: Raw): Uint8Array {
  const bad = () => new WorkspaceImportError(`${raw.name} in that zip is damaged.`);
  if (raw.flags & 1) throw new WorkspaceImportError(`${raw.name} in that zip is encrypted.`);
  const at = raw.localOffset;
  if (at + 30 > zip.length || u32(zip, at) !== 0x04034b50) throw bad();
  const start = at + 30 + u16(zip, at + 26) + u16(zip, at + 28);
  const body = zip.subarray(start, start + raw.compressedSize);
  if (body.length !== raw.compressedSize) throw bad();
  let data: Uint8Array;
  if (raw.method === 0) data = body.slice();
  else if (raw.method === 8) {
    try {
      // no bigger than it said: the sizes were checked against the limit
      data = inflateSync(body, { out: new Uint8Array(raw.size) });
    } catch {
      throw bad();
    }
  } else throw new WorkspaceImportError(`${raw.name} in that zip uses a compression a Riff export doesn't.`);
  if (data.length !== raw.size || crc32(data) !== raw.crc) throw bad();
  return data;
}

// ---- what the export says about itself ----

type ExportManifest = {
  exportedAt: string | null;
  room: string | null;
  branch: string | null;
  commits: number;
  unpushed: number;
  left: LeftOut[];
};

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** A zip path in the export's layout, as the workspace path it came from. */
function workspacePathOf(zipPath: string) {
  const clean = zipPath.replace(/\/+$/, "");
  if (clean === "repo") return WORKSPACE_ROOT;
  if (clean.startsWith(REPO_PREFIX)) return `${WORKSPACE_ROOT}/${clean.slice(REPO_PREFIX.length)}`;
  if (clean.startsWith(TRANSCRIPTS_PREFIX)) return `${TRANSCRIPTS_DIR}/${clean.slice(TRANSCRIPTS_PREFIX.length)}`;
  return clean;
}

// Known fields only, each checked for its type: the rest is ignored.
function readManifest(text: string): ExportManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkspaceImportError(`${MANIFEST_NAME} in that zip isn't JSON.`);
  }
  const manifest = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (manifest.format !== WORKSPACE_FORMAT) throw new WorkspaceImportError("That zip isn't a Riff workspace export.");
  if (manifest.version !== WORKSPACE_VERSION) {
    throw new WorkspaceImportError(`That export is format version ${JSON.stringify(manifest.version)}; this Riff reads version ${WORKSPACE_VERSION}.`);
  }
  const history = (manifest.history && typeof manifest.history === "object" ? manifest.history : null) as Record<string, unknown> | null;
  const left = Array.isArray(manifest.left) ? manifest.left : [];
  return {
    exportedAt: str(manifest.exportedAt),
    room: str(manifest.room),
    branch: history ? str(history.branch) : null,
    commits: history && Array.isArray(history.commits) ? history.commits.length : 0,
    unpushed: history ? num(history.unpushed) : 0,
    left: left.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const path = str(entry.path);
      const reason = str(entry.reason);
      if (!path || !reason) return [];
      return [{ path: workspacePathOf(path), reason, files: num(entry.files), bytes: num(entry.bytes) }];
    }),
  };
}

// ---- the archive ----

export type ImportOptions = {
  /** Bring Claude's transcripts in too (they become Claude's history). */
  transcripts?: boolean;
  /** Real credential values that must not go into the guest. */
  secrets?: readonly string[];
};

export type WorkspaceArchive = {
  summary: ImportSummary;
  /** Whether the export carries transcripts to offer. */
  hasTranscripts: boolean;
  /** The workspace's entries, parents first, inflated one at a time. */
  entries(options?: ImportOptions): Generator<ImportEntry, { skipped: Skipped[]; changed: Changed[] }>;
};

function plainName(name: string) {
  const clean = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!clean || clean.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return clean.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function kindOf(raw: Raw): "dir" | "file" | "symlink" | "special" {
  if (raw.name.endsWith("/")) return "dir";
  const type = raw.unixMode === null ? S_IFREG : raw.unixMode & S_IFMT;
  if (type === S_IFDIR) return "dir";
  if (type === S_IFLNK) return "symlink";
  if (type === S_IFREG || type === 0) return "file";
  return "special";
}

function modeOf(raw: Raw, kind: "dir" | "file" | "symlink") {
  const mode = raw.unixMode === null ? 0 : raw.unixMode & 0o7777;
  return mode || (kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644);
}

/** Why a workspace path is never brought in, or null. */
function never(path: string): Skipped["reason"] | null {
  const parts = path.split("/");
  if (parts.includes(SESSION_DIR)) return "session";
  const name = parts[parts.length - 1];
  if (CREDENTIAL_FILES.includes(name)) return "credentials";
  if (name === "credentials" && parts[parts.length - 2] === ".git") return "credentials";
  return null;
}

/** Read an export's index and manifest; nothing is inflated but the manifest. */
export function openWorkspaceExport(zip: Uint8Array): WorkspaceArchive {
  if (zip.length > MAX_ZIP_BYTES) {
    throw new WorkspaceImportError(`That file is ${Math.round(zip.length / 1024 / 1024)} MB; an import takes up to ${MAX_ZIP_BYTES / 1024 / 1024} MB.`);
  }
  const raws = centralDirectory(zip);
  const names = new Set<string>();
  for (const raw of raws) {
    if (!plainName(raw.name)) throw new WorkspaceImportError(`That zip has an entry named ${JSON.stringify(raw.name)}, which would land outside the workspace.`);
    const key = raw.name.replace(/\/$/, "");
    if (names.has(key)) throw new WorkspaceImportError(`That zip has ${JSON.stringify(key)} twice.`);
    names.add(key);
  }
  const manifestRaw = raws.find((raw) => raw.name === MANIFEST_NAME);
  if (!manifestRaw) throw new WorkspaceImportError(`That zip isn't a Riff workspace export: it has no ${MANIFEST_NAME}.`);
  if (manifestRaw.size > 16 * 1024 * 1024) throw new WorkspaceImportError(`${MANIFEST_NAME} in that zip is too large.`);
  const manifest = readManifest(new TextDecoder().decode(inflate(zip, manifestRaw)));

  const inRepo = (raw: Raw) => raw.name === "repo/" || raw.name.startsWith(REPO_PREFIX);
  const inTranscripts = (raw: Raw) => raw.name.startsWith(TRANSCRIPTS_PREFIX);
  let declared = 0;
  for (const raw of raws) declared += raw.size;
  if (declared > MAX_IMPORT_BYTES) {
    throw new WorkspaceImportError(`That export holds ${Math.round(declared / 1024 / 1024)} MB; an import takes up to ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
  }
  // A symlink's path can't be a directory of other entries: restoring them
  // would follow it, wherever it points.
  const links = new Set(raws.filter((raw) => kindOf(raw) === "symlink").map((raw) => raw.name));
  for (const raw of raws) {
    for (let at = raw.name.indexOf("/"); at > 0; at = raw.name.indexOf("/", at + 1)) {
      if (links.has(raw.name.slice(0, at))) throw new WorkspaceImportError(`That zip has ${JSON.stringify(raw.name)} inside a symlink.`);
    }
  }

  const tally = (pick: (raw: Raw) => boolean) => {
    let files = 0;
    let bytes = 0;
    for (const raw of raws) {
      if (!pick(raw) || kindOf(raw) !== "file" || never(workspacePathOf(raw.name))) continue;
      files++;
      bytes += raw.size;
    }
    return { files, bytes };
  };
  const repo = tally(inRepo);
  const transcripts = tally(inTranscripts);

  function* entries(options: ImportOptions = {}): Generator<ImportEntry, { skipped: Skipped[]; changed: Changed[] }> {
    const secrets = (options.secrets ?? []).filter(Boolean).map((secret) => new TextEncoder().encode(secret));
    const skipped: Skipped[] = [];
    const changed: Changed[] = [];
    // parents first: "a/" sorts before "a/b"
    const sorted = raws.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const raw of sorted) {
      if (raw === manifestRaw) continue;
      const path = workspacePathOf(raw.name);
      if (!inRepo(raw) && !inTranscripts(raw)) {
        skipped.push({ path: raw.name, reason: "not-in-a-workspace" });
        continue;
      }
      if (inTranscripts(raw) && !options.transcripts) {
        skipped.push({ path, reason: "transcripts" });
        continue;
      }
      const why = never(path);
      if (why) {
        skipped.push({ path, reason: why });
        continue;
      }
      const kind = kindOf(raw);
      if (kind === "special") {
        skipped.push({ path, reason: "special" });
        continue;
      }
      const mode = modeOf(raw, kind);
      if (kind === "dir") {
        yield { path, kind, mode, mtimeMs: raw.mtimeMs };
        continue;
      }
      let data = inflate(zip, raw);
      if (kind === "symlink") {
        yield { path, kind, mode, mtimeMs: raw.mtimeMs, target: new TextDecoder().decode(data) };
        continue;
      }
      if (/(^|\/)\.git\/(?:.+\/)?config$/.test(path)) {
        const scrubbed = scrubGitConfig(new TextDecoder().decode(data));
        if (scrubbed.urls) changed.push({ path, what: "url-credentials-removed" });
        if (scrubbed.headers) changed.push({ path, what: "header-removed" });
        if (scrubbed.urls || scrubbed.headers) data = new TextEncoder().encode(scrubbed.text);
      }
      const overwritten = overwriteSecrets(data, secrets);
      if (overwritten.found) {
        changed.push({ path, what: "credential-bytes-overwritten" });
        data = overwritten.bytes;
      }
      yield { path, kind, mode, mtimeMs: raw.mtimeMs, data };
    }
    return { skipped, changed };
  }

  return {
    summary: {
      exportedAt: manifest.exportedAt,
      room: manifest.room,
      files: repo.files,
      bytes: repo.bytes,
      transcriptFiles: transcripts.files,
      transcriptBytes: transcripts.bytes,
      branch: manifest.branch,
      commits: manifest.commits,
      unpushed: manifest.unpushed,
      leftOut: manifest.left,
    },
    hasTranscripts: transcripts.files > 0,
    entries,
  };
}
