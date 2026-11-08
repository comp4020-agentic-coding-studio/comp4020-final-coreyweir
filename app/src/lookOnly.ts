import { useEffect, type RefObject } from "react";
import type { Diff, Editor, QuickdrawRef } from "@quickdrawjs/react";

// A board you can look around but not change: drag (or the wheel) pans,
// a pinch (or ctrl/cmd and the wheel) zooms. quickdraw's own `readonly`
// drops every pointer and wheel event, the camera's too, which left a
// read-only board stuck wherever it opened (and a phone zooming the page
// instead, blurrily). So the board stays live, on the hand tool with its
// toolbar hidden, and whatever could change it is stopped before
// quickdraw sees it: keys (tool shortcuts, Delete, undo), double-click
// (edit text), paste and drop (images). A change that still got through
// would be taken back, but only where the caller says nothing else
// writes the store out (`guard`): with a two-way sync, the sync would
// have sent it already.

const STOPPED = ["keydown", "keyup", "dblclick", "drop", "paste"] as const;

function invert(diff: Diff): Diff {
  const updated: Diff["updated"] = {};
  for (const [id, [from, to]] of Object.entries(diff.updated)) updated[id] = [to, from];
  return { added: diff.removed, removed: diff.added, updated };
}

export function lookOnly(editor: Editor, { guard = false } = {}) {
  editor.setReadonly(false);
  editor.setSelection([]);
  editor.setTool("hand");
  const keepHand = editor.on("tool", () => {
    if (editor.tool !== "hand") editor.setTool("hand");
  });
  const stop = (event: Event) => {
    event.stopImmediatePropagation();
    if (event.type === "drop") event.preventDefault();
  };
  // capture on the container itself runs before quickdraw's own listeners
  for (const type of STOPPED) editor.container.addEventListener(type, stop, true);
  // where the camera is, for a smoke to see it move (nothing reads it here)
  const showCamera = () => {
    const { x, y, z } = editor.camera;
    editor.container.dataset.camera = `${Math.round(x)},${Math.round(y)},${z.toFixed(3)}`;
  };
  showCamera();
  const stopCamera = editor.on("camera", showCamera);
  const takeBack = guard
    ? editor.store.listen((diff, source) => {
      if (source === "user") editor.store.applyDiff(invert(diff), "remote");
    })
    : null;
  return () => {
    keepHand();
    stopCamera();
    delete editor.container.dataset.camera;
    takeBack?.();
    for (const type of STOPPED) editor.container.removeEventListener(type, stop, true);
  };
}

// For a <Quickdraw> whose read-only state can change while it's mounted
// (a live room that fills up or ends). Leaving look-only goes back to
// drawing.
export function useLookOnly(board: RefObject<QuickdrawRef | null>, active: boolean, options?: { guard?: boolean }) {
  const guard = options?.guard ?? false;
  useEffect(() => {
    const editor = board.current?.editor;
    if (!active || !editor) return;
    const undo = lookOnly(editor, { guard });
    return () => {
      undo();
      editor.setTool("draw");
    };
  }, [board, active, guard]);
}
