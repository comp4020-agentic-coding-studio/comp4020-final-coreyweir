import { useEffect, useRef, useState } from "react";
import { Quickdraw, useQuickdrawStore, type ShapeRecord } from "@quickdrawjs/react";
import { addPrompt, replaceYText, saveName, savedName, snapshotPrompts, type PromptSnapshot, type QueuedPrompt, type RoomMember, useRoom } from "./room";
import {
  type Access, ApiError, createRoom, currentUser, endRoom, enterRoom, joinRoom, removeMember, roomByCode, rotateCode, setKeep, setLocked,
  acceptInvite, addColleague, cancelInvite, declineInvite, inviteToRoom, listColleagues, removeColleague, watchRooms,
  type Colleagues, type ListedRoom, type RoomInfo, type RoomList,
  forgetPushToken, hasPushToken, sealPastedToken, signInUrl, signOut, unwrapPushToken, type User,
} from "./api";
import * as Y from "yjs";
import { type BoardLimit, useBoardSync } from "./boardSync";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import type { HostConfig } from "./claudePod";
import { previewRelayUrl } from "./previewChannel";
import {
  BoardFileError, MAX_FILE_BYTES, ROOM_LIMIT_BYTES, type BoardFile, type FilePrompt, type ParsedBoard,
  applyBoardFile, boardBytes, boardFileName, dropUndecodableImages, exportBoard, parseBoardFile,
} from "./boardFile";
import { type LocalCopy, deleteAllCopies, deleteCopy, findCopy, listCopies, loadCopy, noteOpened, seedCopy } from "./copies";

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

