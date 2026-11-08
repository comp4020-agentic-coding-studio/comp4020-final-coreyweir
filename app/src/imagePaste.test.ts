// Image paste into the host's Claude, the parts that don't need a browser.
// npm run test:image-paste
import test from "node:test";
import assert from "node:assert/strict";
import { createImagePaster, fitSize, imagesIn, modelReadsImages, TEXT_ONLY_NOTICE, type FittedImage } from "./imagePaste.ts";

const file = (type: string, name = "x") => new File([new Uint8Array([1, 2, 3])], name, { type });
const transfer = (types: string[], files: File[]) => ({
  types,
  items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  files,
}) as unknown as DataTransfer;

test("an image is shrunk to 2000 px on its longer side, keeping its shape", () => {
  assert.deepEqual(fitSize(4000, 3000), { width: 2000, height: 1500 });
  assert.deepEqual(fitSize(1000, 5000), { width: 400, height: 2000 });
  assert.deepEqual(fitSize(2000, 2000), { width: 2000, height: 2000 });
  assert.deepEqual(fitSize(320, 160), { width: 320, height: 160 });
});

test("a paste with only an image is taken; one that also has text is left to xterm", () => {
  const png = file("image/png");
  assert.deepEqual(imagesIn(transfer(["Files"], [png])), [png]);
  assert.deepEqual(imagesIn(transfer(["Files", "text/html"], [png])), [png]);
  assert.deepEqual(imagesIn(transfer(["text/plain", "text/html", "Files"], [png])), []);
  assert.deepEqual(imagesIn(transfer(["Files"], [file("application/pdf")])), []);
  assert.deepEqual(imagesIn(null), []);
});

test("Riff's free model is the one that can't read images", () => {
  assert.equal(modelReadsImages({ ANTHROPIC_MODEL: "free" }, "free"), false);
  assert.equal(modelReadsImages({ ANTHROPIC_MODEL: "claude-sonnet" }, "free"), true);
  assert.equal(modelReadsImages(undefined, "free"), true);
});

function harness(readsImages = true, existing: string[] = []) {
  const saved = new Map<string, Uint8Array>();
  const pasted: string[] = [];
  const notices: string[] = [];
  const paste = createImagePaster({
    readsImages: () => readsImages,
    exists: (path) => existing.includes(path) || saved.has(path),
    save: (path, bytes) => void saved.set(path, bytes),
    paste: (text) => void pasted.push(text),
    notice: (text) => void notices.push(text),
  }, async (blob): Promise<FittedImage> => {
    if (blob.type === "image/broken") throw new Error("That image couldn't be read.");
    const big = blob.type === "image/big";
    return { bytes: new Uint8Array([blob.size]), extension: big ? "png" : "jpg", width: big ? 2000 : 10, height: big ? 1000 : 10, scaled: big };
  });
  return { paste, saved, pasted, notices };
}

test("each image is saved under /tmp/riff and its path pasted, in order, without overwriting", async () => {
  const h = harness(true, ["/tmp/riff/paste-1.jpg"]);
  await h.paste([file("image/jpeg"), file("image/big")]);
  await h.paste([file("image/jpeg")]);
  assert.deepEqual(h.pasted, ["/tmp/riff/paste-2.jpg", "/tmp/riff/paste-3.png", "/tmp/riff/paste-4.jpg"]);
  assert.deepEqual([...h.saved.keys()], h.pasted);
  assert.deepEqual(h.notices, ["Image scaled to 2000×1000 so Claude can read it."]);
});

test("a text-only model gets no image and the host is told why", async () => {
  const h = harness(false);
  await h.paste([file("image/png")]);
  assert.deepEqual(h.pasted, []);
  assert.equal(h.saved.size, 0);
  assert.deepEqual(h.notices, [TEXT_ONLY_NOTICE]);
});

test("an image that can't be read is reported and doesn't stop the next", async () => {
  const h = harness();
  await h.paste([file("image/broken"), file("image/jpeg")]);
  assert.deepEqual(h.notices, ["That image couldn't be read."]);
  assert.deepEqual(h.pasted, ["/tmp/riff/paste-1.jpg"]);
});
