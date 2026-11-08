// The queue (docs/adr/0004): everyone sees what's up next, whether auto is
// on, and what Claude is doing. Only the host's page can type into Claude,
// so only the host sends, removes and toggles auto; the server refuses a
// participant's write to the control document anyway (docs/adr/0006).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type * as Y from "yjs";
import type { QueuedPrompt, SentBy } from "./room";
import type { TerminalPaneHandle } from "./TerminalPane";
import { acknowledgesSend, canSend, CLAUDE_STATE_LABEL, DIALOG_OPEN, hasDialog, isSlashCommand, nextClaudeState, shouldAutoSend, type ClaudeEvent, type ClaudeState } from "./queueRelease";

/**
 * The host's side: follows Claude's events, publishes Claude's state to the
 * room, and sends the next prompt when auto says so. The state lives in a
 * ref as well as in React state, so a send flips it to "working" at once and
 * a second render can't send another prompt before Claude's hook arrives.
 */
export function useQueueRelease({ facilitator, roomState, synced, terminalRef, queued, auto, full, onSend }: {
  facilitator: boolean;
  roomState: Y.Map<unknown>;
  /** The page has had the control document from the server. */
  synced: boolean;
  terminalRef: RefObject<TerminalPaneHandle | null>;
  queued: QueuedPrompt[];
  auto: boolean;
  full: boolean;
  onSend: (id: string, by: SentBy) => void;
}) {
  const stateRef = useRef<ClaudeState>("off");
  const [state, setState] = useState<ClaudeState>("off");
  // A prompt Riff typed that Claude hasn't acknowledged yet; the next send
  // waits for it (acknowledgesSend in queueRelease.ts).
  const unacknowledgedRef = useRef(false);
  const [unacknowledged, setUnacknowledged] = useState(false);
  const setPending = useCallback((pending: boolean) => {
    unacknowledgedRef.current = pending;
    setUnacknowledged(pending);
  }, []);

  const dispatch = useCallback((event: ClaudeEvent) => {
    if (acknowledgesSend(event) && unacknowledgedRef.current) setPending(false);
    const next = nextClaudeState(stateRef.current, event);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, [setPending]);

  // What the room sees. A reloaded host page starts at "off" and says so,
  // so the room never shows a state left behind by the last page. Not
  // before the page has the server's copy: written earlier, "off" is
  // concurrent with the old page's "working", Yjs keeps either one, and the
  // room could be left seeing "working" for good (found by
  // test:queue-release-resilience-browser).
  useEffect(() => {
    if (!facilitator || full || !synced) return;
    if (roomState.get("claude") !== state) roomState.set("claude", state);
  }, [facilitator, full, roomState, state, synced]);

  const send = useCallback((prompt: QueuedPrompt, by: SentBy) => {
    if (!canSend(stateRef.current) || unacknowledgedRef.current) return false;
    if (!terminalRef.current?.sendPrompt(prompt.text)) return false;
    const command = isSlashCommand(prompt.text);
    dispatch({ event: command ? "SentCommand" : "Sent" });
    if (!command) setPending(true);
    onSend(prompt.id, by);
    return true;
  }, [dispatch, onSend, setPending, terminalRef]);

  const next = queued[0];
  useEffect(() => {
    if (!facilitator || !next) return;
    if (shouldAutoSend({ auto, state: stateRef.current, queued: queued.length, full, unacknowledged: unacknowledgedRef.current })) send(next, "auto");
  }, [auto, facilitator, full, next, queued.length, send, state, unacknowledged]);

  const setAuto = useCallback((on: boolean) => {
    if (on) dispatch({ event: "AutoOn" });
    roomState.set("autoRelease", on);
  }, [dispatch, roomState]);

  return { state, unacknowledged, dispatch, send, setAuto };
}

// What an empty queue says: true now, whatever went before (a queue that
// has sent everything is as empty as one never used), and to whom it's
// shown: the host is the one who queues, a participant is told who does.
export function emptyQueue(facilitator: boolean, editable: boolean, auto: boolean) {
  if (facilitator && !editable) return "Nothing queued.";
  if (facilitator) return auto ? "Nothing queued. Auto is on: the next prompt you queue from staging goes to Claude when it's free." : "Nothing queued. Queue a prompt from staging.";
  return auto ? "Nothing queued. Auto is on: the next prompt the host queues goes to Claude when it's free." : "Nothing queued. The host queues prompts from staging.";
}

export function QueuePanel({ queued, facilitator, full, auto, claudeState, hostHere, ended = false, canSendNow, waiting = false, onSend, onDelete, onAuto }: {
  queued: QueuedPrompt[];
  facilitator: boolean;
  full: boolean;
  auto: boolean;
  claudeState: ClaudeState;
  /** False while the host is away: the last state they published may be stale. */
  hostHere: boolean;
  /** The room has ended: the host isn't away, they're gone. */
  ended?: boolean;
  canSendNow: boolean;
  /** Claude hasn't yet taken the last prompt sent. */
  waiting?: boolean;
  onSend: (prompt: QueuedPrompt) => void;
  onDelete: (id: string) => void;
  onAuto: (on: boolean) => void;
}) {
  const editable = facilitator && !full;
  const sendTitle = waiting
    ? "Waiting for Claude to take the last prompt"
    : canSendNow
    ? claudeState === "working" ? "Claude is working: this goes in as a follow-up" : "Send to Claude"
    : hasDialog(claudeState) ? DIALOG_OPEN
    : claudeState === "starting" ? "Claude is still starting" : "Start Claude first";
  const stateTitle = claudeState === "paused" ? "A turn was interrupted or failed, or a slash command ran: auto waits until Claude finishes a turn, or the host turns auto on again"
    : hasDialog(claudeState) ? "Claude asked something in the host's terminal: nothing is sent until the host answers" : undefined;
  return (
    <article className="queue">
      <header className="section-title queue-heading">
        <h2>Up next</h2><span>{queued.length}</span>
        <small className={`claude-state ${hostHere ? claudeState : "off"}`} title={hostHere ? stateTitle : undefined} data-state={hostHere ? claudeState : "away"}>{hostHere ? CLAUDE_STATE_LABEL[claudeState] : ended ? "Room ended" : "Host away"}</small>
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
            {editable && <button className="send-prompt" disabled={!canSendNow || waiting} title={sendTitle} onClick={() => onSend(prompt)}>Send</button>}
            {editable && <button onClick={() => onDelete(prompt.id)} aria-label="Remove queued prompt">&times;</button>}
          </div>
        ))}
        {!queued.length && <p className="empty">{emptyQueue(facilitator, editable, auto)}</p>}
      </div>
    </article>
  );
}
