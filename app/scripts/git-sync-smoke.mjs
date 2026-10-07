import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Nodepod } from "@scelar/nodepod/headless";

const mithicDir = path.resolve("../../nodepod_wasm_wip/vendor/mithic");
const pod = await Nodepod.boot({
  headless: true,
  serviceWorker: false,
  workerUrl: path.resolve("node_modules/@scelar/nodepod/dist/__worker__.js"),
  workdir: "/work/repo",
  files: {
    "/opt/mithic/mithic-shell.cjs": new Uint8Array(fs.readFileSync(path.join(mithicDir, "mithic-shell.cjs"))),
    "/opt/mithic/mithic-coreutils.cjs": new Uint8Array(fs.readFileSync(path.join(mithicDir, "mithic-coreutils.cjs"))),
    "/opt/mithic/run-mithic.cjs": fs.readFileSync(path.join(mithicDir, "run-mithic.cjs"), "utf8"),
    "/bin/bash": fs.readFileSync(path.join(mithicDir, "bash.cjs"), "utf8"),
    "/work/repo/.keep": "",
  },
  env: {
    HOME: "/home/user",
    PATH: "/usr/local/bin:/usr/bin:/bin:/node_modules/.bin",
    SHELL: "bash",
    GITHUB_TOKEN: "deliberately-invalid-smoke-token",
  },
  preloadEsbuild: false,
});

try {
  async function run(command) {
    const process = await pod.spawn("bash", ["-lc", command], { cwd: "/work/repo" });
    const completion = await process.completion;
    return { ...completion, output: `${completion.stdout}${completion.stderr}` };
  }

  const init = await run("git init delegated");
  assert.equal(init.exitCode, 0, init.output);
  assert.match(init.output, /Initialized empty Git repository/);
  assert.equal(await pod.fs.exists("/work/repo/delegated/.git"), true);

  const clone = await run("git clone https://github.com/octocat/Hello-World.git");
  assert.equal(clone.exitCode, 128);
  assert(!clone.output.includes("sync-supported git command"), clone.output);
  assert.match(clone.output, /Bad credentials|authentication|GitHub API error/i);
  console.log("Mithic Git clone delegated through Nodepod's async Git worker");
} finally {
  await pod.teardown();
}
