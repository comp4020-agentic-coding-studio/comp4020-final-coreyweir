import { useEffect, useRef, useState } from "react";
import { Quickdraw, useQuickdrawStore, type ShapeRecord } from "@quickdrawjs/react";
import { addPrompt, replaceYText, savedIdentityName, setIdentityName, type PromptSnapshot, useRoom } from "./room";
import { useBoardSync } from "./boardSync";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import type { HostConfig } from "./claudePod";
import { GitHubAuthPoc } from "./GitHubAuthPoc";
import { useGitHubSession } from "./GitHubSession";
import { previewRelayUrl } from "./previewChannel";

type View = "board" | "room" | "preview";
type SavedHostConfig = Pick<HostConfig, "baseUrl" | "token" | "repo">;
const DEFAULT_HOST_CONFIG: SavedHostConfig = {
  baseUrl: "https://api.anthropic.com",
  token: "",
  repo: "",
};

function currentRoom() {
  return new URLSearchParams(location.search).get("room")?.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24) ?? "";
}

function savedHostConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem("riff-host-config") ?? "{}") as Partial<SavedHostConfig>;
    return {
      baseUrl: typeof saved.baseUrl === "string" ? saved.baseUrl : DEFAULT_HOST_CONFIG.baseUrl,
      token: typeof saved.token === "string" ? saved.token : DEFAULT_HOST_CONFIG.token,
      repo: typeof saved.repo === "string" ? saved.repo : DEFAULT_HOST_CONFIG.repo,
    };
  } catch {
    return DEFAULT_HOST_CONFIG;
  }
}

function enterRoom(room: string, host: boolean) {
  const params = new URLSearchParams({ room: room.toUpperCase() });
  if (host) params.set("host", "1");
  location.assign(`${location.pathname}?${params}`);
}

function Landing() {
  const [mode, setMode] = useState<"join" | "host">(() => new URLSearchParams(location.search).get("setup") === "host" ? "host" : "join");
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState(savedIdentityName);
  const [config, setConfig] = useState(savedHostConfig);

  function updateConfig(field: keyof SavedHostConfig, value: string) {
    setConfig((current) => ({ ...current, [field]: value }));
  }

  return (
    <main className="landing">
      <header><strong className="brand">riff</strong><span>Collaborative design crits</span></header>
      <section className="landing-copy">
        <span className="overline">A shared studio for small groups</span>
        <h1>Look together.<br />Make a suggestion.<br />Try it live.</h1>
        <p>Sketch ideas, shape prompts, follow the agent’s work, and discuss the site as it changes.</p>
      </section>
      <section className="entry-card">
        <nav><button className={mode === "join" ? "active" : ""} onClick={() => setMode("join")}>Join</button><button className={mode === "host" ? "active" : ""} onClick={() => setMode("host")}>Host</button></nav>
        {mode === "join" ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!roomId.trim() || !name.trim()) return;
            setIdentityName(name);
            enterRoom(roomId.trim(), false);
          }}>
            <label>Your name<input autoFocus required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Corey" /></label>
            <label>Room ID<input required maxLength={24} value={roomId} onChange={(event) => setRoomId(event.target.value.toUpperCase())} placeholder="e.g. PLUM27" /></label>
            <button className="primary" disabled={!roomId.trim() || !name.trim()}>Join room</button>
          </form>
        ) : (
          <form onSubmit={(event) => {
            event.preventDefault();
            setIdentityName(name);
            localStorage.setItem("riff-host-config", JSON.stringify(config));
            enterRoom(Math.random().toString(36).slice(2, 8), true);
          }}>
            <label>Your name<input required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Corey" /></label>
            <label>Claude base URL<input type="url" required value={config.baseUrl} onChange={(event) => updateConfig("baseUrl", event.target.value)} /></label>
            <label>API token<input type="password" required value={config.token} onChange={(event) => updateConfig("token", event.target.value)} placeholder="Stored on this device" /></label>
            <label>Git repository <small>Optional</small><input value={config.repo} onChange={(event) => updateConfig("repo", event.target.value)} placeholder="https://github.com/group/project.git" /></label>
            <p className="local-note">These settings stay in this browser and are never included in the room link.</p>
            <button className="primary">Create room</button>
          </form>
        )}
      </section>
    </main>
  );
}

