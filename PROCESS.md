# Process overview

## What I built
I built Riff, a collaborative-prompting site where participants can collaboratively brainstorm, prompt, and preview
while working on a web application. This is based on a project I have been working on since Week 2, and was originally intended
to be used in the COMP4020 crit riffs.

Riff runs Claude Code inside the browser. It does this using [Nodepod](https://github.com/R1ck404/Nodepod), which provides a node.js-like
environment in the browser. To provide a proper Unix-like environment for agents,  [WASIX](https://www.wasix.org/) is also utilised.
A custom rust filesystem using `SharedArrayBuffer` serves to give the Nodepod and WASIX tools a shared workspace, and the workspace is
also persisted via OPFS to provide resilience and resumability.

Riff has support for GitHub login, as well as guest users hosting and participating. It features a y.js backed whiteboard and prompt-queuing
system. It has support for export and import of whiteboards and the workspace. Users can bring their own Anthropic API endpoint/key or
use the site with Nemotron 3 models provided by the site using OpenRouter. The site supports git operations thanks to Nodepod's built in
GitHub-API backed `git` tool, and features support for MCPs—including GitHub MCP support, which has permission customisation options
and works with the OAuth token Riff already has.

## How I got here
The work in this project really fell into a number of distinct phases:

- Phase 1: Bring over the existing Riff codebase, port it to fly.io, handle licensing and packaging of dependencies.
- Phase 2: A planning phase. Assessing the limitations and desired features, deciding the priorities and implementation plan.
- Phase 3: Initial implementation: data model and authentication changes, core functionality.
- Phase 4: Heavily agentic implementation and polish: work to address bugs, implement quality-of-life improvements, and finalise the project.

Each phase built on the former, but phase 4 really was where everything came together and the app started to feel more polished and
feature-rich.

## Phase 1
Phase 1 was in many ways the least interesting stage of development, but it set the framework for the project.

This phase was where we assessed how well the project fit the brief, how we could move it to fly.io, licensing requirements for
dependencies, how to package everything up, and—importantly—what 'good' would be for this project.

This is where we decided to use Dockerfile with nginx to package and serve the app, which made perfect sense given I'd already been using
nginx for the prototype. The initial project state came together in [`c93f5b9d...346fbf19`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/compare/c93f5b9d...346fbf19), and what good would be landed in [`7af9c158`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/7af9c158).

## Phase 2
Phase 2 is where the plan for the data model came together. The plan landed in [`5c256b0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/5c256b0),
and the architecture decisions made before implementation began are [here](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/tree/2c8adc542ea24369ecff5b86eec7211f815c1739/docs/adr).

A key example was deciding on where the data would live.
Claude recommended SQLite on the Fly volume and swapping y-websocket for Hocuspocus, whose hooks give
the server each connection's identity, which is what permissions and a who-did-what log need. I agreed with both quickly, but not
with how Hocuspocus writes: it stores the whole document on a 2-10 second debounce. I wrote: *"the 'How writes happen' scares me
just a little bit, so we should make sure we think this through."* That sent Claude into quickdraw's source. Pasted images live
inside the document as base64, so the crash most likely on a 256 MB machine is running out of memory on an image-heavy board,
exactly when a debounce window loses edits. We chose an append-only update log written from Hocuspocus's change hook, compacted by
size ([ADR 0002](docs/adr/0002-room-state-in-sqlite-as-an-append-log.md),
[`18041f7`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/18041f7)). My reply was *"Cool,
you've sold me on SQLite using that approach,"* and it landed in
[`36c41f6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/36c41f6).

Another important area where I worked with Claude to decide on a sensible approach was how to handle the github oauth tokens.
The token never being stored on the server was my starting point: git runs in the browser, so storing it would only
create something worth stealing. When Claude proposed handing the token to the page in a URL fragment, I pushed back: *"Is there a
way we could do the token exchange that feels a little more secure than a URL fragment? Just feels like a bad copy paste could
expose it, and session history would potentially store it?"* We moved to a one-time server handoff. I also changed the flow to
sign in first, then host or join, which made sign-in ask for no scope and push access a separate "Connect GitHub" step
([ADR 0005](docs/adr/0005-identity-github-sign-in-and-room-scoped-guests.md),
[`389ffff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/389ffff)). Tokens later moved out of
the guest entirely ([ADR 0007](docs/adr/0007-credentials-stay-in-the-tab.md),
[`99f3ac8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/99f3ac8)).

## Phase 3
## Phase 3
Phase 3 was the manual implementation phase: one long session with Claude, working through the plan a feature at a time.
Each feature followed the same rhythm: the ADR, then a spec check that fails ("red until built"), then the server, the client,
and the docs catching up. Room lists and invites show it well: ADR 0008
([`66cf3b1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/66cf3b1)), the failing spec
([`d1f40ed`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/d1f40ed)), the server
([`a0bee0f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/a0bee0f)) and the client
([`79a008f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/79a008f)).

The data model, GitHub sign-in and the who-did-what log landed together in
[`389ffff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/389ffff), with the client following in
[`4acb32b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/4acb32b). Then came room lifecycle,
keeping the board, board export and import, and Riff's own free models.

Live checks fed back into the decisions. The plan proposed a 16 MB cap per room; writing a 16 MB board on live got the server
killed for memory, the same risk that had decided the append log. The cap became 4 MB
([`59c65ab`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/59c65ab)). I kept reviewing the
designs as they were built. Reading the permissions back, I caught that participants could queue as well as stage: *"that would be
akin to them approving their own prompts and bypassing the control the host is meant to retain under our security model."*
ADR 0006 was amended so only the host queues
([`05f305b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/05f305b)).

## Phase 4
From a harness perspective, this was the most interesting phase.

Having a substantial backlog of features and improvements identified, I brought in a custom opencode plugin I'd written for some
sideprojects: opencode-agent-threads. It allowed Claude to spin off persistent subagents with their own worktrees, steerable both by
Claude and by me directly.

In introducing the plugin, my theory was that it would allow me to massively increase the rate of progress, while retaining my ability to
steer and provide input. I also hoped it would alleviate the need for expansive planning sessions before spinning off a task agent: since
I could steer and answer questions directly, work could be launched once the breakdown was clear without every detail having to be locked in
beforehand.

In practice, *this* was the breakthrough that allowed the project to achieve the level of polish it has.

What was particularly interesting is that the coordinator didn't finalise a task agent every time it finished its work and then launch
new agents as necessary, like I expected. It spawned 6 task agents, and it kept reusing them for additional tasks, picking the agent based
on how relevant its existing context was to the task. And it also kept launching QA sweeps after new changes were merged, identifying
regressions *and areas for improvement* that didn't require my input, and delegating that follow-up work appropriately.

An example of this was a regression the sweep caught. Merging worker D's Bash improvements broke pasting into the terminal; the
coordinator backed the merge out, sent it back with the failing check, and it landed fixed
([`3d66c4f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/3d66c4f)). Assignments also went to
whichever worker already had the context: the worker that built the OPFS workspace later built workspace import and
"Export files" from it.

I still jumped in where it mattered. When the coordinator misread what I wanted for web access, I took that worker over myself
([`1f8915f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/1f8915f)). On the final morning,
I found on live that Claude kept relaunching `npx vite` because it never saw the server's output. I narrowed it down to npx and
passed that on; a worker had the cause and a fix within half an hour
([`a6bbbd2`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/a6bbbd2)). The same push to try
real Vite found two more bugs that every check had missed
([`553ce14`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/553ce14),
[`0773744`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/0773744)).

