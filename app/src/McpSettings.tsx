import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClaudePodController } from "./claudePod";
import type { ClaudeState } from "./queueRelease";
import { GITHUB_TOOLSETS, customProblem, loadMcp, saveMcp, serverName, type CustomMcp, type McpSettings } from "./mcp";
import { WEB_MCP_NAME } from "./webTools";
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
  const [draft, setDraft] = useState<CustomMcp | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const addForm = useRef<HTMLFormElement>(null);
  const drafting = draft !== null;
  // An opened form is scrolled into view whole, above the sticky Apply bar,
  // with the cursor in its first field.
  useEffect(() => {
    if (!drafting) return;
    addForm.current?.scrollIntoView({ block: "end" });
    addForm.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [drafting]);
  // A refusal grows the form: keep Add and the message clear of the bar.
  useEffect(() => {
    if (draftError) addForm.current?.scrollIntoView({ block: "end" });
  }, [draftError]);
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
    setDraft(null);
    setDraftError(null);
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

  function addDraft() {
    if (!draft) return;
    const entry = { name: draft.name.trim(), url: draft.url.trim(), header: draft.header.trim(), value: draft.value };
    // plain http only where the page itself is (the dev server)
    const problem = customProblem(entry, settings.custom, location.protocol === "http:");
    if (problem) return setDraftError(problem);
    setSettings((current) => ({ ...current, custom: [...current.custom, entry] }));
    setDraft(null);
    setDraftError(null);
    setDone(null);
  }

  const github = settings.github;
  const editDraft = (field: keyof CustomMcp) => (event: { target: { value: string } }) => setDraft((current) => current && { ...current, [field]: event.target.value });
  const setGithub = (next: Partial<McpSettings["github"]>) => setSettings((current) => ({ ...current, github: { ...current.github, ...next } }));
  return (
    <>
      {/* The count is the servers the host added; Riff's own web server is always there and not counted. */}
      <button ref={opener} className="mcp-open" title={count ? `MCP servers: ${count} you added, plus Riff's built-in web search` : "MCP servers: Riff's built-in web search, and any you add"} aria-label={count ? `MCPs, ${count} added` : "MCPs"} onClick={show}>MCPs{count ? <span className="mcp-count">{count}</span> : null}</button>
      {open && createPortal(
        <div className="ws-export-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !applying) close(); }}>
          <section className="ws-export mcp-settings" role="dialog" aria-modal="true" aria-labelledby="mcp-title">
            <h2 id="mcp-title">MCP servers</h2>
            <p>Tools Claude can use in this room, from servers you choose. Only you see this, and it stays in this browser. Tokens go only to their own server; Claude sees a stand-in.</p>

            <ul className="mcp-builtin" aria-label="Built in">
              <li><strong>{WEB_MCP_NAME}</strong> <span>(built in)</span><small>Search, and read pages through Jina Reader, from this browser. Always there.</small></li>
            </ul>

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

            <fieldset className="mcp-custom">
              <legend>Other servers</legend>
              {settings.custom.length > 0 && (
                <ul className="mcp-custom-list">
                  {settings.custom.map((entry, index) => (
                    <li key={`${entry.name}-${index}`}>
                      <span><strong>{serverName(entry.name)}</strong><small>{entry.url}{entry.header ? ` · token in ${entry.header}` : " · no token"}</small></span>
                      <button className="link" disabled={applying} onClick={() => setSettings((current) => ({ ...current, custom: current.custom.filter((_, at) => at !== index) }))}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              {draft ? (
                <form ref={addForm} className="mcp-add" aria-label="Add an MCP server" onSubmit={(event) => { event.preventDefault(); addDraft(); }}>
                  <label>Name<input value={draft.name} onChange={editDraft("name")} placeholder="e.g. jina" autoComplete="off" autoCapitalize="none" /></label>
                  <label>URL<input type="url" value={draft.url} onChange={editDraft("url")} placeholder="https://mcp.example.com/mcp" autoComplete="off" /></label>
                  <label>Header <small>Optional</small><input value={draft.header} onChange={editDraft("header")} placeholder="e.g. Authorization" autoComplete="off" autoCapitalize="none" /></label>
                  <label>Value <small>The token, as the header takes it</small><input type="password" value={draft.value} onChange={editDraft("value")} placeholder="e.g. Bearer sk-..." autoComplete="off" /></label>
                  <p className="ws-export-quiet">Riff sends the token only to this server's address, in that one header; Claude sees a stand-in. The server must accept requests from a browser (CORS), and servers that sign you in through their own page (OAuth) won't connect. Many need no token at all.</p>
                  {draftError && <p className="form-error" role="alert">{draftError}</p>}
                  <span className="mcp-add-actions"><button type="submit">Add</button><button type="button" className="link" onClick={() => { setDraft(null); setDraftError(null); }}>Cancel</button></span>
                </form>
              ) : (
                <button className="mcp-add-open" disabled={applying} onClick={() => setDraft({ name: "", url: "", header: "", value: "" })}>Add custom MCP</button>
              )}
            </fieldset>

            <p className="ws-export-quiet">{!running
              ? "Claude uses these when it starts."
              : busy ? `Claude is ${claudeState === "starting" ? "starting" : "working"}: apply when it has finished, since applying restarts it.`
              : "Applying restarts Claude (a few seconds), and it carries on the same conversation."}</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {done && <p className="mcp-done" role="status">{done}</p>}
            <span className="ws-export-actions">
              <button className="ws-export-go" disabled={applying || (running && busy) || draft !== null} title={draft ? "Add the server, or cancel it, first" : undefined} onClick={() => void apply()}>{applying ? "Applying..." : "Apply"}</button>
              <button disabled={applying} onClick={close}>{done ? "Close" : "Cancel"}</button>
            </span>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
