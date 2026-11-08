// The host's workspace as one zip: the "no lock-in" half of the brief for
// the filesystem Claude works in (README; PLAN P2). Only the host's browser
// has the workspace, so only the host exports.
//
// The files are read through a `WorkspaceSource`, which the pod provides
// (`podSource`), so this doesn't care what backs the pod's filesystem:
// memory, or OPFS behind it.
//
// What goes in, and what never does:
// - `repo/` is /work/repo, `.git` included (unpushed commits are the point).
//   Dependency folders (`node_modules` and the like) stay out unless asked
//   for; they are named, counted and sized in the manifest.
// - `.wasix-session` always stays out: Riff's own session folder (about
//   70 MB of command stubs, a per-session certificate), rebuilt on every
//   start. It isn't the host's work.
// - Claude's transcripts (`claude/projects/-work-repo/`) only if asked for.
//   They hold everything people typed to Claude, and whatever the tools
//   printed (docs/adr/0003, "Claude session transcripts").
// - No credential. The guest holds placeholders, not the real tokens
//   (docs/adr/0007), but this checks anyway: any file holding a real
//   token's exact bytes has them overwritten with `*`s, same length, and
//   the manifest says which files. `.git/config` loses the user:token part
//   of remote URLs and any extraheader line (what a pasted-in token would
//   look like), and `.git-credentials` and the like are never included.
//
// No DOM and no React here: `npm run test:workspace-export` runs it under
// node (type stripping), against an in-memory source.
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";

export const WORKSPACE_FORMAT = "riff-workspace";
export const WORKSPACE_VERSION = 1;
export const WORKSPACE_ROOT = "/work/repo";
// Claude Code keeps a project's sessions under its config directory
// (HOME is /home/user in the pod), in a folder named for the project's
// path with "/" turned into "-".
export const TRANSCRIPTS_DIR = "/home/user/.claude/projects/-work-repo";
export const MANIFEST_NAME = "riff-workspace.json";

/** Folders of regenerable dependencies, at any depth. Not a list of build
 * output: a `dist` or `target` may be someone's source in another
 * language, so nothing here is named after a framework. */
export const DEPENDENCY_DIRS: readonly string[] = ["node_modules", ".venv", "__pycache__"];
/** Never exported, however it's asked (relative to the workspace root). */
export const SESSION_DIR = ".wasix-session";
/** Files that exist to hold a credential, wherever they sit. */
export const CREDENTIAL_FILES: readonly string[] = [".git-credentials"];

export type Kind = "file" | "dir" | "symlink" | "other";
export type SourceStat = { kind: Kind; size: number; mode: number; mtimeMs: number };

export interface WorkspaceSource {
  readdir(path: string): Promise<string[]>;
  /** null when the path isn't there. */
  lstat(path: string): Promise<SourceStat | null>;
  readFile(path: string): Promise<Uint8Array>;
  readlink(path: string): Promise<string>;
}

export type ExportOptions = {
  /** Join code, for the manifest. */
  room?: string;
  /** Real credential values to make sure never travel. */
  secrets?: readonly string[];
  /** Keep node_modules and the other dependency folders. */
  dependencies?: boolean;
  /** Include Claude's session transcripts. */
  transcripts?: boolean;
  now?: Date;
  onProgress?: (progress: { files: number; bytes: number; path: string }) => void;
};

export type Left = { path: string; reason: "dependencies" | "session" | "transcripts" | "credentials" | "unreadable" | "special"; files: number; bytes: number };
export type Changed = { path: string; what: "credential-bytes-overwritten" | "url-credentials-removed" | "header-removed" };

export type Manifest = {
  format: typeof WORKSPACE_FORMAT;
  version: typeof WORKSPACE_VERSION;
  exportedAt: string;
  room: string | null;
  /** Where the folder came from, and where it sits in this zip. */
  root: string;
  layout: { repo: "repo/"; transcripts: "claude/projects/-work-repo/" };
  includes: { dependencies: boolean; transcripts: boolean };
  files: number;
  bytes: number;
  transcriptFiles: number;
  /** Left out, with why: paths as they would have been in this zip. */
  left: Left[];
  /** Included, but not byte for byte what was in the pod (zip paths). */
  changed: Changed[];
  notes: string[];
};

