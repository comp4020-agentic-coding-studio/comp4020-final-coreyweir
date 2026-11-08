// "Export files" on a room's row of the landing page: the same zip as the
// workspace's own Export (docs/adr/0003, workspace export), made from what
// this browser saved (docs/adr/0010) without booting a pod. Only where this
// browser has the room's workspace, which is the host's browser.
import { WorkspaceExport } from "./WorkspaceExport";
import { readSavedWorkspace } from "./workspace";
import { exportWorkspace } from "./workspaceExport";
import { savedWorkspaceSource } from "./savedWorkspaceSource";
import type { WorkspaceSummary } from "./workspaceFormat";

export function ExportFiles({ workspace, code, secrets }: { workspace: WorkspaceSummary; code: string | null; secrets: () => Promise<string[]> }) {
  return (
    <WorkspaceExport
      ready
      label="Export files"
      className="link"
      note={<>From the files this browser saved for the room{workspace.savedAt ? `, last at ${new Date(workspace.savedAt).toLocaleString()}` : ""}. If the room is open in another tab, export from there.</>}
      exporter={async (options) => {
        // the real tokens, so they can't travel if one turned up (ADR 0007)
        const held = await secrets();
        return readSavedWorkspace(workspace.room, (manifest, files) => exportWorkspace(savedWorkspaceSource(manifest, files), { ...options, room: code ?? undefined, secrets: held }));
      }}
    />
  );
}
