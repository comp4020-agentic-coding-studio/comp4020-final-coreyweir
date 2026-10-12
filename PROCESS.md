# Process overview

## What I'm building
I'm building Riff, a collaborative-prompting site where participants can collaboratively brainstorm, prompt, and preview
while working on a web application. This is based on a project I have been working on since Week 2, and was originally intended
to be used in the COMP4020 crit riffs.

## How I got here
My project already had realtime websockets, so for this week what I really wanted to do was think about how I needed to adapt the
communications and persistence to better fit my aims for this assignment.

For this week, what I needed to answer was whether this project was actually a reasonable fit for the brief, whether reusing something
I'd been working on was allowed, whether the dependency licenses were such that distributing them with modifications in git was allowed,
whether getting this running on fly.io would be feasible, and whether I could get it done quickly enough.

Last week, Claude proposed helped me create a Dockerfile for and modify my project to run on fly.io. 

This week, I spent the time going back and forth with Claude to figure out the plan. How would we do persistence. How would we do authentication. What did we want in local state, what did we want stored in the sqlite db. How would we adapt the whiteboard to be a better fit (hocuspocus and sqlite storage). Eventually, we formulated a plan of attack, which landed in [5c256b0](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/commit/5c256b0).