export type ExportResult = { blob: Blob; manifest: Manifest; name: string };

const ALREADY_COMPRESSED = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "zip", "gz", "tgz", "bz2", "xz", "7z", "zst",
  "woff", "woff2", "mp3", "mp4", "m4a", "webm", "ogg", "mov", "pdf", "jar",
]);

const GIT_NOTE = "The .git folder is Nodepod's own store (objects in .git/objects/store.json), not the format real git writes. It keeps every commit, so Riff can reopen the history, but `git log` outside Riff won't read it. The files under repo/ are the working tree as it was.";

export function workspaceFileName(room: string | null, at: Date) {
  const day = at.toISOString().slice(0, 10);
  return `riff-workspace-${(room ?? "workspace").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${day}.zip`;
}

function joinPath(dir: string, name: string) {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// -- credentials ----------------------------------------------------------

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number) {
  const first = needle[0];
  let at = hay.indexOf(first, from);
  while (at !== -1 && at + needle.length <= hay.length) {
    let i = 1;
    while (i < needle.length && hay[at + i] === needle[i]) i++;
    if (i === needle.length) return at;
    at = hay.indexOf(first, at + 1);
  }
  return -1;
}

// Too short to be a token: matching it would mangle ordinary text.
const MIN_SECRET_LENGTH = 8;

/** The bytes with every occurrence of a secret overwritten by `*`s of the
 * same length, so offsets in a binary file still hold. Returns the same
 * array, untouched, when nothing matched. */
export function overwriteSecrets(bytes: Uint8Array, secrets: readonly Uint8Array[]): { bytes: Uint8Array; found: boolean } {
  let out = bytes;
  let found = false;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH || secret.length > out.length) continue;
    let at = indexOfBytes(out, secret, 0);
    while (at !== -1) {
      if (!found) out = out.slice();
      found = true;
      out.fill(0x2a, at, at + secret.length);
      at = indexOfBytes(out, secret, at + secret.length);
    }
  }
  return { bytes: out, found };
}

const GIT_CONFIG = /(^|\/)\.git\/(?:.+\/)?config$/;

/** A git config without what would be a credential: the user:token part of
 * a remote's URL, and extraheader lines (`http.extraheader = AUTHORIZATION:
 * basic …` is how a token gets into one). */
