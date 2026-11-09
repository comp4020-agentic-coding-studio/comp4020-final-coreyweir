# Process overview

## What I built
I built Riff, a collaborative-prompting site where participants can collaboratively brainstorm, prompt, and preview
while working on a web application. This is based on a project I have been working on since Week 2, and was originally intended
to be used in the COMP4020 crit riffs.

Riff runs Claude Code inside the host's browser, using [Nodepod](https://github.com/R1ck404/Nodepod) for node.js and
[WASIX](https://www.wasix.org/) for a Unix-like shell, with the workspace persisted to OPFS. This means the host's API key and GitHub
token stay in their browser instead of being a credential that could be stolen from the backend
([ADR 0007](docs/adr/0007-credentials-stay-in-the-tab.md)), and rooms cost the server no compute. The cost is versatility and
maintenance: I carry forks of wasmer-js and Nodepod, and bugs in them became mine, from a deadlock when typing fast
([`2e995ce`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/2e995ce))
to `npx serve` crashing the tab ([`b5567c6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/b5567c6)).

Riff supports GitHub or guest hosting, a shared whiteboard and prompt queue, export and import, Riff's own free models, and MCP
servers, including GitHub's.

## How I got here
The work fell into four phases:

- Phase 1: port the existing Riff to fly.io.
- Phase 2: assess and plan.
- Phase 3: implement the data model, authentication and core features.
- Phase 4: heavily agentic implementation and polish.

## Phase 1
Phase 1 was where we assessed how well the project fit the brief, how to move it to fly.io, licensing requirements for
dependencies, how to package everything up, and—importantly—what 'good' would be for this project.

We packaged the app as a Docker image with nginx, which made sense given I'd already been using nginx for the prototype. The initial
project state came together in [`c93f5b9d...346fbf19`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/compare/c93f5b9d...346fbf19), and what good would be landed in [`7af9c158`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/7af9c158).

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

For GitHub OAuth, the token never being stored on the server was my starting point: git runs in the browser, so storing it would only
create something worth stealing. Claude proposed handing the token to the page in a URL fragment, so I pushed back: *"Is there a
way we could do the token exchange that feels a little more secure than a URL fragment? Just feels like a bad copy paste could
expose it, and session history would potentially store it?"* We moved to a one-time server handoff
([ADR 0005](docs/adr/0005-identity-github-sign-in-and-room-scoped-guests.md),
[`389ffff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/389ffff)).

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
([`59c65ab`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/59c65ab)).

## Phase 4
From a harness perspective, this was the most interesting phase.

Having a substantial backlog of features and improvements identified, I brought in a custom opencode plugin I'd written for some
sideprojects: opencode-agent-threads. It allowed Claude to spin off persistent subagents with their own worktrees, steerable both by
Claude and by me directly. I hoped persistent, steerable workers would let me launch work once the breakdown was clear, without
locking in every detail first. In practice, *this* was the breakthrough that gave the project its polish.

The coordinator kept reusing its six workers, picking whichever had the most relevant context, and ran QA sweeps after each merge,
finding regressions *and areas for improvement* and delegating them without my input. For example, merging worker D's Bash
improvements broke pasting into the terminal; the coordinator backed the merge out, sent it back with the failing check, and it
landed fixed ([`3d66c4f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/3d66c4f)).

I still jumped in where it mattered. On the final morning, I found on live that Claude kept relaunching `npx vite` because it never
saw the server's output. I narrowed it down to npx and passed that on; a worker had the cause and a fix within half an hour
([`a6bbbd2`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/a6bbbd2)). The same push to try
real Vite found two more bugs that every check had missed
([`553ce14`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/553ce14),
[`0773744`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/0773744)).

It wasn't free. Workers sometimes sat for hours inside a single shell command until every command got a timeout, parallel work
collided in shared files, and the run-up used about US$440 of the course budget.