// What happens to the board when the room ends (docs/adr/0003). The same
// words everywhere someone decides whether to draw.
function boardFate(keep: boolean) {
  return keep ? "The server keeps this board after the room ends." : "The server deletes this board when the room ends.";
}

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1).replace(/\.0+$/, "")} MB`;
}

function countdown(until: number, now: number) {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Export (docs/adr/0003, second amendment): the file is the whole board,
// its images as they are, and the prompts.
function downloadBoard(file: BoardFile) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = boardFileName(file.room.code, new Date(file.exportedAt));
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function shortDate(at: number) {
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
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
    case "others_joined": return "Someone else has been in this room, so it can't start keeping the board now: they joined when it wasn't kept.";
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
  // Signing out on a shared machine is when the boards it kept matter.
  const [leaving, setLeaving] = useState<number | null>(null);
  async function startSignOut() {
    const copies = await listCopies().catch(() => []);
    if (copies.length) setLeaving(copies.length);
    else await finishSignOut(false);
  }
  async function finishSignOut(deleteBoards: boolean) {
    if (deleteBoards) await deleteAllCopies();
    await signOut();
    location.reload();
  }
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
      <button className="link" onClick={() => void startSignOut()}>Sign out</button>
      {leaving !== null && (
        <span className="signing-out" role="group" aria-label="Signing out">
          <span>This browser has {leaving === 1 ? "a copy of 1 board" : `copies of ${leaving} boards`} you've been in. Delete {leaving === 1 ? "it" : "them"} too?</span>
          <button onClick={() => void finishSignOut(true)}>Sign out and delete</button>
          <button onClick={() => void finishSignOut(false)}>Sign out, keep {leaving === 1 ? "it" : "them"}</button>
          <button className="link" onClick={() => setLeaving(null)}>Cancel</button>
        </span>
      )}
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
function YourRooms({ name, list }: { name: string; list: RoomList | null }) {
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

// Every board this browser keeps a copy of (docs/adr/0003, second
// amendment). Open goes to the room while you're in it, and otherwise to
// the copy alone, read-only. Delete takes the copy and this browser's
// place in the room with it.
function LocalBoards({ list }: { list: RoomList | null }) {
  const [copies, setCopies] = useState<LocalCopy[] | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => listCopies().then(setCopies, () => setCopies([]));
  useEffect(() => {
    void refresh();
  }, []);
  if (!copies?.length) return null;
  const inRooms = new Set(list?.rooms.map((room) => room.id));

  function open(copy: LocalCopy) {
    if (copy.roomId && inRooms.has(copy.roomId)) goToRoom(copy.roomId);
    else location.assign(`${location.pathname}?${new URLSearchParams({ copy: copy.database })}`);
  }

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch {
      setError("Couldn't do that in this browser's storage. Try again.");
    }
    setAsking(null);
    await refresh();
  }

  async function exportCopy(copy: LocalCopy) {
    const { doc, destroy } = await loadCopy(copy);
    try {
      downloadBoard(exportBoard({ code: copy.code ?? "board", doc }));
    } finally {
      destroy();
    }
  }

  return (
    <section className="local-boards" aria-label="Boards on this browser">
      <h2>Boards on this browser</h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      <ul>
        {copies.map((copy) => (
          <li key={copy.database}>
            <span className="copy-name">{copy.code ? <>Room <code>{copy.code}</code></> : "A room"}</span>
            <small>{[copy.host === null ? null : copy.host ? "hosted" : "joined", copy.lastOpened ? shortDate(copy.lastOpened) : null].filter(Boolean).join(" · ")}</small>
            {asking === copy.database ? (
              <span className="actions asking">
                <span>Delete this browser's copy{copy.roomId ? ", and its place in the room" : ""}?</span>
                <button className="danger" onClick={() => void act(() => deleteCopy(copy))}>Delete</button>
                <button className="link" onClick={() => setAsking(null)}>Cancel</button>
              </span>
            ) : (
              <span className="actions">
                <button className="link" onClick={() => open(copy)}>Open</button>
                <button className="link" onClick={() => void act(() => exportCopy(copy))}>Export</button>
                <button className="link" onClick={() => setAsking(copy.database)}>Delete</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {copies.length > 1 && (asking === "all" ? (
        <p className="delete-all asking">
          <span>Delete all {copies.length} copies, and this browser's place in every room?</span>
          <button className="danger" onClick={() => void act(deleteAllCopies)}>Delete all</button>
          <button className="link" onClick={() => setAsking(null)}>Cancel</button>
        </p>
      ) : <p className="delete-all"><button className="link" onClick={() => setAsking("all")}>Delete all</button></p>)}
    </section>
  );
}

// Starting a room from an exported board: the file is checked here, before
// any room exists, and only what quickdraw draws comes in (boardFile.ts).
function ImportBoard({ imported, onChange }: { imported: ParsedBoard | null; onChange: (board: ParsedBoard | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  async function choose(file: File | undefined) {
    setError(null);
    onChange(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(`That file is ${megabytes(file.size)}; a room holds ${megabytes(ROOM_LIMIT_BYTES)}.`);
      return;
    }
    setReading(true);
    try {
      const parsed = await dropUndecodableImages(parseBoardFile(await file.text()));
      const bytes = boardBytes(parsed);
      // a little room for the room's own records alongside the board
      if (bytes > ROOM_LIMIT_BYTES - 64 * 1024) setError(`That board holds ${megabytes(bytes)}; a room holds ${megabytes(ROOM_LIMIT_BYTES)}.`);
      else onChange(parsed);
    } catch (failure) {
      setError(failure instanceof BoardFileError ? failure.message : "Couldn't read that file.");
    } finally {
      setReading(false);
    }
  }

  const counts = imported && [
    `${imported.shapes} ${imported.shapes === 1 ? "thing" : "things"} on the board`,
    imported.images ? `${imported.images} ${imported.images === 1 ? "image" : "images"}` : null,
    `${imported.prompts.length} ${imported.prompts.length === 1 ? "prompt" : "prompts"}`,
  ].filter(Boolean).join(", ");
  return (
    <div className="import-board">
      <label>Start from an exported board <small>Optional</small>
        <input type="file" accept="application/json,.json" disabled={reading} onChange={(event) => void choose(event.target.files?.[0])} />
      </label>
      {reading && <small>Reading...</small>}
      {imported && (
        <p className="local-note import-summary">
          {imported.code ? <>From room <code>{imported.code}</code>{imported.exportedAt && `, ${shortDate(Date.parse(imported.exportedAt))}`}: </> : null}
          {counts}. Queued prompts come in staged.
          {imported.leftOut.length > 0 && <> Left out: {imported.leftOut.join("; ")}.</>}
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

function Landing({ code: sharedCode = "", keep: sharedKeep }: { code?: string; keep?: boolean }) {
  const user = useUser();
  const [keepBoard, setKeepBoard] = useState(true);
  const ended = new URLSearchParams(location.search).get("ended")?.replace(/[^A-Z0-9]/gi, "").slice(0, 16);
  const [mode, setMode] = useState<"join" | "host">(() => new URLSearchParams(location.search).get("setup") === "host" ? "host" : "join");
  const [code, setCode] = useState(sharedCode);
  const [name, setName] = useState(savedName);
  const [config, setConfig] = useState(savedHostConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colleagues, setColleagues] = useState(false);
  const [imported, setImported] = useState<ParsedBoard | null>(null);
  const list = useRoomList();
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
        {ended && <p className="ended-note" role="status">Room <code>{ended}</code> has ended.</p>}
        {colleagues ? <ColleaguesPanel onClose={() => setColleagues(false)} /> : <>
        <YourRooms name={shownName} list={list} />
        <LocalBoards list={list} />
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
            {sharedKeep !== undefined && code === sharedCode && <p className="local-note board-fate">{boardFate(sharedKeep)}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary" disabled={busy || !code.trim() || !shownName.trim()}>{busy ? "Joining..." : "Join room"}</button>
          </form>
        ) : (
          <form onSubmit={(event) => {
            event.preventDefault();
            saveName(name);
            localStorage.setItem("riff-host-config", JSON.stringify(config));
            void submit(async () => {
              const access = await createRoom(shownName.trim(), keepBoard);
              if (imported) await seedCopy(access.room.id, (doc) => applyBoardFile(doc, imported));
              return access;
            });
          }}>
            <label>Your name<input required maxLength={40} value={shownName} onChange={(event) => setName(event.target.value)} placeholder="e.g. Corey" /></label>
            <label>Claude base URL<input type="url" required value={config.baseUrl} onChange={(event) => updateConfig("baseUrl", event.target.value)} /></label>
            <label>API token<input type="password" required value={config.token} onChange={(event) => updateConfig("token", event.target.value)} placeholder="Stored on this device" /></label>
            <label>Git repository <small>Optional</small><input value={config.repo} onChange={(event) => updateConfig("repo", event.target.value)} placeholder="https://github.com/group/project.git" /></label>
            <GitHubPush user={user} back="/?setup=host" beforeLeaving={() => { saveName(name); localStorage.setItem("riff-host-config", JSON.stringify(config)); }} />
            <ImportBoard imported={imported} onChange={setImported} />
            <label className="check"><input type="checkbox" checked={keepBoard} onChange={(event) => setKeepBoard(event.target.checked)} /><span>Keep the board after the room ends<small>{keepBoard ? "Kept on the server while space allows, read-only. Everyone who joins is told." : "Deleted from the server when the room ends. Everyone who joins is told."}</small></span></label>
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

function PromptCard({ prompt, canQueue, readOnly, onQueue, onDelete }: { prompt: PromptSnapshot; canQueue: boolean; readOnly: boolean; onQueue: () => void; onDelete: () => void }) {
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
        {!readOnly && <button onClick={onDelete} aria-label="Delete prompt">&times;</button>}
      </header>
      <textarea readOnly={readOnly} value={prompt.text.toString()} onChange={(event) => replaceYText(prompt.text, event.target.value)} aria-label={`Prompt by ${prompt.author}`} />
      <footer><span>Shared draft</span><button disabled={!canQueue || readOnly} title={canQueue ? "Add to queue" : "Only the host can queue prompts"} onClick={onQueue}>Queue</button></footer>
    </article>
  );
}

function Staging({ prompts, canQueue, readOnly, onAdd, onQueue, onDelete }: {
  prompts: PromptSnapshot[];
  canQueue: boolean;
  readOnly: boolean;
  onAdd: (text: string) => void;
  onQueue: (prompt: PromptSnapshot) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const staged = prompts;

  return (
    <aside className="staging">
      <header className="section-title"><h2>Staging</h2><span>{staged.length}</span></header>
      {!readOnly && <form className="new-prompt" onSubmit={(event) => {
        event.preventDefault();
        if (!draft.trim()) return;
        onAdd(draft.trim());
        setDraft("");
      }}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a thought for the group..." />
        <button disabled={!draft.trim()}>Stage prompt</button>
      </form>}
      <div className="prompt-list">
        {staged.map((prompt) => <PromptCard key={prompt.id} prompt={prompt} canQueue={canQueue} readOnly={readOnly} onQueue={() => onQueue(prompt)} onDelete={() => onDelete(prompt.id)} />)}
        {!staged.length && <p className="empty">Ideas staged from the board will appear here.</p>}
      </div>
    </aside>
  );
}

function BoardView({ store, selected, readOnly, notice, onSelection, onStageSelection }: {
  store: ReturnType<typeof useQuickdrawStore>;
  readOnly: string | null;
  notice: string | null;
  selected: string[];
  onSelection: (ids: string[]) => void;
  onStageSelection: () => void;
}) {
  return (
    <section className="board-wrap">
      <div className="board-actions">{readOnly ? <span>{readOnly}</span> : <><span>Draw, write, paste images, or move things around.</span><button disabled={!selected.length} onClick={onStageSelection}>Stage selected</button></>}</div>
      {notice && <p className="board-notice" role="alert">{notice}</p>}
      <Quickdraw
        className="quickdraw-surface"
        store={store}
        grid="dots"
        theme="light"
        readonly={readOnly !== null}
        styles={{ dash: "solid" }}
        themeToggle={false}
        watermark={false}
        onSelectionChange={onSelection}
      />
    </section>
  );
}

function RoomView({ roomId, token, queued, facilitator, config, hidden, ended, full, onSend, onDelete, onPreviewUrlChange }: {
  roomId: string;
  ended: boolean;
  // A full room's queue is read-only for the host too.
  full: boolean;
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
      {/* A participant's terminal stops asking once the room ends; a new one starts if the host revives it. Never remount the host's: it runs Claude. */}
      <TerminalPane key={facilitator ? "host" : ended ? "ended" : "open"} ref={terminalRef} roomId={roomId} token={token} facilitator={facilitator} config={config} onPreviewUrlChange={onPreviewUrlChange} />
      <article className="queue">
        <header className="section-title"><h2>Up next</h2><span>{queued.length}</span></header>
        <div className="queue-list">
          {queued.map((prompt, index) => <div className="queue-row" key={prompt.id}><span>{index + 1}</span><p>{prompt.text}</p><small>{prompt.author}</small>{facilitator && !full && <button className="load-prompt" onClick={() => { if (terminalRef.current?.loadPrompt(prompt.text)) onSend(prompt.id); }}>Load</button>}{facilitator && !full && <button onClick={() => onDelete(prompt.id)} aria-label="Remove queued prompt">&times;</button>}</div>)}
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

// What the room's state means for the people in it (docs/adr/0003). The
// host never sees these: their page is what keeps the room live.
function RoomBanner({ state, endsAt, keep, facilitator, onExport }: { state: RoomInfo["state"]; endsAt: number | null; keep: boolean; facilitator: boolean; onExport: () => void }) {
  const now = useNow(1000);
  if (facilitator || state === "live") return null;
  if (state === "away") {
    const left = endsAt === null ? null : endsAt - now;
    return (
      <p className="room-banner away" role="status">
        The host isn't connected, so there's no Claude or preview for now. The whiteboard still works.{" "}
        {left === null ? null : left > 0 ? <>If they don't come back, the room ends in <strong>{countdown(endsAt!, now)}</strong>.</> : <>The room is ending.</>}
      </p>
    );
  }
  return (
    <p className="room-banner ended" role="status">
      This room has ended. {keep ? "The server keeps this board while space allows; you can look, but not change it." : "The server doesn't keep this board."}{" "}
      <button className="link" onClick={onExport}>Export it</button> to keep your own copy.
    </p>
  );
}

// A full room is read-only for everyone, the host included, and stays that
// way (docs/adr/0003, amendment). Claude and the terminal carry on.
function FullBanner({ limitBytes, onExport }: { limitBytes: number | null; onExport: () => void }) {
  return (
    <p className="room-banner full" role="status">
      This board is full{limitBytes ? ` (${megabytes(limitBytes)})` : ""}, so nothing more can be added to it, the prompts or the queue. Claude and the terminal still work. To keep going together, <button className="link" onClick={onExport}>export it</button> and start a new room from the file.
    </p>
  );
}

// The host can end the room for everyone. Ending isn't undone by anyone
// but the host coming back, so it asks first and says what happens.
function EndRoom({ access, code, keep }: { access: Access; code: string; keep: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function end() {
    setBusy(true);
    setError(null);
    try {
      await endRoom(access);
      // Leave at once: the host's page reconnecting would revive the room.
      location.assign(`${location.pathname}?${new URLSearchParams({ ended: code })}`);
    } catch (failure) {
      setError(problem(failure));
      setBusy(false);
    }
  }

  if (!asking) return <div className="end-room"><button onClick={() => setAsking(true)}>End room</button></div>;
  return (
    <div className="end-room asking">
      <p>End this room for everyone? Claude and the preview stop, and {keep ? "the board stays on the server, read-only, while space allows." : "the server deletes the board."}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <span><button className="danger" disabled={busy} onClick={() => void end()}>{busy ? "Ending..." : "End it"}</button><button disabled={busy} onClick={() => setAsking(false)}>Cancel</button></span>
    </div>
  );
}

// About what the server stores for the room: both documents, as this page
// has them. Recounted at most once a second while they change.
function useRoomBytes(docs: Y.Doc[]) {
  const [bytes, setBytes] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const count = () => {
      timer = null;
      setBytes(docs.reduce((sum, doc) => sum + Y.encodeStateAsUpdate(doc).byteLength, 0));
    };
    const changed = () => {
      timer ??= setTimeout(count, 1000);
    };
    count();
    docs.forEach((doc) => doc.on("update", changed));
    return () => {
      if (timer) clearTimeout(timer);
      docs.forEach((doc) => doc.off("update", changed));
    };
  }, docs);
  return bytes;
}

// Who's in the room, as the server says. The host also gets the room's
// controls: a new code, the lock, and removing someone.
function PeoplePanel({ access, room, onClose, onExport }: { access: Access; room: ReturnType<typeof useRoom>; onClose: () => void; onExport: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const host = access.member.host;
  const online = new Set(room.participants.map((participant) => participant.memberId));
  const present = room.members.filter((member) => !member.removed);
  const bytes = useRoomBytes([room.doc, room.control]);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(problem(failure));
    }
  }

  function changeKeep(keep: boolean) {
    const others = room.members.some((member) => !member.host);
    if (!keep && others && !confirm("Stop keeping the board? With others in the room, you can't start keeping it again.")) return;
    void act(() => setKeep(access, keep));
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
      <div className="board-fate">
        <p>{boardFate(room.keep)}</p>
        {host && <button onClick={() => changeKeep(!room.keep)}>{room.keep ? "Stop keeping it" : "Keep it"}</button>}
      </div>
      {room.limitBytes && <p className="board-size">{room.full ? "Full: it holds" : "It holds"} {megabytes(bytes)} of the {megabytes(room.limitBytes)} a room can.</p>}
      <p className="export-board"><button onClick={onExport}>Export the board</button><small>A file with the board, its images and the prompts. Anyone can start a new room from it.</small></p>
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
      {host && <EndRoom access={access} code={room.code} keep={room.keep} />}
    </aside>
  );
}

// Shut out of a room: removed by the host, or the room ended and the server
// didn't keep its board.
function RoomClosed({ reason, roomId }: { reason: string; roomId?: string }) {
  const ended = reason === "room-ended" || reason === "board-pruned";
  const [copy, setCopy] = useState<LocalCopy | null>(null);
  useEffect(() => {
    if (ended && roomId) findCopy(`room/${roomId}/shared`).then(setCopy, () => {});
  }, [ended, roomId]);
  return (
    <main className="landing">
      <section className="entry-card">
        <h2>{ended ? "This room has ended" : reason === "removed" ? "The host removed you from this room" : "You're no longer in this room"}</h2>
        <p>{reason === "board-pruned" ? "The server deleted this board to make space." : ended ? "The server doesn't keep this board." : reason === "removed" ? "You can't open it again unless they invite you back." : "The host removed you, or the room has ended."}</p>
        {copy && <p>This browser kept its own copy. <button className="link" onClick={() => location.assign(`${location.pathname}?${new URLSearchParams({ copy: copy.database })}`)}>Open it</button></p>}
        <button className="primary" onClick={() => location.assign(location.pathname)}>Back to start</button>
      </section>
    </main>
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
  // An ended room that keeps its board can still be looked at, and a full
  // one by everyone; the server refuses writes, so the page doesn't offer them.
  const readOnly = room.full
    ? "This board is full: you can look, but nothing more fits."
    : room.state === "ended" && !facilitator ? "The room has ended: you can look, but not change anything." : null;
  const [notice, setNotice] = useState<string | null>(null);
  // Refuse an image that wouldn't fit before it reaches the server, which
  // would turn the whole room read-only (docs/adr/0003, amendment).
  const limit = useRef<BoardLimit>({ limitBytes: null, bytesUsed: () => 0, onTooBig: () => {} });
  limit.current = {
    limitBytes: room.limitBytes,
    bytesUsed: () => Y.encodeStateAsUpdate(room.doc).byteLength + Y.encodeStateAsUpdate(room.control).byteLength,
    onTooBig: (bytes) => {
      const left = Math.max(0, (room.limitBytes ?? 0) - limit.current.bytesUsed());
      setNotice(`That image (${megabytes(bytes)}) doesn't fit: this room holds ${megabytes(room.limitBytes ?? 0)} and has about ${megabytes(left)} left.`);
    },
  };
  useBoardSync(room.doc, store, limit);

  // This browser's note of the room its copy belongs to (copies.ts).
  const hostName = room.members.find((member) => member.host)?.name ?? null;
  useEffect(() => {
    noteOpened({ roomId, code: room.code, host: facilitator, hostName });
  }, [roomId, room.code, facilitator, hostName]);

  function exportRoom() {
    const queue: FilePrompt[] = room.queued.map(({ author, text }) => ({ author, text }));
    downloadBoard(exportBoard({ code: room.code, doc: room.doc, queue }));
  }

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  function stageSelected() {
    const records = selected.map((id) => store.get(id)).filter((record): record is ShapeRecord => record?.typeName === "shape");
    if (!records.length) return;
    const textRecord = records.find((record) => record.type === "note" || record.type === "text");
    const text = typeof textRecord?.props.text === "string" && textRecord.props.text.trim() ? textRecord.props.text.trim() : `Follow up on ${records.length === 1 ? "this board item" : `these ${records.length} board items`}.`;
    addPrompt(room.doc, room.identity.name, text, records[0].id);
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
    return <RoomClosed reason={room.shutOut} roomId={roomId} />;
  }
  return (
    <div className="app">
      <header className="topbar">
        <button className="brand brand-button" onClick={() => location.assign(location.pathname)}>riff</button>
        <div className="room-name"><i className={room.status}></i><span>Room {room.code}</span><small>{room.status}</small><small className="board-fate" title={boardFate(room.keep)}>· board {room.keep ? "kept" : "not kept"}</small></div>
        <nav>
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>Board</button>
          <button className={view === "room" ? "active" : ""} onClick={() => setView("room")}>Room</button>
          <button className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>Preview</button>
        </nav>
        <button className="participants" onClick={() => setPeople((open) => !open)} title="People in this room">{room.participants.slice(0, 4).map((participant) => <span key={participant.clientId} style={{ background: participant.colour }} title={`${participant.name}${participant.role === "facilitator" ? " (host)" : ""}`}>{participant.name.slice(0, 1).toUpperCase()}</span>)}</button>
        <button className="share" onClick={copyRoomLink}>{copied ? "Copied" : "Share room"}</button>
      </header>

      {room.full ? <FullBanner limitBytes={room.limitBytes} onExport={exportRoom} /> : <RoomBanner state={room.state} endsAt={room.endsAt} keep={room.keep} facilitator={facilitator} onExport={exportRoom} />}
      <main className={`workspace ${view === "preview" ? "preview-workspace" : ""}`}>
        {view === "board" && <BoardView store={store} selected={selected} readOnly={readOnly} notice={notice} onSelection={setSelected} onStageSelection={stageSelected} />}
        <RoomView roomId={roomId} token={access.token} queued={room.queued} facilitator={facilitator} config={hostConfig} hidden={view !== "room"} ended={room.state === "ended"} full={room.full} onSend={room.sendQueued} onDelete={(id) => room.queue.delete(id)} onPreviewUrlChange={handlePreviewUrlChange} />
        {view === "preview" && <PreviewView roomId={roomId} previewKey={access.member.previewKey} live={room.previewLive} generation={room.previewGeneration} facilitator={facilitator} preview={preview} />}
        {view !== "preview" && <Staging prompts={room.promptSnapshots} canQueue={facilitator} readOnly={readOnly !== null} onAdd={(text) => addPrompt(room.doc, room.identity.name, text)} onQueue={room.queuePrompt} onDelete={(id) => room.prompts.delete(id)} />}
        {people && <PeoplePanel access={access} room={room} onClose={() => setPeople(false)} onExport={exportRoom} />}
      </main>
    </div>
  );
}

