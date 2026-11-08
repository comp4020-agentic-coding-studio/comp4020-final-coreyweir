// The host's workspace, saved in this browser (docs/adr/0010).
//
// The pod's filesystem lives in memory: Nodepod's volume, which moves into
// the shared Rust store once bash starts. The store can't write to OPFS
// itself (the page's main thread writes to it, and only workers get
// synchronous OPFS access), but it records every mutation, and the volume
// reports each one through `onGlobalChange`, whoever made it: Claude's
// tools, git, bash, Nodepod's workers. So this follows those reports and
// saves what changed shortly afterwards, without the writer waiting. A
// crash loses the save in progress, never more, and never half of one
// (workspaceWorker.ts).
//
// One workspace per room, keyed by the room's permanent id, held by one tab
// at a time (a Web Lock).
import type { MemoryVolume } from "@scelar/nodepod";
import type { ImportedNote, ManifestEntry, WorkerRequest, WorkerResponse, WorkspaceManifest, WorkspaceSummary } from "./workspaceFormat";
import { MANIFEST_FORMAT } from "./workspaceFormat";

export type { ImportedNote, WorkspaceSummary } from "./workspaceFormat";

/** What a saved workspace covers, for the host to read. */
export const SAVED_DIRS = ["/work", "/home/user"] as const;
export const SAVED_SUMMARY = "Saved in this browser: everything under /work and /home/user, node_modules and .git included. Not saved: /tmp and the rest of the filesystem, Claude's settings, and bash's tools (the boot writes those fresh).";

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether a path is part of the saved workspace. */
export function isSaved(path: string) {
  const under = SAVED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
  if (!under) return false;
  // bash's tools, installed at every boot (wasixSession.ts)
  if (path.split("/").includes(".wasix-session")) return false;
  // written at every boot by claudePod.ts; .claude.json also has backups
  if (path.startsWith("/home/user/.claude.json")) return false;
  if (path === "/home/user/.claude/settings.json") return false;
  // package managers' caches, not anyone's work
  for (const cache of ["/home/user/.npm", "/home/user/.cache"]) {
    if (path === cache || path.startsWith(`${cache}/`)) return false;
  }
  return true;
}

// ---- the worker ----

let worker: Worker | null = null;
let nextRequest = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

type Request = WorkerRequest extends infer R ? R extends { id: number } ? Omit<R, "id"> : never : never;

function call<T>(request: Request, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./workspaceWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const waiting = pending.get(event.data.id);
      if (!waiting) return;
      pending.delete(event.data.id);
      if (event.data.ok) waiting.resolve(event.data.value);
      else waiting.reject(new Error(event.data.error));
    };
  }
  const id = nextRequest++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    worker!.postMessage({ ...request, id }, transfer);
  });
}

// ---- one tab per workspace ----

type Held = { release: () => void; whenLost: (callback: () => void) => void };

const lockName = (room: string) => `riff-workspace:${room}`;

function requestLock(room: string, options: LockOptions): Promise<Held | null> {
  return new Promise((resolve, reject) => {
    let acquired = false;
    let lost: (() => void) | null = null;
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    navigator.locks.request(lockName(room), options, async (lock) => {
      if (!lock) return resolve(null);
      acquired = true;
      resolve({ release, whenLost: (callback) => (lost = callback) });
      await held;
    }).catch((error: DOMException) => {
      // Once held, a rejection means another tab took it (steal).
      if (acquired) lost?.();
      else if (error.name === "AbortError" || error.name === "TimeoutError") resolve(null);
      else reject(error);
    });
  });
}

export class WorkspaceBusyError extends Error {}

async function acquire(room: string, confirmTakeover: () => boolean | Promise<boolean>) {
  if (!navigator.locks) return { release: () => {}, whenLost: () => {} } satisfies Held;
  // A reload frees the old page's lock as it goes, but not necessarily
  // before the new page asks, so wait a moment before asking anyone.
  const held = await requestLock(room, { signal: AbortSignal.timeout(3000) });
  if (held) return held;
  if (!await confirmTakeover()) throw new WorkspaceBusyError("This room's workspace is open in another tab of this browser.");
  return (await requestLock(room, { steal: true }))!;
}

// ---- the workspace ----

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

type Stat = ReturnType<MemoryVolume["lstatSync"]>;

export type OpenOptions = {
  /** Asked when another tab has this workspace; true takes it over. */
  confirmTakeover?: () => boolean | Promise<boolean>;
  /** Another tab took the workspace over; this one has stopped saving. */
  onLost?: () => void;
  /** A save failed; saving carries on with the next change. */
  onError?: (error: Error) => void;
};

