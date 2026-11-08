// Send board to Claude (app/src/boardForClaude.ts): the board, or a
// selection, maps onto a small board.json Claude can read, the pasted
// images come out as files, and strokes don't drag their points along.
// Runs the module under node (type stripping) with a stand-in for
// quickdraw's bounds, which needs a canvas to measure text.
//
// Not told apart here: whether quickdraw's real bounds and render agree
// with these (the browser smoke, `npm run test:send-board-browser`, writes
// a real board into a real pod), and whether Claude reads the files well.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOARD_FORMAT, PICTURE_MARGIN, boardFiles, boardPrompt, dataUrlBlob, nextBoardDir, pictureScale, writeBoardFiles,
} from "../src/boardForClaude.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const shape = (id, type, x, y, props, z = 1) => ({ id, typeName: "shape", type, x, y, rot: 0, z, props });
const note = (id, x, y, text, color = "yellow") => shape(id, "note", x, y, { text, color, size: "m", scale: 1 });
const geo = (id, x, y, w, h, label = "") => shape(id, "geo", x, y, { geo: "rectangle", w, h, label, color: "black", fill: "none", dash: "draw" });
const arrow = (id, x, y, dx, dy, bend = 0) => shape(id, "arrow", x, y, { dx, dy, bend, color: "black", size: "m", dash: "solid" });
const image = (id, x, y, assetId) => shape(id, "image", x, y, { w: 120, h: 80, assetId });
const asset = (id, src = PNG) => ({ id, typeName: "asset", src, w: 1, h: 1 });
const stroke = (id, x, y, count) => {
  const pts = [];
  for (let index = 0; index < count; index += 1) pts.push(index * 0.5, Math.sin(index / 10) * 30, 0.5);
  return shape(id, "draw", x, y, { pts, color: "blue", size: "m", dash: "draw", done: true });
};

