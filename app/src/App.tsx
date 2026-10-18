import { useEffect, useRef, useState } from "react";
import { Quickdraw, useQuickdrawStore, type ShapeRecord } from "@quickdrawjs/react";
import { addPrompt, replaceYText, saveName, savedName, type PromptSnapshot, type QueuedPrompt, type RoomMember, useRoom } from "./room";
import {
  type Access, ApiError, createRoom, currentUser, enterRoom, joinRoom, removeMember, roomByCode, rotateCode, setLocked,
  signInUrl, signOut, type User,
} from "./api";
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

// Inside a room the URL names it by its permanent id; a shared link names
// it by its join code, which the host can change.
function goToRoom(roomId: string) {
  location.assign(`${location.pathname}?${new URLSearchParams({ id: roomId })}`);
}

function problem(error: unknown) {
  if (!(error instanceof ApiError)) return "Couldn't reach Riff. Check your connection and try again.";
  switch (error.code) {
    case "no_such_room": return "There's no live room with that code. Check it with the host.";
    case "name_taken": return "Someone in that room already goes by that name. Pick another.";
    case "locked": return "The host has locked that room. Ask them for an invite.";
    case "removed": return "The host removed you from that room.";
    case "bad_name": return "Names need 1 to 40 visible characters.";
    case "slow_down": return "Too many attempts from here. Wait a few minutes and try again.";
    default: return `Something went wrong (${error.code}).`;
  }
}

function useUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    currentUser().then(setUser, () => setUser(null));
  }, []);
  return user;
}

function Account({ user }: { user: User | null | undefined }) {
  if (user === undefined) return <p className="account">&nbsp;</p>;
  if (!user) {
    return (
      <p className="account">
        <a className="github-sign-in" href={signInUrl()}>Sign in with GitHub</a>
        <small>Optional. Signed-in people can be invited and keep their place in a room on any device.</small>
      </p>
    );
  }
  return (
    <p className="account">
      {user.avatarUrl && <img src={user.avatarUrl} alt="" width={20} height={20} crossOrigin="anonymous" />}
      <span>Signed in as <strong>@{user.login}</strong></span>
      <button className="link" onClick={() => signOut().then(() => location.reload())}>Sign out</button>
    </p>
  );
}

function Landing({ code: sharedCode = "" }: { code?: string }) {
  const user = useUser();
  const [mode, setMode] = useState<"join" | "host">(() => new URLSearchParams(location.search).get("setup") === "host" ? "host" : "join");
  const [code, setCode] = useState(sharedCode);
  const [name, setName] = useState(savedName);
  const [config, setConfig] = useState(savedHostConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Signed in, your GitHub login is the default name.
  const shownName = name || (user?.login ?? "");

  function updateConfig(field: keyof SavedHostConfig, value: string) {
    setConfig((current) => ({ ...current, [field]: value }));
  }

  async function submit(action: () => Promise<Access>) {
    setBusy(true);
    setError(null);
    try {
      const access = await action();
      goToRoom(access.room.id);
    } catch (failure) {
      setError(problem(failure));
      setBusy(false);
    }
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
        <Account user={user} />
        <nav><button className={mode === "join" ? "active" : ""} onClick={() => setMode("join")}>Join</button><button className={mode === "host" ? "active" : ""} onClick={() => setMode("host")}>Host</button></nav>
        {mode === "join" ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!code.trim() || !shownName.trim()) return;
            saveName(name);
            void submit(() => joinRoom(code.trim(), shownName.trim()));
          }}>
            <label>Your name<input autoFocus={!sharedCode || undefined} required maxLength={40} value={shownName} onChange={(event) => setName(event.target.value)} placeholder="e.g. Corey" /></label>
            <label>Room code<input required maxLength={16} value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="e.g. K7MQ2P" autoCapitalize="characters" autoComplete="off" /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary" disabled={busy || !code.trim() || !shownName.trim()}>{busy ? "Joining..." : "Join room"}</button>
          </form>
        ) : (
          <form onSubmit={(event) => {
            event.preventDefault();
            saveName(name);
            localStorage.setItem("riff-host-config", JSON.stringify(config));
            void submit(() => createRoom(shownName.trim()));
          }}>
            <label>Your name<input required maxLength={40} value={shownName} onChange={(event) => setName(event.target.value)} placeholder="e.g. Corey" /></label>
            <label>Claude base URL<input type="url" required value={config.baseUrl} onChange={(event) => updateConfig("baseUrl", event.target.value)} /></label>
            <label>API token<input type="password" required value={config.token} onChange={(event) => updateConfig("token", event.target.value)} placeholder="Stored on this device" /></label>
            <label>Git repository <small>Optional</small><input value={config.repo} onChange={(event) => updateConfig("repo", event.target.value)} placeholder="https://github.com/group/project.git" /></label>
            <p className="local-note">These settings stay in this browser and are never included in the room link.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>{busy ? "Creating..." : "Create room"}</button>
          </form>
        )}
      </section>
    </main>
  );
}

