// The board, or a selection of it, as files Claude can read (PLAN P3,
// week-12 #5). Host only: the files go into the host's pod, under
// /tmp/riff/board-N/, and a staged prompt points Claude at them.
//
// - board.json: the shapes, trimmed to what a model can use. Text in full,
//   positions and sizes rounded, freehand strokes as a box (not thousands
//   of points), arrows with the shapes their ends touch. quickdraw keeps no
//   bindings (an arrow is a start point and an offset), so the ends are
//   matched to shapes by position here, and the file says so.
// - image-N.*: the board's pasted images, out of their data URLs and shrunk
//   to Claude's limit (imagePaste.ts).
// - board.png: a picture of it, only for a model that reads images (Riff's
//   free models don't, docs/adr/0009).
//
// No DOM and no React here: `npm run test:board-for-claude` runs it under
// node. What needs a canvas (quickdraw's bounds and render, resizing an
// image) comes in as functions.
import type { BoardRecord, ShapeRecord } from "@quickdrawjs/react";

export const BOARD_DIR = "/tmp/riff";
export const BOARD_FORMAT = "riff-board-for-claude-1";
/** Margin around the picture, in board units. */
export const PICTURE_MARGIN = 24;
/** Claude attaches nothing over 2000 px a side (imagePaste.ts). */
export const PICTURE_MAX_SIDE = 2000;
/** How far (board units) an arrow's end can be from a shape and still touch it. */
const TOUCH = 16;

export type Bounds = { x: number; y: number; w: number; h: number };

/** The host's pod, as far as writing files in it goes (claudePod.ts). */
export type PodFiles = {
  /** False for a model that can't read images (Riff's free models). */
  readsImages: boolean;
  exists: (path: string) => boolean;
  /** Writes the file, making its directory first. */
  write: (path: string, bytes: Uint8Array) => void;
  remove: (path: string) => void;
};

type Point = { x: number; y: number };

export type BoardShape =
  | { id: string; type: "note" | "text"; text: string; color?: string; x: number; y: number; w: number; h: number; inside?: string }
  | { id: string; type: "geo"; geo: string; label?: string; color?: string; fill?: string; x: number; y: number; w: number; h: number; inside?: string }
  | { id: string; type: "arrow" | "line"; start: Point; end: Point; from?: string; to?: string; curved?: true; color?: string; dash?: string }
  | { id: string; type: "image"; file: string | null; x: number; y: number; w: number; h: number; inside?: string }
  | { id: string; type: "freehand" | "highlight"; color?: string; x: number; y: number; w: number; h: number; inside?: string };

export type BoardDescription = {
  format: typeof BOARD_FORMAT;
  about: string;
  scope: string;
  size: { w: number; h: number };
  picture?: { file: "board.png"; pixelsPerUnit: number; margin: number };
  shapes: BoardShape[];
};

export type ExtractedImage = { bytes: Uint8Array; extension: string };

export type BoardFiles = {
  description: BoardDescription;
  /** Name in the board's directory and contents, board.json first. */
  files: Array<{ name: string; bytes: Uint8Array }>;
  images: string[];
  picture: boolean;
  selection: boolean;
  shapes: number;
};

const round = (value: number) => Math.round(value);
const area = (box: Bounds) => box.w * box.h;
const contains = (outer: Bounds, inner: Bounds) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const near = (box: Bounds, point: Point) =>
  point.x >= box.x - TOUCH && point.x <= box.x + box.w + TOUCH && point.y >= box.y - TOUCH && point.y <= box.y + box.h + TOUCH;

export function unionBounds(boxes: Bounds[]): Bounds | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** Pixels per board unit for a picture of `box` (with its margin) within Claude's limit. */
export function pictureScale(box: Bounds, max = PICTURE_MAX_SIDE, margin = PICTURE_MARGIN) {
  const side = Math.max(box.w, box.h) + margin * 2;
  return Math.min(2, max / side);
}

/** A data URL's bytes and type, without fetch (a CSP can refuse data: there). */
export function dataUrlBlob(src: string): Blob | null {
  const match = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(src);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: match[1] });
  } catch {
    return null;
  }
}

const textOf = (value: unknown) => typeof value === "string" ? value : "";
const stringProp = (shape: ShapeRecord, key: string) => typeof shape.props[key] === "string" && shape.props[key] ? shape.props[key] as string : undefined;

