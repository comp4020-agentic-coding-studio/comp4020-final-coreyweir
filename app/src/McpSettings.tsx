import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClaudePodController } from "./claudePod";
import type { ClaudeState } from "./queueRelease";
import { GITHUB_TOOLSETS, loadMcp, saveMcp, type McpSettings } from "./mcp";
import "./mcp.css";

// The host's MCP servers for this room (docs/adr/0012): a button in the
// terminal controls, beside Export. Only the host has it; what's saved stays
// in this browser (mcp.ts).

export function McpSettingsButton({ roomId, getController, hasGithub, claudeState }: {
  roomId: string;
  getController: () => ClaudePodController | null;
  /** The host connected GitHub for pushing: GitHub's MCP uses that token. */
  hasGithub: boolean;
  claudeState?: ClaudeState;
}) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<McpSettings>(() => loadMcp(roomId));
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const saved = loadMcp(roomId);
  const count = (saved.github.on && hasGithub ? 1 : 0) + saved.custom.length;
  const running = getController()?.isRunning() ?? false;
  const busy = claudeState === "working" || claudeState === "starting";

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !applying) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function show() {
    setSettings(loadMcp(roomId));
    setDone(null);
    setError(null);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    opener.current?.focus();
  }

  async function apply() {
    setApplying(true);
    setError(null);
    setDone(null);
    try {
      saveMcp(roomId, settings);
      const restarted = await getController()?.applyMcp(settings);
      setDone(restarted ? "Applied. Claude restarted on the same conversation." : "Saved. Claude uses them when it starts.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setApplying(false);
    }
  }

  const github = settings.github;
  const setGithub = (next: Partial<McpSettings["github"]>) => setSettings((current) => ({ ...current, github: { ...current.github, ...next } }));
  return (
    <>
      <button ref={opener} className="mcp-open" title="MCP servers Claude can use in this room" onClick={show}>MCPs{count ? ` ${count}` : ""}</button>
      {open && createPortal(
        <div className="ws-export-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !applying) close(); }}>
          <section className="ws-export mcp-settings" role="dialog" aria-modal="true" aria-labelledby="mcp-title">
            <h2 id="mcp-title">MCP servers</h2>
            <p>Tools Claude can use in this room, from servers you choose. Only you see this, and it stays in this browser. Tokens go only to their own server; Claude sees a stand-in.</p>

            <fieldset className="mcp-github">
              <label className="ws-export-option">
                <input type="checkbox" checked={github.on && hasGithub} disabled={!hasGithub || applying} onChange={(event) => setGithub({ on: event.target.checked })} />
                <span>GitHub
                  <small>{hasGithub
                    ? "GitHub's MCP server, with the GitHub account you connected for pushing: issues, pull requests, repositories and more."
                    : "Connect GitHub for pushing in the host setup to use it."}</small>
                </span>
              </label>
              {github.on && hasGithub && (
                <div className="mcp-github-options">
                  <div className="mcp-mode" role="radiogroup" aria-label="What Claude may do on GitHub">
                    <label><input type="radio" name="mcp-github-mode" checked={github.readOnly} disabled={applying} onChange={() => setGithub({ readOnly: true })} />Read only</label>
                    <label><input type="radio" name="mcp-github-mode" checked={!github.readOnly} disabled={applying} onChange={() => setGithub({ readOnly: false })} />Read and write<small>Claude can open issues and pull requests, comment and push files as you.</small></label>
                  </div>
                  <div className="mcp-toolsets" role="group" aria-label="GitHub toolsets">
                    {GITHUB_TOOLSETS.map((set) => (
                      <label key={set.id}>
                        <input type="checkbox" checked={github.toolsets.includes(set.id)} disabled={applying} onChange={(event) => setGithub({ toolsets: event.target.checked ? [...github.toolsets, set.id] : github.toolsets.filter((id) => id !== set.id) })} />
                        {set.label}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </fieldset>

            <p className="ws-export-quiet">{!running
              ? "Claude uses these when it starts."
              : busy ? "Claude is working: apply when it has finished, since applying restarts it."
              : "Applying restarts Claude (a few seconds), and it carries on the same conversation."}</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {done && <p className="mcp-done" role="status">{done}</p>}
            <span className="ws-export-actions">
              <button className="ws-export-go" disabled={applying || (running && busy)} onClick={() => void apply()}>{applying ? "Applying..." : "Apply"}</button>
              <button disabled={applying} onClick={close}>{done ? "Close" : "Cancel"}</button>
            </span>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
