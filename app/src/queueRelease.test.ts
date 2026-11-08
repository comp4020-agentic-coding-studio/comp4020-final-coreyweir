// The queue's state machine and the hook input it reads (docs/adr/0004).
// npm run test:queue-release
import test from "node:test";
import assert from "node:assert/strict";
import { isSlashCommand, nextClaudeState, shouldAutoSend, type ClaudeEvent, type ClaudeState } from "./queueRelease.ts";
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
  for (const state of ["off", "starting", "working", "paused"] as const) {
    assert.equal(shouldAutoSend({ auto: true, state, queued: 1, full: false }), false, state);
  }
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
  assert.deepEqual(Object.keys(riffHookSettings()).sort(), ["SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
});
