// Queue release (docs/adr/0004): what Claude is doing, as the host's page
// learns it from Claude's hooks, and when auto sends the next prompt.
//
// The rule auto follows: whenever auto is on, Claude is idle and the queue
// isn't empty, the next prompt goes, one per turn. So turning auto on while
// Claude is idle sends at once, a prompt queued while Claude idles goes at
// once, and an empty queue just waits.
import type { ClaudeHookEvent } from "./claudeHooks";

/**
 * - off: Claude isn't running in the host's page.
 * - starting: Claude's process is up but not past its start-up dialogs, so
 *   keystrokes would land in a dialog. Nothing is sent.
 * - idle: Claude is waiting for a prompt.
 * - working: Claude is on a turn.
 * - paused: the turn ended without finishing: the host interrupted it
 *   (Claude fires no hook for that) or the API failed. Auto waits for a
 *   turn to finish normally, or for the host to turn auto on again.
 */
export const CLAUDE_STATES = ["off", "starting", "idle", "working", "paused"] as const;
export type ClaudeState = (typeof CLAUDE_STATES)[number];

export type ClaudeEvent =
  | ClaudeHookEvent
  /** The host pressed Esc or Ctrl+C in Claude, or Riff's Interrupt button. */
  | { event: "Interrupt" }
  /** Claude's process started or exited. */
  | { event: "Started" }
  | { event: "Exited" }
  /** The host sent a prompt: working at once, so auto can't send a second before Claude's hook says so. */
  | { event: "Sent" }
  /** The host turned auto on: after an interrupt or an API error Claude is at its prompt again. */
  | { event: "AutoOn" };

export function nextClaudeState(state: ClaudeState, event: ClaudeEvent): ClaudeState {
  switch (event.event) {
    case "Started":
      // SessionStart says when it can take a prompt.
      return "starting";
    case "Exited":
      return "off";
    case "SessionStart":
      // "compact" can come in the middle of a turn.
      return event.source === "compact" ? state : "idle";
    case "UserPromptSubmit":
    case "Sent":
      return "working";
    case "AutoOn":
      return state === "paused" ? "idle" : state;
    case "Stop":
      // A Stop hook that blocked the stop re-runs the turn: not finished.
      return event.stopHookActive ? state : "idle";
    case "StopFailure":
      return "paused";
    case "Interrupt":
      return state === "working" ? "paused" : state;
  }
}

/** Whether Send can type into Claude now (while working, it queues as a follow-up). */
export function canSend(state: ClaudeState) {
  return state === "idle" || state === "working" || state === "paused";
}

export function shouldAutoSend({ auto, state, queued, full }: { auto: boolean; state: ClaudeState; queued: number; full: boolean }) {
  return auto && state === "idle" && queued > 0 && !full;
}

export const CLAUDE_STATE_LABEL: Record<ClaudeState, string> = {
  off: "Claude not running",
  starting: "Claude is starting",
  idle: "Claude is waiting",
  working: "Claude is working",
  paused: "Claude stopped mid-turn",
};

/** Keys a host can press in Claude's terminal that interrupt a turn. */
export function isInterruptKey(data: string) {
  return data === "\x1b" || data === "\x03";
}
