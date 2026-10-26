# Week 12 review findings

Issues that were noticed and/or features requested.
Still need to be investigated further.

1. git auth: been causing `git` command failures.
   - maybe expired token, maybe something else
2. npx create: creating vite site seems to hang forever?
3. everything missing: occasionally all of the commands don't
   load in (e.g. curl missing, jq missing). also seen pnpm missing.
4. insecure sources warning: long-lived problem.
   - think it's node:fs from claude code?
5. whiteboard paste into claude? requested.
   - image paste doesn't work. not sure how complex it'd be.
   - could consider json whiteboard input, not sure how
     worthwhile it is.
