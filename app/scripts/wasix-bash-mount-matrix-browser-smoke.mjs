// Probe P7 — external-command mount and cwd inheritance matrix.
//
// `PHASE4_COREUTILS_EXPERIMENT.md` concluded that a `uses`-injected child of an
// interactive WASIX bash "gets a separate filesystem" and cannot see the
// session's mounted `Directory`. That conclusion was drawn from an unmatched
// comparison: the failing bash cases used relative paths (`cat x`) while the
// passing standalone control used an absolute path
// (`/work/repo/external-after.txt`). "Child cannot see the mount" and "child
// has the wrong working directory" were never separated, and they differ by a
// wasmer-js fork.
//
// This probe separates them inside one live shell:
//   * `/bin/pwd` (external) vs `$PWD` (builtin)  -> is the child's cwd inherited?
//   * `cat /work/repo/x` (absolute) vs `cat x`   -> is the mount visible at all?
//   * `ls /`, `ls /work`, `ls /work/repo`        -> where does the child's view stop?
//
// It pins the corrected behaviour of the maintained package line. The legacy
// packages remain selectable with RIFF_BASH and RIFF_COREUTILS for comparison.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  // The matrix runs many external WASIX commands in one evaluate; each one
  // compiles a multi-megabyte module. The 180s default is far too short.
  protocolTimeout: 1_200_000,
});

// Bash is selectable so the matrix can be run against a candidate package,
// matching wasix-bash-fork-browser-smoke.mjs. The digests are the validated
// registry WebC SHA-256s; the session runs from the registry specifier but
// still validates the digest's shape.
const BASH_PACKAGES = {
  "sharrattj/bash@1.0.18": "2d71072b8f2eff804bba8f3edeadca8d52855f31e474b8c4d40b8b898f5fcb39",
  "wasmer/bash@1.0.25": "059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
};
const BASH_SPEC = process.env.RIFF_BASH ?? "wasmer/bash@1.0.25";
const BASH_DIGEST = BASH_PACKAGES[BASH_SPEC];
if (BASH_DIGEST === undefined) throw new Error(`Unknown bash package: ${BASH_SPEC}`);

const COREUTILS_SPEC = process.env.RIFF_COREUTILS ?? "wasmer/coreutils@1.0.25";

const BASH = {
  packageUrl: `https://cdn.wasmer.io/webcimages/${BASH_DIGEST}.webc`,
  packageSha256: BASH_DIGEST,
  command: "bash",
  entrypoint: true,
  registrySpecifier: BASH_SPEC,
  uses: [COREUTILS_SPEC],
};

// The same binary run as a top-level command, for the cwd control below.
// NOTE: this control must use the SAME coreutils as the shell, otherwise it
// silently measures a different package than the matrix above -- which is
// exactly how P7's original "bash is at fault" conclusion went wrong.
const COREUTILS_PACKAGES = {
  "sharrattj/coreutils@1.0.16": "5909ce0a168ceba89078bea97c19b22e47807cc21a7097bfb45f58c93d00233a",
  "wasmer/coreutils@1.0.25": "36ea48f185ca15fe8454b1defb6a11754659dbed6330549662b62874d509f95f",
};
const COREUTILS_DIGEST = COREUTILS_PACKAGES[COREUTILS_SPEC];
if (COREUTILS_DIGEST === undefined) throw new Error(`Unknown coreutils package: ${COREUTILS_SPEC}`);
const COREUTILS = {
  packageUrl: `https://cdn.wasmer.io/webcimages/${COREUTILS_DIGEST}.webc`,
  packageSha256: COREUTILS_DIGEST,
  command: "cat",
  registrySpecifier: COREUTILS_SPEC,
};

// Every case runs in the same live shell, in order. `after` cases run once a
// host writes created after the shell starts are visible through the store.
const CASES = [
  // Decisive cases first: a hang in a later case must not cost the earlier answers.
  ["pwdvar", 'printf "%s\\n" "$PWD"'],
  ["type", "type -a cat"],
  ["lsmount", "ls /work/repo"],
  ["catabs", "cat /work/repo/x"],
  ["catrel", "cat x"],
  ["catdot", "cat ./x"],
  // Where is the child's working directory actually anchored? If a relative
  // path resolves only after `cd /`, the child's cwd is the root rather than
  // the shell's, and the mount is not the problem.
  ["cdroot", "cd /; cat work/repo/x; cd /work/repo"],
  ["cdwork", "cd /work; cat repo/x; cd /work/repo"],
  ["cdsame", "cd /work/repo; cat x"],
  ["pwdext", "/bin/pwd"],
  ["lsroot", "ls /"],
  ["lswork", "ls /work"],
  ["lsbin", "ls /bin"],
];

const AFTER_CASES = [
  ["afterabs", "cat /work/repo/after.txt"],
  ["afterrel", "cat after.txt"],
  ["afterls", "ls /work/repo"],
];

