import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClaudePodController } from "./claudePod";
import type { ExportOptions, ExportResult, Manifest } from "./workspaceExport";

// The host's way out with their workspace (README: no lock-in for the
// filesystem). A button in the terminal controls opens this; what the zip
// holds and leaves out is decided in workspaceExport.ts, and the manifest
// it writes is what the summary here reads.

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Summary({ name, bytes, manifest }: { name: string; bytes: number; manifest: Manifest }) {
  const left = manifest.left.filter((entry) => entry.reason === "dependencies" || entry.reason === "transcripts" || entry.reason === "unreadable");
  const sessionLeft = manifest.left.find((entry) => entry.reason === "session");
  const cleaned = manifest.changed.length;
  const unpushed = manifest.history?.unpushed ?? 0;
  return (
    <div className="ws-export-summary" role="status">
      <p><strong>{name}</strong> ({size(bytes)}): {plural(manifest.files, "file")}
        {manifest.transcriptFiles > 0 && <>, and {plural(manifest.transcriptFiles, "Claude transcript")}</>}.</p>
      {manifest.history && <p>{unpushed > 0 ? `${plural(unpushed, "commit")} that no remote branch has ${unpushed === 1 ? "is" : "are"} in it, listed in riff-workspace.json.` : "Every commit is already on a remote branch."}</p>}
      {left.length > 0 && <p>Left out: {left.map((entry) => {
        const what = entry.reason === "unreadable" ? "couldn't be read" : `${plural(entry.files, "file")}, ${size(entry.bytes)}`;
        return `${entry.path.replace(/^repo\//, "")} (${what})`;
      }).join("; ")}.</p>}
      {sessionLeft && <p className="ws-export-quiet">Riff's own session files ({size(sessionLeft.bytes)}) are never included.</p>}
      {cleaned > 0 && <p>Cleaned: {plural(cleaned, "place")} where a token Riff holds turned up ({manifest.changed.map((entry) => entry.path.replace(/^repo\//, "")).join(", ")}).</p>}
    </div>
  );
}

// ready: the workspace has booted. The controller exists from the moment
// booting starts, so it can't be the test: an export then has no files yet.
// exporter: where the zip comes from instead of the running pod (the landing
// page's "Export files" reads the saved workspace); label and className are
// its button's.
type Exporter = (options: Omit<ExportOptions, "secrets">) => Promise<ExportResult>;
export function WorkspaceExport({ getController, ready, exporter, label = "Export", className, note }: { getController?: () => ClaudePodController | null; ready: boolean; exporter?: Exporter; label?: string; className?: string; note?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [transcripts, setTranscripts] = useState(true);
  const [dependencies, setDependencies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; bytes: number; manifest: Manifest } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  function close() {
    setOpen(false);
    opener.current?.focus();
  }

  async function run() {
    const controller = getController?.();
    const make: Exporter | undefined = exporter ?? (controller ? (options) => controller.exportWorkspace(options) : undefined);
    if (!make) return;
    setBusy(true);
    setError(null);
    setDone(null);
    setProgress(0);
    try {
      const result = await make({ transcripts, dependencies, onProgress: ({ files }) => setProgress(files) });
      download(result.blob, result.name);
      setDone({ name: result.name, bytes: result.blob.size, manifest: result.manifest });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <>
      <button ref={opener} className={className} disabled={!ready} title={ready ? "Download the workspace as a zip" : "There's a workspace to export once Claude or Bash has started"} onClick={() => setOpen(true)}>{label}</button>
      {/* In the body, not here: the terminal header's own styles would reach it. */}
      {open && createPortal(
        <div className="ws-export-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
          <section className="ws-export" role="dialog" aria-modal="true" aria-labelledby="ws-export-title">
            <h2 id="ws-export-title">Export workspace</h2>
            <p>A zip of the workspace folder (<code>/work/repo</code>). It includes <code>.git</code>, so commits you haven't pushed are in it, and it unzips into an ordinary project folder.</p>
            {note && <p>{note}</p>}
            <label className="ws-export-option">
              <input type="checkbox" checked={transcripts} disabled={busy} onChange={(event) => setTranscripts(event.target.checked)} />
              <span>Include Claude's session transcripts<small>Everything typed to Claude in this room, and what its tools printed. Anyone who gets the file can read it.</small></span>
            </label>
            <label className="ws-export-option">
              <input type="checkbox" checked={dependencies} disabled={busy} onChange={(event) => setDependencies(event.target.checked)} />
              <span>Include <code>node_modules</code> and other dependency folders<small>Also <code>.venv</code> and <code>__pycache__</code>. Left out unless you tick this: they can be rebuilt, and can be huge.</small></span>
            </label>
            <p className="ws-export-quiet">Files in your project go as they are (a <code>.env</code>, say). Riff's own session files never go, and any token Riff holds for you is blanked if it turns up. The git history is in Nodepod's own format: outside Riff, read the commit list in <code>riff-workspace.json</code>.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {done && <Summary name={done.name} bytes={done.bytes} manifest={done.manifest} />}
            <span className="ws-export-actions">
              <button className="ws-export-go" disabled={busy} onClick={() => void run()}>{busy ? `Zipping${progress ? `, ${progress.toLocaleString()} files` : ""}...` : done ? "Download again" : "Download zip"}</button>
              <button disabled={busy} onClick={close}>{done ? "Close" : "Cancel"}</button>
            </span>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
