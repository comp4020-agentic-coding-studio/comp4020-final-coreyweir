# 4. Queue release: manual by default, auto as an option

- Status: accepted, not yet implemented (week 10, planning phase)
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
