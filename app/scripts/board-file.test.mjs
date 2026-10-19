// Export and import of a board file (app/src/boardFile.ts, docs/adr/0003's
// second amendment): what goes out comes back the same, and what a hostile
// or broken file holds beyond quickdraw's known records and fields doesn't
// come in. Runs boardFile.ts itself under node (type stripping).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import {
  BoardFileError,
  applyBoardFile,
  boardBytes,
  boardFileName,
  dropUndecodableImages,
  exportBoard,
  parseBoardFile,
  readPrompts,
  stagePrompt,
} from "../src/boardFile.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG_BYTES = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==";

function shape(id, type, props, extra = {}) {
  return { id, typeName: "shape", type, x: 10, y: 20, rot: 0, z: 1, props, ...extra };
}

function boardDoc() {
  const doc = new Y.Doc();
  const records = doc.getMap("boardRecords");
  records.set("shape:a", shape("shape:a", "draw", { pts: [0, 0, 0.5, 4, 4, 0.5], color: "blue", size: "m", dash: "draw", done: true }));
  records.set("shape:b", shape("shape:b", "geo", { geo: "star", w: 120, h: 80, color: "red", size: "l", dash: "solid", fill: "semi", font: "sans", label: "Header", labelSize: "m" }));
  records.set("shape:c", shape("shape:c", "note", { text: "make the header blue", color: "yellow", size: "m", font: "draw", scale: 1 }));
  records.set("asset:p", { id: "asset:p", typeName: "asset", src: PNG, w: 1, h: 1 });
  records.set("shape:d", shape("shape:d", "image", { w: 100, h: 100, assetId: "asset:p" }));
  stagePrompt(doc, "Bo", "first", null, 1);
  stagePrompt(doc, "Ada", "second\nwith a newline", null, 2);
  return doc;
}

function fileWith(store, extra = {}) {
  return JSON.stringify({
    format: "riff-board",
    version: 1,
    exportedAt: "2026-10-19T00:00:00.000Z",
    room: { code: "K7MQ2P" },
    board: { document: { store } },
    prompts: [],
    queue: [],
    ...extra,
  });
}

test("a board exported and imported into a new room comes back the same", () => {
  const source = boardDoc();
  const file = exportBoard({ code: "K7MQ2P", doc: source, queue: [{ author: "Cy", text: "queued one" }], now: new Date("2026-10-19T01:02:03Z") });
  assert.equal(file.format, "riff-board");
  assert.equal(file.version, 1);
  assert.deepEqual(file.prompts, [{ author: "Bo", text: "first" }, { author: "Ada", text: "second\nwith a newline" }]);
  assert.deepEqual(file.queue, [{ author: "Cy", text: "queued one" }]);

  const parsed = parseBoardFile(JSON.stringify(file));
  assert.equal(parsed.code, "K7MQ2P");
  assert.equal(parsed.shapes, 4);
  assert.equal(parsed.images, 1);
  assert.deepEqual(parsed.leftOut, []);

  const target = new Y.Doc();
  applyBoardFile(target, parsed);
  assert.deepEqual(target.getMap("boardRecords").toJSON(), source.getMap("boardRecords").toJSON(), "every record, images byte for byte");
  // The queue comes in staged, after the staged prompts: the new host queues again.
  assert.deepEqual(readPrompts(target.getMap("prompts")), [
    { author: "Bo", text: "first" },
    { author: "Ada", text: "second\nwith a newline" },
    { author: "Cy", text: "queued one" },
  ]);
  for (const [, prompt] of target.getMap("prompts")) assert.equal(prompt.get("status"), "staged");
});

