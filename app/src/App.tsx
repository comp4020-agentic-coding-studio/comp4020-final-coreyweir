import { useEffect, useRef, useState } from "react";
import { Quickdraw, useQuickdrawStore, type ShapeRecord } from "@quickdrawjs/react";
import { addPrompt, replaceYText, saveName, savedName, type PromptSnapshot, type QueuedPrompt, type RoomMember, useRoom } from "./room";
import {
  type Access, ApiError, createRoom, currentUser, enterRoom, joinRoom, removeMember, roomByCode, rotateCode, setLocked,
  acceptInvite, addColleague, cancelInvite, declineInvite, inviteToRoom, listColleagues, removeColleague, watchRooms,
  type Colleagues, type ListedRoom, type RoomList,
  forgetPushToken, hasPushToken, sealPastedToken, signInUrl, signOut, unwrapPushToken, type User,
} from "./api";
import { useBoardSync } from "./boardSync";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import type { HostConfig } from "./claudePod";
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

function problem(error: unknown, login?: string) {
  if (!(error instanceof ApiError)) return "Couldn't reach Riff. Check your connection and try again.";
  switch (error.code) {
    case "no_such_github_user": return `No GitHub user called ${login ?? "that"}.`;
    case "bad_login": return "That isn't a GitHub username.";
    case "that_is_you": return "That's you.";
    case "github_unreachable": return "Couldn't reach GitHub to look that up. Try again in a moment.";
    case "no_such_invite": return "That invite has gone: the host cancelled it, or the room ended.";
    case "signed_out": return "Sign in with GitHub first.";
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

function Account({ user, onColleagues }: { user: User | null | undefined; onColleagues?: () => void }) {
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
      {onColleagues && <button className="link" onClick={onColleagues}>Colleagues</button>}
      <button className="link" onClick={() => signOut().then(() => location.reload())}>Sign out</button>
    </p>
  );
}

// "GitHub for pushing" in host setup. Connecting is a GitHub sign-in with
// the repo scope; the token comes back sealed for this session (api.ts).
// A pasted token (for an org that hasn't approved Riff's OAuth app) must
// be the signed-in user's own, so the paste needs a sign-in first.
function GitHubPush({ user, beforeLeaving, back }: { user: User | null | undefined; beforeLeaving?: () => void; back: string }) {
  const [connected, setConnected] = useState(hasPushToken);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (user === undefined) return null;
  const linked = connected && user !== null;

  async function paste() {
    setBusy(true);
    setError(null);
    try {
      await sealPastedToken(pasted.trim());
      setPasted("");
      setPasting(false);
      setConnected(true);
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : "";
      setError(code === "not_yours" ? `That token isn't @${user?.login}'s. Paste one of your own.`
        : code === "bad_token" ? "GitHub didn't accept that token."
        : problem(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="github-push">
      <span className="github-push-label">GitHub for pushing <small>Optional</small></span>
      {linked ? (
        <p>Connected as <strong>@{user.login}</strong>. Claude can push with your access. <button type="button" className="link" onClick={() => { forgetPushToken(); setConnected(false); }}>Disconnect</button></p>
      ) : (
        <>
          <p>
            <a className="github-sign-in" href={signInUrl("push", back)} onClick={() => beforeLeaving?.()}>Connect GitHub</a>
            {!pasting && <button type="button" className="link" onClick={() => setPasting(true)}>or paste a token</button>}
          </p>
          {pasting && (user ? (
            <span className="github-push-paste">
              <input type="password" aria-label="GitHub token" value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="github_pat_..." autoComplete="off" />
              <button type="button" disabled={busy || !pasted.trim()} onClick={() => void paste()}>{busy ? "Checking..." : "Use token"}</button>
            </span>
          ) : <small>Sign in with GitHub first: a pasted token has to be your own.</small>)}
          {error && <small className="form-error" role="alert">{error}</small>}
        </>
      )}
    </div>
  );
}

// The rooms list as the server keeps it, live (docs/adr/0008).
function useRoomList() {
  const [list, setList] = useState<RoomList | null>(null);
  useEffect(() => watchRooms(setList), []);
  return list;
}

function useNow(every = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

function minutesSince(at: number | null, now: number) {
  return Math.max(1, Math.round((now - (at ?? now)) / 60_000));
}

function hostPresence(room: ListedRoom, now: number) {
  if (room.state === "live") return room.role === "host" ? "You're hosting it" : `${room.hostName} is hosting`;
  const away = `away for ${minutesSince(room.hostLastSeen, now)} min`;
  return room.role === "host" ? `You host it · ${away}` : `Host ${away}`;
}

// Invites first, then the rooms you're in: by GitHub account when signed
// in, by this browser's guest secrets otherwise. Never anyone else's.
function YourRooms({ name }: { name: string }) {
  const list = useRoomList();
  const now = useNow();
  const [renaming, setRenaming] = useState<{ roomId: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!list || (!list.rooms.length && !list.invites.length)) return null;

  async function accept(roomId: string, chosen?: string) {
    setBusy(roomId);
    setError(null);
    try {
      const access = await acceptInvite(roomId, chosen?.trim() || undefined);
      goToRoom(access.room.id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "name_taken") setRenaming({ roomId, name: chosen ?? name });
      setError(problem(failure));
      setBusy(null);
    }
  }

  async function decline(roomId: string) {
    setError(null);
    try {
      await declineInvite(roomId);
    } catch (failure) {
      setError(problem(failure));
    }
  }

  return (
    <section className="your-rooms" aria-label="Your rooms">
      <h2>Your rooms</h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      <ul>
        {list.invites.map((invite) => (
          <li key={`invite-${invite.roomId}`} className="invite">
            <span><strong>{invite.invitedBy}</strong> invited you to <code>{invite.code}</code></span>
            {renaming?.roomId === invite.roomId ? (
              <form onSubmit={(event) => { event.preventDefault(); void accept(invite.roomId, renaming.name); }}>
                <input aria-label="Your name in that room" required maxLength={40} value={renaming.name} onChange={(event) => setRenaming({ roomId: invite.roomId, name: event.target.value })} />
                <button disabled={busy === invite.roomId || !renaming.name.trim()}>Join</button>
              </form>
            ) : (
              <span className="actions">
                <button disabled={busy === invite.roomId} onClick={() => void accept(invite.roomId, name)}>{busy === invite.roomId ? "Joining..." : "Join"}</button>
                <button className="link" onClick={() => void decline(invite.roomId)}>Decline</button>
              </span>
            )}
          </li>
        ))}
        {list.rooms.map((room) => (
          <li key={room.id}>
            <button className="room-link" onClick={() => goToRoom(room.id)}>Room <code>{room.code}</code></button>
            <small><i className={room.state}></i>{hostPresence(room, now)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Your colleagues: private and one-way. Adding someone tells them nothing
// and lets them into nothing; they become suggestions when you invite.
function ColleaguesPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Colleagues | null>(null);
  const [login, setLogin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => listColleagues().then(setData, (failure) => setError(problem(failure)));
  useEffect(() => {
    void refresh();
  }, []);

  async function act(action: () => Promise<unknown>, typed?: string) {
    setError(null);
    try {
      await action();
      setLogin("");
      await refresh();
    } catch (failure) {
      setError(problem(failure, typed));
    }
  }

  const recent = data?.recent.filter((person) => !person.colleague) ?? [];
  return (
    <section className="colleagues" aria-label="Colleagues">
      <header><h2>Colleagues</h2><button className="link" onClick={onClose}>Done</button></header>
      <p>Only you see this list. Adding someone doesn't tell them or let them into anything; it puts them first when you invite.</p>
      <form onSubmit={(event) => { event.preventDefault(); const typed = login.trim().replace(/^@/, ""); if (typed) void act(() => addColleague(typed), typed); }}>
        <input aria-label="GitHub username" value={login} onChange={(event) => setLogin(event.target.value)} placeholder="GitHub username" autoComplete="off" autoCapitalize="none" />
        <button disabled={!login.trim()}>Add</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!data ? <small>Loading...</small> : (
        <>
          <ul>
            {data.colleagues.map((person) => (
              <li key={person.githubId}><span>@{person.login}</span><button className="link" onClick={() => void act(() => removeColleague(person.githubId))}>Remove</button></li>
            ))}
            {!data.colleagues.length && <li><small>No colleagues yet.</small></li>}
          </ul>
          {recent.length > 0 && (
            <>
              <h3>Recently worked together</h3>
              <ul>
                {recent.map((person) => (
                  <li key={person.githubId}><span>@{person.login}</span><button className="link" onClick={() => void act(() => addColleague(person.login))}>Add</button></li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
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
  const [colleagues, setColleagues] = useState(false);
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
        <Account user={user} onColleagues={() => setColleagues((open) => !open)} />
        {colleagues ? <ColleaguesPanel onClose={() => setColleagues(false)} /> : <>
        <YourRooms name={shownName} />
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
            <GitHubPush user={user} back="/?setup=host" beforeLeaving={() => { saveName(name); localStorage.setItem("riff-host-config", JSON.stringify(config)); }} />
            <p className="local-note">These settings stay in this browser and are never included in the room link.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>{busy ? "Creating..." : "Create room"}</button>
          </form>
        )}
        </>}
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

function RoomView({ roomId, token, queued, facilitator, config, hidden, onSend, onDelete, onPreviewUrlChange }: {
  roomId: string;
  token: string | null;
  queued: QueuedPrompt[];
  facilitator: boolean;
  config: HostConfig | null;
  hidden: boolean;
  onSend: (id: string) => void;
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
          {queued.map((prompt, index) => <div className="queue-row" key={prompt.id}><span>{index + 1}</span><p>{prompt.text}</p><small>{prompt.author}</small>{facilitator && <button className="load-prompt" onClick={() => { if (terminalRef.current?.loadPrompt(prompt.text)) onSend(prompt.id); }}>Load</button>}{facilitator && <button onClick={() => onDelete(prompt.id)} aria-label="Remove queued prompt">&times;</button>}</div>)}
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

// The host invites by GitHub username. The reply is the same whether or
// not that person has ever used Riff, so it can't be used to find out.
// Colleagues and recent co-workers are suggestions; invites still pending
// come from the live rooms list and can be cancelled.
function InviteBox({ access, members }: { access: Access; members: RoomMember[] }) {
  const user = useUser();
  const list = useRoomList();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = list?.rooms.find((room) => room.id === access.room.id)?.invites ?? [];

  useEffect(() => {
    if (!user) return;
    listColleagues().then(({ colleagues, recent }) => {
      setSuggestions([...new Set([...colleagues, ...recent].map((person) => person.login))]);
    }, () => {});
  }, [user]);

  const here = new Set(members.filter((member) => !member.removed && member.login).map((member) => member.login!.toLowerCase()));
  const offered = suggestions.filter((suggestion) => !here.has(suggestion.toLowerCase()));

  async function invite(typed: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { invited } = await inviteToRoom(access, typed);
      setLogin("");
      setMessage(`Invited @${invited.login}. They'll see it when they sign in.`);
    } catch (failure) {
      setError(problem(failure, typed));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(githubId: number) {
    setError(null);
    try {
      await cancelInvite(access, githubId);
    } catch (failure) {
      setError(problem(failure));
    }
  }

  return (
    <div className="invite-box">
      <form onSubmit={(event) => { event.preventDefault(); const typed = login.trim().replace(/^@/, ""); if (typed) void invite(typed); }}>
        <label htmlFor="riff-invite">Invite by GitHub username</label>
        <span>
          <input id="riff-invite" list="riff-invite-suggestions" value={login} onChange={(event) => setLogin(event.target.value)} placeholder="username" autoComplete="off" autoCapitalize="none" />
          <button disabled={busy || !login.trim()}>{busy ? "Inviting..." : "Invite"}</button>
        </span>
        <datalist id="riff-invite-suggestions">{offered.map((suggestion) => <option key={suggestion} value={suggestion} />)}</datalist>
      </form>
      {message && <p className="invite-sent" role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {pending.length > 0 && (
        <ul className="pending-invites" aria-label="Invited, not joined yet">
          {pending.map((invite) => (
            <li key={invite.githubId}><span>@{invite.login}</span><small>invited</small><button onClick={() => void cancel(invite.githubId)}>Cancel</button></li>
          ))}
        </ul>
      )}
    </div>
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
      {host && <InviteBox access={access} members={room.members} />}
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
        <RoomView roomId={roomId} token={access.token} queued={room.queued} facilitator={facilitator} config={hostConfig} hidden={view !== "room"} onSend={room.sendQueued} onDelete={(id) => room.queue.delete(id)} onPreviewUrlChange={handlePreviewUrlChange} />
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
  const [state, setState] = useState<{ access: Access; githubToken: string | null; pushLost: boolean } | { join: string } | { error: string } | null>(null);
  const [withoutGitHub, setWithoutGitHub] = useState(false);
  const user = useUser();

  useEffect(() => {
    let active = true;
    (async () => {
      const id = roomId ?? (await roomByCode(code ?? "")).id;
      const access = await enterRoom(id);
      if (!active) return;
      if (access) {
        if (!roomId) history.replaceState(null, "", `${location.pathname}?${new URLSearchParams({ id: access.room.id })}`);
        // The host's pod gets the push token at boot, so open it first.
        const hadPush = hasPushToken();
        const githubToken = access.member.host ? await unwrapPushToken() : null;
        if (!active) return;
        setState({ access, githubToken, pushLost: access.member.host && hadPush && !githubToken });
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
  const { githubToken, pushLost } = state;
  // A host who meant to push (a repository, or a token that has since
  // expired with its session) is told before Claude starts without it.
  if (storedConfig && !githubToken && (pushLost || storedConfig.repo) && !withoutGitHub) {
    return (
      <main className="landing">
        <section className="entry-card">
          <h2>{pushLost ? "GitHub for pushing has expired" : "Connect GitHub for pushing?"}</h2>
          <p>{pushLost ? "It ended with the GitHub session it was connected in (signing out, or 30 days unused). Connect again so Claude can push." : `This room works on ${storedConfig.repo}. Without GitHub, Claude can read public repositories but can't push.`}</p>
          <GitHubPush user={user} back={`${location.pathname}${location.search}`} />
          <button className="link" onClick={() => setWithoutGitHub(true)}>Continue without GitHub</button>
        </section>
      </main>
    );
  }
  const hostConfig = storedConfig && githubToken ? { ...storedConfig, githubToken } : storedConfig;
  return <RoomApp access={state.access} hostConfig={hostConfig} />;
}

export default function App() {
  const params = new URLSearchParams(location.search);
  // A page that opens nothing, for browser smokes that drive modules
  // directly (`?poc=blank`).
  if (params.has("poc")) return <main className="poc-blank" />;
  const roomId = params.get("id")?.replace(/[^\w-]/g, "").slice(0, 64) || null;
  const code = params.get("room")?.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 16).toUpperCase() || null;
  if (!roomId && !code) return <Landing />;
  return <RoomGate roomId={roomId} code={code} />;
}