// Works out who this browser is in the room the URL names, before anything
// connects: a shared link (?room=CODE) for someone already in the room goes
// straight in; for anyone else it's the join form with the code filled in.
function RoomGate({ roomId, code }: { roomId: string | null; code: string | null }) {
  const [state, setState] = useState<{ access: Access; githubToken: string | null; pushLost: boolean } | { join: string; keep?: boolean } | { error: string } | null>(null);
  const [withoutGitHub, setWithoutGitHub] = useState(false);
  const user = useUser();

  useEffect(() => {
    let active = true;
    (async () => {
      const found = roomId ? null : await roomByCode(code ?? "");
      const id = roomId ?? found!.id;
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
        setState(code ? { join: code, keep: found?.keep } : { error: "This browser isn't in that room. Ask the host for the code." });
      }
    })().catch((failure) => active && setState(code && failure instanceof ApiError && failure.status === 404 ? { join: code } : { error: problem(failure) }));
    return () => {
      active = false;
    };
  }, [code, roomId]);

  if (!state) return <main className="landing"><section className="entry-card"><p>Finding the room...</p></section></main>;
  if ("join" in state) return <Landing code={state.join} keep={state.keep} />;
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
  const { room: entered } = state.access;
  if (!facilitator && entered.state === "ended" && (!entered.keep || entered.pruned)) return <RoomClosed reason={entered.pruned ? "board-pruned" : "room-ended"} roomId={entered.id} />;
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