const ABOUT = [
  "Shapes from a whiteboard in a Riff room, for reading.",
  "x and y are the top-left of each shape, w and h its size, in board units counted from the top-left of what was sent (x right, y down), rounded.",
  "Shapes are listed top to bottom, then left to right.",
  "note: a sticky note; text: free text; geo: a drawn shape (rectangle, ellipse...) with an optional label; image: a pasted image, its file in this directory;",
  "freehand/highlight: a pen or highlighter stroke, given only as the box around it.",
  "arrow/line: start and end points; from and to name the shape each end touches, worked out from positions (the board doesn't record connections).",
  "inside: the smallest drawn shape that encloses this one.",
].join(" ");

/**
 * The files for the board, or for the shapes in `selection` if there are
 * any. `bounds` is quickdraw's `pageBounds`; `extract` turns an image's
 * data URL into the bytes Claude takes; `render` draws the shapes as a PNG
 * at a scale (left out when the model can't read images).
 */
export async function boardFiles(records: Iterable<BoardRecord>, options: {
  selection?: string[];
  bounds: (shape: ShapeRecord) => Bounds;
  extract: (src: string) => Promise<ExtractedImage>;
  render?: (ids: Set<string> | null, scale: number, margin: number) => Promise<Uint8Array | null>;
}): Promise<BoardFiles> {
  const all = [...records];
  const assets = new Map<string, string>();
  for (const record of all) if (record.typeName === "asset") assets.set(record.id, (record as { src: string }).src);
  const every = all.filter((record): record is ShapeRecord => record.typeName === "shape");
  const chosen = new Set(options.selection ?? []);
  const selection = every.some((shape) => chosen.has(shape.id));
  const shapes = selection ? every.filter((shape) => chosen.has(shape.id)) : every;

  const boxes = new Map(shapes.map((shape) => [shape.id, options.bounds(shape)]));
  const whole = unionBounds([...boxes.values()]) ?? { x: 0, y: 0, w: 0, h: 0 };
  const local = (box: Bounds) => ({ x: round(box.x - whole.x), y: round(box.y - whole.y), w: round(box.w), h: round(box.h) });
  const localPoint = (point: Point) => ({ x: round(point.x - whole.x), y: round(point.y - whole.y) });

  // Reading order, and short names in that order.
  const ordered = [...shapes].sort((a, b) => {
    const boxA = boxes.get(a.id)!, boxB = boxes.get(b.id)!;
    return round(boxA.y) - round(boxB.y) || round(boxA.x) - round(boxB.x) || a.z - b.z;
  });
  const names = new Map(ordered.map((shape, index) => [shape.id, `s${index + 1}`]));
  const lineish = (shape: ShapeRecord) => shape.type === "arrow" || shape.type === "line";
  const targets = ordered.filter((shape) => !lineish(shape));
  const geos = ordered.filter((shape) => shape.type === "geo");

  const touching = (point: Point, self: string) => {
    let best: ShapeRecord | null = null;
    for (const shape of targets) {
      if (shape.id === self || !near(boxes.get(shape.id)!, point)) continue;
      if (!best || area(boxes.get(shape.id)!) < area(boxes.get(best.id)!)) best = shape;
    }
    return best ? names.get(best.id) : undefined;
  };
  const insideOf = (shape: ShapeRecord) => {
    const box = boxes.get(shape.id)!;
    let best: ShapeRecord | null = null;
    for (const geo of geos) {
      if (geo.id === shape.id) continue;
      const outer = boxes.get(geo.id)!;
      if (area(outer) <= area(box) || !contains(outer, box)) continue;
      if (!best || area(outer) < area(boxes.get(best.id)!)) best = geo;
    }
    return best ? { inside: names.get(best.id)! } : {};
  };

  const files: BoardFiles["files"] = [];
  const imageFiles = new Map<string, string | null>();
  const imageFile = async (assetId: unknown) => {
    if (typeof assetId !== "string" || !assets.has(assetId)) return null;
    if (imageFiles.has(assetId)) return imageFiles.get(assetId)!;
    let name: string | null = null;
    try {
      const image = await options.extract(assets.get(assetId)!);
      name = `image-${imageFiles.size + 1}.${image.extension}`;
      files.push({ name, bytes: image.bytes });
    } catch {
      // Said in board.json: the shape is there, its file isn't.
    }
    imageFiles.set(assetId, name);
    return name;
  };

  const described: BoardShape[] = [];
  for (const shape of ordered) {
    const id = names.get(shape.id)!;
    const box = local(boxes.get(shape.id)!);
    const color = stringProp(shape, "color");
    switch (shape.type) {
      case "note":
      case "text":
        described.push({ id, type: shape.type, text: textOf(shape.props.text), ...(color ? { color } : {}), ...box, ...insideOf(shape) });
        break;
      case "geo": {
        const label = textOf(shape.props.label);
        const fill = stringProp(shape, "fill");
        described.push({ id, type: "geo", geo: stringProp(shape, "geo") ?? "rectangle", ...(label ? { label } : {}), ...(color ? { color } : {}), ...(fill && fill !== "none" ? { fill } : {}), ...box, ...insideOf(shape) });
        break;
      }
      case "arrow":
      case "line": {
        const dx = Number(shape.props.dx) || 0, dy = Number(shape.props.dy) || 0;
        const start = { x: shape.x, y: shape.y };
        const end = { x: shape.x + dx, y: shape.y + dy };
        const from = touching(start, shape.id), to = touching(end, shape.id);
        const dash = stringProp(shape, "dash");
        described.push({
          id, type: shape.type, start: localPoint(start), end: localPoint(end),
          ...(from ? { from } : {}), ...(to ? { to } : {}),
          ...(shape.props.bend ? { curved: true as const } : {}),
          ...(color ? { color } : {}), ...(dash && dash !== "solid" ? { dash } : {}),
        });
        break;
      }
      case "image":
        described.push({ id, type: "image", file: await imageFile(shape.props.assetId), ...box, ...insideOf(shape) });
        break;
      case "draw":
      case "highlight":
        described.push({ id, type: shape.type === "draw" ? "freehand" : "highlight", ...(color ? { color } : {}), ...box, ...insideOf(shape) });
        break;
    }
  }

  let picture = false;
  const scale = pictureScale(whole);
  if (options.render && shapes.length) {
    const png = await options.render(selection ? new Set(shapes.map((shape) => shape.id)) : null, scale, PICTURE_MARGIN);
    if (png) {
      files.push({ name: "board.png", bytes: png });
      picture = true;
    }
  }
  const total = every.length;
  const description: BoardDescription = {
    format: BOARD_FORMAT,
    about: ABOUT,
    scope: selection ? `${shapes.length} selected of the board's ${total} shapes` : `the whole board, ${total} shape${total === 1 ? "" : "s"}`,
    size: { w: round(whole.w), h: round(whole.h) },
    ...(picture ? { picture: { file: "board.png" as const, pixelsPerUnit: Math.round(scale * 1000) / 1000, margin: PICTURE_MARGIN } } : {}),
    shapes: described,
  };
  files.unshift({ name: "board.json", bytes: new TextEncoder().encode(`${JSON.stringify(description, null, 2)}\n`) });
  return {
    description,
    files,
    images: [...imageFiles.values()].filter((name): name is string => name !== null),
    picture,
    selection,
    shapes: shapes.length,
  };
}

