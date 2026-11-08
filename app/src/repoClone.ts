// Cloning the host's repository into /work/repo at boot (docs/adr/0010).
// It runs as Nodepod's own `git clone` in the pod, like any git command
// Claude runs, so the push token only ever reaches it as the placeholder
// and riff-sw.js swaps it in on the way to GitHub (docs/adr/0007).
import type { Nodepod } from "@scelar/nodepod";

/** `https://github.com/owner/name` for whatever the host typed, or null. */
export function githubRepoUrl(repo: string) {
  const typed = repo.trim();
  if (!typed) return null;
  const match = /^(?:(?:https?:\/\/|git@)?(?:www\.)?github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(typed);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}`;
}

/** Clone into `target`; resolves with git's exit code. */
export async function cloneRepository(
  pod: Nodepod,
  url: string,
  target: string,
  env: Record<string, string>,
  write: (text: string) => void,
) {
  // Boots before saved workspaces left a `.keep` here. Nodepod's clone
  // commits whatever is in the directory as the first commit's tree, so it
  // would go to GitHub with the next push.
  if (pod.volume.existsSync(`${target}/.keep`)) pod.volume.unlinkSync(`${target}/.keep`);
  const process = await pod.spawn("git", ["clone", url, target], { cwd: "/work", env });
  process.on("output", write);
  process.on("error", write);
  return new Promise<number>((resolve) => process.on("exit", (code) => resolve(code ?? 1)));
}
