import { useEffect, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import type { Awareness } from "y-protocols/awareness";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type Participant = {
  clientId: number;
  name: string;
  colour: string;
  role: "facilitator" | "participant";
};

export type PromptSnapshot = {
  id: string;
  author: string;
  sourceId: string | null;
  status: "staged" | "queued";
  rank: number;
  text: Y.Text;
  map: Y.Map<unknown>;
};

const colours = ["#315efb", "#b35642", "#39775d", "#8156a4", "#a16c17"];

function storedIdentity() {
  try {
    const stored = JSON.parse(localStorage.getItem("riff-identity") ?? "null") as { name?: unknown; colour?: unknown } | null;
    if (stored && typeof stored.name === "string" && typeof stored.colour === "string") {
      return { name: stored.name, colour: stored.colour };
    }
  } catch {
    // Replace malformed local identity data below.
  }
  return null;
}

function getIdentity() {
  const stored = storedIdentity();
  if (stored) return stored;
  const identity = {
    name: "Guest",
    colour: colours[Math.floor(Math.random() * colours.length)],
  };
  localStorage.setItem("riff-identity", JSON.stringify(identity));
  return identity;
}

export function savedIdentityName() {
  const identity = storedIdentity();
  return identity?.name === "Guest" ? "" : identity?.name ?? "";
}

export function setIdentityName(name: string) {
  const current = getIdentity();
  const identity = { ...current, name: name.trim().slice(0, 40) || "Guest" };
  localStorage.setItem("riff-identity", JSON.stringify(identity));
  return identity;
}

function websocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/collaboration`;
}

function participantList(awareness: Awareness): Participant[] {
  return [...awareness.getStates()].map(([clientId, state]) => ({
    clientId,
    name: state.user?.name ?? "Guest",
    colour: state.user?.colour ?? "#999999",
    role: state.user?.role === "facilitator" ? "facilitator" : "participant",
  }));
}

export function useRoom(roomId: string, facilitator: boolean) {
  const [doc] = useState(() => new Y.Doc());
  const [provider] = useState(() => new WebsocketProvider(websocketUrl(), `riff-${roomId}`, doc));
  const [persistence] = useState(() => new IndexeddbPersistence(`riff-${roomId}`, doc));
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [promptVersion, setPromptVersion] = useState(0);
  const [roomVersion, setRoomVersion] = useState(0);
  const [identity] = useState(() => getIdentity());
  const prompts = doc.getMap<Y.Map<unknown>>("prompts");
  const roomState = doc.getMap<unknown>("roomState");

  useEffect(() => {
    const onStatus = ({ status: next }: { status: ConnectionStatus }) => setStatus(next);
    const onAwareness = () => setParticipants(participantList(provider.awareness));
    const onPrompts = () => setPromptVersion((version) => version + 1);
    const onRoomState = () => setRoomVersion((version) => version + 1);

    provider.awareness.setLocalStateField("user", {
      ...identity,
      role: facilitator ? "facilitator" : "participant",
    });
    provider.on("status", onStatus);
    provider.awareness.on("change", onAwareness);
    prompts.observeDeep(onPrompts);
    roomState.observe(onRoomState);
    onAwareness();

    return () => {
      provider.off("status", onStatus);
      provider.awareness.off("change", onAwareness);
      prompts.unobserveDeep(onPrompts);
      roomState.unobserve(onRoomState);
      provider.destroy();
      persistence.destroy();
      doc.destroy();
    };
  }, [doc, facilitator, identity.colour, identity.name, persistence, prompts, provider, roomState]);

  const promptSnapshots: PromptSnapshot[] = [];
  prompts.forEach((map, id) => {
    const text = map.get("text");
    if (!(text instanceof Y.Text)) return;
    promptSnapshots.push({
      id,
      author: String(map.get("author") ?? "Guest"),
      sourceId: typeof map.get("sourceId") === "string" ? String(map.get("sourceId")) : null,
      status: map.get("status") === "queued" ? "queued" : "staged",
      rank: Number(map.get("rank") ?? 0),
      text,
      map,
    });
  });
  promptSnapshots.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));

  return {
    doc,
    identity,
    participants,
    persistence,
    promptSnapshots,
    promptVersion,
    prompts,
    provider,
    previewLive: roomState.get("previewLive") === true,
    previewGeneration: Number(roomState.get("previewGeneration") ?? 0),
    roomState,
    roomVersion,
    status,
  };
}

export function addPrompt(
  doc: Y.Doc,
  prompts: Y.Map<Y.Map<unknown>>,
  author: string,
  text: string,
  sourceId: string | null = null,
) {
  const id = crypto.randomUUID();
  const prompt = new Y.Map<unknown>();
  prompt.set("author", author);
  prompt.set("sourceId", sourceId);
  prompt.set("status", "staged");
  prompt.set("rank", Date.now());
  prompt.set("text", new Y.Text(text));
  doc.transact(() => prompts.set(id, prompt));
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