// Run last: a construct that forks the shell hangs this bash build, and a hung
// shell costs every case after it.
const FORK_CASES = [
  ["pipe", "cat /work/repo/x | cat"],
  ["subst", 'printf "[%s]\\n" "$(cat /work/repo/x)"'],
  ["redirin", 'printf "%s" "$(< /work/repo/x)"'],
];

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("[P7]")) console.log(text);
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async ({ bash, coreutils, cases, afterCases, forkCases }) => {
    const [{ ClaudePodController }, { WasixSession }] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasixSession.ts"),
    ]);
    const controller = new ClaudePodController(
      { baseUrl: "https://api.anthropic.com", token: "unused", repo: "" },
      () => {},
    );
    await controller.boot();
    let session;
    try {
      await controller.pod.fs.writeFile("/work/repo/x", "before-value\n");
      session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });

      const output = [];
      let announce;
      const ready = new Promise((resolve) => { announce = resolve; });
      const running = session.run(bash, [], {
        onOutput: (_stream, chunk) => output.push(new TextDecoder().decode(chunk)),
        onReady: (send) => announce(send),
      });
      running.catch(() => {});
      const stdin = await Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Bash did not expose live stdin")), 60_000)),
      ]);

      const strip = (text) => text.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
      const all = () => strip(output.join(""));

      // Wait for the output stream to go quiet. A case returns as soon as its
      // end marker is detected, but readline redraw fragments and prompt bytes
      // of the finished command can still be in flight; without this drain
      // they land inside the NEXT case's marker slice (observed as stray
      // characters from other cases' echoed lines inside a body).
      const quiesce = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        let last = -1;
        let stable = 0;
        while (Date.now() < deadline) {
          const len = all().length;
          if (len === last) {
            stable += 25;
            if (stable >= 200) return;
          } else {
            stable = 0;
            last = len;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };

      const runCase = async (label, cmdline, timeoutMs) => {
        const tag = label.toUpperCase();
        const begin = `__RIFFB_${tag}__`;
        const end = `__RIFF_${tag}__`;
        const start = all().length;
        // Both markers are assembled by printf at runtime, so the terminal echo
        // of the typed line never contains either one. Bash redraws the input
        // line as it echoes, so anything that counts echoes desynchronises.
        // A shell that has stopped reading stdin never acknowledges the write,
        // so the write itself needs a deadline or one hung case hangs the run.
        const written = await Promise.race([
          stdin(new TextEncoder().encode(
            `printf "%s_%s__\\n" "__RIFFB" "${tag}"; ${cmdline}; printf "%s_%s__%s\\n" "__RIFF" "${tag}" "$?"\r`,
          )).then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        if (!written) return { label, command: cmdline, timedOut: true, stdinStalled: true };
        const deadline = Date.now() + timeoutMs;
        let text = "";
        let from = -1;
        let to = -1;
        for (;;) {
          text = all().slice(start);
          from = text.indexOf(begin);
          to = from === -1 ? -1 : text.indexOf(end, from + begin.length);
          if (to !== -1) {
            // Drain in-flight redraw bytes, then re-locate the markers in the
            // grown buffer before slicing: quiescence may append text after
            // the end marker (status digit, prompt) but never before it.
            await quiesce(2_000);
            text = all().slice(start);
            from = text.indexOf(begin);
            to = from === -1 ? -1 : text.indexOf(end, from + begin.length);
            if (to !== -1) break;
          }
          if (Date.now() >= deadline) {
            return { label, command: cmdline, timedOut: true, started: from !== -1, raw: text };
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const status = /^\d+/.exec(text.slice(to + end.length));
        return {
          label,
          command: cmdline,
          status: status === null ? "?" : status[0],
          body: text.slice(from + begin.length, to).replace(/\r/g, "").trim(),
        };
      };

      const guarded = async (label, cmdline, timeoutMs = 45_000) => {
        const started = Date.now();
        let entry;
        try {
          entry = await runCase(label, cmdline, timeoutMs);
        } catch (error) {
          entry = { label, command: cmdline, failed: String(error) };
        }
        entry.ms = Date.now() - started;
        // Forwarded to the Node console so a protocol timeout still leaves evidence.
        console.log(`[P7] ${JSON.stringify(entry)}`);
        return entry;
      };

      const before = [];
      for (const [label, cmdline] of cases) before.push(await guarded(label, cmdline));

      await controller.pod.fs.writeFile("/work/repo/after.txt", "after-value\n");

      const after = [];
      for (const [label, cmdline] of afterCases) after.push(await guarded(label, cmdline));

      // Is the child's `/` working directory bash's fault or the coreutils
      // build's? Run the same binary as a top-level command with an explicit
      // cwd. If a relative path still fails here, nothing about the shell or
      // the runtime's spawn path is responsible: the build ignores the
      // runtime's working directory entirely.
      let standalone;
      const direct = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
      try {
        const run = async (args, cwd) => {
          const value = await direct.run(coreutils, args, { cwd });
          return { code: value.code, stdout: new TextDecoder().decode(value.stdout).trim(), stderr: new TextDecoder().decode(value.stderr).trim() };
        };
        standalone = {
          absolute: await run(["/work/repo/x"], "/work/repo"),
          relative: await run(["x"], "/work/repo"),
          dotted: await run(["./x"], "/work/repo"),
        };
      } catch (error) {
        standalone = { failed: String(error) };
      } finally {
        await direct.dispose();
      }
      console.log(`[P7] ${JSON.stringify({ label: "standalone", ...standalone })}`);

      const fork = [];
      for (const [label, cmdline] of forkCases) fork.push(await guarded(label, cmdline, 20_000));

      return { before, after, fork, standalone };
    } finally {
      await session?.dispose();
      await controller.dispose();
    }
  }, { bash: BASH, coreutils: COREUTILS, cases: CASES, afterCases: AFTER_CASES, forkCases: FORK_CASES });

  const all = [...result.before, ...result.after, ...result.fork];
  console.log(`\n--- P7 matrix (uses ${BASH.uses.join(", ")}) ---`);
  for (const entry of all) {
    const status = entry.timedOut ? "TIMEOUT" : entry.failed ? "THREW" : entry.status;
    console.log(`${entry.label.padEnd(13)} status=${String(status).padEnd(7)} :: ${JSON.stringify(entry.body ?? entry.raw ?? entry.failed)}`);
  }
  console.log(`standalone    ${JSON.stringify(result.standalone)}`);
  if (errors.length > 0) console.log(`\nbrowser errors: ${JSON.stringify(errors)}`);

  // Characterisation assertions for the maintained package line. See
  // PHASE4_P9D_BACKPORT.md.
  const byLabel = Object.fromEntries(all.map((entry) => [entry.label, entry]));
  assert.ok(!byLabel.pwdvar.timedOut, "The shell never answered a builtin; the session is not usable");
  assert.equal(byLabel.pwdvar.body, "/work/repo", "Bash did not start in the mount root");

  // The mount IS inherited by an injected package's child process.
  assert.equal(byLabel.catabs.status, "0", "An external child could not read the mount at an absolute path");
  assert.equal(byLabel.catabs.body, "before-value");
  assert.equal(byLabel.lsmount.status, "0", "An external child could not list the mount");

  // A host write is directly visible to an external child.
  assert.equal(byLabel.afterabs.status, "0", "A shared-store host file was not readable by an external child");
  assert.equal(byLabel.afterabs.body, "after-value");

  // Maintained coreutils resolves relative paths against the inherited cwd.
  assert.equal(byLabel.catrel.status, "0", "A relative path did not use the shell cwd");
  assert.ok(byLabel.catrel.body.endsWith("before-value"), "A relative path returned the wrong content");
  assert.equal(byLabel.catdot.status, "0", "A dotted path did not use the shell cwd");
  assert.equal(byLabel.cdwork.status, "0", "A child did not inherit cwd after cd /work");
  assert.equal(byLabel.cdsame.status, "0", "A child did not inherit cwd after cd /work/repo");
  assert.equal(byLabel.cdroot.status, "0", "A path relative to / stopped working");
  assert.equal(byLabel.pwdext.status, "0", "External pwd could not read the inherited cwd");
  assert.equal(byLabel.pwdext.body, "/work/repo");
  assert.equal(byLabel.afterrel.status, "0", "A shared-store host file was not readable by relative path");
  assert.ok(byLabel.afterrel.body.endsWith("after-value"), "A relative path returned the wrong host-written content");

  // The same binary also honours cwd when run directly by the SDK.
  assert.equal(result.standalone.absolute.code, 0, result.standalone.absolute.stderr);
  assert.equal(result.standalone.relative.code, 0, result.standalone.relative.stderr);
  assert.equal(result.standalone.relative.stdout, "before-value");
  assert.equal(result.standalone.dotted.code, 0, result.standalone.dotted.stderr);
  assert.equal(result.standalone.dotted.stdout, "before-value");

  // Pipelines and both command-substitution forms work in maintained bash.
  assert.equal(byLabel.pipe.status, "0", "A pipeline stopped working");
  assert.equal(byLabel.subst.status, "0", "$(...) command substitution did not complete");
  assert.equal(byLabel.subst.body, "[before-value]");
  assert.equal(byLabel.redirin.status, "0", "$(< file) command substitution did not complete");
  assert.ok(byLabel.redirin.body.endsWith("before-value"), "$(< file) did not return the mounted file content");
} finally {
  await browser.close();
}
