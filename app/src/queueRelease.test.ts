// The queue's state machine and the hook input it reads (docs/adr/0004).
// npm run test:queue-release
import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgesSend, canSend, isAnswerKey, isSlashCommand, nextClaudeState, shouldAutoSend, type ClaudeEvent, type ClaudeState } from "./queueRelease.ts";
import { parseHookInput, promptKeystrokes, riffHookSettings } from "./claudeHooks.ts";

const run = (events: ClaudeEvent[], from: ClaudeState = "off") => events.reduce(nextClaudeState, from);

test("Claude is idle only once past its start-up dialogs, and between turns", () => {
  assert.equal(run([{ event: "Started" }]), "starting");
  assert.equal(run([{ event: "Started" }, { event: "SessionStart", source: "startup" }]), "idle");
  assert.equal(run([{ event: "UserPromptSubmit", prompt: "x" }], "idle"), "working");
  assert.equal(run([{ event: "Stop", stopHookActive: false }], "working"), "idle");
  assert.equal(run([{ event: "Exited" }], "working"), "off");
});

test("a Stop with stop_hook_active doesn't end the turn", () => {
  assert.equal(run([{ event: "Stop", stopHookActive: true }], "working"), "working");
});

test("an interrupt or an API error pauses auto until a turn ends or auto is turned on again", () => {
  assert.equal(run([{ event: "Interrupt" }], "working"), "paused");
  assert.equal(run([{ event: "StopFailure" }], "working"), "paused");
  assert.equal(run([{ event: "Interrupt" }], "idle"), "idle");
  assert.equal(run([{ event: "AutoOn" }], "paused"), "idle");
  assert.equal(run([{ event: "AutoOn" }], "working"), "working");
  assert.equal(run([{ event: "UserPromptSubmit", prompt: "x" }, { event: "Stop", stopHookActive: false }], "paused"), "idle");
});

test("a slash command pauses auto, since most fire no hook; /clear and a finished turn resume it", () => {
  assert.equal(run([{ event: "SentCommand" }], "idle"), "paused");
  assert.equal(run([{ event: "SentCommand" }], "working"), "working");
  assert.equal(run([{ event: "SessionStart", source: "clear" }], "paused"), "idle");
  assert.equal(run([{ event: "SessionStart", source: "compact" }], "paused"), "idle");
  assert.equal(run([{ event: "SessionStart", source: "compact" }], "working"), "working");
  assert.equal(isSlashCommand("/cost"), true);
  assert.equal(isSlashCommand("  /model sonnet"), true);
  assert.equal(isSlashCommand("/usr/bin is a path"), false);
  assert.equal(isSlashCommand("fix /about page"), false);
});

test("a send counts as working before Claude's hook says so", () => {
  assert.equal(run([{ event: "Sent" }], "idle"), "working");
});

test("auto sends only when on, idle, not full and something is queued", () => {
  assert.equal(shouldAutoSend({ auto: true, state: "idle", queued: 1, full: false }), true);
  assert.equal(shouldAutoSend({ auto: false, state: "idle", queued: 1, full: false }), false);
  assert.equal(shouldAutoSend({ auto: true, state: "idle", queued: 0, full: false }), false);
  assert.equal(shouldAutoSend({ auto: true, state: "idle", queued: 1, full: true }), false);
  for (const state of ["off", "starting", "working", "paused", "asking", "approving"] as const) {
    assert.equal(shouldAutoSend({ auto: true, state, queued: 1, full: false }), false, state);
  }
});

test("the next send waits for Claude to acknowledge the last one", () => {
  assert.equal(acknowledgesSend({ event: "UserPromptSubmit", prompt: "x" }), true);
  assert.equal(acknowledgesSend({ event: "Interrupt" }), true);
  assert.equal(acknowledgesSend({ event: "Stop", stopHookActive: false }), false);
  assert.equal(acknowledgesSend({ event: "Sent" }), false);
  assert.equal(shouldAutoSend({ auto: true, state: "idle", queued: 1, full: false, unacknowledged: true }), false);
});

test("hook input is read from Claude Code's JSON", () => {
  assert.deepEqual(parseHookInput('{"hook_event_name":"Stop","stop_hook_active":true}'), { event: "Stop", stopHookActive: true });
  assert.deepEqual(parseHookInput('{"hook_event_name":"UserPromptSubmit","prompt":"a\\nb"}'), { event: "UserPromptSubmit", prompt: "a\nb" });
  assert.deepEqual(parseHookInput('{"hook_event_name":"SessionStart","source":"clear"}'), { event: "SessionStart", source: "clear" });
  assert.equal(parseHookInput('{"hook_event_name":"PreToolUse"}'), null);
  assert.equal(parseHookInput("not json"), null);
});

