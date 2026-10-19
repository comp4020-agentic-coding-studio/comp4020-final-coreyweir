// This browser's copies of the boards it has been in (docs/adr/0003, second
// amendment). The copy itself is y-indexeddb's database for the room's
// shared document, which `room.ts` keeps whenever the room is open. This
// module makes those copies visible and deletable: a note of which room
// each one is, the list, a read-only load that never touches the server,
// and delete (the copy and this browser's membership together).
import * as Y from "yjs";
import { IndexeddbPersistence, clearDocument } from "y-indexeddb";
import { forget, storedSecrets } from "./api";

const NOTES_KEY = "riff-boards";

export type CopyNote = {
  roomId: string;
  code: string;
  host: boolean;
  hostName: string | null;
  firstOpened: number;
  lastOpened: number;
};

export type LocalCopy = {
  // the IndexedDB database holding it
  database: string;
  // null for a copy from before rooms had ids (a `riff-<code>` database)
  roomId: string | null;
  code: string | null;
  host: boolean | null;
  hostName: string | null;
  firstOpened: number | null;
  lastOpened: number | null;
};

const databaseOf = (roomId: string) => `room/${roomId}/shared`;
const CURRENT = /^room\/([\w-]{8,64})\/shared$/;
// Before sign-in, a room's document was named for its code.
const OLD = /^riff-([A-Za-z0-9-]{1,16})$/;

function readNotes(): Record<string, CopyNote> {
  try {
    const notes = JSON.parse(localStorage.getItem(NOTES_KEY) ?? "{}") as unknown;
    return notes && typeof notes === "object" && !Array.isArray(notes) ? notes as Record<string, CopyNote> : {};
  } catch {
    return {};
  }
}

function writeNotes(notes: Record<string, CopyNote>) {
  if (Object.keys(notes).length) localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  else localStorage.removeItem(NOTES_KEY);
}

// Called while a room is open, and again when its code or host changes.
export function noteOpened(note: Omit<CopyNote, "firstOpened" | "lastOpened">, now = Date.now()) {
  const notes = readNotes();
  const before = notes[note.roomId];
  notes[note.roomId] = { ...note, firstOpened: before?.firstOpened ?? now, lastOpened: now };
  writeNotes(notes);
}

async function databaseNames() {
  if (!indexedDB.databases) return null;
  return (await indexedDB.databases()).map((database) => database.name ?? "");
}

// Every copy on this browser: the ones it has notes for, and any database
// that looks like a room's without one, so none is kept silently. Most
// recently opened first.
export async function listCopies(): Promise<LocalCopy[]> {
  const notes = readNotes();
  const names = await databaseNames();
  const copies = new Map<string, LocalCopy>();
  const known = names ? new Set(names) : null;
  for (const note of Object.values(notes)) {
    const database = databaseOf(note.roomId);
    // a note whose database has gone (cleared by the browser) isn't a copy
    if (known && !known.has(database)) continue;
    copies.set(database, { database, ...note });
  }
  for (const name of names ?? []) {
    if (copies.has(name)) continue;
    const current = CURRENT.exec(name);
    const old = OLD.exec(name);
    if (!current && !old) continue;
    copies.set(name, {
      database: name,
      roomId: current?.[1] ?? null,
      code: old ? old[1].toUpperCase() : null,
      host: null,
      hostName: null,
      firstOpened: null,
      lastOpened: null,
    });
  }
  return [...copies.values()].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0) || a.database.localeCompare(b.database));
}

export async function findCopy(database: string) {
  return (await listCopies()).find((copy) => copy.database === database) ?? null;
}

// The copy as a document, read from IndexedDB alone. The caller destroys it.
// Deleting a copy (Delete, or signing out) with the room open in another
// tab closes that tab's connection to the database (lib0 closes on
// versionchange), but y-indexeddb keeps writing to it: the tab's next edit
// threw InvalidStateError from inside the document's update event. Every
// copy is opened through here and stops writing when another tab deletes
// it; the room carries on with the server alone (rooms-browser smoke).
export function openCopy(database: string, doc: Y.Doc) {
  const persistence = new IndexeddbPersistence(database, doc);
  void (persistence as unknown as { _db: Promise<IDBDatabase> })._db.then((db) => {
    db.addEventListener("versionchange", () => void persistence.destroy());
  });
  return persistence;
}

export async function loadCopy(copy: LocalCopy) {
  const doc = new Y.Doc();
  const persistence = openCopy(copy.database, doc);
  await persistence.whenSynced;
  return {
    doc,
    destroy: () => {
      void persistence.destroy();
      doc.destroy();
    },
  };
}

// The copy, and this browser's membership of the room with it: nothing of
// the room stays on this machine. (A member by GitHub account stays a
// member through the account; the server keeps that, not this browser.)
export async function deleteCopy(copy: LocalCopy) {
  await clearDocument(copy.database);
  if (copy.roomId) {
    forget(copy.roomId);
    const notes = readNotes();
    delete notes[copy.roomId];
    writeNotes(notes);
  }
}

// Every copy, and every room membership this browser holds, copy or not.
export async function deleteAllCopies() {
  const copies = await listCopies();
  for (const copy of copies) await deleteCopy(copy);
  for (const { roomId } of storedSecrets()) forget(roomId);
  writeNotes({});
  return copies.length;
}

// A new room's copy, filled before the room first opens (import): the room
// page loads it from IndexedDB like any copy and sends it to the server.
// Read back before returning, so leaving the page can't lose it.
export async function seedCopy(roomId: string, fill: (doc: Y.Doc) => void) {
  const database = databaseOf(roomId);
  const doc = new Y.Doc();
  fill(doc);
  const writer = new IndexeddbPersistence(database, doc);
  await writer.whenSynced;
  await writer.destroy();
  const check = new Y.Doc();
  const reader = new IndexeddbPersistence(database, check);
  await reader.whenSynced;
  const same = Y.encodeStateVector(check).join() === Y.encodeStateVector(doc).join();
  await reader.destroy();
  doc.destroy();
  check.destroy();
  if (!same) throw new Error("the board didn't save in this browser");
}
