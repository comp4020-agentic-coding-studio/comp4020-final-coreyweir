# 4. Queue release: manual by default, auto as an option

- Status: accepted (week 10); implemented 8 Nov with the hooks fallback (see "Implementation")
- Date: 2026-10-12

## Context

Everyone in a room writes prompts. The host decides which reach Claude, in
what order, through the queue. Today "Load" types the prompt into Claude's
input with its newlines replaced by spaces (`claudePod.ts` `loadPrompt`), and
the host still has to press enter. With several people adding to the queue,
the host becomes a relay, and every prompt waits on them noticing that
Claude has finished.

Whether the next prompt should go straight in depends on the room. Usually
the output of one prompt changes whether the next still fits. Sometimes the
queue is a plan the room already agreed on. README's "not too opinionated"
says that where hosts could reasonably differ, it should be a setting.

## Options

1. **Manual only.** The host sends every prompt.
2. **Auto only.** Each prompt goes in as soon as Claude finishes.
3. **Manual by default, with an auto toggle for the host.**

## Decision

**3.**

- **Send** puts the prompt into Claude and submits it, newlines intact. To edit a
  prompt first, edit it in the queue. Sending while Claude is still working
  is fine: Claude Code treats it as a follow-up and answers once its turn
  ends. Re-check this on the bundled version (2.1.221).
- **Auto** sends the next queued prompt each time Claude finishes a turn.
  Turning it on while Claude is idle sends the next prompt straight away.
  The toggle sits in the room's shared state, so everyone can see whether
  auto is on.
- **How the page and Claude talk.** Two mechanisms; the decision doesn't
  depend on which one we use.
  - **Planned: a Claude Code mod** (v2.1.287+). A mod runs inside Claude
    Code, follows each turn's start and end directly, and can submit a prompt
    as if it had been typed, so nothing is pasted into stdin. It needs the
    bundled Claude Code moved up from 2.1.221 and our patches redone. That's
    worth doing anyway for newer models. The mod API is early access and
    "may change between releases without notice".
  - **Until then: settings hooks plus a paste.** At boot, the host's settings
    get a `Stop` hook and a `UserPromptSubmit` hook, both calling
    `riff-hook`.
  - **Either way, the channel to the page is `riff-hook`.** It's a Nodepod
    `externalCommands` entry, so it runs as a function in the host page and
    gets its JSON on stdin. No network, no polling. WASIX bash already
    reaches Nodepod commands through the existing bridge, so it doesn't
    matter which shell Claude uses. Getting a prompt from the page to a mod
    needs a channel the other way: something the mod polls, or a file it
    watches.
- **One prompt per turn.** Auto ignores a `Stop` with `stop_hook_active` set,
  and an empty queue means auto just waits.
- **Only the host can send or toggle auto,** because only the host's browser
  can type into Claude. The server enforcing that, and logging each send as
  "host" or "auto", is crit 10's work.

## Consequences

- **Interrupting pauses auto by itself.** Claude Code doesn't fire `Stop`
  when the user interrupts, so after the host interrupts, auto won't send
  anything until Claude finishes a turn normally.
- **Auto can't read.** If Claude ends a turn with a question, auto sends the
  next prompt anyway. That's the case manual exists for, and why it's the
  default.
- **The busy signal:** `UserPromptSubmit` and `Stop` together tell the page
  whether Claude is working. The room can show that, and it's one more fact
  for the audit log.
- **To check during implementation:** for the mod, that function hooks can
  be enabled in our bundle. For the fallback:
  - that pasting followed by a separate enter submits reliably in Nodepod;
  - that a long paste (shown as `[Pasted text #1 +N lines]`) still sends the
    full text.

## The case for the options we didn't pick

**Auto by default.** "The room queued it, so the room meant it. Making the
host approve each one turns them into a bottleneck." Our answer: a queue is
written before the output it depends on exists. The cost of an unwanted
prompt (Claude off course, maybe with a push) is higher than the cost of a
click. A host who wants a fast pipeline is one toggle away.

**Manual only.** "Auto is how a room gets surprised." Our answer: some rooms
are working through an agreed plan, and a host who wants that shouldn't have
to stay glued to the queue. The toggle is visible to everyone, and
interrupting stops it.

## Implementation (8 Nov)

Built on the fallback: settings hooks and `riff-hook`. They proved
workable on the bundled 2.1.221, so the bundle stays where it is and no mod
was needed.

- **The channel.** `app/src/claudeHooks.ts`. At boot the host's
  `~/.claude/settings.json` gets `SessionStart`, `UserPromptSubmit`,
  `Stop` and `StopFailure` hooks in exec form (`command: "riff-hook"`,
  `args: []`, so no shell parses them). Nodepod runs `riff-hook` as an
  external command in the host's page with the hook's JSON on stdin. It
  prints nothing, because a `UserPromptSubmit` hook's stdout would be
  added to the prompt.
