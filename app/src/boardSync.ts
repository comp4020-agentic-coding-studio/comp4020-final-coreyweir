import { useEffect } from "react";
import type { BoardRecord, Diff, Store } from "@quickdrawjs/react";
import * as Y from "yjs";

const LOCAL_BOARD_CHANGE = Symbol("local-board-change");

function emptyDiff(): Diff {
  return { added: {}, removed: {}, updated: {} };
}

function cloneRecord(record: BoardRecord): BoardRecord {
  return structuredClone(record);
}

// The room's size limit, as the board sees it (docs/adr/0003, amendment).
// The server refuses the write that would cross it and the room turns
// read-only; refusing an image here first means a pasted screenshot that
// doesn't fit is turned away, not the room.
export type BoardLimit = {
  limitBytes: number | null;
  // what the room's documents hold now, about what the server stores
  bytesUsed: () => number;
  onTooBig: (bytes: number) => void;
};

const recordBytes = (record: BoardRecord) => new TextEncoder().encode(JSON.stringify(record)).byteLength;

function invert(diff: Diff): Diff {
  const updated: Diff["updated"] = {};
  for (const [id, [from, to]] of Object.entries(diff.updated)) updated[id] = [to, from];
  return { added: diff.removed, removed: diff.added, updated };
}

export function useBoardSync(doc: Y.Doc, store: Store, limit?: { current: BoardLimit }) {
  useEffect(() => {
    const records = doc.getMap<BoardRecord>("boardRecords");

    store.transact(() => {
      store.clear("remote");
      records.forEach((record) => store.put(cloneRecord(record), "remote"));
    }, "remote");

    const stopStoreListener = store.listen((diff, source) => {
      if (source !== "user") return;
      // Only images are big enough to matter; strokes and notes are bytes.
      const { limitBytes, bytesUsed, onTooBig } = limit?.current ?? { limitBytes: null };
      const addsAnImage = Object.values(diff.added).some((record) => record.typeName === "asset");
      if (limitBytes && addsAnImage && bytesUsed) {
        const adding = [...Object.values(diff.added), ...Object.values(diff.updated).map(([, record]) => record)]
          .reduce((sum, record) => sum + recordBytes(record), 0);
        if (bytesUsed() + adding > limitBytes) {
          // Take it back off this board without it ever reaching the room,
          // and out of the undo history, so undo doesn't bring it back.
          const history = store as unknown as { undos?: Diff[] };
          if (history.undos?.at(-1) === diff) history.undos.pop();
          store.applyDiff(invert(diff), "remote");
          onTooBig?.(adding);
          return;
        }
      }
      doc.transact(() => {
        Object.entries(diff.added).forEach(([id, record]) => records.set(id, cloneRecord(record)));
        Object.entries(diff.updated).forEach(([id, [, record]]) => records.set(id, cloneRecord(record)));
        Object.keys(diff.removed).forEach((id) => records.delete(id));
      }, LOCAL_BOARD_CHANGE);
    });

    const onRemoteRecords = (event: Y.YMapEvent<BoardRecord>) => {
      if (event.transaction.origin === LOCAL_BOARD_CHANGE) return;
      const diff = emptyDiff();

      event.changes.keys.forEach((change, id) => {
        const current = records.get(id);
        if (change.action === "add" && current) diff.added[id] = cloneRecord(current);
        if (change.action === "delete" && change.oldValue) diff.removed[id] = cloneRecord(change.oldValue);
        if (change.action === "update" && change.oldValue && current) {
          diff.updated[id] = [cloneRecord(change.oldValue), cloneRecord(current)];
        }
      });

      store.applyDiff(diff, "remote");
    };

    records.observe(onRemoteRecords);
    return () => {
      stopStoreListener();
      records.unobserve(onRemoteRecords);
    };
  }, [doc, store]);
}