export class Workspace {
  /** The restored manifest's summary, or null for a new workspace. */
  restored: WorkspaceSummary | null = null;
  /** Set when the restored workspace was seeded from an export and hasn't
   * been saved over since (seedWorkspace). */
  imported: ImportedNote | null = null;
  /** Whether the browser agreed not to evict this origin's storage. */
  persisted = false;
  private entries = new Map<string, ManifestEntry>();
  private children = new Map<string, Set<string>>();
  private seq = 0;
  private next = 1;
  private dirty = new Set<string>();
  private timer = 0;
  private saving: Promise<void> | null = null;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;

  private constructor(
    readonly room: string,
    private volume: MemoryVolume,
    private held: Held,
    private options: OpenOptions,
  ) {}

  /**
   * Take this room's workspace for this tab and put what was saved back
   * into the volume. Call before anything else writes to the saved
   * directories, and before the shared store is attached (bash), which
   * sizes itself from the volume.
   */
  static async open(volume: MemoryVolume, room: string, options: OpenOptions = {}) {
    const held = await acquire(room, options.confirmTakeover ?? (() => confirm(
      "This room's workspace is open in another tab of this browser. Use it here instead? The other tab stops saving it.",
    )));
    const workspace = new Workspace(room, volume, held, options);
    held.whenLost(() => workspace.lose());
    try {
      workspace.persisted = await navigator.storage.persist?.() ?? false;
      const loaded = await call<{ manifest: WorkspaceManifest | null; files: Array<{ path: string; data: ArrayBuffer }> }>({ op: "load", room });
      if (loaded.manifest) workspace.restore(loaded.manifest, loaded.files);
    } catch (error) {
      held.release();
      throw error;
    }
    return workspace;
  }

  private restore(manifest: WorkspaceManifest, files: Array<{ path: string; data: ArrayBuffer }>) {
    const data = new Map(files.map((file) => [file.path, file.data]));
    const volume = this.volume;
    // Parents before children.
    const paths = Object.keys(manifest.entries).sort();
    for (const path of paths) {
      const entry = manifest.entries[path];
      if (!isSaved(path)) continue;
      const parent = parentOf(path);
      if (!volume.existsSync(parent)) volume.mkdirSync(parent, { recursive: true });
      if (entry[0] === "d") {
        if (!volume.existsSync(path)) volume.mkdirSync(path, { recursive: true });
      } else if (entry[0] === "l") {
        if (exists(volume, path)) volume.unlinkSync(path);
        volume.symlinkSync(entry[4], path);
      } else {
        const bytes = data.get(path);
        // a blob that went missing on disk: leave the file out, not the workspace
        if (!bytes) continue;
        volume.writeFileSync(path, new Uint8Array(bytes));
      }
      try {
        if (entry[0] !== "l") {
          volume.chmodSync(path, entry[1]);
          volume.utimesSync(path, entry[2] / 1000, entry[2] / 1000);
        }
      } catch {
        // modes and times are kept where the volume keeps them
      }
      this.setEntry(path, entry);
    }
    this.seq = manifest.seq;
    this.next = manifest.next;
    this.restored = { room: this.room, savedAt: manifest.savedAt, bytes: manifest.bytes, files: manifest.files };
    this.imported = manifest.imported ?? null;
  }

  /**
   * Start saving. A new workspace is walked once first, so what the boot
   * (or a clone) already wrote is saved too.
   */
  track() {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.volume.onGlobalChange((path) => {
      if (!isSaved(path)) return;
      this.dirty.add(path);
      this.schedule();
    });
    for (const dir of SAVED_DIRS) if (this.volume.existsSync(dir)) this.dirty.add(dir);
    this.schedule();
  }

  /**
   * Put saved modes back after the shared store is attached (bash's first
   * start). Nodepod's `attachSharedStore` copies files into the store
   * without their modes, so a restored `chmod +x` would come back 644.
   */
  reapplyModes() {
    for (const [path, entry] of this.entries) {
      if (entry[0] === "l") continue;
      try {
        if ((this.volume.lstatSync(path).mode & 0o7777) !== entry[1]) this.volume.chmodSync(path, entry[1]);
      } catch {
        // gone since; its own change report says so
      }
    }
  }

  /** Save whatever has changed, and wait for it. */
  async flush() {
    clearTimeout(this.timer);
    this.timer = 0;
    while (this.saving) await this.saving;
    if (this.stopped || !this.dirty.size) return;
    this.saving = this.save().finally(() => {
      this.saving = null;
    });
    await this.saving;
    if (this.dirty.size) await this.flush();
  }

