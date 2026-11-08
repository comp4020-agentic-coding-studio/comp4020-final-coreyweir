// How the page learns that Claude started or finished a turn (docs/adr/0004).
//
// Claude Code's settings hooks run a command on each event with the event's
// JSON on stdin. The command is `riff-hook`, a Nodepod external command, so
// it runs as a function in the host's page: no network, no polling, and it
// doesn't matter which shell Claude would use. It prints nothing, because a
// UserPromptSubmit hook's stdout would be added to the prompt.
import type { ExternalCommandContext, ExternalCommandRequest } from "@scelar/nodepod";

export const RIFF_HOOK_COMMAND = "riff-hook";

/**
 * The events the queue cares about. SessionStart fires once Claude is past
 * its start-up dialogs and can take a prompt (measured on 2.1.221: not
 * before the bypass-permissions dialog is accepted), and again after
 * `/clear` or a compaction. StopFailure is a turn ended by an API error.
 */
export type ClaudeHookEvent =
  | { event: "SessionStart"; source: string }
  | { event: "UserPromptSubmit"; prompt: string }
  | { event: "Stop"; stopHookActive: boolean }
  | { event: "StopFailure" };

const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"] as const;

/** The `hooks` block for ~/.claude/settings.json. Exec form, so no shell parses it. */
export function riffHookSettings() {
  const entry = [{ hooks: [{ type: "command", command: RIFF_HOOK_COMMAND, args: [] as string[], timeout: 10 }] }];
  return Object.fromEntries(EVENTS.map((name) => [name, entry]));
}

export function parseHookInput(text: string): ClaudeHookEvent | null {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (input?.hook_event_name) {
    case "SessionStart":
      return { event: "SessionStart", source: typeof input.source === "string" ? input.source : "" };
    case "UserPromptSubmit":
      return { event: "UserPromptSubmit", prompt: typeof input.prompt === "string" ? input.prompt : "" };
    case "Stop":
      return { event: "Stop", stopHookActive: input.stop_hook_active === true };
    case "StopFailure":
      return { event: "StopFailure" };
    default:
      return null;
  }
}

/**
 * Claude writes the JSON and a newline, then ends stdin. Stop reading at
 * whichever comes first, so a pipe whose end never arrives can't hold up
 * Claude's turn.
 */
async function readHookInput(stdin: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stdin.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const newline = text.indexOf("\n");
      if (newline !== -1 && parseHookInput(text.slice(0, newline))) return text.slice(0, newline);
    }
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* already released */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return text + decoder.decode();
}

export function createRiffHook(onEvent: (event: ClaudeHookEvent) => void) {
  return async (_request: ExternalCommandRequest, context: ExternalCommandContext) => {
    const event = parseHookInput((await readHookInput(context.stdin, context.signal)).trim());
    if (event) {
      try {
        onEvent(event);
      } catch (error) {
        console.error("[riff-hook] listener failed", error);
      }
    }
    return { exitCode: 0 };
  };
}

/**
 * What Send types into Claude, measured on 2.1.221 in Nodepod:
 * - Ctrl+S first stashes whatever is in Claude's input box: the host's own
 *   half-typed draft, or a prompt Claude put back there after an interrupt.
 *   Without it the queued prompt is appended to that text and both go as
 *   one. Claude restores the stash by itself once the prompt is submitted.
 *   With an empty box it does nothing (unless the host stashed something by
 *   hand, which it would bring back: the one case this can't tell apart).
 * - The prompt as one bracketed paste, so its newlines stay newlines
 *   instead of each one submitting. A long paste shows as "[Pasted text]"
 *   but is sent whole.
 * - Enter on its own, which submits, or queues a follow-up while Claude is
 *   working.
 */
export function promptKeystrokes(prompt: string) {
  // A paste can't contain its own end marker, or the rest would be typed.
  const text = prompt.replace(/\r\n?/g, "\n").replaceAll("\x1b[201~", "");
  return { stash: "\x13", paste: `\x1b[200~${text}\x1b[201~`, submit: "\r" };
}
