// A board as one file: export from a room or from this browser's copy of
// one, import into a new room (docs/adr/0003, second amendment).
//
// The board part is quickdraw's own snapshot shape, `{ document: { store } }`,
// so the file also loads into a plain quickdraw. Import copies only the
// record types and fields quickdraw draws (palette.js, editor.js, shapes.js
// in @quickdrawjs/core 0.1.3), rebuilt one known key at a time, so nothing
// else in a file (a `__proto__`, a remote image URL) reaches a room.
//
// No DOM and no React here: `npm run test:board-file` runs it under node.
import type { BoardRecord, ShapeRecord } from "@quickdrawjs/react";
import * as Y from "yjs";

export const BOARD_FILE_FORMAT = "riff-board";
export const BOARD_FILE_VERSION = 1;
// What a room holds (app/server/riff.mjs, ROOM_LIMIT_BYTES). The server
// enforces it; checking here means an import that can't fit never makes
// a room at all.
export const ROOM_LIMIT_BYTES = 4 * 1024 * 1024;
// Above the room's limit, so a file can't be big for any other reason.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export type FilePrompt = { author: string; text: string };

export type BoardFile = {
  format: typeof BOARD_FILE_FORMAT;
  version: typeof BOARD_FILE_VERSION;
  exportedAt: string;
  room: { code: string };
  board: { document: { store: Record<string, BoardRecord> } };
  prompts: FilePrompt[];
  queue: FilePrompt[];
};

export type ParsedBoard = {
  code: string | null;
  exportedAt: string | null;
  records: BoardRecord[];
  prompts: FilePrompt[];
  shapes: number;
  images: number;
  // what was in the file but isn't coming in, in words
  leftOut: string[];
};

export class BoardFileError extends Error {}

// ---- the room's documents -------------------------------------------------

type PromptMap = Y.Map<Y.Map<unknown>>;

// A staged prompt, as `room.ts` and the server's log expect it.
export function stagePrompt(doc: Y.Doc, author: string, text: string, sourceId: string | null = null, rank = Date.now()) {
  const id = crypto.randomUUID();
  const prompt = new Y.Map<unknown>();
  prompt.set("author", author);
  prompt.set("sourceId", sourceId);
  prompt.set("status", "staged");
  prompt.set("rank", rank);
  prompt.set("text", new Y.Text(text));
  doc.transact(() => doc.getMap<Y.Map<unknown>>("prompts").set(id, prompt));
  return id;
}

export function readPrompts(prompts: PromptMap): FilePrompt[] {
  const list: Array<FilePrompt & { rank: number; id: string }> = [];
  prompts.forEach((map, id) => {
    const text = map.get("text");
    if (!(text instanceof Y.Text)) return;
    list.push({ id, rank: Number(map.get("rank") ?? 0), author: String(map.get("author") ?? "Guest"), text: text.toString() });
  });
  return list
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .map(({ author, text }) => ({ author, text }));
}

// ---- export ---------------------------------------------------------------

export function exportBoard({ code, doc, queue = [], now = new Date() }: {
  code: string;
  doc: Y.Doc;
  queue?: FilePrompt[];
  now?: Date;
}): BoardFile {
  const store: Record<string, BoardRecord> = {};
  doc.getMap<BoardRecord>("boardRecords").forEach((record, id) => {
    store[id] = structuredClone(record);
  });
  return {
    format: BOARD_FILE_FORMAT,
    version: BOARD_FILE_VERSION,
    exportedAt: now.toISOString(),
    room: { code },
    board: { document: { store } },
    prompts: readPrompts(doc.getMap("prompts")),
    queue: queue.map(({ author, text }) => ({ author, text })),
  };
}

export function boardFileName(code: string, at = new Date()) {
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return `riff-${code.replace(/[^\w-]/g, "") || "board"}-${day}.json`;
}

// ---- import ---------------------------------------------------------------

const SHAPE_TYPES = new Set(["draw", "highlight", "geo", "arrow", "line", "text", "note", "image"]);
const COLORS = ["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red"];
const SIZES = ["s", "m", "l", "xl"];
const ENUM_PROPS: Record<string, string[]> = {
  color: COLORS,
  size: SIZES,
  labelSize: SIZES,
  dash: ["draw", "solid", "dashed", "dotted"],
  fill: ["none", "semi", "solid", "pattern"],
  font: ["draw", "sans", "serif", "mono"],
  geo: ["rectangle", "ellipse", "triangle", "diamond", "hexagon", "star"],
  align: ["start", "middle", "end"],
};
const NUMBER_PROPS = ["w", "h", "dx", "dy", "bend", "scale"];
const TEXT_PROPS = ["text", "label"];
const FLAG_PROPS = ["done", "isPen", "autosize"];
const MAX_TEXT = 20_000;
const MAX_POINTS = 300_000;
const MAX_RECORDS = 20_000;
const MAX_PROMPTS = 500;
// quickdraw's own limit for an image it keeps (readImage in editor.js)
export const MAX_IMAGE_SIDE = 2048;

