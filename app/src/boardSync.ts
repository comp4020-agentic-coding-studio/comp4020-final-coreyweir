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

export function useBoardSync(doc: Y.Doc, store: Store) {
  useEffect(() => {
    const records = doc.getMap<BoardRecord>("boardRecords");

    store.transact(() => {
      store.clear("remote");
      records.forEach((record) => store.put(cloneRecord(record), "remote"));
    }, "remote");

    const stopStoreListener = store.listen((diff, source) => {
      if (source !== "user") return;
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
