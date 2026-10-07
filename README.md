# Riff

Riff is a collaborative-prompting site. It allows one person to host a room, where participants can collaboratively brainstorm,
prompt, and preview while working on a web application. It was originally intended to be used for the COMP4020 Riffs, and I started
working on the project after Crit 1.

For Riff to be good, it needs:
- Ease of use: easy to get started. Hosting should be as simple as providing your name, API endpoint and token, and connecting your
  GitHub. Joining should just need your name and the room code.
- Resilience: it must be resilient to data loss. The filesystem Claude works in must be persisted locally, not just in memory, so that
  a browser crash/accidental reload/etc. don't result in unpushed changes being lost.
- Versatility: it must not unduly limit the sort of projects that can be worked on, e.g. only vite projects. It needs to be able to work
  with projects written in different programming languages and using different frameworks.
- Communications reliability: prompts must arrive and not be duplicated. The whiteboard must operate smoothly. The claude stdout must render
  cleanly for the non-host participants.
- Not to be too opinionated: perhaps the host wants to manually release prompts from the queue, perhaps they want them to automatically be
  submitted. Both should be supported.
- Information durability: brainstorms should be able to be persisted to a database.
- Not to create lock-in: brainstorms should have an export mechanism; the filesystem should have an export mechanism.
