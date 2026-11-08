// The queue (docs/adr/0004): everyone sees what's up next, whether auto is
// on, and what Claude is doing. Only the host's page can type into Claude,
// so only the host sends, removes and toggles auto; the server refuses a
// participant's write to the control document anyway (docs/adr/0006).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type * as Y from "yjs";
import type { QueuedPrompt, SentBy } from "./room";
import type { TerminalPaneHandle } from "./TerminalPane";
import { canSend, CLAUDE_STATE_LABEL, isSlashCommand, nextClaudeState, shouldAutoSend, type ClaudeEvent, type ClaudeState } from "./queueRelease";

/**
 * The host's side: follows Claude's events, publishes Claude's state to the
 * room, and sends the next prompt when auto says so. The state lives in a
 * ref as well as in React state, so a send flips it to "working" at once and
 * a second render can't send another prompt before Claude's hook arrives.
 */
export function useQueueRelease({ facilitator, roomState, terminalRef, queued, auto, full, onSend }: {
  facilitator: boolean;
  roomState: Y.Map<unknown>;
  terminalRef: RefObject<TerminalPaneHandle | null>;
  queued: QueuedPrompt[];
  auto: boolean;
  full: boolean;
  onSend: (id: string, by: SentBy) => void;
}) {
  const stateRef = useRef<ClaudeState>("off");
  const [state, setState] = useState<ClaudeState>("off");

  const dispatch = useCallback((event: ClaudeEvent) => {
    const next = nextClaudeState(stateRef.current, event);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  // What the room sees. A reloaded host page starts at "off" and says so,
  // so the room never shows a state left behind by the last page.
  useEffect(() => {
    if (!facilitator || full) return;
    if (roomState.get("claude") !== state) roomState.set("claude", state);
  }, [facilitator, full, roomState, state]);

  const send = useCallback((prompt: QueuedPrompt, by: SentBy) => {
    if (!canSend(stateRef.current)) return false;
    if (!terminalRef.current?.sendPrompt(prompt.text)) return false;
    dispatch({ event: isSlashCommand(prompt.text) ? "SentCommand" : "Sent" });
    onSend(prompt.id, by);
    return true;
  }, [dispatch, onSend, terminalRef]);

  const next = queued[0];
  useEffect(() => {
    if (!facilitator || !next) return;
    if (shouldAutoSend({ auto, state: stateRef.current, queued: queued.length, full })) send(next, "auto");
  }, [auto, facilitator, full, next, queued.length, send, state]);

  const setAuto = useCallback((on: boolean) => {
    if (on) dispatch({ event: "AutoOn" });
    roomState.set("autoRelease", on);
  }, [dispatch, roomState]);

  return { state, dispatch, send, setAuto };
}

export function QueuePanel({ queued, facilitator, full, auto, claudeState, hostHere, canSendNow, onSend, onDelete, onAuto }: {
  queued: QueuedPrompt[];
  facilitator: boolean;
  full: boolean;
  auto: boolean;
  claudeState: ClaudeState;
  /** False while the host is away: the last state they published may be stale. */
  hostHere: boolean;
  canSendNow: boolean;
  onSend: (prompt: QueuedPrompt) => void;
  onDelete: (id: string) => void;
  onAuto: (on: boolean) => void;
}) {
  const editable = facilitator && !full;
  const sendTitle = canSendNow
    ? claudeState === "working" ? "Claude is working: this goes in as a follow-up" : "Send to Claude"
    : claudeState === "starting" ? "Claude is still starting" : "Start Claude first";
  const stateTitle = claudeState === "paused" ? "A turn was interrupted or failed, or a slash command ran: auto waits until Claude finishes a turn, or the host turns auto on again" : undefined;
  return (
    <article className="queue">
      <header className="section-title queue-heading">
        <h2>Up next</h2><span>{queued.length}</span>
        <small className={`claude-state ${hostHere ? claudeState : "off"}`} title={hostHere ? stateTitle : undefined} data-state={hostHere ? claudeState : "away"}>{hostHere ? CLAUDE_STATE_LABEL[claudeState] : "Host away"}</small>
        <label className="auto-release" title={facilitator ? "Send the next prompt each time Claude finishes a turn" : "Only the host can change this"}>
          <input type="checkbox" checked={auto} disabled={!editable} onChange={(event) => onAuto(event.target.checked)} />
          Auto
        </label>
      </header>
      <div className="queue-list">
        {queued.map((prompt, index) => (
          <div className="queue-row" key={prompt.id}>
            <span>{index + 1}</span>
            <p>{prompt.text}</p>
            <small>{prompt.author}</small>
            {editable && <button className="send-prompt" disabled={!canSendNow} title={sendTitle} onClick={() => onSend(prompt)}>Send</button>}
            {editable && <button onClick={() => onDelete(prompt.id)} aria-label="Remove queued prompt">&times;</button>}
          </div>
        ))}
        {!queued.length && <p className="empty">{auto ? "Auto is on: the next prompt the host queues goes to Claude when it's free." : "The host hasn't queued anything yet."}</p>}
      </div>
    </article>
  );
}
