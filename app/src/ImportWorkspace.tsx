// Starting a room from a workspace export, on the host form (docs/adr/0003,
// workspace import). The zip is read and checked here, before any room
// exists; once the room is created its workspace is seeded from it in this
// browser (workspace.ts), and the pod boots from that like any saved
// workspace. Only ever a new room's workspace, so nothing is overwritten.
import { useState } from "react";
import { formatBytes, seedWorkspace } from "./workspace";
import { MAX_ZIP_BYTES, WorkspaceImportError, openWorkspaceExport, type ImportEntry, type WorkspaceArchive } from "./workspaceImport";

export type PickedWorkspace = { archive: WorkspaceArchive; name: string; transcripts: boolean };

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** Seed a just-created room's workspace from the picked export. */
export async function seedFromExport(room: string, picked: PickedWorkspace, secrets: readonly string[]) {
  const entries = picked.archive.entries({ transcripts: picked.transcripts, secrets });
  let outcome = { skipped: [] as unknown[], changed: [] as unknown[] };
  // keep the generator's return value (what was skipped or changed)
  const all: Iterable<ImportEntry> = {
    *[Symbol.iterator]() {
      outcome = yield* entries;
    },
  };
  const { summary } = picked.archive;
  return seedWorkspace(room, all, {
    exportedAt: summary.exportedAt,
    room: summary.room,
    transcripts: picked.transcripts && picked.archive.hasTranscripts,
    leftOut: summary.leftOut,
    get skipped() { return outcome.skipped.length; },
    get changed() { return outcome.changed.length; },
  });
}

export function ImportWorkspace({ picked, repo, onChange }: { picked: PickedWorkspace | null; repo: string; onChange: (picked: PickedWorkspace | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  async function choose(file: File | undefined) {
    setError(null);
    onChange(null);
    if (!file) return;
    if (file.size > MAX_ZIP_BYTES) {
      setError(`That file is ${formatBytes(file.size)}; an import takes up to ${formatBytes(MAX_ZIP_BYTES)}.`);
      return;
    }
    setReading(true);
    try {
      const archive = openWorkspaceExport(new Uint8Array(await file.arrayBuffer()));
      onChange({ archive, name: file.name, transcripts: false });
    } catch (failure) {
      setError(failure instanceof WorkspaceImportError ? failure.message : "Couldn't read that file.");
    } finally {
      setReading(false);
    }
  }

  const summary = picked?.archive.summary;
  return (
    <div className="import-board import-workspace">
      <label>Start from an exported workspace <small>Optional</small>
        <input type="file" accept="application/zip,.zip" disabled={reading} onChange={(event) => void choose(event.target.files?.[0])} />
      </label>
      {reading && <small>Reading...</small>}
      {picked && summary && (
        <>
          <p className="local-note import-summary">
            {summary.room ? <>From room <code>{summary.room}</code>{summary.exportedAt && `, ${new Date(summary.exportedAt).toLocaleString()}`}: </> : null}
            {plural(summary.files, "file")} ({formatBytes(summary.bytes)})
            {summary.branch && <>, branch <code>{summary.branch}</code></>}
            {summary.commits > 0 && <>, {plural(summary.commits, "commit")}{summary.unpushed > 0 && <> ({summary.unpushed.toLocaleString()} not pushed)</>}</>}.
            {" "}It goes into this room's workspace in this browser, uncommitted changes and all.
            {summary.leftOut.length > 0 && <> The export left out {summary.leftOut.map((left) => `${left.path} (${plural(left.files, "file")})`).join(", ")}: reinstall what you need once it's running.</>}
          </p>
          {picked.archive.hasTranscripts && (
            <label className="check">
              <input type="checkbox" checked={picked.transcripts} onChange={(event) => onChange({ ...picked, transcripts: event.target.checked })} />
              <span>Also bring back Claude's transcripts<small>{plural(summary.transcriptFiles, "file")}: everything typed to Claude, and whatever its tools printed. They become Claude's history in this room.</small></span>
            </label>
          )}
          {repo.trim() && <p className="local-note">The Git repository above is ignored for this room: the workspace brings its own.</p>}
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