- **Send** (`promptKeystrokes`, `ClaudePodController.sendPrompt`): Ctrl+S,
  then the prompt as one bracketed paste, then Enter on its own. Ctrl+S
  stashes whatever is already in Claude's input box (the host's own draft,
  or a prompt Claude put back after an interrupt); without it the queued
  prompt was appended to that text and both went as one. Claude restores
  the stash after the submit. With an empty box Ctrl+S does nothing,
  unless the host stashed something by hand, which it brings back: the
  one case this can't tell apart.
- **What Claude is doing** (`app/src/queueRelease.ts`): off, starting,
  idle, working, paused. Starting lasts until `SessionStart`, which on
  2.1.221 fires only once the bypass-permissions dialog is accepted, so
  nothing is typed into a dialog. `UserPromptSubmit` (or the page's own
  Send) means working; `Stop` without `stop_hook_active` means idle.
  Esc or Ctrl+C typed into Claude, or the Interrupt button, means paused,
  and so does `StopFailure` (a turn ended by an API error): there is no
  hook for an interrupt. So does sending a slash command: most run
  locally and fire no hook at all (measured: `/cost`, `/help`, `/model`,
  `/compact` with nothing to compact), and some leave a dialog open that
  the next prompt would be typed into. A finished turn or `/clear`
  (which fires `SessionStart`) resumes. Turning auto on while paused
  counts as idle: the host is saying Claude is at its prompt again.
- **One send at a time.** Measured: a second prompt typed before Claude
  has processed the first one's Enter is merged into it, duplicated or
  lost, idle or busy (sends 1-20 ms apart; none from 50 ms on; with or
  without the Ctrl+S). No delay is safe on every machine, so Riff types
  the next prompt only once Claude has acknowledged the last with its
  `UserPromptSubmit` hook: at once when idle, and at the end of the turn
  for a follow-up typed while Claude works (so one follow-up per busy
  turn). Until then Send is disabled ("Waiting for Claude to take the last
  prompt") and auto waits. An interrupt, an API error, Claude exiting or a
  new session also end the wait; a slash command never starts one.
  Separate from the WASIX bash input stall found on 8 Nov: Send writes to
  Claude's node process, not bash, and 20 sends one acknowledgement apart
  (up to 13 KB, with `$(...)`, quotes, Unicode) all arrived; Claude
  itself turns a tab into spaces and trims trailing whitespace.
- **Auto** (`useQueueRelease` in `app/src/QueuePanel.tsx`): whenever auto
  is on, Claude is idle and something is queued, the first prompt goes.
  A send marks Claude working at once, before its hook says so, so a
  second render can't send another: one prompt per turn. The toggle is
  `roomState.autoRelease` in the control document, and the host's page
  publishes Claude's state as `roomState.claude`; everyone sees both in
  the queue's heading ("Host away" while the room is away, because the
  last state may be stale). A reloaded host page starts at off and says
  so.
- **The log.** `queue.send` now carries `by=host` or `by=auto` (from
  `roomState.lastSentBy`, written with `lastSent` in the delete's
  transaction), and the toggle logs `queue.auto on=true|false`, once per
  change. Still the host's claim: the server never sees the terminal.
- **Measured on 2.1.221 in Nodepod** (fake Anthropic API,
  `app/scripts/fake-anthropic.mjs`, recording each turn's prompt):
  - a bracketed paste, then a separate Enter, submits every time;
  - a 40-line prompt shows as pasted text and reaches the model whole;
  - a Send while Claude works (a slow reply, or between tool calls) is
    held and goes in once the turn ends, as its own turn, or, when two
    were waiting, joined into one turn;
  - Esc interrupts with no hook, and Claude puts the interrupted prompt
    back in the input box (hence Ctrl+S);
  - an API error fires `StopFailure`, not `Stop`.
- **Checks.**
  - `npm run test:queue-release-browser` (in `app/`): two clients, the
    participant at 390×844. The participant stages six prompts and the host
    queues them; one by Send, two by turning auto on while idle, one queued
    while auto is on, a `/cost` after which auto pauses until the host
    turns it on again, two Sends clicked in the same moment (the second
    waits and is sent once Claude has the first), and a Send while
    Claude works. Every prompt reaches
    the model exactly once, newlines intact, one turn each. The
    participant sees the state and the toggle and has no Send. Mutations:
    flattening newlines (as Load did), dropping the immediate "working"
    on send, not pausing after a slash command, and not waiting for the
    acknowledgement each turn it red. It can't see a prompt whose turn failed
    before the model call, or what a slow real model would change.
  - `npm run test:queue-release`: the state machine, hook input and
    keystrokes.
  - `npm run test:audit-log`: `by=host`/`by=auto` and the toggle, read
    back from `events`; logging every send as the host's, or every toggle
    write, turns it red.
  - `spec/permissions.test.ts`: a participant's forged toggle and send
    are refused and absent on a fresh read; the host's toggle sticks.
    Red with the control document writable by participants.
- **Left.**
  - Live verification on fly.
  - Auto treats any prompt starting `/word` as a slash command, including
    a custom command that does reach the model; it pauses after it anyway
    and resumes when that turn's `Stop` arrives.