test("Send stashes the input box, pastes with newlines intact, then presses Enter", () => {
  const { stash, paste, submit } = promptKeystrokes("one\r\ntwo\n\x1b[201~three");
  assert.equal(stash, "\x13");
  assert.equal(paste, "\x1b[200~one\ntwo\nthree\x1b[201~");
  assert.equal(submit, "\r");
  assert.deepEqual(Object.keys(riffHookSettings()).sort(), [
    "Elicitation", "ElicitationResult", "Notification", "PermissionDenied", "PermissionRequest", "PostToolUse", "PostToolUseFailure",
    "SessionStart", "Stop", "StopFailure", "UserPromptSubmit",
  ]);
});

// Dialogs mid-turn (measured on 2.1.221, claudeHooks.ts DialogEvent). What
// this can't tell apart: which key answered a permission prompt (a No and a
// Yes both go to paused; a Yes's PostToolUse and Stop follow), or a late
// notification from a dialog the host answered in the same instant.
const opened = (kind: "question" | "permission" | "elicitation", late = false): ClaudeEvent => ({ event: "DialogOpened", kind, late });
const closed: ClaudeEvent = { event: "DialogClosed" };

test("a dialog mid-turn stops Send and auto until it's answered", () => {
  assert.equal(run([{ event: "Sent" }, { event: "UserPromptSubmit", prompt: "x" }, opened("question")], "idle"), "asking");
  assert.equal(run([opened("permission")], "working"), "approving");
  assert.equal(run([opened("elicitation")], "working"), "asking");
  for (const state of ["asking", "approving"] as const) {
    assert.equal(canSend(state), false, state);
    assert.equal(shouldAutoSend({ auto: true, state, queued: 1, full: false }), false, state);
  }
});

test("an answered question resumes the turn; Esc pauses; the turn's end clears it", () => {
  assert.equal(run([closed], "asking"), "working");
  assert.equal(run([closed, { event: "Stop", stopHookActive: false }], "asking"), "idle");
  assert.equal(run([{ event: "Interrupt" }], "asking"), "paused");
  assert.equal(run([{ event: "Stop", stopHookActive: false }], "asking"), "idle", "Chat about this ends the turn");
  assert.equal(run([{ event: "StopFailure" }], "approving"), "paused");
  assert.equal(run([{ event: "Exited" }], "asking"), "off");
  assert.equal(run([{ event: "AnswerKey" }], "asking"), "asking", "Enter moves between a question's options");
});

test("a permission prompt's answer key pauses, since a No fires no hook", () => {
  assert.equal(run([{ event: "AnswerKey" }], "approving"), "paused");
  // A Yes: the tool runs, then the turn ends.
  assert.equal(run([{ event: "AnswerKey" }, closed, { event: "Stop", stopHookActive: false }], "approving"), "idle");
  // The next tool asks again.
  assert.equal(run([{ event: "AnswerKey" }, opened("permission")], "approving"), "approving");
  assert.equal(run([{ event: "AnswerKey" }], "working"), "working");
  assert.equal(isAnswerKey("\r"), true);
  assert.equal(isAnswerKey("3"), true);
  assert.equal(isAnswerKey("\x1b[B"), false);
  assert.equal(isAnswerKey("y"), false);
});

test("a late notification announces only a dialog nothing else did", () => {
  assert.equal(run([opened("permission", true)], "working"), "approving");
  assert.equal(run([opened("permission", true)], "asking"), "asking");
  assert.equal(run([opened("permission", true)], "paused"), "paused", "after the host's answer");
  assert.equal(run([opened("permission", true)], "idle"), "idle");
  assert.equal(run([opened("question")], "idle"), "idle");
  assert.equal(run([closed], "working"), "working");
});

test("dialog hooks are read from Claude Code's JSON", () => {
  assert.deepEqual(parseHookInput('{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion"}'), opened("question"));
  assert.deepEqual(parseHookInput('{"hook_event_name":"PermissionRequest","tool_name":"Bash"}'), opened("permission"));
  assert.deepEqual(parseHookInput('{"hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode"}'), opened("permission"));
  assert.deepEqual(parseHookInput('{"hook_event_name":"Elicitation"}'), opened("elicitation"));
  assert.deepEqual(parseHookInput('{"hook_event_name":"Notification","notification_type":"permission_prompt"}'), opened("permission", true));
  assert.deepEqual(parseHookInput('{"hook_event_name":"Notification","notification_type":"elicitation_dialog"}'), opened("elicitation", true));
  assert.equal(parseHookInput('{"hook_event_name":"Notification","notification_type":"idle_prompt"}'), null);
  assert.equal(parseHookInput('{"hook_event_name":"Notification","notification_type":"constructor"}'), null);
  for (const name of ["PostToolUse", "PostToolUseFailure", "PermissionDenied", "ElicitationResult"]) {
    assert.deepEqual(parseHookInput(`{"hook_event_name":"${name}"}`), closed, name);
  }
});