const ID = /^[A-Za-z0-9_:-]{1,80}$/;
const IMAGE_SRC = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// The first bytes of each type we take, so a file can't call an SVG a PNG.
function magicMatches(type: string, base64: string) {
  let head: string;
  try {
    head = atob(base64.slice(0, 24));
  } catch {
    return false;
  }
  const bytes = [...head].map((char) => char.charCodeAt(0));
  const starts = (...expected: number[]) => expected.every((byte, index) => bytes[index] === byte);
  switch (type) {
    case "png": return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "jpeg": return starts(0xff, 0xd8, 0xff);
    case "gif": return starts(0x47, 0x49, 0x46, 0x38);
    case "webp": return starts(0x52, 0x49, 0x46, 0x46) && head.slice(8, 12) === "WEBP";
    default: return false;
  }
}

type AssetCheck = { record: BoardRecord } | { problem: "type" | "size" | "broken" };

function readAsset(raw: Record<string, unknown>): AssetCheck {
  const { id, src, w, h } = raw;
  if (typeof id !== "string" || !ID.test(id)) return { problem: "broken" };
  if (!isNumber(w) || !isNumber(h) || w <= 0 || h <= 0) return { problem: "broken" };
  if (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) return { problem: "size" };
  if (typeof src !== "string") return { problem: "broken" };
  const match = IMAGE_SRC.exec(src);
  if (!match) return { problem: src.startsWith("data:image/") ? "type" : "broken" };
  if (!magicMatches(match[1], match[2])) return { problem: "type" };
  return { record: { id, typeName: "asset", src, w, h } as BoardRecord };
}

function readShape(raw: Record<string, unknown>): ShapeRecord | null {
  const { id, type, x, y, rot, z, props } = raw;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof type !== "string" || !SHAPE_TYPES.has(type)) return null;
  if (!isNumber(x) || !isNumber(y) || !isNumber(z)) return null;
  if (!isObject(props)) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, allowed] of Object.entries(ENUM_PROPS)) {
    if (typeof props[key] === "string" && allowed.includes(props[key] as string)) clean[key] = props[key];
  }
  for (const key of NUMBER_PROPS) if (isNumber(props[key])) clean[key] = props[key];
  for (const key of TEXT_PROPS) if (typeof props[key] === "string") clean[key] = (props[key] as string).slice(0, MAX_TEXT);
  for (const key of FLAG_PROPS) if (typeof props[key] === "boolean") clean[key] = props[key];
  if (Array.isArray(props.pts)) {
    if (props.pts.length > MAX_POINTS || !props.pts.every(isNumber)) return null;
    clean.pts = [...props.pts];
  }
  if (typeof props.assetId === "string" && ID.test(props.assetId)) clean.assetId = props.assetId;
  if ((type === "draw" || type === "highlight") && !clean.pts) return null;
  if (type === "image" && !clean.assetId) return null;
  return { id, typeName: "shape", type, x, y, rot: isNumber(rot) ? rot : 0, z, props: clean } as ShapeRecord;
}