test("only known record types and fields come in", () => {
  const hostile = `{"format":"riff-board","version":1,"board":{"document":{"store":{
    "shape:a":{"id":"shape:a","typeName":"shape","type":"geo","x":1,"y":2,"rot":0,"z":1,"onclick":"x",
      "props":{"geo":"rectangle","w":10,"h":10,"color":"not-a-colour","script":"alert(1)","__proto__":{"polluted":true}}},
    "shape:b":{"id":"shape:b","typeName":"shape","type":"iframe","x":1,"y":2,"z":1,"props":{}},
    "binding:c":{"id":"binding:c","typeName":"binding"},
    "__proto__":{"id":"shape:p","typeName":"shape","type":"note","x":0,"y":0,"z":1,"props":{"text":"from proto"}}
  }}}}`;
  const parsed = parseBoardFile(hostile);
  const geo = parsed.records.find((record) => record.id === "shape:a");
  assert.deepEqual(Object.keys(geo).sort(), ["id", "props", "rot", "type", "typeName", "x", "y", "z"]);
  assert.deepEqual(geo.props, { geo: "rectangle", w: 10, h: 10 });
  assert.equal(Object.getPrototypeOf(geo.props), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(parsed.leftOut, ["2 other things Riff doesn't know how to draw"]);
  // JSON.parse makes "__proto__" an ordinary key, so its record is just a note
  assert.ok(parsed.records.some((record) => record.id === "shape:p"));
});

test("images: PNG, JPEG, WebP or GIF as data, what they claim, and within 2048px", () => {
  const image = (id, assetId) => shape(id, "image", { w: 10, h: 10, assetId });
  const parsed = parseBoardFile(fileWith({
    "asset:ok": { id: "asset:ok", typeName: "asset", src: PNG, w: 1, h: 1 },
    "shape:ok": image("shape:ok", "asset:ok"),
    "asset:remote": { id: "asset:remote", typeName: "asset", src: "https://evil.example/track.png", w: 1, h: 1 },
    "shape:remote": image("shape:remote", "asset:remote"),
    "asset:svg": { id: "asset:svg", typeName: "asset", src: "data:image/svg+xml;base64,PHN2Zy8+", w: 1, h: 1 },
    "shape:svg": image("shape:svg", "asset:svg"),
    "asset:liar": { id: "asset:liar", typeName: "asset", src: `data:image/png;base64,${JPEG_BYTES}`, w: 1, h: 1 },
    "shape:liar": image("shape:liar", "asset:liar"),
    "asset:big": { id: "asset:big", typeName: "asset", src: PNG, w: 4096, h: 10 },
    "shape:big": image("shape:big", "asset:big"),
    "shape:orphan": image("shape:orphan", "asset:missing"),
    "asset:unused": { id: "asset:unused", typeName: "asset", src: PNG, w: 1, h: 1 },
  }));
  assert.deepEqual(parsed.records.map((record) => record.id).sort(), ["asset:ok", "shape:ok"]);
  assert.equal(parsed.images, 1);
  assert.deepEqual(parsed.leftOut, [
    "2 images that aren't PNG, JPEG, WebP or GIF",
    "1 image over 2048px",
    "1 image Riff couldn't read",
    "1 other thing Riff doesn't know how to draw",
  ]);
});

test("an image that won't decode is left out with the shape that shows it", async () => {
  const parsed = parseBoardFile(fileWith({
    "asset:a": { id: "asset:a", typeName: "asset", src: PNG, w: 1, h: 1 },
    "shape:a": shape("shape:a", "image", { w: 10, h: 10, assetId: "asset:a" }),
    "shape:n": shape("shape:n", "note", { text: "stays" }),
  }));
  const kept = await dropUndecodableImages(parsed, async () => ({ width: 1, height: 1 }));
  assert.equal(kept, parsed);
  const dropped = await dropUndecodableImages(parsed, async () => { throw new Error("corrupt"); });
  assert.deepEqual(dropped.records.map((record) => record.id), ["shape:n"]);
  assert.equal(dropped.images, 0);
  assert.deepEqual(dropped.leftOut, ["1 image that wouldn't open"]);
  const lying = await dropUndecodableImages(parsed, async () => ({ width: 3000, height: 1 }));
  assert.deepEqual(lying.records.map((record) => record.id), ["shape:n"]);
});

test("files that aren't boards are refused with a reason", () => {
  assert.throws(() => parseBoardFile("not json"), BoardFileError);
  assert.throws(() => parseBoardFile(JSON.stringify({ format: "tldraw" })), /isn't a Riff board file/);
  assert.throws(() => parseBoardFile(JSON.stringify({ format: "riff-board", version: 2 })), /newer Riff/);
  assert.throws(() => parseBoardFile(JSON.stringify({ format: "riff-board", version: 1 })), /no board/);
});

test("the size counted before creating a room is about what the room will store", () => {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024 * 1024, 7)]);
  const src = `data:image/png;base64,${bytes.toString("base64")}`;
  const parsed = parseBoardFile(fileWith({
    "asset:a": { id: "asset:a", typeName: "asset", src, w: 10, h: 10 },
    "shape:a": shape("shape:a", "image", { w: 10, h: 10, assetId: "asset:a" }),
  }));
  assert.equal(parsed.images, 1);
  const doc = new Y.Doc();
  applyBoardFile(doc, parsed);
  const stored = Y.encodeStateAsUpdate(doc).byteLength;
  const counted = boardBytes(parsed);
  assert.ok(Math.abs(counted - stored) < 1024, `${counted} vs ${stored}`);
  assert.ok(counted > src.length);
});

test("the file is named for the room and the day", () => {
  assert.equal(boardFileName("K7MQ2P", new Date(2026, 9, 19, 23, 59)), "riff-K7MQ2P-2026-10-19.json");
  assert.equal(boardFileName("../x", new Date(2026, 0, 2)), "riff-x-2026-01-02.json");
});
