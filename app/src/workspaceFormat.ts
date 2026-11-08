// What the page and the OPFS worker say to each other about a saved
// workspace (docs/adr/0010).

export const MANIFEST_FORMAT = "riff-workspace-1";

// [kind, mode, mtimeMs, size, blob] for a file, [kind, mode, mtimeMs] for a
// directory, [kind, mode, mtimeMs, 0, target] for a symlink. Arrays rather
// than objects: a workspace with node_modules has tens of thousands.
export type ManifestEntry =
  | ["f", number, number, number, string]
  | ["d", number, number]
  | ["l", number, number, number, string];

export type WorkspaceManifest = {
  format: typeof MANIFEST_FORMAT;
  room: string;
  seq: number;
  savedAt: number;
  // the next blob name to hand out
  next: number;
  files: number;
  bytes: number;
  entries: Record<string, ManifestEntry>;
  /** Set when the workspace was seeded from an export (workspaceImport.ts),
   * for the first boot to say so; later saves leave it out. */
  imported?: ImportedNote;
};

export type ImportedNote = {
  exportedAt: string | null;
  room: string | null;
  files: number;
  transcripts: boolean;
  /** What the export left out, for the host to reinstall. */
  leftOut: Array<{ path: string; reason: string; files: number; bytes: number }>;
  /** Paths skipped or changed on the way in. */
  skipped: number;
  changed: number;
};

export type WorkspaceSummary = { room: string; savedAt: number; bytes: number; files: number };

export type WorkerRequest =
  | { id: number; op: "load"; room: string }
  | { id: number; op: "save"; room: string; manifest: WorkspaceManifest; writes: Array<{ blob: string; data: ArrayBuffer }>; drop: string[] }
  | { id: number; op: "blobs"; room: string; writes: Array<{ blob: string; data: ArrayBuffer }> }
  | { id: number; op: "list" }
  | { id: number; op: "delete"; room: string };

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