function PromptCard({ prompt, canQueue, onQueue, onDelete }: { prompt: PromptSnapshot; canQueue: boolean; onQueue: () => void; onDelete: () => void }) {
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
      <textarea value={prompt.text.toString()} onChange={(event) => replaceYText(prompt.text, event.target.value)} aria-label={`Prompt by ${prompt.author}`} />
      <footer><span>Shared draft</span><button disabled={!canQueue} title={canQueue ? "Add to queue" : "Only the host can queue prompts"} onClick={onQueue}>Queue</button></footer>
    </article>
  );
}

function Staging({ prompts, canQueue, onAdd, onQueue, onDelete }: {
  prompts: PromptSnapshot[];
  canQueue: boolean;
  onAdd: (text: string) => void;
  onQueue: (prompt: PromptSnapshot) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const staged = prompts;

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
        {staged.map((prompt) => <PromptCard key={prompt.id} prompt={prompt} canQueue={canQueue} onQueue={() => onQueue(prompt)} onDelete={() => onDelete(prompt.id)} />)}
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

function RoomView({ roomId, token, queued, facilitator, config, hidden, onDelete, onPreviewUrlChange }: {
  roomId: string;
  token: string | null;
  queued: QueuedPrompt[];
  facilitator: boolean;
  config: HostConfig | null;
  hidden: boolean;
  onDelete: (id: string) => void;
  onPreviewUrlChange: (url: string | null, generation: number) => void;
}) {
  const terminalRef = useRef<TerminalPaneHandle>(null);
  return (
    <section className="crit-room" hidden={hidden} style={hidden ? { display: "none" } : undefined}>
      <TerminalPane ref={terminalRef} roomId={roomId} token={token} facilitator={facilitator} config={config} onPreviewUrlChange={onPreviewUrlChange} />
      <article className="queue">
        <header className="section-title"><h2>Up next</h2><span>{queued.length}</span></header>
        <div className="queue-list">
          {queued.map((prompt, index) => <div className="queue-row" key={prompt.id}><span>{index + 1}</span><p>{prompt.text}</p><small>{prompt.author}</small>{facilitator && <button className="load-prompt" onClick={() => terminalRef.current?.loadPrompt(prompt.text)}>Load</button>}{facilitator && <button onClick={() => onDelete(prompt.id)} aria-label="Remove queued prompt">&times;</button>}</div>)}
          {!queued.length && <p className="empty">The host hasn't queued anything yet.</p>}
        </div>
      </article>
    </section>
  );
}

function PreviewView({ roomId, previewKey, live, generation, facilitator, preview }: {
  roomId: string;
  previewKey: string;
  live: boolean;
  generation: number;
  facilitator: boolean;
  preview: { url: string; revision: number } | null;
}) {
  const localLive = facilitator && preview !== null;
  const [reload, setReload] = useState(0);
  const source = localLive ? preview.url : live && generation > 0
    ? previewRelayUrl(roomId, previewKey, generation)
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

// Who's in the room, as the server says. The host also gets the room's
// controls: a new code, the lock, and removing someone.
function PeoplePanel({ access, room, onClose }: { access: Access; room: ReturnType<typeof useRoom>; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const host = access.member.host;
  const online = new Set(room.participants.map((participant) => participant.memberId));
  const present = room.members.filter((member) => !member.removed);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(problem(failure));
    }
  }

  function remove(member: RoomMember) {
    if (!confirm(`Remove ${member.name} from this room? They lose access straight away.`)) return;
    void act(() => removeMember(access, member.id));
  }

  return (
    <aside className="people-panel" aria-label="People in this room">
      <header className="section-title"><h2>People</h2><button onClick={onClose} aria-label="Close">&times;</button></header>
      <p className="room-code">Code <strong>{room.code}</strong>{room.locked && <small> · locked</small>}</p>
      {host && (
        <div className="room-controls">
          <button onClick={() => act(() => rotateCode(access))} title="The old code stops working; everyone already here stays">New code</button>
          <button onClick={() => act(() => setLocked(access, !room.locked))} title="A locked room takes no new joins by code">{room.locked ? "Unlock" : "Lock"}</button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <ul>
        {present.map((member) => (
          <li key={member.id}>
            <i className={online.has(member.id) ? "online" : "offline"} title={online.has(member.id) ? "Here now" : "Not here"}></i>
            <span>{member.name}</span>
            {member.login ? <small title="Signed in with GitHub">@{member.login}</small> : <small>guest</small>}
            {member.host && <small className="host-tag">host</small>}
            {member.id === access.member.id && <small>you</small>}
            {host && !member.host && <button onClick={() => remove(member)}>Remove</button>}
          </li>
        ))}
      </ul>
      {host && <p className="local-note">If a code leaks: give the room a new code, remove anyone who shouldn't be here, then lock it.</p>}
    </aside>
  );
}

function RoomApp({ access, hostConfig }: { access: Access; hostConfig: HostConfig | null }) {
  const roomId = access.room.id;
  const facilitator = access.member.host;
  const [view, setView] = useState<View>(() => {
    const requested = new URLSearchParams(location.search).get("view");
    return requested === "room" || requested === "preview" ? requested : "board";
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [people, setPeople] = useState(false);
  const [preview, setPreview] = useState<{ url: string; revision: number } | null>(null);
  const store = useQuickdrawStore();
  const room = useRoom(access);

  useBoardSync(room.doc, store);

  function stageSelected() {
    const records = selected.map((id) => store.get(id)).filter((record): record is ShapeRecord => record?.typeName === "shape");
    if (!records.length) return;
    const textRecord = records.find((record) => record.type === "note" || record.type === "text");
    const text = typeof textRecord?.props.text === "string" && textRecord.props.text.trim() ? textRecord.props.text.trim() : `Follow up on ${records.length === 1 ? "this board item" : `these ${records.length} board items`}.`;
    addPrompt(room.doc, room.prompts, room.identity.name, text, records[0].id);
  }

  // The link carries the join code, never the room's id or anyone's secret.
  function copyRoomLink() {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set("room", room.code);
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }

  function handlePreviewUrlChange(url: string | null, generation: number) {
    setPreview((current) => url ? { url, revision: (current?.revision ?? 0) + 1 } : null);
    room.control.transact(() => {
      room.roomState.set("previewLive", Boolean(url));
      room.roomState.set("previewGeneration", generation);
    });
  }

  if (room.shutOut) {
    return (
      <main className="landing">
        <section className="entry-card">
          <h2>You're no longer in this room</h2>
          <p>The host removed you, or the room has ended.</p>
          <button className="primary" onClick={() => location.assign(location.pathname)}>Back to start</button>
        </section>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand brand-button" onClick={() => location.assign(location.pathname)}>riff</button>
        <div className="room-name"><i className={room.status}></i><span>Room {room.code}</span><small>{room.status}</small></div>
        <nav>
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>Board</button>
          <button className={view === "room" ? "active" : ""} onClick={() => setView("room")}>Room</button>
          <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>Preview</button>
        </nav>
        <button className="participants" onClick={() => setPeople((open) => !open)} title="People in this room">{room.participants.slice(0, 4).map((participant) => <span key={participant.clientId} style={{ background: participant.colour }} title={`${participant.name}${participant.role === "facilitator" ? " (host)" : ""}`}>{participant.name.slice(0, 1).toUpperCase()}</span>)}</button>
        <button className="share" onClick={copyRoomLink}>{copied ? "Copied" : "Share room"}</button>
      </header>

      <main className={`workspace ${view === "preview" ? "preview-workspace" : ""}`}>
        {view === "board" && <BoardView store={store} selected={selected} onSelection={setSelected} onStageSelection={stageSelected} />}
        <RoomView roomId={roomId} token={access.token} queued={room.queued} facilitator={facilitator} config={hostConfig} hidden={view !== "room"} onDelete={(id) => room.queue.delete(id)} onPreviewUrlChange={handlePreviewUrlChange} />
        {view === "preview" && <PreviewView roomId={roomId} previewKey={access.member.previewKey} live={room.previewLive} generation={room.previewGeneration} facilitator={facilitator} preview={preview} />}
        {view !== "preview" && <Staging prompts={room.promptSnapshots} canQueue={facilitator} onAdd={(text) => addPrompt(room.doc, room.prompts, room.identity.name, text)} onQueue={room.queuePrompt} onDelete={(id) => room.prompts.delete(id)} />}
        {people && <PeoplePanel access={access} room={room} onClose={() => setPeople(false)} />}
      </main>
    </div>
  );
}

// Works out who this browser is in the room the URL names, before anything
// connects: a shared link (?room=CODE) for someone already in the room goes
// straight in; for anyone else it's the join form with the code filled in.
function RoomGate({ roomId, code }: { roomId: string | null; code: string | null }) {
  const { session } = useGitHubSession();
  const [state, setState] = useState<{ access: Access } | { join: string } | { error: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const id = roomId ?? (await roomByCode(code ?? "")).id;
      const access = await enterRoom(id);
      if (!active) return;
      if (access) {
        if (!roomId) history.replaceState(null, "", `${location.pathname}?${new URLSearchParams({ id: access.room.id })}`);
        setState({ access });
      } else {
        setState(code ? { join: code } : { error: "This browser isn't in that room. Ask the host for the code." });
      }
    })().catch((failure) => active && setState(code && failure instanceof ApiError && failure.status === 404 ? { join: code } : { error: problem(failure) }));
    return () => {
      active = false;
    };
  }, [code, roomId]);

  if (!state) return <main className="landing"><section className="entry-card"><p>Finding the room...</p></section></main>;
  if ("join" in state) return <Landing code={state.join} />;
  if ("error" in state) {
    return (
      <main className="landing">
        <section className="entry-card">
          <p className="form-error" role="alert">{state.error}</p>
          <button className="primary" onClick={() => location.assign(location.pathname)}>Back to start</button>
        </section>
      </main>
    );
  }
  const facilitator = state.access.member.host;
  const storedConfig = facilitator ? savedHostConfig() : null;
  if (storedConfig?.repo && !session) return <GitHubAuthPoc roomGate />;
  const hostConfig = storedConfig && session ? { ...storedConfig, githubToken: session.token } : storedConfig;
  return <RoomApp access={state.access} hostConfig={hostConfig} />;
}

export default function App() {
  const params = new URLSearchParams(location.search);
  if (params.get("poc") === "github-auth") return <GitHubAuthPoc />;
  const roomId = params.get("id")?.replace(/[^\w-]/g, "").slice(0, 64) || null;
  const code = params.get("room")?.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 16).toUpperCase() || null;
  if (!roomId && !code) return <Landing />;
  return <RoomGate roomId={roomId} code={code} />;
}
