# Process overview

## What I'm building
I'm building Riff, a collaborative-prompting site where participants can collaboratively brainstorm, prompt, and preview
while working on a web application. This is based on a project I have been working on since Week 2, and was originally intended
to be used in the COMP4020 crit riffs.

## How I got here
For this week, what I needed to answer was whether this project was actually a reasonable fit for the brief, whether reusing something
I'd been working on was allowed, whether the dependency licenses were such that distributing them with modifications in git was allowed,
whether getting this running on fly.io would be feasible, and whether I could get it done quickly enough.

After getting Claude up to speed with the project requirements using the course skills, I asked it if the project would be suitable.
It responded with a number of pros and cons; it then also told me we didn't have time to port anything before the Crit. I pushed back,
hard:
> Are you sure porting it in the timeframe isn't feasible. I'm not sure how carefully you've examined this.
> 
> For one, we don't actually use a gateway for network traffic generally? We use a fetch-backed proxy to make curls work in WASIX land, i.e. it's proxied by the browser. And git actually uses github api which has Access-Control-Allow-Origin: *, i.e. it's done directly.
> 
> Similarly, I think examination of the ansible stuff would reveal that there's already a process for building deployable artifacts, instead of the dev server approach I run locally.
> 
> If we don't get subdomains on fly, that's the trickier part. That also only affects previews of dev servers by non-host users, and it was one of a number of options we considered to make that work, so there are alternatives already in that project's markdown files. (I can point you towards those later, but it isn't relevant immediately)
> 
> I think examination of those details, plus some searching of what exactly we can deploy to Fly, would be a better starting point?

Claude's response to that accepted all of my corrections, and it proposed a plan for a Dockerfile for a container based deployment to Fly.
I followed up by asking it do a license check for the external dependencies to determine whether we could legally add them to git, and to
check what work would be required to comply with those licenses in doing so. I then followed up with paths to my local research/working
directories, which allowed it to close the gaps in its knowledge and determine how to incorporate the dependencies appropriately.

With that satisifed, Claude went ahead and committed the initial app state, the license files, and its new Dockerfile. These landed in
[`c93f5b9d...346fbf19`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-coreyweir/compare/c93f5b9d...346fbf19).