// A board from this browser's copy alone: no server, nobody else, nothing
// to change. Export works the same as in the room.
function CopyBoard({ copy, doc }: { copy: LocalCopy; doc: Y.Doc }) {
  const store = useQuickdrawStore();
  useBoardSync(doc, store);
  const prompts = snapshotPrompts(doc.getMap("prompts"));
  const name = copy.code ? `room ${copy.code}` : "a room";
  return (
    <div className="app copy-view">
      <header className="topbar">
        <button className="brand brand-button" onClick={() => location.assign(location.pathname)}>riff</button>
        <div className="room-name"><span>Copy of {name}</span>{copy.lastOpened && <small>last opened {shortDate(copy.lastOpened)}</small>}</div>
        <button className="share" onClick={() => downloadBoard(exportBoard({ code: copy.code ?? "board", doc }))}>Export</button>
      </header>
      <p className="room-banner ended" role="status">This is the copy this browser kept of {name}. It isn't connected to anyone, and nothing here can be changed.</p>
      <main className="workspace">
        <BoardView store={store} selected={[]} readOnly="A copy: look, but not change." notice={null} onSelection={() => {}} onStageSelection={() => {}} />
        <Staging prompts={prompts} canQueue={false} readOnly onAdd={() => {}} onQueue={() => {}} onDelete={() => {}} />
      </main>
    </div>
  );
}

