import type { Terminal } from "@xterm/xterm";

// A participant's mirror always has the host's columns and rows, so Claude's
// layout is the host's, line for line. What differs is the box it's shown
// in: a phone watching a desktop host, or a desktop watching a phone host.
// "fit" sizes the font so the whole of the host's screen fills the box;
// "actual" keeps the host's own font size and lets the box scroll.

export type MirrorMode = "fit" | "actual";

export const ACTUAL_FONT_SIZE = 12;
const MIN_FONT_SIZE = 3;
const MAX_FONT_SIZE = 18;
const STEP = 0.25;

function innerSize(element: HTMLElement) {
  const style = getComputedStyle(element);
  return {
    width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    height: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
  };
}

// Character cells scale with the font size, so one measurement says what
// size fits; a second pass catches rounding in the renderer's cell sizes.
export function fitMirror(terminal: Terminal, box: HTMLElement, mode: MirrorMode, passes = 4) {
  if (mode === "actual") {
    if (terminal.options.fontSize !== ACTUAL_FONT_SIZE) terminal.options.fontSize = ACTUAL_FONT_SIZE;
    return;
  }
  const screen = box.querySelector<HTMLElement>(".xterm-screen");
  const available = innerSize(box);
  if (!screen || available.width <= 0 || available.height <= 0) return;
  const { width, height } = screen.getBoundingClientRect();
  if (width <= 0 || height <= 0) return;
  const current = terminal.options.fontSize ?? ACTUAL_FONT_SIZE;
  const exact = current * Math.min(available.width / width, available.height / height);
  const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.floor(exact / STEP) * STEP));
  // The last pass only ever shrinks, so rounding never leaves it overflowing.
  if (next === current || passes === 1 && next > current) return;
  terminal.options.fontSize = next;
  // The renderer lays out the new cells on its next frame.
  if (passes > 1) requestAnimationFrame(() => fitMirror(terminal, box, mode, passes - 1));
}