// Close enough to quickdraw's pageBounds for these shapes, without a canvas.
function bounds(record) {
  const p = record.props;
  switch (record.type) {
    case "note": return { x: record.x, y: record.y, w: 200, h: 200 };
    case "arrow": case "line": return { x: record.x + Math.min(0, p.dx), y: record.y + Math.min(0, p.dy), w: Math.abs(p.dx), h: Math.abs(p.dy) };
    case "draw": case "highlight": {
      const xs = p.pts.filter((_, index) => index % 3 === 0), ys = p.pts.filter((_, index) => index % 3 === 1);
      return { x: record.x + Math.min(...xs), y: record.y + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    default: return { x: record.x, y: record.y, w: p.w, h: p.h };
  }
}

const extracted = [];
const extract = async (src) => {
  extracted.push(src);
  if (!src.startsWith("data:image/png")) throw new Error("unreadable");
  return { bytes: new Uint8Array([1, 2, 3]), extension: "png" };
};
const json = (result) => JSON.parse(new TextDecoder().decode(result.files.find((file) => file.name === "board.json").bytes));
const byText = (description, text) => description.shapes.find((item) => item.text === text || item.label === text);

test("notes, text and labelled shapes keep their words, in reading order, at rounded positions from the top-left", async () => {
  const result = await boardFiles([
    note("shape:b", 400.4, 100.6, "Second idea"),
    note("shape:a", 100.2, 100.4, "First idea", "green"),
    shape("shape:t", "text", 100, 400, { text: "A heading", color: "black", size: "l", autosize: true, scale: 1, w: 150, h: 40 }),
    geo("shape:g", 600, 380, 160, 90, "Login page"),
  ], { bounds, extract });
  const description = json(result);
  assert.equal(description.format, BOARD_FORMAT);
  assert.match(description.about, /board units/);
  assert.equal(description.scope, "the whole board, 4 shapes");
  assert.deepEqual(description.shapes.map((item) => item.id), ["s1", "s2", "s3", "s4"]);
  assert.deepEqual(description.shapes[0], { id: "s1", type: "note", text: "First idea", color: "green", x: 0, y: 0, w: 200, h: 200 });
  assert.deepEqual(description.shapes[1], { id: "s2", type: "note", text: "Second idea", color: "yellow", x: 300, y: 0, w: 200, h: 200 });
  assert.equal(description.shapes[2].label, "Login page");
  assert.equal(description.shapes[2].geo, "rectangle");
  assert.equal(description.shapes[3].text, "A heading");
  assert.deepEqual(description.size, { w: 660, h: 370 });
  // Nothing of quickdraw's own ids or style noise.
  const raw = new TextDecoder().decode(result.files[0].bytes);
  assert.doesNotMatch(raw, /shape:|autosize|"dash"|"size": "m"/);
});

test("an arrow names the shapes its ends touch, the smallest when they nest, and nothing in empty space", async () => {
  const description = json(await boardFiles([
    geo("shape:frame", 0, 0, 1000, 600, "Flow"),
    note("shape:from", 50, 50, "Sign in"),
    note("shape:to", 600, 50, "Dashboard"),
    // from inside "Sign in" to just short of "Dashboard"'s edge
    arrow("shape:link", 200, 150, 392, 0, 20),
    // into empty space outside the frame
    arrow("shape:loose", 700, 260, 0, 500),
  ], { bounds, extract }));
  const signIn = byText(description, "Sign in"), dashboard = byText(description, "Dashboard"), frame = byText(description, "Flow");
  const link = description.shapes.find((item) => item.type === "arrow" && item.curved);
  assert.equal(link.from, signIn.id);
  assert.equal(link.to, dashboard.id);
  assert.deepEqual(link.start, { x: 200, y: 150 });
  assert.deepEqual(link.end, { x: 592, y: 150 });
  const loose = description.shapes.find((item) => item.type === "arrow" && !item.curved);
  assert.equal(loose.from, dashboard.id);
  assert.equal(loose.to, undefined);
  assert.equal(signIn.inside, frame.id);
  assert.equal(frame.inside, undefined);
  assert.match(description.about, /worked out from positions/);
});

test("pasted images come out as files, once per image, and one that can't be read says so", async () => {
  extracted.length = 0;
  const result = await boardFiles([
    asset("asset:one"),
    asset("asset:bad", "data:image/webp;base64,AAAA"),
    asset("asset:unused"),
    image("shape:i1", 0, 0, "asset:one"),
    image("shape:i2", 300, 0, "asset:one"),
    image("shape:i3", 600, 0, "asset:bad"),
    image("shape:i4", 900, 0, "asset:gone"),
  ], { bounds, extract });
  const description = json(result);
  assert.deepEqual(description.shapes.map((item) => item.file), ["image-1.png", "image-1.png", null, null]);
  assert.deepEqual(result.files.map((file) => file.name), ["board.json", "image-1.png"]);
  assert.deepEqual(result.images, ["image-1.png"]);
  assert.equal(extracted.length, 2, "each used image is read once; an unused one isn't read");
});

test("a freehand stroke is a box, not its points", async () => {
  const result = await boardFiles([stroke("shape:s", 10, 10, 4000), note("shape:n", 0, 200, "Note")], { bounds, extract });
  const description = json(result);
  const drawn = description.shapes.find((item) => item.type === "freehand");
  assert.deepEqual(Object.keys(drawn).sort(), ["color", "h", "id", "type", "w", "x", "y"]);
  assert.equal(drawn.color, "blue");
  assert.ok(result.files[0].bytes.byteLength < 2500, `board.json is ${result.files[0].bytes.byteLength} bytes`);
});

test("a selection sends only its shapes, measured from its own corner, and says what it is", async () => {
  const renders = [];
  const result = await boardFiles([
    note("shape:a", 0, 0, "Kept out"),
    note("shape:b", 1000, 1000, "Chosen"),
    arrow("shape:c", 1100, 1300, 0, -150),
    asset("asset:x"),
    image("shape:d", 3000, 3000, "asset:x"),
  ], {
    selection: ["shape:b", "shape:c", "shape:missing"],
    bounds,
    extract,
    render: async (ids, scale, margin) => {
      renders.push({ ids: [...ids].sort(), scale, margin });
      return new Uint8Array([9]);
    },
  });
  const description = json(result);
  assert.equal(result.selection, true);
  assert.equal(description.scope, "2 selected of the board's 4 shapes");
  assert.deepEqual(description.shapes.map((item) => item.text ?? item.type), ["Chosen", "arrow"]);
  assert.deepEqual(description.shapes[0], { id: "s1", type: "note", text: "Chosen", color: "yellow", x: 0, y: 0, w: 200, h: 200 });
  assert.equal(description.shapes[1].to, "s1");
  assert.deepEqual(result.files.map((file) => file.name), ["board.json", "board.png"], "the unselected image isn't extracted");
  assert.deepEqual(renders, [{ ids: ["shape:b", "shape:c"], scale: 2, margin: PICTURE_MARGIN }]);
  assert.deepEqual(description.picture, { file: "board.png", pixelsPerUnit: 2, margin: PICTURE_MARGIN });
});

test("no picture without a renderer (a text-only model); the selection is ignored if none of it is on the board", async () => {
  const result = await boardFiles([note("shape:a", 0, 0, "Only")], { selection: ["shape:gone"], bounds, extract });
  assert.equal(result.picture, false);
  assert.equal(result.selection, false);
  assert.equal(json(result).picture, undefined);
  assert.deepEqual(result.files.map((file) => file.name), ["board.json"]);
});

test("the picture's scale keeps its longest side within Claude's 2000 px", () => {
  assert.equal(pictureScale({ x: 0, y: 0, w: 300, h: 100 }), 2);
  for (const box of [{ x: 0, y: 0, w: 5000, h: 1200 }, { x: -9, y: 4, w: 30, h: 8000 }]) {
    const scale = pictureScale(box);
    assert.ok((Math.max(box.w, box.h) + PICTURE_MARGIN * 2) * scale <= 2000 + 1e-9);
    assert.ok((Math.max(box.w, box.h) + PICTURE_MARGIN * 2) * scale > 1999);
  }
});

test("each send gets its own directory, and the prompt says what's in it", () => {
  const taken = new Set(["/tmp/riff/board-1", "/tmp/riff/board-2"]);
  assert.equal(nextBoardDir((path) => taken.has(path)), "/tmp/riff/board-3");
  assert.equal(nextBoardDir(() => false), "/tmp/riff/board-1");
  assert.equal(
    boardPrompt("/tmp/riff/board-3", { selection: false, picture: true, images: ["image-1.png", "image-2.jpg"] }),
    "The board from our room is in /tmp/riff/board-3/ (board.json describes every shape; board.png is a picture of it; image-1.png and image-2.jpg are the pasted images).\n\n",
  );
  assert.equal(
    boardPrompt("/tmp/riff/board-1", { selection: true, picture: false, images: [] }),
    "The shapes we selected on our room's board are in /tmp/riff/board-1/ (board.json describes every shape).\n\n",
  );
  assert.equal(
    boardPrompt("/tmp/riff/board-2", { selection: true, picture: true, images: ["image-1.webp"] }),
    "The shapes we selected on our room's board are in /tmp/riff/board-2/ (board.json describes every shape; board.png is a picture of them; image-1.webp is the pasted image).\n\n",
  );
  assert.equal(
    boardPrompt("/tmp/riff/board-4", { selection: false, picture: false, images: ["image-1.png"] }, true),
    "The board from our room is in /tmp/riff/board-4/ (board.json describes every shape; image-1.png is the pasted image, which the model in use can't look at).\n\n",
  );
  const written = [];
  writeBoardFiles({ write: (path, bytes) => written.push([path, bytes.length]) }, "/tmp/riff/board-3", [{ name: "board.json", bytes: new Uint8Array(4) }]);
  assert.deepEqual(written, [["/tmp/riff/board-3/board.json", 4]]);
});

test("a data URL turns into its bytes without fetch", async () => {
  const blob = dataUrlBlob(PNG);
  assert.equal(blob.type, "image/png");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(dataUrlBlob("https://example.com/a.png"), null);
});
