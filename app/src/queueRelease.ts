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
 * - paused: Claude is at its prompt, but auto shouldn't trust that: the
 *   host interrupted a turn (Claude fires no hook for that), the API
 *   failed, or the host sent a slash command. Most slash commands run
 *   locally and fire no hook at all (measured on 2.1.221: /cost, /help,
 *   /model, /compact with nothing to compact), and some leave a dialog
 *   open that the next prompt would land in. Auto waits for a turn to
 *   finish normally, `/clear`, or the host turning auto on again.
 * - asking: mid-turn, Claude asked the host a question (AskUserQuestion)
 *   or an MCP server's form is open. Typed keys answer it, so a Send would
 *   go into the dialog (measured: the prompt was lost and the first option
 *   chosen). Nothing is sent until the answer's hook, Esc, or the turn's
 *   end (claudeHooks.ts, DialogEvent).
 * - approving: the same for a permission prompt or plan approval. Saying
 *   No to one fires no hook, so the host's own answer key (Enter or a
 *   digit, typed in Claude's terminal) moves on to paused; a Yes then
 *   fires PostToolUse when the tool has run, and Stop ends the turn.
 */
export const CLAUDE_STATES = ["off", "starting", "idle", "working", "paused", "asking", "approving"] as const;
export type ClaudeState = (typeof CLAUDE_STATES)[number];

export type ClaudeEvent =
  | ClaudeHookEvent
  /** The host pressed Esc or Ctrl+C in Claude, or Riff's Interrupt button. */
  | { event: "Interrupt" }
  /** Claude's process started or exited. */
  | { event: "Started" }
  | { event: "Exited" }
  /** A prompt was sent: working at once, so auto can't send a second before Claude's hook says so. */
  | { event: "Sent" }
  /** A slash command was sent; it may never reach the model, so no hook may follow. */
  | { event: "SentCommand" }
  /** The host turned auto on: after an interrupt or an API error Claude is at its prompt again. */
  | { event: "AutoOn" }
  /** The host typed a key that answers a permission prompt (Enter or a digit) into Claude. */
  | { event: "AnswerKey" };

export function nextClaudeState(state: ClaudeState, event: ClaudeEvent): ClaudeState {
  switch (event.event) {
    case "Started":
      // SessionStart says when it can take a prompt.
      return "starting";
    case "Exited":
      return "off";
    case "SessionStart":
      // An automatic compaction comes in the middle of a turn; a /compact
      // the host sent ends one.
      if (event.source === "compact") return state === "paused" ? "idle" : state;
      return "idle";
    case "UserPromptSubmit":
    case "Sent":
      return "working";
    case "SentCommand":
      return state === "working" ? state : "paused";
    case "AutoOn":
      return state === "paused" ? "idle" : state;
    case "Stop":
      // A Stop hook that blocked the stop re-runs the turn: not finished.
      return event.stopHookActive ? state : "idle";
    case "StopFailure":
      return "paused";
    case "Interrupt":
      return state === "working" || state === "asking" || state === "approving" ? "paused" : state;
    case "DialogOpened":
      // A late notification only stands in for a dialog nothing announced:
      // after the host's answer it would reopen one that's gone.
      if (event.late ? state !== "working" : state !== "working" && state !== "paused") return state;
      return event.kind === "permission" ? "approving" : "asking";
    case "DialogClosed":
      return state === "asking" || state === "approving" ? "working" : state;
    case "AnswerKey":
      return state === "approving" ? "paused" : state;
  }
}

/** Keys that answer a permission prompt: Enter, or an option's number. */
export function isAnswerKey(data: string) {
  return data === "\r" || /^[1-9]$/.test(data);
}

/** Whether Send can type into Claude now (while working, it queues as a follow-up). */
export function canSend(state: ClaudeState) {
  return state === "idle" || state === "working" || state === "paused";
}

export function shouldAutoSend({ auto, state, queued, full, unacknowledged = false }: { auto: boolean; state: ClaudeState; queued: number; full: boolean; unacknowledged?: boolean }) {
  return auto && state === "idle" && queued > 0 && !full && !unacknowledged;
}

/**
 * Whether Claude has taken the last prompt Riff typed, so the next may be
 * typed. Measured on 2.1.221: a second prompt typed before Claude has
 * processed the first one's Enter gets merged into it, duplicated, or lost,
 * idle or busy (two sends 1-20 ms apart; from 50 ms none were). No delay is
 * safe on every machine, so sends wait for Claude's own acknowledgement:
 * its UserPromptSubmit hook, which fires at once when Claude is idle, and
 * for a follow-up typed while it works, when that turn ends. Anything that
 * ends the wait without one (Claude exiting, an interrupt, an API error, a
 * new session) also lets the next go. A slash command fires no hook, so it
 * never waits (isSlashCommand).
 */
export function acknowledgesSend(event: ClaudeEvent) {
  switch (event.event) {
    case "UserPromptSubmit":
    case "StopFailure":
    case "Interrupt":
    case "Exited":
    case "Started":
    case "SessionStart":
      return true;
    default:
      return false;
  }
}

export const CLAUDE_STATE_LABEL: Record<ClaudeState, string> = {
  off: "Claude not running",
  starting: "Claude is starting",
  idle: "Claude is waiting",
  working: "Claude is working",
  paused: "Paused for the host",
  asking: "Claude is asking the host",
  approving: "Claude is asking the host",
};

/** Why Send is off while Claude has a dialog open. */
export const DIALOG_OPEN = "Claude is asking something in the terminal. Answer it first.";

export function hasDialog(state: ClaudeState) {
  return state === "asking" || state === "approving";
}

/** A prompt Claude Code reads as a slash command. */
export function isSlashCommand(prompt: string) {
  return /^\/[\w:-]+(\s|$)/.test(prompt.trimStart());
}

/** Keys a host can press in Claude's terminal that interrupt a turn. */
export function isInterruptKey(data: string) {
  return data === "\x1b" || data === "\x03";
}
