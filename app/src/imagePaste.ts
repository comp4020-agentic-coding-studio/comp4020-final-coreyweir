// Images into the host's Claude: paste or drop one on the host's terminal.
//
// xterm only reads text/plain from the clipboard, so an image paste did
// nothing. Claude Code reads an image itself when an absolute path to it is
// pasted (measured on 2.1.221 in Nodepod: `[Image #1]`, then an image block
// in the request). So the page writes the image into the pod and pastes its
// path. Claude attaches nothing over 2000 px a side, and there's no `sharp`
// in the pod to shrink it, so the page shrinks it first.
//
// Host only: participants' terminals are mirrors with no pod behind them.

/** Claude Code's limits for an image it attaches without resizing. */
export const MAX_SIDE = 2000;
export const MAX_BYTES = 3_932_160;
const KEPT_TYPES = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"]]);

export type FittedImage = { bytes: Uint8Array; extension: string; width: number; height: number; scaled: boolean };

/** The size to draw an image at so neither side is over `max`. */
export function fitSize(width: number, height: number, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The images to take from a paste or drop, or none. A clipboard that also
 * has text (a spreadsheet's cells come with a picture of them) is left to
 * xterm's text paste.
 */
export function imagesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.types.includes("text/plain")) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) for (const file of Array.from(data.files ?? [])) if (file.type.startsWith("image/")) files.push(file);
  return files;
}

/**
 * Whether the host's model can read an image. Riff's free model
 * (`RIFF_MODEL`, docs/adr/0009) reads text only: OpenRouter answers a
 * request with an image in it 404 "No endpoints found that support image
 * input" (measured 8 Nov 2026).
 */
export function modelReadsImages(env: Record<string, string> | undefined, textOnlyModel: string) {
  return env?.ANTHROPIC_MODEL !== textOnlyModel;
}

/** The image as Claude will take it: its own bytes if within limits, else shrunk. */
export async function fitImage(blob: Blob): Promise<FittedImage> {
  const bitmap = await createImageBitmap(blob).catch(() => {
    throw new Error("That image couldn't be read.");
  });
  try {
    const kept = KEPT_TYPES.get(blob.type);
    if (kept && bitmap.width <= MAX_SIDE && bitmap.height <= MAX_SIDE && blob.size <= MAX_BYTES) {
      return { bytes: new Uint8Array(await blob.arrayBuffer()), extension: kept, width: bitmap.width, height: bitmap.height, scaled: false };
    }
    const { width, height } = fitSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser can't resize images.");
    context.drawImage(bitmap, 0, 0, width, height);
    const scaled = width !== bitmap.width || height !== bitmap.height;
    for (const [type, extension, quality] of [["image/png", "png", undefined], ["image/jpeg", "jpg", 0.85], ["image/jpeg", "jpg", 0.6]] as const) {
      const out = await canvas.convertToBlob({ type, quality });
      if (out.size <= MAX_BYTES) return { bytes: new Uint8Array(await out.arrayBuffer()), extension, width, height, scaled };
    }
    throw new Error("That image is too large to give Claude.");
  } finally {
    bitmap.close();
  }
}

export const PASTE_DIR = "/tmp/riff";

export type ImagePasteIO = {
  /** False when the model in use can't read images (Riff's free model). */
  readsImages: () => boolean;
  exists: (path: string) => boolean;
  save: (path: string, bytes: Uint8Array) => void;
  /** Paste text into whatever has the terminal's input (Claude's prompt). */
  paste: (text: string) => void;
  notice: (text: string) => void;
};

export const TEXT_ONLY_NOTICE = "Riff's free model reads text only, so the image wasn't given to Claude. To share images, host with your own API endpoint.";

/**
 * Save each image under /tmp/riff and paste its path, one paste at a time
 * and in the order they came.
 */
export function createImagePaster(io: ImagePasteIO, fit: (blob: Blob) => Promise<FittedImage> = fitImage) {
  let next = 1;
  let tail = Promise.resolve();
  const one = async (file: File) => {
    if (!io.readsImages()) {
      io.notice(TEXT_ONLY_NOTICE);
      return;
    }
    const image = await fit(file);
    let path: string;
    do path = `${PASTE_DIR}/paste-${next++}.${image.extension}`;
    while (io.exists(path));
    io.save(path, image.bytes);
    io.paste(path);
    if (image.scaled) io.notice(`Image scaled to ${image.width}×${image.height} so Claude can read it.`);
  };
  return (files: File[]) => {
    for (const file of files) {
      tail = tail.then(() => one(file)).catch((error) => io.notice(error instanceof Error ? error.message : String(error)));
    }
    return tail;
  };
}

/**
 * Take image pastes and drops on `target` (the host's terminal) before
 * xterm sees them. Returns a function that stops listening.
 */
export function installImagePaste(target: HTMLElement, take: (files: File[]) => void) {
  const onPaste = (event: ClipboardEvent) => {
    const files = imagesIn(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    take(files);
  };
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    // Any dropped file: otherwise the browser opens it and leaves the room.
    event.preventDefault();
    const files = imagesIn(event.dataTransfer);
    if (files.length > 0) take(files);
  };
  // Capture, so this runs before xterm's own listener on its textarea.
  target.addEventListener("paste", onPaste, true);
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("paste", onPaste, true);
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}
