// A saved workspace (docs/adr/0010), read straight from its OPFS manifest
// and blobs, as a source workspaceExport.ts can zip: the landing page's
// "Export files" makes the same zip as the workspace's own Export without
// booting a pod.
//
// The manifest names each path it saved (files, directories, symlinks);
// the directories above them (/work, /home/user/.claude/projects, ...) are
// implied. A file whose blob went missing is listed but can't be read, so
// the export says it couldn't read it rather than leaving it out silently.
//
// Types only from the rest of the app, so `npm run test:workspace-export-saved`
// runs it under node.
import type { WorkspaceManifest } from "./workspaceFormat";
import type { SourceStat, WorkspaceSource } from "./workspaceExport";

export function savedWorkspaceSource(manifest: WorkspaceManifest, files: Map<string, ArrayBuffer>): WorkspaceSource {
  const stats = new Map<string, SourceStat>();
  const children = new Map<string, Set<string>>();
  const target = new Map<string, string>();
  const implied: SourceStat = { kind: "dir", size: 0, mode: 0o755, mtimeMs: manifest.savedAt };
  const link = (path: string) => {
    for (let child = path; child !== "/";) {
      const at = child.lastIndexOf("/");
      const parent = at <= 0 ? "/" : child.slice(0, at);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(child.slice(at + 1));
      if (!stats.has(parent)) stats.set(parent, implied);
      child = parent;
    }
  };
  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (entry[0] === "f") stats.set(path, { kind: "file", size: entry[3], mode: entry[1], mtimeMs: entry[2] });
    else if (entry[0] === "d") stats.set(path, { kind: "dir", size: 0, mode: entry[1], mtimeMs: entry[2] });
    else {
      stats.set(path, { kind: "symlink", size: entry[4].length, mode: entry[1], mtimeMs: entry[2] });
      target.set(path, entry[4]);
    }
    link(path);
  }
  return {
    async readdir(path) {
      if (stats.get(path)?.kind !== "dir") throw new Error(`ENOTDIR: ${path}`);
      return [...(children.get(path) ?? [])];
    },
    async lstat(path) {
      return stats.get(path) ?? null;
    },
    async readFile(path) {
      const data = files.get(path);
      if (!data) throw new Error(`ENOENT: ${path} (its saved copy is missing)`);
      return new Uint8Array(data);
    },
    async readlink(path) {
      const to = target.get(path);
      if (to === undefined) throw new Error(`EINVAL: ${path}`);
      return to;
    },
  };
}