export function scrubGitConfig(text: string): { text: string; urls: number; headers: number } {
  let urls = 0;
  let headers = 0;
  const lines = text.split("\n").flatMap((line) => {
    if (/^\s*extraheader\s*=/i.test(line)) {
      headers++;
      return [];
    }
    const next = line.replace(/^(\s*(?:pushurl|url)\s*=\s*[a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, (_, head: string) => {
      urls++;
      return head;
    });
    return [next];
  });
  return { text: lines.join("\n"), urls, headers };
}

// -- the walk -------------------------------------------------------------

type Collected = {
  zip: Zip;
  left: Map<string, Left>;
  changed: Changed[];
  files: number;
  bytes: number;
  secrets: Uint8Array[];
  options: ExportOptions;
  source: WorkspaceSource;
  sinceYield: number;
};

async function tally(source: WorkspaceSource, dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (path: string) => {
    let names: string[];
    try { names = await source.readdir(path); } catch { return; }
    for (const name of names) {
      const full = joinPath(path, name);
      const stat = await source.lstat(full);
      if (!stat) continue;
      if (stat.kind === "dir") await walk(full);
      else { files++; bytes += stat.size; }
    }
  };
  await walk(dir);
  return { files, bytes };
}

// Chrome keeps the page responsive between files, not inside one deflate.
async function breathe(c: Collected, weight: number) {
  c.sinceYield += weight;
  if (c.sinceYield < 4 * 1024 * 1024) return;
  c.sinceYield = 0;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function unixAttrs(type: number, mode: number, fallback: number) {
  return (((type | ((mode & 0o7777) || fallback)) << 16) >>> 0);
}

function addEntry(c: Collected, zipPath: string, data: Uint8Array, stat: SourceStat | null, type = 0o100000) {
  const stored = ALREADY_COMPRESSED.has(extensionOf(zipPath)) || data.length === 0;
  const entry = stored ? new ZipPassThrough(zipPath) : new ZipDeflate(zipPath, { level: 6 });
  entry.os = 3;
  entry.attrs = unixAttrs(type, stat?.mode ?? 0, type === 0o120000 ? 0o777 : 0o644);
  // A zip's clock starts in 1980.
  if (stat && stat.mtimeMs > Date.UTC(1980, 0, 2)) entry.mtime = stat.mtimeMs;
  c.zip.add(entry);
  entry.push(data, true);
}

function addDirectory(c: Collected, zipPath: string, stat: SourceStat | null) {
  const entry = new ZipPassThrough(`${zipPath}/`);
  entry.os = 3;
  entry.attrs = unixAttrs(0o040000, stat?.mode ?? 0, 0o755);
  if (stat && stat.mtimeMs > Date.UTC(1980, 0, 2)) entry.mtime = stat.mtimeMs;
  c.zip.add(entry);
  entry.push(new Uint8Array(0), true);
}

function leave(c: Collected, path: string, reason: Left["reason"], files: number, bytes: number) {
  const key = `${reason}:${path}`;
  const have = c.left.get(key);
  if (have) { have.files += files; have.bytes += bytes; }
  else c.left.set(key, { path, reason, files, bytes });
}

async function addFile(c: Collected, full: string, rel: string, zipPath: string, stat: SourceStat) {
  let data: Uint8Array;
  try {
    data = await c.source.readFile(full);
  } catch {
    leave(c, zipPath, "unreadable", 1, stat.size);
    return;
  }
  if (GIT_CONFIG.test(rel)) {
    const scrubbed = scrubGitConfig(new TextDecoder().decode(data));
    if (scrubbed.urls) c.changed.push({ path: zipPath, what: "url-credentials-removed" });
    if (scrubbed.headers) c.changed.push({ path: zipPath, what: "header-removed" });
    if (scrubbed.urls || scrubbed.headers) data = strToU8(scrubbed.text);
  }
  const overwritten = overwriteSecrets(data, c.secrets);
  if (overwritten.found) {
    c.changed.push({ path: zipPath, what: "credential-bytes-overwritten" });
    data = overwritten.bytes;
  }
  addEntry(c, zipPath, data, stat);
  c.files++;
  c.bytes += data.length;
  c.options.onProgress?.({ files: c.files, bytes: c.bytes, path: rel });
  await breathe(c, data.length + 1024);
}

async function walk(c: Collected, dir: string, rel: string, zipDir: string) {
  const names = (await c.source.readdir(dir)).slice().sort();
  for (const name of names) {
    const full = joinPath(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const zipPath = `${zipDir}/${relPath}`;
    const stat = await c.source.lstat(full);
    if (!stat) continue;
    if (stat.kind === "dir") {
      if (!rel && name === SESSION_DIR) {
        const size = await tally(c.source, full);
        leave(c, zipPath, "session", size.files, size.bytes);
        continue;
      }
      if (DEPENDENCY_DIRS.includes(name) && !c.options.dependencies) {
        const size = await tally(c.source, full);
        leave(c, zipPath, "dependencies", size.files, size.bytes);
        continue;
      }
      addDirectory(c, zipPath, stat);
      await walk(c, full, relPath, zipDir);
    } else if (CREDENTIAL_FILES.includes(name) || (name === "credentials" && /(^|\/)\.git$/.test(rel))) {
      leave(c, zipPath, "credentials", 1, stat.size);
    } else if (stat.kind === "symlink") {
      let target: string;
      try { target = await c.source.readlink(full); } catch { leave(c, zipPath, "unreadable", 1, 0); continue; }
      addEntry(c, zipPath, strToU8(target), stat, 0o120000);
      c.files++;
    } else if (stat.kind === "file") {
      await addFile(c, full, relPath, zipPath, stat);
    } else {
      leave(c, zipPath, "special", 1, 0);
    }
  }
}

/** Zip the workspace. Throws if /work/repo isn't there. */
export async function exportWorkspace(source: WorkspaceSource, options: ExportOptions = {}): Promise<ExportResult> {
  const now = options.now ?? new Date();
  const chunks: Uint8Array[] = [];
  let failure: unknown = null;
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const zip = new Zip((error, chunk, final) => {
    if (error) failure = error;
    else chunks.push(chunk);
    if (final || error) finished();
  });
  const c: Collected = {
    zip,
    left: new Map(),
    changed: [],
    files: 0,
    bytes: 0,
    secrets: (options.secrets ?? []).filter((secret) => secret.length >= MIN_SECRET_LENGTH).map((secret) => strToU8(secret)),
    options,
    source,
    sinceYield: 0,
  };

  const root = await source.lstat(WORKSPACE_ROOT);
  if (!root || root.kind !== "dir") throw new Error("There is no workspace to export yet. Boot it first.");
  addDirectory(c, "repo", root);
  await walk(c, WORKSPACE_ROOT, "", "repo");

  let transcriptFiles = 0;
  const transcriptDir = await source.lstat(TRANSCRIPTS_DIR);
  if (options.transcripts && transcriptDir?.kind === "dir") {
    const before = c.files;
    addDirectory(c, "claude", null);
    addDirectory(c, "claude/projects", null);
    addDirectory(c, "claude/projects/-work-repo", transcriptDir);
    await walk(c, TRANSCRIPTS_DIR, "", "claude/projects/-work-repo");
    transcriptFiles = c.files - before;
  } else if (!options.transcripts && transcriptDir?.kind === "dir") {
    const size = await tally(source, TRANSCRIPTS_DIR);
    leave(c, "claude/projects/-work-repo", "transcripts", size.files, size.bytes);
  }

  const left = [...c.left.values()];
  const manifest: Manifest = {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    exportedAt: now.toISOString(),
    room: options.room ?? null,
    root: WORKSPACE_ROOT,
    layout: { repo: "repo/", transcripts: "claude/projects/-work-repo/" },
    includes: { dependencies: options.dependencies === true, transcripts: options.transcripts === true },
    files: c.files - transcriptFiles,
    bytes: c.bytes,
    transcriptFiles,
    left,
    changed: c.changed,
    notes: [GIT_NOTE],
  };
  const text = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  addEntry(c, MANIFEST_NAME, text, null);
  zip.end();
  await done;
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  return {
    blob: new Blob(chunks as BlobPart[], { type: "application/zip" }),
    manifest,
    name: workspaceFileName(options.room ?? null, now),
  };
}

// -- the pod --------------------------------------------------------------

type PodVolume = {
  lstatSync(path: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mode: number; mtimeMs: number };
  readlinkSync(path: string): string;
};
type PodLike = { fs: { readdir(path: string): Promise<string[]>; readFile(path: string): Promise<Uint8Array> }; volume: PodVolume };

/** A running pod's files. Reads go through Nodepod's own filesystem API;
 * only `lstat` and `readlink` need the volume, since the API follows links
 * and has no way to read one. */
export function podSource(pod: PodLike): WorkspaceSource {
  return {
    readdir: (path) => pod.fs.readdir(path),
    readFile: async (path) => new Uint8Array(await pod.fs.readFile(path)),
    readlink: async (path) => pod.volume.readlinkSync(path),
    async lstat(path) {
      let stat: ReturnType<PodVolume["lstatSync"]>;
      try { stat = pod.volume.lstatSync(path); } catch { return null; }
      const kind: Kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
      return { kind, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs };
    },
  };
}