  /** Save what's left and let another tab have it. */
  async close() {
    try {
      await this.flush();
    } finally {
      this.stop();
      this.held.release();
    }
  }

  private stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private lose() {
    if (this.stopped) return;
    this.stop();
    this.options.onLost?.();
  }

  private schedule() {
    // About a quarter of a second after a change, so a burst (an install,
    // a checkout) goes in a few saves rather than thousands.
    if (this.timer || this.stopped) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.flush().catch((error) => this.options.onError?.(error instanceof Error ? error : new Error(String(error))));
    }, 250);
  }

  private async save() {
    const paths = [...this.dirty];
    this.dirty.clear();
    const writes: Array<{ blob: string; data: ArrayBuffer }> = [];
    const drop: string[] = [];
    const missing = new Set<string>();
    for (const path of paths) {
      let stat: Stat;
      try {
        stat = this.volume.lstatSync(path);
      } catch {
        missing.add(path);
        continue;
      }
      this.visit(path, stat, writes, drop);
    }
    for (const path of missing) {
      if (hasAncestorIn(path, missing)) continue;
      this.removeTree(path, drop);
    }
    this.seq += 1;
    let files = 0;
    let bytes = 0;
    for (const entry of this.entries.values()) {
      if (entry[0] !== "f") continue;
      files += 1;
      bytes += entry[3];
    }
    const manifest: WorkspaceManifest = {
      format: MANIFEST_FORMAT,
      room: this.room,
      seq: this.seq,
      savedAt: Date.now(),
      next: this.next,
      files,
      bytes,
      entries: Object.fromEntries(this.entries),
    };
    try {
      await call({ op: "save", room: this.room, manifest, writes, drop }, writes.map((write) => write.data));
    } catch (error) {
      // Saved nothing: mark everything again so the next save retries it.
      for (const path of paths) this.dirty.add(path);
      throw error;
    }
  }

  /** Bring one path's entry up to date; a directory also checks its children. */
  private visit(path: string, stat: Stat, writes: Array<{ blob: string; data: ArrayBuffer }>, drop: string[]) {
    const known = this.entries.get(path);
    const mode = stat.mode & 0o7777;
    const mtime = Math.round(stat.mtimeMs);
    if (stat.isSymbolicLink()) {
      if (known && known[0] !== "l") this.removeTree(path, drop);
      this.setEntry(path, ["l", mode, mtime, 0, this.volume.readlinkSync(path)]);
    } else if (stat.isDirectory()) {
      if (known && known[0] !== "d") this.removeTree(path, drop);
      this.setEntry(path, ["d", mode, mtime]);
      const names = new Set(this.volume.readdirSync(path));
      for (const name of [...this.children.get(path) ?? []]) {
        if (!names.has(name)) this.removeTree(childOf(path, name), drop);
      }
      // Only children not yet saved: the ones already saved report their
      // own changes. A directory moved in arrives whole, with no reports
      // for what's inside it.
      for (const name of names) {
        const child = childOf(path, name);
        if (!isSaved(child) || this.entries.has(child)) continue;
        this.visit(child, this.volume.lstatSync(child), writes, drop);
      }
    } else {
      if (known && known[0] !== "f") this.removeTree(path, drop);
      if (known?.[0] === "f") drop.push(known[4]);
      // A copy: the volume may hand out its own buffer (or a view of the
      // shared store), and transferring would detach it.
      const content = this.volume.readFileSync(path) as Uint8Array;
      const data = new Uint8Array(content.byteLength);
      data.set(content);
      const blob = (this.next++).toString(36);
      writes.push({ blob, data: data.buffer });
      this.setEntry(path, ["f", mode, mtime, data.byteLength, blob]);
    }
  }

  private setEntry(path: string, entry: ManifestEntry) {
    this.entries.set(path, entry);
    if (path === "/") return;
    const parent = parentOf(path);
    let names = this.children.get(parent);
    if (!names) this.children.set(parent, names = new Set());
    names.add(nameOf(path));
  }

  private removeTree(path: string, drop: string[]) {
    const entry = this.entries.get(path);
    if (!entry) return;
    if (entry[0] === "d") {
      for (const name of [...this.children.get(path) ?? []]) this.removeTree(childOf(path, name), drop);
      this.children.delete(path);
    } else if (entry[0] === "f") {
      drop.push(entry[4]);
    }
    this.entries.delete(path);
    this.children.get(parentOf(path))?.delete(nameOf(path));
  }
}