/** The first /tmp/riff/board-N that doesn't exist yet, so earlier ones stay. */
export function nextBoardDir(exists: (path: string) => boolean) {
  let index = 1;
  while (exists(`${BOARD_DIR}/board-${index}`)) index += 1;
  return `${BOARD_DIR}/board-${index}`;
}

const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * The staged prompt's opening, for the host to edit. With a model that
 * can't read images (`textOnly`) it says so of the image files, so Claude
 * isn't sent to open one: what a text-only endpoint does with an image in
 * a request is refuse the whole request (imagePaste.ts).
 */
export function boardPrompt(dir: string, files: Pick<BoardFiles, "images" | "picture" | "selection">, textOnly = false) {
  const what = files.selection ? "The shapes we selected on our room's board are" : "The board from our room is";
  const parts = ["board.json describes every shape"];
  if (files.picture) parts.push(`board.png is a picture of ${files.selection ? "them" : "it"}`);
  if (files.images.length) parts.push(`${list(files.images)} ${files.images.length === 1 ? "is the pasted image" : "are the pasted images"}${textOnly ? ", which the model in use can't look at" : ""}`);
  return `${what} in ${dir}/ (${parts.join("; ")}).\n\n`;
}

export const NO_PICTURE_NOTICE = "Riff's free models read text only, so there's no picture of the board: Claude gets board.json and any image files, but can't look at images. To share pictures, host with your own API endpoint.";

/** Write the files into the pod. */
export function writeBoardFiles(pod: PodFiles, dir: string, files: BoardFiles["files"]) {
  for (const file of files) pod.write(`${dir}/${file.name}`, file.bytes);
}