function PromptCard({ prompt, canQueue, onDelete }: { prompt: PromptSnapshot; canQueue: boolean; onDelete: () => void }) {
  const [, render] = useState(0);

  useEffect(() => {
    const update = () => render((version) => version + 1);
    prompt.text.observe(update);
    return () => prompt.text.unobserve(update);
  }, [prompt.text]);

  return (
    <article className="prompt-card">
      <header>
        <span className="author-dot">{prompt.author.slice(0, 1).toUpperCase()}</span><span>{prompt.author}</span>
        {prompt.sourceId && <small>From board</small>}
        <button onClick={onDelete} aria-label="Delete prompt">&times;</button>
      </header>
      <textarea value={prompt.text.toString()} onChange={(event) => replaceYText(prompt.text, event.target.value)} aria-label={`Prompt by ${prompt.author}`} readOnly={prompt.status === "queued"} />
      {prompt.status === "staged" && (
        <footer><span>Shared draft</span><button disabled={!canQueue} title={canQueue ? "Add to queue" : "Only the facilitator can queue prompts"} onClick={() => {
          prompt.map.doc?.transact(() => {
            prompt.map.set("status", "queued");
            prompt.map.set("rank", Date.now());
          });
        }}>Queue</button></footer>
      )}
    </article>
  );
}

