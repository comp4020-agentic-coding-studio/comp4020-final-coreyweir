// The board as a picture, beside the board file (docs/adr/0003): a PNG to
// put in a report or a chat, where the JSON file is for starting a room
// again. Drawn by quickdraw's own export (Editor.exportImage, the same one
// Send board uses for board.png), so it looks like the board: its paper,
// its dots, its shapes.
//
// Always from the room's document, through an editor of its own that is
// never on the page, not from whichever board happens to be showing. A
// row on the start page has no board mounted, only this browser's copy, and
// the room's own board has the person's selection and camera on it; one
// path gives the same picture of the same document wherever it's asked for.
import { Editor, Store, drawShape, themeOf, type BoardRecord, type ShapeRecord } from "@quickdrawjs/react";
import type * as Y from "yjs";
import { PICTURE_MARGIN } from "./boardForClaude";

export const EMPTY_PICTURE = "The board is empty, so there's no picture to make.";

/** Said to the person as it is, unlike a storage or network failure. */
export class EmptyBoard extends Error {
  constructor() {
    super(EMPTY_PICTURE);
  }
}

export const boardPictureName = (code: string) => `riff-${code}-board.png`;

const boardRecords = (doc: Y.Doc) => doc.getMap<BoardRecord>("boardRecords");

export function boardHasShapes(doc: Y.Doc) {
  for (const record of boardRecords(doc).values()) if (record.typeName === "shape") return true;
  return false;
}

// quickdraw draws an image from a cache of its own, by asset id, that
// starts loading the first time a shape asks and draws a grey box until
// then. exportImage decodes the images itself first, but not into that
// cache, so a board that was never on screen exports grey boxes (it worked
// in the room only because the room's board had drawn the images). So the
// images are put in the cache here first, under ids of the picture's own
// ("picture:<id>", which nothing on screen uses, so nothing else is part
// way through loading one), and waited for: the cache says it's ready, or
// the image can't be read at all and stays a grey box. One picture at a
// time, so a second click can't find one half loaded.
const PICTURE_ID = "picture:";
let previous: Promise<unknown> = Promise.resolve();

function cached(store: Store, image: ShapeRecord, src: string) {
  return new Promise<void>((resolve) => {
    let fresh = false;
    // asset() is only asked when the cache has no entry for the id yet.
    const asking = { asset: (id: string) => { fresh = true; return store.asset(id); } } as unknown as Store;
    const scratch = document.createElement("canvas").getContext("2d")!;
    drawShape(scratch, image, { theme: themeOf("light"), store: asking, onAssetLoad: resolve });
    // Already there (an earlier picture), or broken for good: nothing to wait for.
    if (!fresh) return resolve();
    const probe = new Image();
    probe.onerror = () => resolve();
    probe.src = src;
  });
}

async function render(doc: Y.Doc): Promise<Blob> {
  const store = new Store();
  store.transact(() => {
    for (const original of boardRecords(doc).values()) {
      const record = structuredClone(original) as BoardRecord & { props?: { assetId?: unknown } };
      if (record.typeName === "asset") record.id = `${PICTURE_ID}${record.id}`;
      else if (record.type === "image" && typeof record.props?.assetId === "string") record.props.assetId = `${PICTURE_ID}${record.props.assetId}`;
      store.put(record, "remote");
    }
  }, "remote");
  const shapes = store.shapes();
  if (!shapes.length) throw new EmptyBoard();
  await Promise.all(shapes.filter((shape) => shape.type === "image").map((shape) => {
    const asset = typeof shape.props.assetId === "string" ? store.asset(shape.props.assetId) : null;
    return asset ? cached(store, shape, asset.src) : null;
  }));
  // As the room shows it (App.tsx's <Quickdraw grid="dots" theme="light">).
  const editor = new Editor({ container: document.createElement("div"), store, grid: "dots", theme: "light", readonly: true });
  try {
    const png = await editor.exportImage({ background: true, scale: 2, margin: PICTURE_MARGIN });
    if (!png) throw new EmptyBoard();
    return png;
  } finally {
    editor.destroy();
  }
}

/** The whole board as a PNG, at twice board scale (quickdraw keeps it under ~24 MP). */
export function boardPicture(doc: Y.Doc): Promise<Blob> {
  const next = previous.then(() => render(doc), () => render(doc));
  previous = next.catch(() => {});
  return next;
}
