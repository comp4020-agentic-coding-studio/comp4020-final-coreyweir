// "Send board to Claude" (boardForClaude.ts): host only. The button writes
// the board's files into the host's pod at once, then asks for the prompt
// that goes with them, which is staged like any other: the queue and its
// release (queueRelease.ts) decide when Claude gets it, never this.
import { useEffect, useRef, useState } from "react";
import { pageBounds, type Editor, type Store } from "@quickdrawjs/react";
import { boardFiles, boardPrompt, dataUrlBlob, nextBoardDir, NO_PICTURE_NOTICE, writeBoardFiles, type PodFiles } from "./boardForClaude";
import { fitImage } from "./imagePaste";

type Sent = { dir: string; text: string; notice: string | null; files: string[] };

const NOT_READY = "Start Claude first (Room view): the board goes into its files.";

/**
 * The button's state and the popup for a host. `pod` reads the host's pod
 * now (null before it boots); `ready` is whether it has booted, to show.
 */
export function useSendBoard({ store, selected, pod, ready, onStage }: {
  store: Store;
  selected: string[];
  pod: () => PodFiles | null;
  ready: boolean;
  onStage: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Gone after a while, like the board's other notices.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error]);
  const live = selected.filter((id) => store.get(id)?.typeName === "shape");
  const label = live.length ? `Send ${live.length === 1 ? "selected shape" : `${live.length} selected`} to Claude` : "Send board to Claude";

  async function send(editor: Editor | null) {
    const target = pod();
    if (!target) return setError(NOT_READY);
    // Asked now, not at render: drawing doesn't re-render the room.
    if (store.shapes().length === 0) return setError("The board is empty: there's nothing to send yet.");
    setBusy(true);
    setError(null);
    try {
      const files = await boardFiles(store.all(), {
        selection: live,
        bounds: pageBounds,
        extract: async (src) => {
          const blob = dataUrlBlob(src);
          if (!blob) throw new Error("not a data URL");
          const image = await fitImage(blob);
          return { bytes: image.bytes, extension: image.extension };
        },
        render: target.readsImages && editor ? async (ids, scale, margin) => {
          const png = await editor.exportImage({ ids, scale, margin, background: true });
          if (!png) return null;
          // Within limits already; fitting again only guards the byte size.
          return (await fitImage(png)).bytes;
        } : undefined,
      });
      const dir = nextBoardDir(target.exists);
      writeBoardFiles(target, dir, files.files);
      setSent({
        dir,
        text: boardPrompt(dir, files, !target.readsImages),
        notice: target.readsImages ? null : NO_PICTURE_NOTICE,
        files: files.files.map((file) => file.name),
      });
    } catch (failure) {
      setError(`The board couldn't be written for Claude: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    // Nothing points at them, so they go: Cancel leaves the pod as it was.
    if (sent) pod()?.remove(sent.dir);
    setSent(null);
  }

  return {
    button: {
      label: busy ? "Writing files..." : label,
      // For a phone's board bar, where the long one doesn't fit.
      short: busy ? "Writing..." : "Send to Claude",
      disabled: busy || !ready,
      title: !ready ? NOT_READY : live.length ? "Write the selected shapes into Claude's files, then stage a prompt about them" : "Write the board into Claude's files, then stage a prompt about it",
      send,
    },
    error,
    dialog: sent && <SendBoardDialog sent={sent} onStage={(text) => {
      onStage(text);
      setSent(null);
    }} onCancel={cancel} />,
  };
}

function SendBoardDialog({ sent, onStage, onCancel }: { sent: Sent; onStage: (text: string) => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(sent.text);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    // The cursor after the guidance, on the blank line for what to do.
    const area = field.current;
    if (area) {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }
    return () => element.close();
  }, []);
  return (
    // A modal <dialog>: the browser keeps focus inside, and Esc cancels.
    <dialog ref={dialog} className="send-board" aria-labelledby="send-board-title" onCancel={(event) => {
      event.preventDefault();
      onCancel();
    }}>
      <form method="dialog" onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) onStage(text.trim());
      }}>
        <h2 id="send-board-title">Stage a prompt about the board</h2>
        <p>Written to <code>{sent.dir}/</code>: {sent.files.map((name, index) => <span key={name}>{index ? ", " : ""}<code>{name}</code></span>)}.</p>
        {sent.notice && <p className="send-board-notice" role="note">{sent.notice}</p>}
        <label>
          Prompt
          <textarea ref={field} value={text} rows={7} onChange={(event) => setText(event.target.value)} />
        </label>
        <p className="send-board-quiet">Stage puts it with the other staged prompts; it reaches Claude when it's queued and released. Cancel deletes the files.</p>
        <span className="send-board-actions">
          <button className="send-board-go" type="submit" disabled={!text.trim()}>Stage</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </span>
      </form>
    </dialog>
  );
}
