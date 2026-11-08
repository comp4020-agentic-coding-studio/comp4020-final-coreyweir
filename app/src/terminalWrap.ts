// Riff's own notes in the host's terminal (and so in everyone's mirror)
// are wrapped at word boundaries before they're written: xterm wraps at
// the last column, mid-word, which on a phone's 40-odd columns splits
// most lines. Escape sequences take no columns. A word longer than the
// line is left for xterm to break. Wrapping happens once, at the width
// the terminal has when the note is written.

const ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/y;

function visibleLength(text: string) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

function wrapLine(line: string, cols: number) {
  if (visibleLength(line) <= cols) return line;
  // tokens: runs of spaces, or words with any escapes inside them
  const tokens: string[] = [];
  let index = 0;
  let current = "";
  let inSpace: boolean | null = null;
  while (index < line.length) {
    ESCAPE.lastIndex = index;
    const escape = ESCAPE.exec(line);
    if (escape) {
      current += escape[0];
      index += escape[0].length;
      continue;
    }
    const space = line[index] === " ";
    if (inSpace !== null && space !== inSpace) {
      tokens.push(current);
      current = "";
    }
    inSpace = space;
    current += line[index];
    index += 1;
  }
  if (current) tokens.push(current);

  const lines: string[] = [];
  let built = "";
  let width = 0;
  for (const token of tokens) {
    const tokenWidth = visibleLength(token);
    const isSpace = tokenWidth > 0 && token.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim() === "";
    if (width + tokenWidth <= cols || width === 0) {
      built += token;
      width += tokenWidth;
      continue;
    }
    if (isSpace) {
      // the break goes here; keep the escapes, drop the spaces
      lines.push(built + token.replace(/ /g, ""));
      built = "";
      width = 0;
      continue;
    }
    lines.push(built.replace(/ +((?:\x1b\[[0-9;?]*[A-Za-z])*)$/, "$1"));
    built = token;
    width = tokenWidth;
  }
  lines.push(built);
  return lines.join("\n");
}

export function wrapNote(text: string, cols: number) {
  if (!Number.isFinite(cols) || cols < 10) return text;
  return text.split("\n").map((line) => wrapLine(line, cols)).join("\n");
}
