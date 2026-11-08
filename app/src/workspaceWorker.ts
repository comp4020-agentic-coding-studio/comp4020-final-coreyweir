/// <reference lib="webworker" />
// The OPFS side of a saved workspace (docs/adr/0010). It runs in a worker
// because only workers get synchronous access handles, which write a file
// in a fraction of the time `createWritable` takes on the page (that one
// copies through a swap file on every close).
//
// Layout, one directory per room under `riff-workspaces/`:
//   b/<n>            one file's bytes; a new name every time it's saved
//   manifest-0.json  the manifest, alternating between two slots, so a
//   manifest-1.json  crash while writing one leaves the other whole
//
// A save writes its new blobs, then its manifest, then removes the blobs
// only the previous manifest used. Whatever the newest readable manifest
// names is therefore always on disk: a crash costs the save in progress,
// never a mix of two.
import type { WorkspaceManifest, WorkerRequest, WorkerResponse } from "./workspaceFormat";
import { MANIFEST_FORMAT } from "./workspaceFormat";

const ROOT = "riff-workspaces";

async function rootDirectory() {
  const opfs = await navigator.storage.getDirectory();
  return opfs.getDirectoryHandle(ROOT, { create: true });
}

async function roomDirectory(room: string, create: boolean) {
  const root = await rootDirectory();
  try {
    return await root.getDirectoryHandle(room, { create });
  } catch (error) {
    if (!create && (error as DOMException).name === "NotFoundError") return null;
    throw error;
  }
}

async function writeSync(directory: FileSystemDirectoryHandle, name: string, data: Uint8Array) {
  const handle = await directory.getFileHandle(name, { create: true });
  const access = await (handle as FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<{ truncate(n: number): void; write(d: Uint8Array, o: { at: number }): number; flush(): void; close(): void }>;
  }).createSyncAccessHandle();
  try {
    access.truncate(0);
    let at = 0;
    while (at < data.byteLength) at += access.write(data.subarray(at), { at });
    access.flush();
  } finally {
    access.close();
  }
}

async function readManifest(directory: FileSystemDirectoryHandle, slot: number): Promise<WorkspaceManifest | null> {
  try {
    const file = await (await directory.getFileHandle(`manifest-${slot}.json`)).getFile();
    const manifest = JSON.parse(await file.text()) as WorkspaceManifest;
    return manifest?.format === MANIFEST_FORMAT && typeof manifest.seq === "number" ? manifest : null;
  } catch {
    return null;
  }
}

async function newestManifest(directory: FileSystemDirectoryHandle) {
  const [a, b] = await Promise.all([readManifest(directory, 0), readManifest(directory, 1)]);
  if (!a) return b;
  if (!b) return a;
  return a.seq >= b.seq ? a : b;
}

function blobsOf(manifest: WorkspaceManifest) {
  const blobs = new Set<string>();
  for (const entry of Object.values(manifest.entries)) if (entry[0] === "f") blobs.add(entry[4]);
  return blobs;
}

async function load(room: string) {
  const directory = await roomDirectory(room, false);
  if (!directory) return { manifest: null, files: [] };
  const manifest = await newestManifest(directory);
  if (!manifest) return { manifest: null, files: [] };
  const blobDirectory = await directory.getDirectoryHandle("b", { create: true });
  const used = blobsOf(manifest);
  const wanted = Object.entries(manifest.entries).filter((item): item is [string, ["f", number, number, number, string]] => item[1][0] === "f");
  const files: Array<{ path: string; data: ArrayBuffer } | null> = [];
  // A batch at a time: one file after another is dominated by the
  // per-file round trip, all at once by the open-file count.
  for (let at = 0; at < wanted.length; at += 64) {
    files.push(...await Promise.all(wanted.slice(at, at + 64).map(async ([path, entry]) => {
      try {
        const file = await (await blobDirectory.getFileHandle(entry[4])).getFile();
        return { path, data: await file.arrayBuffer() };
      } catch {
        // A blob gone missing costs that file, not the workspace.
        return null;
      }
    })));
  }
  // Blobs no manifest names: a save that crashed before its manifest.
  for await (const name of (blobDirectory as unknown as { keys(): AsyncIterable<string> }).keys()) {
    if (!used.has(name)) await blobDirectory.removeEntry(name).catch(() => {});
  }
  return { manifest, files: files.filter((file) => file !== null) };
}

async function save(request: Extract<WorkerRequest, { op: "save" }>) {
  const directory = await roomDirectory(request.room, true);
  if (!directory) throw new Error("no workspace directory");
  const blobDirectory = await directory.getDirectoryHandle("b", { create: true });
  for (const write of request.writes) await writeSync(blobDirectory, write.blob, new Uint8Array(write.data));
  const manifest = new TextEncoder().encode(JSON.stringify(request.manifest));
  await writeSync(directory, `manifest-${request.manifest.seq % 2}.json`, manifest);
  for (const blob of request.drop) await blobDirectory.removeEntry(blob).catch(() => {});
}

async function list() {
  const root = await rootDirectory();
  const found: Array<{ room: string; savedAt: number; bytes: number; files: number }> = [];
  for await (const [name, handle] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== "directory") continue;
    const manifest = await newestManifest(handle as FileSystemDirectoryHandle);
    if (!manifest) {
      found.push({ room: name, savedAt: 0, bytes: 0, files: 0 });
      continue;
    }
    found.push({ room: name, savedAt: manifest.savedAt, bytes: manifest.bytes, files: manifest.files });
  }
  return found;
}

async function remove(room: string) {
  const root = await rootDirectory();
  await root.removeEntry(room, { recursive: true }).catch((error: DOMException) => {
    if (error.name !== "NotFoundError") throw error;
  });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const reply = (response: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);
  try {
    if (request.op === "load") {
      const loaded = await load(request.room);
      reply({ id: request.id, ok: true, value: loaded }, loaded.files.map((file) => file.data));
    } else if (request.op === "save") {
      await save(request);
      reply({ id: request.id, ok: true, value: null });
    } else if (request.op === "list") {
      reply({ id: request.id, ok: true, value: await list() });
    } else if (request.op === "delete") {
      await remove(request.room);
      reply({ id: request.id, ok: true, value: null });
    }
  } catch (error) {
    reply({ id: request.id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
};
