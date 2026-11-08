// W1/B2 regression: Claude Code resolves $SHELL ("bash") or "/bin/bash" and
// spawns `<shell> -c <cmd>` inside Nodepod. Both keys are registered as host
// external commands forwarding to the shared WASIX bash session, so those
// spawns run REAL bash (composed GNU tools, bridge stubs, tokens) instead of
// the mythic shim — with live streamed output.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) errors.push(String(error));
  });
  // docs/week-12.md, "insecure sources": a browser has no node: scheme, so
  // an import("node:fs") in a Nodepod worker goes out as a request for the
  // URL "node:fs", and Chrome flags the site for a script from an insecure
  // source. Nothing may ask for one.
  const nodeSchemeRequests = [];
  page.on("request", (request) => { if (request.url().startsWith("node:")) nodeSchemeRequests.push(request.url()); });
  await page.goto(`${baseUrl}/?poc=blank`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async (checkWorkerCwd) => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const { ClaudePodController } = await import("/src/claudePod.ts");

    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
      githubToken: "claude-bash-fake-token",
    }, () => {});
    // No config.githubToken in other smokes — here it must ride the session
    // env for the token assertion below.
    await controller.boot();

    async function spawnCollect(command, args, opts) {
      const stdout = [];
      const stderr = [];
      const times = [];
      let exitedAt = null;
      let code = null;
      const t0 = Date.now();
      const proc = await controller.pod.spawn(command, args, opts);
      proc.on("output", (chunk) => {
        stdout.push(chunk);
        times.push(Date.now() - t0);
      });
      proc.on("error", (chunk) => stderr.push(chunk));
      proc.on("exit", (c) => {
        code = c;
        exitedAt = Date.now() - t0;
      });
      // poll until exit recorded
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (exitedAt !== null) {
            clearInterval(timer);
            resolve();
          }
        }, 25);
        setTimeout(() => {
          if (exitedAt === null) {
            clearInterval(timer);
            reject(new Error(`spawn ${command} timed out`));
          }
        }, 240_000);
      });
      return { code, stdout: stdout.join(""), stderr: stderr.join(""), times, exitedAt };
    }

    try {
      const out = {};
      controller.pod.volume.mkdirSync("/home/user/.claude/shell-snapshots", { recursive: true });
      await controller.pod.fs.writeFile(
        "/home/user/.claude/shell-snapshots/probe.sh",
        "export RIFF_SNAPSHOT_OK=1\n",
      );
      await controller.pod.fs.writeFile("/tmp/claude-task.output", "task-output-ok\n");
      // 1) $SHELL-by-name form, Claude-style -c invocation.
      out.byName = await spawnCollect("bash", [
        "-c",
        [
          'echo "pwd: $(pwd)"',
          'echo "bash-ver: ${BASH_VERSION:-none}"',
          'echo "home: $HOME"',
          'echo "user: $USER"',
          'echo "tmpdir: $TMPDIR"',
          'printf "alpha\\nwasix-line\\n" > /work/repo/cb.txt',
          'echo "task: $(cat /tmp/claude-task.output)"',
          'pwd -P > /tmp/claude-cwd',
          'echo "grep: $(grep -c wasix /work/repo/cb.txt)"',
          'echo "sed: $(sed -n 1p /work/repo/cb.txt)"',
          'echo "git: $(git --version)"',
          'node -e "console.log(\'token:\' + (process.env.GITHUB_TOKEN || \'\'))"',
          'exit 7',
        ].join(" && "),
      ], { cwd: "/work/repo", env: {} });
      out.cwdReadback = await controller.pod.fs.readFile("/tmp/claude-cwd", "utf8");

      // 2) Absolute-path form (shell snapshot style).
      out.byPath = await spawnCollect("/bin/bash", [
        "-c",
        ". /home/user/.claude/shell-snapshots/probe.sh && echo snapshot:$RIFF_SNAPSHOT_OK",
      ], { cwd: "/work/repo", env: {} });

      // 3) Compound redirections must not leak Bash's saved descriptors into
      // replacement programs. Older WASIX libc cannot mark those FDs CLOEXEC.
      out.redirectedGroups = await spawnCollect("bash", [
        "-c",
        "{ /bin/basename /a/b; } 2>&1 && f() { /bin/basename /c/d; } && f 2>&1",
      ], { cwd: "/work/repo", env: {} });
      out.redirectedExec = await spawnCollect("bash", [
        "-c",
        "{ exec /bin/basename /e/f; } 2>&1",
      ], { cwd: "/work/repo", env: {} });

      // 4) The locally bundled findutils uses getcwd/chdir restoration rather
      // than gnulib's unavailable fchdir path, including around -exec.
      controller.pod.volume.mkdirSync("/work/repo/find-fixture/nested", { recursive: true });
      await controller.pod.fs.writeFile("/work/repo/find-fixture/nested/needle.txt", "ok\n");
      out.find = await spawnCollect("bash", [
        "-c",
        "find find-fixture -name needle.txt -exec /bin/basename {} \\;",
      ], { cwd: "/work/repo", env: {} });
      out.xargs = await spawnCollect("bash", [
        "-c",
        "printf '/a/b\\n/c/d\\n' | xargs -n1 /bin/basename",
      ], { cwd: "/work/repo", env: {} });

      // 5) Streaming: ticks must arrive while the child runs.
      await controller.pod.fs.writeFile(
        "/work/repo/tickler.js",
        "let n=0; const t=setInterval(()=>{console.log('tick-'+ ++n); if(n>=6) clearInterval(t);},300);",
      );
      await controller.pod.fs.writeFile(
        "/work/repo/package.json",
        JSON.stringify({ name: "cb-fixture", version: "1.0.0", scripts: { tickle: "node ./tickler.js" } }),
      );
      out.stream = await spawnCollect("bash", ["-c", "npm run tickle"], { cwd: "/work/repo", env: {} });

      // 6) docs/week-12.md, "everything missing": the session's tools and
      // bridge pipe used to live in /work/repo/.wasix-session, so git saw them
      // as untracked files and anything that emptied the workspace took every
      // tool at once. Empty it here; the snapshot commands below (git, jq, rg,
      // nano, node, npm) then have to run from a wiped workspace.
      // docs/week-12.md, "npx create hangs": the bridge carries no stdin, so
      // a bridged process must not claim a TTY there, or prompting CLIs wait
      // forever for keys.
      out.stdinTty = await spawnCollect("bash", ["-c", "node -e 'console.log(String(process.stdin.isTTY))'"], { cwd: "/work/repo", env: {} });
      out.workspaceGit = await spawnCollect("bash", ["-c", "git init -q && git status --porcelain --untracked-files=all"], { cwd: "/work/repo", env: {} });
      out.wipe = await spawnCollect("bash", ["-c", "rm -rf /work/repo/* /work/repo/.[!.]* && ls -A /work/repo | wc -l"], { cwd: "/work/repo", env: {} });
      // A Python script for the snapshot commands: relative paths must
      // resolve against the cwd bash gave it, not the root.
      controller.pod.volume.mkdirSync("/work/repo/py", { recursive: true });
      await controller.pod.fs.writeFile("/work/repo/py/script.py", [
        "import os, sys",
        "text = open('in.txt').read().strip()",
        "open('out.txt', 'w').write(os.getcwd() + ' ' + text)",
        "print('read:' + text)",
        "sys.exit(int(sys.argv[1]))",
        "",
      ].join("\n"));
      // subprocess from Python: by bare name (cat isn't in the first PATH
      // directory), Python itself, and a program that doesn't exist.
      await controller.pod.fs.writeFile("/work/repo/py/sub.py", [
        "import subprocess, sys",
        "print(subprocess.run(['cat', 'in.txt'], capture_output=True, text=True).stdout.strip())",
        "print(subprocess.run([sys.executable, '-c', 'import os; print(os.getcwd())'], capture_output=True, text=True).stdout.strip())",
        "try:",
        "    subprocess.run(['riff-no-such-program'])",
        "except FileNotFoundError as error:",
        "    print('missing:' + error.filename)",
        "",
      ].join("\n"));

      // Exercise the pinned Claude shell provider itself, without an API call.
      // Only replace its CLI entrypoint; snapshot generation and command wrapping
      // remain the shipped implementation running inside a real Nodepod worker.
      const bundle = await controller.pod.fs.readFile("/opt/claude/claude-booted.patched.js", "utf8");
      const entrypoint = "ZhS();})(exports, require, module, __filename, __dirname);";
      if (!bundle.includes(entrypoint)) throw new Error("Claude test entrypoint no longer matches");
      await controller.pod.fs.writeFile("/opt/claude/snapshot-test.cjs", bundle.replace(
        entrypoint,
        "_Fd();module.exports={createBashProvider:yFd};})(exports, require, module, __filename, __dirname);",
      ));
      await controller.pod.fs.writeFile("/opt/claude/snapshot-driver.cjs", `
        const { spawn } = require('child_process');
        const fs = require('fs');
        (async () => {
          const { createBashProvider } = require('/opt/claude/snapshot-test.cjs');
          const provider = await createBashProvider('bash');
          const results = { parentPath: process.env.PATH, commands: {} };
          const commands = {
            gitVersion: 'git --version',
            gitCommit: 'mkdir -p snapshot-git && cd snapshot-git && git init && git config user.name Probe && git config user.email probe@example.invalid && echo snapshot-ok > tracked.txt && git add tracked.txt && git commit -m snapshot-commit && git log -1 --format=%s',
            gitStatus: 'cd snapshot-git && git status --porcelain',
            gitLogTail: 'cd snapshot-git && git log --format=%s | tail -n 1',
            seqTail: 'seq 1 20 | tail -n 3',
            tailRelCwd: 'cd snapshot-git && tail -n 1 tracked.txt',
            rgNeedle: 'cd snapshot-git && rg -n --color never snapshot-ok tracked.txt',
            jqFilter: 'echo \\\'{"a":7}\\\' | jq -M .a',
            nanoVersion: 'nano --version',
            nodeVersion: 'node --version',
            npmVersion: 'npm --version',
            // python/python3 run in the session itself (pythonCommand.ts).
            pythonPrint: \`python3 -c 'print(6*7)'\`,
            pythonVersion: 'python --version',
            pythonStdin: \`echo hi | python3 -c 'import sys;print(sys.stdin.read().upper())'\`,
            pythonExit: \`python3 -c 'import sys; sys.exit(3)'; echo "exit=$?"\`,
            pythonScript: 'cd py && echo from-bash > in.txt && python3 script.py 0 && cat out.txt',
            pythonScriptExit: 'cd py && python3 script.py 5; echo "exit=$?"',
            pythonSubprocess: 'cd py && python3 sub.py',
          };
          for (const [name, command] of Object.entries(commands)) {
            const { commandString, cwdFilePath } = await provider.buildExecCommand(command, { id: name, useSandbox: false });
            const args = provider.getSpawnArgs(commandString);
            const result = await new Promise((resolve, reject) => {
              const child = spawn('bash', args, { cwd: '/work/repo' });
              let stdout = '', stderr = '';
              child.stdout.on('data', chunk => { stdout += chunk; });
              child.stderr.on('data', chunk => { stderr += chunk; });
              child.on('error', reject);
              child.on('close', code => resolve({ code, stdout, stderr }));
            });
            results.commands[name] = { ...result, commandString, spawnFlags: args.slice(0, -1), cwdFilePath };
            if (${checkWorkerCwd}) await fs.promises.readFile(cwdFilePath, 'utf8');
          }
          results.snapshotFiles = fs.readdirSync('/home/user/.claude/shell-snapshots')
            .filter(name => name.startsWith('snapshot-'))
            .map(name => '/home/user/.claude/shell-snapshots/' + name);
          console.log(JSON.stringify(results));
        })().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
      `);
      const runner = await controller.pod.fs.readFile("/opt/claude/run.cjs", "utf8");
      if (!runner.includes("require(entry);")) throw new Error("Claude runner test entrypoint no longer matches");
      await controller.pod.fs.writeFile("/opt/claude/snapshot-run.cjs", runner.replace("require(entry);", "require('./snapshot-driver.cjs');"));
      out.realSnapshot = await spawnCollect("node", ["/opt/claude/snapshot-run.cjs", "--print"], { cwd: "/work/repo" });
      if (out.realSnapshot.code === 0) {
        out.snapshot = JSON.parse(out.realSnapshot.stdout);
        delete out.realSnapshot.stdout;
        out.snapshot.snapshotPaths = await Promise.all(out.snapshot.snapshotFiles.map(async path => {
          const content = await controller.pod.fs.readFile(path, 'utf8');
          return content.split('\n').find(line => line.startsWith('export PATH='));
        }));
        for (const command of Object.values(out.snapshot.commands)) {
          // A failed command never writes it; let the code assertion say why.
          command.cwd = await controller.pod.fs.readFile(command.cwdFilePath, 'utf8').catch(() => null);
        }
      }

      return out;
    } finally {
      await controller.dispose();
    }
  }, process.env.RIFF_SNAPSHOT_WORKER_CWD === "1");

  console.log(JSON.stringify(result, null, 2));

  // Name form: real bash semantics + composed tools + bridge + tokens + exit code.
  assert.equal(result.byName.code, 7, `byName exited ${result.byName.code}: ${result.byName.stderr}`);
  assert.match(result.byName.stdout, /pwd: \/work\/repo/);
  assert.match(result.byName.stdout, /bash-ver: .+/, "BASH_VERSION empty — not real bash?");
  assert.match(result.byName.stdout, /home: \/home\/user/);
  assert.match(result.byName.stdout, /user: user/);
  assert.match(result.byName.stdout, /tmpdir: \/tmp/);
  assert.match(result.byName.stdout, /task: task-output-ok/);
  assert.match(result.byName.stdout, /grep: 1/);
  assert.match(result.byName.stdout, /sed: alpha/);
  assert.match(result.byName.stdout, /git: git version 2\.43\.0/);
  // The guest holds a placeholder, never the token itself (docs/adr/0007).
  assert.match(result.byName.stdout, /token:riff-placeholder-github-[0-9a-f]+/);
  assert.doesNotMatch(result.byName.stdout, /claude-bash-fake-token/);
  assert.equal(result.cwdReadback, "/work/repo\n");

  // Absolute-path snapshot startup sees the Nodepod-created home file.
  assert.equal(result.byPath.code, 0);
  assert.equal(result.byPath.stdout, "snapshot:1\n");

  assert.equal(result.redirectedGroups.code, 0, result.redirectedGroups.stderr);
  assert.equal(result.redirectedGroups.stdout, "b\nd\n");
  assert.equal(result.redirectedExec.code, 0, result.redirectedExec.stderr);
  assert.equal(result.redirectedExec.stdout, "f\n");

  assert.equal(result.find.code, 0, result.find.stderr);
  assert.equal(result.find.stdout, "needle.txt\n");
  assert.equal(result.find.stderr, "");
  assert.equal(result.xargs.code, 0, result.xargs.stderr);
  assert.equal(result.xargs.stdout, "b\nd\n");
  assert.equal(result.xargs.stderr, "");

  // Streaming through the external command path.
  assert.equal(result.stream.code, 0, `stream exited ${result.stream.code}: ${result.stream.stderr}`);
  assert.match(result.stream.stdout, /tick-6/);
  const firstTickTime = result.stream.times.find((t) => true); // first chunk arrival
  assert.ok(firstTickTime !== undefined && result.stream.exitedAt - firstTickTime >= 500,
    `output arrived late: first chunk at ${firstTickTime} ms, exit at ${result.stream.exitedAt} ms`);

  assert.equal(result.stdinTty.stdout, "false\n", result.stdinTty.stderr);
  assert.equal(result.workspaceGit.code, 0, result.workspaceGit.stderr);
  assert.doesNotMatch(result.workspaceGit.stdout, /wasix-session/, "the session's control files must not show up in the user's repo");
  assert.equal(result.wipe.code, 0, result.wipe.stderr);
  assert.equal(result.wipe.stdout.trim(), "0", "the workspace should be empty before the snapshot commands run");

  assert.deepEqual(nodeSchemeRequests, [], "a worker asked the network for a node: module");
  assert.deepEqual(errors, []);
  assert.equal(result.realSnapshot.code, 0, result.realSnapshot.stderr);
  const snapshot = result.snapshot;
  assert.ok(snapshot.parentPath.split(":").includes("/opt/riff/.wasix-session/bin"));
  assert.equal(snapshot.snapshotPaths.length, 1, "Claude must create a real snapshot, not fall back to a login shell");
  assert.match(snapshot.snapshotPaths[0], /\/opt\/riff\/\.wasix-session\/bin/);
  for (const [name, command] of Object.entries(snapshot.commands)) {
    assert.equal(command.code, 0, `${name}: ${command.stderr}`);
    assert.match(command.commandString, /^source \/home\/user\/\.claude\/shell-snapshots\/snapshot-/);
    assert.deepEqual(command.spawnFlags, ["-c"], "snapshot-backed commands should not need a login shell");
    const subdirectory = { gitCommit: "snapshot-git", gitStatus: "snapshot-git", gitLogTail: "snapshot-git", rgNeedle: "snapshot-git", tailRelCwd: "snapshot-git", pythonScript: "py", pythonScriptExit: "py", pythonSubprocess: "py" }[name];
    assert.equal(command.cwd, subdirectory ? `/work/repo/${subdirectory}\n` : "/work/repo\n");
  }
  assert.equal(snapshot.commands.gitVersion.stdout, "git version 2.43.0\n");
  assert.match(snapshot.commands.gitCommit.stdout, /snapshot-commit\n$/);
  assert.equal(snapshot.commands.gitStatus.stdout, "");
  // Piping bridged Git output into GNU tail is the exact pipeline the old uutils
  // multicall broke (tail fell through to its usage dump).
  assert.equal(snapshot.commands.gitLogTail.stdout, "snapshot-commit\n");
  assert.equal(snapshot.commands.seqTail.stdout, "18\n19\n20\n");
  // Relative tail from a child whose cwd is a subdirectory: preview1 has no
  // getcwd, so new wasi-libc children anchored the tracked-cwd join at `/`
  // and missed; the runtime now retries root-anchored misses against the
  // process's real working directory.
  assert.equal(snapshot.commands.tailRelCwd.stdout, "snapshot-ok\n");
  // wasinix jq/ripgrep session binaries (need the fork's proc_spawn3 backport).
  // rg colors its output because the session terminal isatty; --color never
  // keeps the assertion deterministic, and a single file omits the path.
  assert.equal(snapshot.commands.rgNeedle.stdout, "1:snapshot-ok\n");
  assert.equal(snapshot.commands.jqFilter.stdout, "7\n");
  assert.match(snapshot.commands.nanoVersion.stdout, /GNU nano, version 9\.2\n/);
  assert.match(snapshot.commands.nodeVersion.stdout, /^v\d+\./);
  assert.match(snapshot.commands.npmVersion.stdout, /^\d+\./);
  assert.equal(snapshot.commands.pythonPrint.stdout, "42\n");
  assert.equal(snapshot.commands.pythonVersion.stdout, "Python 3.12.0\n");
  assert.equal(snapshot.commands.pythonStdin.stdout, "HI\n\n");
  assert.equal(snapshot.commands.pythonExit.stdout, "exit=3\n");
  assert.equal(snapshot.commands.pythonScript.stdout, "read:from-bash\n/work/repo/py from-bash");
  assert.equal(snapshot.commands.pythonScriptExit.stdout, "read:from-bash\nexit=5\n");
  assert.equal(snapshot.commands.pythonSubprocess.stdout, "from-bash\n/work/repo/py\nmissing:riff-no-such-program\n");
  console.log(`Claude-bash E2E: both $SHELL forms intercepted; tools/bridge/token/exit-code verified; first output at ${firstTickTime} ms of ${result.stream.exitedAt} ms.`);
} finally {
  await browser.close();
}
