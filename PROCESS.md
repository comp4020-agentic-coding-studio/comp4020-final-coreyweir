# Process overview

## What I'm building
I'm building Riff, a collaborative-prompting site where participants can collaboratively brainstorm, prompt, and preview
while working on a web application. This is based on a project I have been working on since Week 2, and was originally intended
to be used in the COMP4020 crit riffs.

## How I got here
For this week, what I really needed to do was get the new data model, authentication system, and invite flow in, to enable the logging.

Ahead of crit 9, I determined a plan of attack for the stages this assignment would be approached in, which landed in [5c256b0](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/5c256b0be4163c59f82e0e8d7e5533d673013d91).

During the 'assess and plan' phase, I focussed on working with claude to produce a set of architecture decisions that would guide the later
implementation phase. The decisions up to the end of the phase are [here](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/tree/2c8adc542ea24369ecff5b86eec7211f815c1739/docs/adr).

This week, the focus became implementing the key features required for the site to start taking shape.

The major change for the week was in [389ffff](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/389ffff).
This commit included the data model, the new GitHub OAuth flow, the Hocuspocus SQLite whiteboard, and the initial audit logging.

Following that commit was [4acb32b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/4acb32b), which
included the client-side changes to use the new GitHub auth flow, create and join rooms through the updated API, keep track of the new
boards, and add a 'people panel'.
