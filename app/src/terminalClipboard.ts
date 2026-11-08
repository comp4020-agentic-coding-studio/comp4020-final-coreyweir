import type { IDisposable, Terminal } from "@xterm/xterm";

// Claude Code copies a selection by printing OSC 52
// (`ESC ] 52 ; c ; <base64> BEL`), which xterm.js ignores on its own. The
// host's terminal honours it, writes only:
//
// - A copy puts the text on the host's clipboard. The host is the one at the
//   keyboard, so it's their copy.
// - A query (`ESC ] 52 ; c ; ? BEL`) gets no answer. Answering would hand the
//   host's clipboard (a pasted token, say) to a program in the guest
//   (docs/adr/0007). @xterm/addon-clipboard always answers a query, if only
//   with an empty clipboard, and its answer arrives in the program's input,
//   where bash takes it for typed text; so this handler is our own.
//
// The participants' mirror never registers it. The same bytes reach them in
// the host's output, and honouring them there would let the host's terminal
// write to everyone's clipboard.

function decodeBase64Utf8(data: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function honourClipboardWrites(terminal: Terminal): IDisposable {
  return terminal.parser.registerOscHandler(52, (payload) => {
    const separator = payload.indexOf(";");
    if (separator < 0) return true;
    // `p` is X11's primary selection, which a browser can't reach; an empty
    // or other target means the clipboard.
    const targets = payload.slice(0, separator);
    const data = payload.slice(separator + 1);
    if (data === "?" || targets === "p") return true;
    const text = decodeBase64Utf8(data);
    if (text === null) return true;
    navigator.clipboard?.writeText(text).catch(() => {
      // The page wasn't focused, or the browser refused: the copy is lost
      // and the terminal carries on.
    });
    return true;
  });
}