function CopyView({ database }: { database: string }) {
  const [loaded, setLoaded] = useState<{ copy: LocalCopy; doc: Y.Doc } | "missing" | null>(null);
  useEffect(() => {
    let gone = false;
    let destroy: (() => void) | null = null;
    findCopy(database).then(async (copy) => {
      if (!copy) return setLoaded("missing");
      const opened = await loadCopy(copy);
      if (gone) return opened.destroy();
      destroy = opened.destroy;
      setLoaded({ copy, doc: opened.doc });
    }).catch(() => !gone && setLoaded("missing"));
    return () => {
      gone = true;
      destroy?.();
    };
  }, [database]);
  if (loaded === null) return <main className="landing"><section className="entry-card"><p>Opening the copy...</p></section></main>;
  if (loaded === "missing") {
    return (
      <main className="landing">
        <section className="entry-card">
          <h2>That copy isn't on this browser</h2>
          <p>It was deleted, or the browser cleared it.</p>
          <button className="primary" onClick={() => location.assign(location.pathname)}>Back to start</button>
        </section>
      </main>
    );
  }
  return <CopyBoard copy={loaded.copy} doc={loaded.doc} />;
}

export default function App() {
  const params = new URLSearchParams(location.search);
  // A page that opens nothing, for browser smokes that drive modules
  // directly (`?poc=blank`).
  if (params.has("poc")) return <main className="poc-blank" />;
  const copy = params.get("copy");
  if (copy) return <CopyView database={copy} />;
  const roomId = params.get("id")?.replace(/[^\w-]/g, "").slice(0, 64) || null;
  const code = params.get("room")?.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 16).toUpperCase() || null;
  if (!roomId && !code) return <Landing />;
  return <RoomGate roomId={roomId} code={code} />;
}