function Staging({ prompts, canQueue, onAdd, onDelete }: {
  prompts: PromptSnapshot[];
  canQueue: boolean;
  onAdd: (text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const staged = prompts.filter((prompt) => prompt.status === "staged");

  return (
    <aside className="staging">
      <header className="section-title"><h2>Staging</h2><span>{staged.length}</span></header>
      <form className="new-prompt" onSubmit={(event) => {
        event.preventDefault();
        if (!draft.trim()) return;
        onAdd(draft.trim());
        setDraft("");
      }}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a thought for the group..." />
        <button disabled={!draft.trim()}>Stage prompt</button>
      </form>
      <div className="prompt-list">
        {staged.map((prompt) => <PromptCard key={prompt.id} prompt={prompt} canQueue={canQueue} onDelete={() => onDelete(prompt.id)} />)}
        {!staged.length && <p className="empty">Ideas staged from the board will appear here.</p>}
      </div>
    </aside>
  );
}

function BoardView({ store, selected, onSelection, onStageSelection }: {
  store: ReturnType<typeof useQuickdrawStore>;
  selected: string[];
  onSelection: (ids: string[]) => void;
  onStageSelection: () => void;
}) {
  return (
    <section className="board-wrap">
      <div className="board-actions"><span>Draw, write, paste images, or move things around.</span><button disabled={!selected.length} onClick={onStageSelection}>Stage selected</button></div>
      <Quickdraw
        className="quickdraw-surface"
        store={store}
        grid="dots"
        theme="light"
        styles={{ dash: "solid" }}
        themeToggle={false}
        watermark={false}
        onSelectionChange={onSelection}
      />
    </section>
  );
}

function RoomView({ roomId, prompts, facilitator, config, hidden, onDelete, onPreviewUrlChange }: {
  roomId: string;
  prompts: PromptSnapshot[];
  facilitator: boolean;
  config: HostConfig | null;
  hidden: boolean;
  onDelete: (id: string) => void;
  onPreviewUrlChange: (url: string | null, generation: number) => void;
}) {
  const queued = prompts.filter((prompt) => prompt.status === "queued");
  const terminalRef = useRef<TerminalPaneHandle>(null);
  return (
    <section className="crit-room" hidden={hidden} style={hidden ? { display: "none" } : undefined}>
      <TerminalPane ref={terminalRef} roomId={roomId} facilitator={facilitator} config={config} onPreviewUrlChange={onPreviewUrlChange} />
      <article className="queue">
        <header className="section-title"><h2>Up next</h2><span>{queued.length}</span></header>
        <div className="queue-list">
          {queued.map((prompt, index) => <div className="queue-row" key={prompt.id}><span>{index + 1}</span><p>{prompt.text.toString()}</p><small>{prompt.author}</small>{facilitator && <button className="load-prompt" onClick={() => terminalRef.current?.loadPrompt(prompt.text.toString())}>Load</button>}{facilitator && <button onClick={() => onDelete(prompt.id)} aria-label="Remove queued prompt">&times;</button>}</div>)}
          {!queued.length && <p className="empty">The facilitator has not queued anything yet.</p>}
        </div>
      </article>
    </section>
  );
}

function PreviewView({ roomId, live, generation, facilitator, preview }: {
  roomId: string;
  live: boolean;
  generation: number;
  facilitator: boolean;
  preview: { url: string; revision: number } | null;
}) {
  const localLive = facilitator && preview !== null;
  const [reload, setReload] = useState(0);
  const source = localLive ? preview.url : live && generation > 0
    ? previewRelayUrl(roomId, generation)
    : null;
  return (
    <section className="preview-pane">
      <header className="preview-heading"><div><h2>Preview</h2><span className={live ? "live" : "offline"}><i></i>{live ? "Live" : "Not live"}</span></div>{source && <nav className="preview-actions"><button onClick={() => setReload((value) => value + 1)}>Refresh</button>{localLive && <a href={source} target="_blank" rel="noreferrer">Open in new tab</a>}</nav>}</header>
      {source ? <iframe className="preview-frame" key={`${generation}:${preview?.revision ?? 0}:${reload}`} src={source} title="Workspace preview" sandbox={facilitator ? undefined : "allow-forms allow-modals allow-scripts"} /> : <div className="preview-empty">
        {live ? <><span className="preview-icon live-icon"></span><h3>Preview is connecting</h3><p>Waiting for the facilitator's preview relay.</p></> : <><span className="preview-icon"></span><h3>No preview yet</h3><p>Start a development server in the workspace to show it here.</p></>}
      </div>}
    </section>
  );
}

function RoomApp({ roomId, facilitator, hostConfig }: { roomId: string; facilitator: boolean; hostConfig: HostConfig | null }) {
  const [view, setView] = useState<View>(() => {
    const requested = new URLSearchParams(location.search).get("view");
    return requested === "room" || requested === "preview" ? requested : "board";
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState<{ url: string; revision: number } | null>(null);
  const store = useQuickdrawStore();
  const room = useRoom(roomId, facilitator);

  useBoardSync(room.doc, store);

  function stageSelected() {
    const records = selected.map((id) => store.get(id)).filter((record): record is ShapeRecord => record?.typeName === "shape");
    if (!records.length) return;
    const textRecord = records.find((record) => record.type === "note" || record.type === "text");
    const text = typeof textRecord?.props.text === "string" && textRecord.props.text.trim() ? textRecord.props.text.trim() : `Follow up on ${records.length === 1 ? "this board item" : `these ${records.length} board items`}.`;
    addPrompt(room.doc, room.prompts, room.identity.name, text, records[0].id);
  }

  function copyRoomLink() {
    const url = new URL(location.href);
    url.searchParams.delete("host");
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }

  function handlePreviewUrlChange(url: string | null, generation: number) {
    setPreview((current) => url ? { url, revision: (current?.revision ?? 0) + 1 } : null);
    room.doc.transact(() => {
      room.roomState.set("previewLive", Boolean(url));
      room.roomState.set("previewGeneration", generation);
    });
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand brand-button" onClick={() => location.assign(location.pathname)}>riff</button>
        <div className="room-name"><i className={room.status}></i><span>Room {roomId}</span><small>{room.status}</small></div>
        <nav>
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>Board</button>
          <button className={view === "room" ? "active" : ""} onClick={() => setView("room")}>Room</button>
          <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>Preview</button>
        </nav>
        <div className="participants">{room.participants.slice(0, 4).map((participant) => <span key={participant.clientId} style={{ background: participant.colour }} title={`${participant.name}${participant.role === "facilitator" ? " (facilitator)" : ""}`}>{participant.name.slice(0, 1).toUpperCase()}</span>)}</div>
        <button className="share" onClick={copyRoomLink}>{copied ? "Copied" : "Share room"}</button>
      </header>

      <main className={`workspace ${view === "preview" ? "preview-workspace" : ""}`}>
        {view === "board" && <BoardView store={store} selected={selected} onSelection={setSelected} onStageSelection={stageSelected} />}
        <RoomView roomId={roomId} prompts={room.promptSnapshots} facilitator={facilitator} config={hostConfig} hidden={view !== "room"} onDelete={(id) => room.prompts.delete(id)} onPreviewUrlChange={handlePreviewUrlChange} />
        {view === "preview" && <PreviewView roomId={roomId} live={room.previewLive} generation={room.previewGeneration} facilitator={facilitator} preview={preview} />}
        {view !== "preview" && <Staging prompts={room.promptSnapshots} canQueue={facilitator} onAdd={(text) => addPrompt(room.doc, room.prompts, room.identity.name, text)} onDelete={(id) => room.prompts.delete(id)} />}
      </main>
    </div>
  );
}

export default function App() {
  const { session } = useGitHubSession();
  if (new URLSearchParams(location.search).get("poc") === "github-auth") return <GitHubAuthPoc />;
  const roomId = currentRoom();
  if (!roomId) return <Landing />;
  const facilitator = new URLSearchParams(location.search).get("host") === "1";
  const storedConfig = facilitator ? savedHostConfig() : null;
  if (storedConfig?.repo && !session) return <GitHubAuthPoc roomGate />;
  const hostConfig = storedConfig && session ? { ...storedConfig, githubToken: session.token } : storedConfig;
  return <RoomApp roomId={roomId} facilitator={facilitator} hostConfig={hostConfig} />;
}