function readPromptList(value: unknown): FilePrompt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item) || typeof item.text !== "string" || !item.text.trim()) return [];
    const author = typeof item.author === "string" && item.author.trim() ? item.author.trim().slice(0, 40) : "Guest";
    return [{ author, text: item.text.slice(0, MAX_TEXT) }];
  });
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function parseBoardFile(text: string): ParsedBoard {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new BoardFileError("That isn't a Riff board file.");
  }
  if (!isObject(file) || file.format !== BOARD_FILE_FORMAT) throw new BoardFileError("That isn't a Riff board file.");
  if (file.version !== BOARD_FILE_VERSION) {
    throw new BoardFileError(isNumber(file.version) && file.version > BOARD_FILE_VERSION
      ? "That board file comes from a newer Riff."
      : "That isn't a Riff board file.");
  }
  const board = isObject(file.board) && isObject(file.board.document) ? file.board.document.store : undefined;
  if (!isObject(board)) throw new BoardFileError("That board file has no board in it.");
  const raw = Object.values(board);
  if (raw.length > MAX_RECORDS) throw new BoardFileError(`That board has more than ${MAX_RECORDS} things on it.`);

  const assets = new Map<string, BoardRecord>();
  const shapes: ShapeRecord[] = [];
  const left = { type: 0, size: 0, broken: 0, other: 0 };
  const rejected = new Set<unknown>();
  for (const item of raw) {
    if (!isObject(item)) {
      left.other += 1;
    } else if (item.typeName === "asset") {
      const checked = readAsset(item);
      if ("record" in checked) assets.set(checked.record.id, checked.record);
      else {
        left[checked.problem] += 1;
        rejected.add(item.id);
      }
    } else if (item.typeName === "shape") {
      const shape = readShape(item);
      if (shape) shapes.push(shape);
      else left.other += 1;
    } else {
      left.other += 1;
    }
  }

  // An image shape is only as good as its image; an image nothing shows is
  // dead weight.
  const used = new Set<string>();
  const kept = shapes.filter((shape) => {
    const assetId = (shape.props as { assetId?: string }).assetId;
    if (shape.type !== "image") return true;
    if (!assetId || !assets.has(assetId)) {
      // already counted, as the image it shows
      if (!rejected.has(assetId)) left.other += 1;
      return false;
    }
    used.add(assetId);
    return true;
  });
  const shapesLeft = left.other;
  const keptAssets = [...assets.values()].filter((asset) => used.has(asset.id));

  const leftOut: string[] = [];
  if (left.type) leftOut.push(`${plural(left.type, "image")} that ${left.type === 1 ? "isn't" : "aren't"} PNG, JPEG, WebP or GIF`);
  if (left.size) leftOut.push(`${plural(left.size, "image")} over ${MAX_IMAGE_SIDE}px`);
  if (left.broken) leftOut.push(`${plural(left.broken, "image")} Riff couldn't read`);
  if (shapesLeft > 0) leftOut.push(`${plural(shapesLeft, "other thing")} Riff doesn't know how to draw`);

  const prompts = [...readPromptList(file.prompts), ...readPromptList(file.queue)];
  if (prompts.length > MAX_PROMPTS) throw new BoardFileError(`That board file has more than ${MAX_PROMPTS} prompts.`);

  return {
    code: isObject(file.room) && typeof file.room.code === "string" ? file.room.code.replace(/[^\w-]/g, "").slice(0, 16) : null,
    exportedAt: typeof file.exportedAt === "string" && !Number.isNaN(Date.parse(file.exportedAt)) ? file.exportedAt : null,
    records: [...keptAssets, ...kept],
    prompts,
    shapes: kept.length,
    images: keptAssets.length,
    leftOut,
  };
}

// Images that pass the checks above but don't decode, or are bigger than
// they claim, are left out too. Needs a browser (createImageBitmap).
export async function dropUndecodableImages(
  parsed: ParsedBoard,
  decode: (blob: Blob) => Promise<{ width: number; height: number; close?: () => void }> = createImageBitmap,
): Promise<ParsedBoard> {
  const bad = new Set<string>();
  for (const record of parsed.records) {
    if (record.typeName !== "asset") continue;
    const src = (record as { src: string }).src;
    try {
      const blob = await (await fetch(src)).blob();
      const image = await decode(blob);
      const fits = image.width <= MAX_IMAGE_SIDE && image.height <= MAX_IMAGE_SIDE;
      image.close?.();
      if (!fits) bad.add(record.id);
    } catch {
      bad.add(record.id);
    }
  }
  if (!bad.size) return parsed;
  const records = parsed.records.filter((record) => {
    if (record.typeName === "asset") return !bad.has(record.id);
    const shape = record as { type?: string; props?: { assetId?: string } };
    return !(shape.type === "image" && shape.props?.assetId && bad.has(shape.props.assetId));
  });
  return {
    ...parsed,
    records,
    images: parsed.images - bad.size,
    shapes: records.filter((record) => record.typeName === "shape").length,
    leftOut: [...parsed.leftOut, `${plural(bad.size, "image")} that wouldn't open`],
  };
}

// Into a room's shared document: the board, then the prompts as staged,
// in the file's order (the queue's after the staged ones). Nothing goes
// to the queue: the new room's host decides that again.
export function applyBoardFile(doc: Y.Doc, parsed: ParsedBoard, now = Date.now()) {
  const records = doc.getMap<BoardRecord>("boardRecords");
  doc.transact(() => {
    for (const record of parsed.records) records.set(record.id, structuredClone(record));
    parsed.prompts.forEach((prompt, index) => stagePrompt(doc, prompt.author, prompt.text, null, now + index));
  });
}

// About what the server will store for it (both are Yjs updates).
export function boardBytes(parsed: ParsedBoard) {
  const doc = new Y.Doc();
  applyBoardFile(doc, parsed, 0);
  const bytes = Y.encodeStateAsUpdate(doc).byteLength;
  doc.destroy();
  return bytes;
}
