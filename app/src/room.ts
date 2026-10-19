import { useEffect, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { openCopy } from "./copies";
import { stagePrompt } from "./boardFile";
import { Awareness } from "y-protocols/awareness";
import type { Access, RoomState } from "./api";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type Participant = {
  clientId: number;
  memberId: number | null;
  name: string;
  colour: string;
  role: "facilitator" | "participant";
};

// Written by the server into the control document (server/riff.mjs).
export type RoomMember = { id: number; name: string; host: boolean; login: string | null; removed: boolean };

export type QueuedPrompt = { id: string; author: string; text: string; rank: number };

export type PromptSnapshot = {
  id: string;
  author: string;
  sourceId: string | null;
  status: "staged";
  rank: number;
  text: Y.Text;
  map: Y.Map<unknown>;
};

const colours = ["#315efb", "#b35642", "#39775d", "#8156a4", "#a16c17"];

// Your colour on the board is a local choice; your name is the one the
// server holds for you in this room.
function localColour() {
  try {
    const stored = JSON.parse(localStorage.getItem("riff-identity") ?? "null") as { colour?: unknown } | null;
    if (stored && typeof stored.colour === "string") return stored.colour;
  } catch {
    // Replace malformed local identity data below.
  }
  const colour = colours[Math.floor(Math.random() * colours.length)];
  localStorage.setItem("riff-identity", JSON.stringify({ colour }));
  return colour;
}

const NAME_KEY = "riff-name";

export function savedName() {
  return localStorage.getItem(NAME_KEY) ?? "";
}

export function saveName(name: string) {
  localStorage.setItem(NAME_KEY, name.trim().slice(0, 40));
}

// One socket per page carries both of the room's documents. Hocuspocus
// names the document in every message, so the path is just /collaboration.
function websocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/collaboration`;
}

function participantList(awareness: Awareness): Participant[] {
  return [...awareness.getStates()].map(([clientId, state]) => ({
    clientId,
    memberId: typeof state.user?.memberId === "number" ? state.user.memberId : null,
    name: state.user?.name ?? "Guest",
    colour: state.user?.colour ?? "#999999",
    role: state.user?.role === "facilitator" ? "facilitator" : "participant",
  }));
}

// A room is two documents (docs/adr/0006): `shared` (the board and staged
// prompts) everyone writes; `control` (the queue, the preview state, and the
// server-written code and member list) only the host writes. The server
// enforces that; the UI just doesn't offer what would be refused.
export function useRoom(access: Access) {
  const roomId = access.room.id;
  const facilitator = access.member.host;
  const [doc] = useState(() => new Y.Doc());
  const [control] = useState(() => new Y.Doc());
  const [awareness] = useState(() => new Awareness(doc));
  const [socket] = useState(() => new HocuspocusProviderWebsocket({ url: websocketUrl() }));
  const [provider] = useState(() => {
    const shared = new HocuspocusProvider({
      websocketProvider: socket,
      name: `room/${roomId}/shared`,
      document: doc,
      awareness,
      token: access.token ?? "",
    });
    shared.attach();
    return shared;
  });
  const [controlProvider] = useState(() => {
    const controlled = new HocuspocusProvider({
      websocketProvider: socket,
      name: `room/${roomId}/control`,
      document: control,
      awareness: null,
      token: access.token ?? "",
    });
    controlled.attach();
    return controlled;
  });
  const [persistence] = useState(() => openCopy(`room/${roomId}/shared`, doc));
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [shutOut, setShutOut] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [promptVersion, setPromptVersion] = useState(0);
  const [roomVersion, setRoomVersion] = useState(0);
  const [colour] = useState(localColour);
  const prompts = doc.getMap<Y.Map<unknown>>("prompts");
  const queue = control.getMap<QueuedPrompt>("queue");
  const roomState = control.getMap<unknown>("roomState");
  const roomInfo = control.getMap<unknown>("room");
  const members = control.getMap<RoomMember>("members");

  useEffect(() => {
    const onStatus = ({ status: next }: { status: ConnectionStatus }) => setStatus(next);
    const onAwareness = () => setParticipants(participantList(awareness));
    const onPrompts = () => setPromptVersion((version) => version + 1);
    const onControl = () => setRoomVersion((version) => version + 1);
    const onRefused = ({ reason }: { reason: string }) => setShutOut(reason);

    awareness.setLocalStateField("user", {
      memberId: access.member.id,
      name: access.member.name,
      colour,
      role: facilitator ? "facilitator" : "participant",
    });
    socket.on("status", onStatus);
    provider.on("authenticationFailed", onRefused);
    awareness.on("change", onAwareness);
    prompts.observeDeep(onPrompts);
    control.on("update", onControl);
    onAwareness();

    return () => {
      socket.off("status", onStatus);
      provider.off("authenticationFailed", onRefused);
      awareness.off("change", onAwareness);
      prompts.unobserveDeep(onPrompts);
      control.off("update", onControl);
      provider.destroy();
      controlProvider.destroy();
      socket.destroy();
      persistence.destroy();
      doc.destroy();
      control.destroy();
    };
  }, [access.member.id, access.member.name, awareness, colour, control, controlProvider, doc, facilitator, persistence, prompts, provider, socket]);

  const promptSnapshots = snapshotPrompts(prompts);

  const queued = [...queue.entries()]
    .map(([id, item]) => ({ ...item, id }))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const memberList = [...members.values()].sort((a, b) => a.id - b.id);

  // The host moves a staged prompt into the queue: its text as it stands,
  // into the control document, and out of the shared one.
  function queuePrompt(prompt: PromptSnapshot) {
    control.transact(() => {
      queue.set(prompt.id, { id: prompt.id, author: prompt.author, text: prompt.text.toString(), rank: Date.now() });
    });
    prompts.delete(prompt.id);
  }

  // Once a queued prompt is in the host's terminal it leaves the queue.
  // `lastSent` in the same transaction is how the server's log tells this
  // apart from removing it.
  function sendQueued(id: string) {
    control.transact(() => {
      roomState.set("lastSent", id);
      queue.delete(id);
    });
  }

  return {
    doc,
    control,
    identity: { name: access.member.name, colour },
    participants,
    persistence,
    promptSnapshots,
    promptVersion,
    prompts,
    provider,
    queue,
    queued,
    queuePrompt,
    sendQueued,
    members: memberList,
    code: typeof roomInfo.get("code") === "string" ? String(roomInfo.get("code")) : access.room.code,
    locked: roomInfo.has("locked") ? roomInfo.get("locked") === true : access.room.locked,
    keep: roomInfo.has("keep") ? roomInfo.get("keep") === true : access.room.keep,
    state: (["live", "away", "ended"].includes(String(roomInfo.get("state"))) ? roomInfo.get("state") : access.room.state) as RoomState,
    endsAt: roomInfo.has("endsAt") ? (typeof roomInfo.get("endsAt") === "number" ? Number(roomInfo.get("endsAt")) : null) : access.room.endsAt,
    full: roomInfo.has("full") ? roomInfo.get("full") === true : access.room.full,
    limitBytes: typeof roomInfo.get("limitBytes") === "number" ? Number(roomInfo.get("limitBytes")) : access.room.limitBytes,
    previewLive: roomState.get("previewLive") === true,
    previewGeneration: Number(roomState.get("previewGeneration") ?? 0),
    roomState,
    roomVersion,
    shutOut,
    status,
  };
}

// The staged prompts as the page shows them, oldest first.
export function snapshotPrompts(prompts: Y.Map<Y.Map<unknown>>): PromptSnapshot[] {
  const promptSnapshots: PromptSnapshot[] = [];
  prompts.forEach((map, id) => {
    const text = map.get("text");
    if (!(text instanceof Y.Text)) return;
    promptSnapshots.push({
      id,
      author: String(map.get("author") ?? "Guest"),
      sourceId: typeof map.get("sourceId") === "string" ? String(map.get("sourceId")) : null,
      status: "staged",
      rank: Number(map.get("rank") ?? 0),
      text,
      map,
    });
  });
  promptSnapshots.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return promptSnapshots;
}

// boardFile.ts owns the shape of a prompt, because import writes them too.
export function addPrompt(doc: Y.Doc, author: string, text: string, sourceId: string | null = null) {
  stagePrompt(doc, author, text, sourceId);
}

export function replaceYText(text: Y.Text, next: string) {
  const previous = text.toString();
  if (previous === next) return;

  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;

  text.doc?.transact(() => {
    const deleteLength = previous.length - prefix - suffix;
    if (deleteLength) text.delete(prefix, deleteLength);
    const insertion = next.slice(prefix, next.length - suffix);
    if (insertion) text.insert(prefix, insertion);
  });
}