const childOf = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

function hasAncestorIn(path: string, set: Set<string>) {
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
    if (set.has(path.slice(0, at))) return true;
  }
  return false;
}

function exists(volume: MemoryVolume, path: string) {
  try {
    volume.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---- listing and deleting, for the landing page ----

/** Every workspace this browser holds. */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  if (!navigator.storage?.getDirectory) return [];
  return call<WorkspaceSummary[]>({ op: "list" });
}

/**
 * Delete a room's workspace. A tab that has it open stops saving first
 * (it loses the lock), so it can't write a manifest over the deletion.
 */
export async function deleteWorkspace(room: string) {
  if (!navigator.storage?.getDirectory) return;
  const held = navigator.locks ? await requestLock(room, { steal: true }) : null;
  try {
    await call({ op: "delete", room });
  } finally {
    held?.release();
  }
}

export async function deleteAllWorkspaces() {
  const all = await listWorkspaces();
  for (const workspace of all) await deleteWorkspace(workspace.room);
  return all.length;
}

// ---- seeding a new room's workspace from an export ----

export class WorkspaceExistsError extends Error {}

export type SeedEntry =
  | { path: string; kind: "dir"; mode: number; mtimeMs: number }
  | { path: string; kind: "file"; mode: number; mtimeMs: number; data: Uint8Array }
  | { path: string; kind: "symlink"; mode: number; mtimeMs: number; target: string };

/** Written to OPFS in batches of about this many bytes. */
const SEED_BATCH_BYTES = 16 * 1024 * 1024;

/**
 * Seed a room's workspace that doesn't exist yet: an import goes into a new
 * workspace only, never over one (docs/adr/0003). Files go first, in
 * batches, and the manifest last, so a crash part-way leaves nothing a boot
 * would restore. The next boot restores it like any saved workspace.
 */
export async function seedWorkspace(
  room: string,
  entries: Iterable<SeedEntry>,
  note: Omit<ImportedNote, "files">,
  onProgress?: (files: number) => void,
) {
  if ((await listWorkspaces()).some((workspace) => workspace.room === room)) {
    throw new WorkspaceExistsError("This room already has a workspace in this browser; an import goes into a new one.");
  }
  const held = navigator.locks ? await requestLock(room, { ifAvailable: true }) : null;
  if (navigator.locks && !held) throw new WorkspaceExistsError("This room's workspace is open in another tab.");
  const manifestEntries: Record<string, ManifestEntry> = {};
  let next = 1;
  let files = 0;
  let bytes = 0;
  let batch: Array<{ blob: string; data: ArrayBuffer }> = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const writes = batch;
    batch = [];
    batchBytes = 0;
    await call({ op: "blobs", room, writes }, writes.map((write) => write.data));
  };
  try {
    for (const entry of entries) {
      if (!isSaved(entry.path)) continue;
      // parents the export didn't list, so the manifest is a whole tree
      for (let at = entry.path.indexOf("/", 1); at > 0; at = entry.path.indexOf("/", at + 1)) {
        const parent = entry.path.slice(0, at);
        if (isSaved(parent) && !manifestEntries[parent]) manifestEntries[parent] = ["d", 0o755, entry.mtimeMs];
      }
      if (entry.kind === "dir") manifestEntries[entry.path] = ["d", entry.mode, entry.mtimeMs];
      else if (entry.kind === "symlink") manifestEntries[entry.path] = ["l", entry.mode, entry.mtimeMs, 0, entry.target];
      else {
        const blob = (next++).toString(36);
        const data = entry.data.byteOffset === 0 && entry.data.byteLength === entry.data.buffer.byteLength
          ? entry.data.buffer as ArrayBuffer
          : entry.data.slice().buffer;
        batch.push({ blob, data });
        batchBytes += data.byteLength;
        manifestEntries[entry.path] = ["f", entry.mode, entry.mtimeMs, data.byteLength, blob];
        files += 1;
        bytes += data.byteLength;
        onProgress?.(files);
        if (batchBytes >= SEED_BATCH_BYTES) await flush();
      }
    }
    await flush();
    const manifest: WorkspaceManifest = {
      format: MANIFEST_FORMAT,
      room,
      seq: 1,
      savedAt: Date.now(),
      next,
      files,
      bytes,
      entries: manifestEntries,
      imported: { ...note, files },
    };
    await call({ op: "save", room, manifest, writes: [], drop: [] });
    return { files, bytes };
  } catch (error) {
    await call({ op: "delete", room }).catch(() => {});
    throw error;
  } finally {
    held?.release();
  }
}
