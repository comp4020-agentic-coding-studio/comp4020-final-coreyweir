import { bridgeRootOf, type BridgeRequest } from "./wasixBridge.ts";

/*
 * Background jobs from Claude's Bash tool.
 *
 * Each of Claude's Bash commands is one `bash -c` exec in the WASIX session
 * (claudePod.ts runBashExternal). When that bash exits, WASIX ends every
 * process it started, so `node server.js &` died with it: measured
 * 2026-11-08, the backgrounded bridge stub never even reached the page, and a
 * pure-WASIX `(sleep 2; echo hi > f) &` never wrote f. On Linux the job
 * outlives the shell, and that is what Claude expects when it starts a dev
 * server in the background.
 *
 * So a Bash command ends in an EXIT trap: when the command started a
 * background job (`$!` is set), the shell tells the page "done, with this
 * status" through the bridge (DETACH_COMMAND), then waits for its jobs. The
 * page answers Claude's Bash tool with that status at once and leaves the
 * exec running for as long as the jobs do. A command that started no job
 * exits as before and pays nothing.
 *
 * What it can't do: a command that replaces the EXIT trap with its own, or
 * starts its job from a subshell that has already exited (`(cmd &)`), loses
 * the job as before. Output a job writes after the command has returned goes
 * nowhere (as with `nohup cmd >/dev/null &`); redirect it to a file to read it.
 */

/** Bridge command the EXIT trap runs; answered by the page, not Nodepod. */
export const DETACH_COMMAND = "riff-detach";

/**
 * The command, run so that background jobs it starts outlive it. `$!` is
 * empty until the shell starts a job, so the trap costs nothing otherwise.
 */
export function detachingCommand(command: string): string {
  return `trap '__riff_status=$?; if [ -n "$!" ]; then ${DETACH_COMMAND} "$__riff_status"; wait; fi; exit "$__riff_status"' EXIT\n${command}`;
}

export function isDetach(request: BridgeRequest) {
  const name = request.argv[0] ?? "";
  return name.slice(name.lastIndexOf("/") + 1) === DETACH_COMMAND;
}

/** Which running Bash command (by its exec's bridge root) is waiting to hear it's done. */
export class DetachableCommands {
  private waiting = new Map<string, (status: number) => void>();

  /** Wait for the command whose stubs carry this bridge root to say it's done. */
  register(bridgeRoot: string, done: (status: number) => void): () => void {
    this.waiting.set(bridgeRoot, done);
    return () => {
      if (this.waiting.get(bridgeRoot) === done) this.waiting.delete(bridgeRoot);
    };
  }

  /** Answer a DETACH_COMMAND request; its only argument is the command's status. */
  answer(request: BridgeRequest): number {
    const root = bridgeRootOf(request);
    const done = root === undefined ? undefined : this.waiting.get(root);
    if (!done) return 1;
    this.waiting.delete(root!);
    const status = Number(request.argv[1]);
    done(Number.isInteger(status) ? status : 1);
    return 0;
  }
}
