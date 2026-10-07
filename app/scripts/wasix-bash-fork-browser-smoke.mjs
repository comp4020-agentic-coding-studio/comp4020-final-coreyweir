// Probe P8 — which shell constructs hang a live WASIX bash?
//
// P7 found that `cat a | cat` works but `$(cat a)` hangs the shell forever
// (`PHASE4_P7_EXTERNAL_COMMANDS.md`). Both fork and both create a pipe, so
// "fork is broken" is not the explanation. The difference is who reads the
// pipe: in a pipeline the runtime wires two children together, while in a
// command substitution bash itself reads the child's output to EOF and waits.
//
// This probe bisects the space: builtin vs external child, output vs no
// output, parent-reads-pipe vs not, and a no-fork control. A hang is
// permanent, so cases run until one hangs, then the session is rebuilt and the
// remaining cases continue.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  protocolTimeout: 1_800_000,
});

// Known bash packages, so a candidate can be evaluated against the same
// matrix without editing the probe. `digest` is the validated registry WebC
// SHA-256; the session runs from the registry specifier, but still validates
// the digest's shape.
const PACKAGES = {
  "sharrattj/bash@1.0.18": {
    digest: "2d71072b8f2eff804bba8f3edeadca8d52855f31e474b8c4d40b8b898f5fcb39",
    uses: ["sharrattj/coreutils@1.0.16"],
  },
  "wasmer/bash@1.0.25": {
    digest: "059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
    uses: ["wasmer/coreutils@1.0.25"],
  },
};

const SPECIFIER = process.env.RIFF_BASH ?? "wasmer/bash@1.0.25";
const SELECTED = PACKAGES[SPECIFIER];
if (SELECTED === undefined) throw new Error(`Unknown bash package: ${SPECIFIER}`);

const BASH = {
  packageUrl: `https://cdn.wasmer.io/webcimages/${SELECTED.digest}.webc`,
  packageSha256: SELECTED.digest,
  command: "bash",
  entrypoint: true,
  registrySpecifier: SPECIFIER,
  uses: process.env.RIFF_USES === undefined
    ? SELECTED.uses
    : process.env.RIFF_USES.split(",").filter((value) => value !== ""),
};

// Which phases to run. A candidate package is cheapest to judge on `script`
// alone: without a TTY the $( ) failure is a clean exit rather than a hang.
const PHASES = (process.env.RIFF_P8_PHASES ?? "script,bisect,options").split(",");

// `note` records what the case isolates, so the output reads as an argument
// rather than a list.
const ALL_CASES = [
  ["readredir", 'read v < /work/repo/x; printf "[%s]" "$v"', "no fork at all"],
  ["truesub", 'v=$(true); printf "[%s]" "$v"', "substitution, builtin child, no output"],
  ["truearg", 'v=$(true ignored); printf "[%s]" "$v"', "bare true with an ignored argument"],
  ["truesemi", 'v=$(true;); printf "[%s]" "$v"', "bare true with an explicit terminator"],
  ["truethencolon", 'v=$(true; :); printf "[%s]" "$v"', "bare true followed by another command"],
  ["commandtrue", 'v=$(command true); printf "[%s]" "$v"', "true through the command builtin"],
  ["trueandcolon", 'v=$(true && :); printf "[%s]" "$v"', "true as the left side of a connection"],
  ["iftrue", 'v=$(if true; then :; fi); printf "[%s]" "$v"', "true inside a control structure"],
  ["colonsub", 'v=$(:); printf "[%s]" "$v"', "substitution, no-op special builtin"],
  ["falsesub", 'v=$(false); printf "[%s:%s]" "$v" "$?"', "substitution, failing no-output builtin"],
  ["builtintrue", 'v=$(builtin true); printf "[%s]" "$v"', "substitution, explicit true builtin"],
  ["externaltrue", 'v=$(/bin/true); printf "[%s]" "$v"', "substitution, external true command"],
  ["emptysub", 'v=$(printf ""); printf "[%s]" "$v"', "substitution, builtin child, explicit empty output"],
  ["newlinesub", 'v=$(printf "\\n"); printf "[%s]" "$v"', "substitution whose output trims to empty"],
  ["touchsub", 'v=$(touch /work/repo/touchsub.txt); printf "[%s]" "$v"', "substitution, external child, no output"],
  ["echosub", 'v=$(echo hi); printf "[%s]" "$v"', "substitution, builtin child, output"],
  ["nestedecho", 'v=$(echo "$(echo deep)"); printf "[%s]" "$v"', "nested substitution, builtin children"],
  ["nestedcat", 'v=$(echo "$(cat /work/repo/x)"); printf "[%s]" "$v"', "nested substitution, external inner child"],
  ["dollarback", 'v=$(echo "`echo deep`"); printf "[%s]" "$v"', "outer dollar substitution, inner backticks"],
  ["backdollar", 'v=`echo "$(echo deep)"`; printf "[%s]" "$v"', "outer backticks, inner dollar substitution"],
  ["subshell", "(echo hi)", "fork, no pipe read by the parent"],
  ["subshellredir", "(echo hi) > /work/repo/subshell.txt", "fork writing to the mount"],
  ["pipebuiltin", "echo hi | cat", "builtin into external, runtime wires the pipe"],
  ["pipeext", "cat /work/repo/x | cat", "external into external (known good)"],
  ["twobackground", "(sleep 4; echo bg-four) & (sleep 1; echo bg-one) & echo submitted", "two background subshells should return immediately"],
  ["backgroundsub", "(sleep 4; echo bg-four) & (sleep 1; echo fg-one)", "background subshell plus foreground subshell"],
  ["backgroundlist", "(sleep 4; echo bg-four) & sleep 1; echo fg-one", "background subshell plus foreground simple list"],
  ["pipewhile", "printf '1\\n2\\n' | while read -r line; do echo \"hello $line\"; done", "pipeline into a foreground while loop"],
  ["backtrue", "v=`true`; printf \"[%s]\" \"$v\"", "backtick, builtin child, no output"],
  ["backtick", 'v=`echo hi`; printf "[%s]" "$v"', "backtick, builtin child, output"],
  ["backext", "v=`cat /work/repo/x`; printf \"[%s]\" \"$v\"", "backtick, external child"],
  ["extsub", 'v=$(cat /work/repo/x); printf "[%s]" "$v"', "substitution, external child"],
  ["substwrite", '$(touch /work/repo/substwrite.txt); printf "done"', "did the substituted child run at all?"],
  ["redirin", 'printf "[%s]" "$(< /work/repo/x)"', "the $(<file) special case"],
];
const CASE_FILTER = new Set((process.env.RIFF_P8_CASES ?? "").split(",").filter(Boolean));
const CASES = CASE_FILTER.size === 0
  ? ALL_CASES
  : ALL_CASES.filter(([label]) => CASE_FILTER.has(label));

// Shell options tried before `$(...)` in a fresh shell, looking for one that
// avoids whatever path is broken. Job control is the first suspect: it is the
// obvious difference between a forked child that the parent waits on and one
// it does not, and this session has no use for it anyway (P4 already ruled out
// interrupting a live WASIX process).
const OPTION_CASES = [
  ["aliastrue", "alias true=:", 'v=$(true); printf "[%s]" "$v"'],
  ["nojobs", "set +m", 'v=$(echo hi); printf "[%s]" "$v"'],
  ["posix", "set -o posix", 'v=$(echo hi); printf "[%s]" "$v"'],
  ["spaced", "true", 'v=$( echo hi ); printf "[%s]" "$v"'],
];

// The same constructs fed to a non-interactive bash as a script on stdin.
// S1 (an agent driving `bash -c`) never touches the interactive path, so this
// decides whether the hang is a Phase 4 problem or a project-wide one.
const SCRIPT = [
  'printf "P8N_START\\n"',
  'v=`echo hi`; printf "P8N_BACKTICK=[%s]\\n" "$v"',
  'v=$(true); printf "P8N_TRUE=[%s]\\n" "$v"',
  'v=$(printf ""); printf "P8N_EMPTY=[%s]\\n" "$v"',
  'v=$(printf "\\n"); printf "P8N_NEWLINE=[%s]\\n" "$v"',
  'v=$(touch /work/repo/script-touch.txt); printf "P8N_TOUCH=[%s]\\n" "$v"',
  'v=$(echo hi); printf "P8N_DOLLAR=[%s]\\n" "$v"',
  'v=$(cat /work/repo/x); printf "P8N_EXT=[%s]\\n" "$v"',
  'v=$(echo "$(echo deep)"); printf "P8N_NESTED=[%s]\\n" "$v"',
  'v=$(echo "$(cat /work/repo/x)"); printf "P8N_NESTED_EXT=[%s]\\n" "$v"',
  'printf "P8N_END\\n"',
  "",
].join("\n");

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("[P8]")) console.log(text);
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async ({ bash, cases, script, optionCases, phases }) => {
    const [{ ClaudePodController }, { WasixSession }] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasixSession.ts"),
    ]);
    const controller = new ClaudePodController(
      { baseUrl: "https://api.anthropic.com", token: "unused", repo: "" },
      () => {},
    );
    await controller.boot();
    await controller.pod.fs.writeFile("/work/repo/x", "before-value\n");

    const strip = (text) => text.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

    // Phase A — the same constructs, non-interactively.
    let nonInteractive = { skipped: true };
    if (phases.includes("script")) {
      const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
      const seen = [];
      try {
        const controllerAbort = new AbortController();
        const timer = setTimeout(() => controllerAbort.abort(), 60_000);
        try {
          const value = await session.run(bash, [], {
            stdinBytes: new TextEncoder().encode(script),
            signal: controllerAbort.signal,
            onOutput: (_stream, chunk) => seen.push(new TextDecoder().decode(chunk)),
          });
          nonInteractive = { code: value.code, output: strip(seen.join("")).trim() };
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        nonInteractive = { aborted: String(error), output: strip(seen.join("")).trim() };
      } finally {
        await session.dispose().catch(() => {});
      }
      console.log(`[P8] ${JSON.stringify({ label: "non-interactive", ...nonInteractive })}`);
    }

    async function openShell() {
      const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
      const output = [];
      let announce;
      const ready = new Promise((resolve) => { announce = resolve; });
      session.run(bash, [], {
        onOutput: (_stream, chunk) => output.push(new TextDecoder().decode(chunk)),
        onReady: (send) => announce(send),
      }).catch(() => {});
      const stdin = await Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Bash did not expose live stdin")), 60_000)),
      ]);
      return { session, stdin, all: () => strip(output.join("")) };
    }

    async function runCase(shell, label, cmdline, timeoutMs) {
      const tag = label.toUpperCase();
      const begin = `__P8B_${tag}__`;
      const end = `__P8E_${tag}__`;
      const start = shell.all().length;
      const line = `printf "%s_%s__\\n" "__P8B" "${tag}"; ${cmdline}; printf "%s_%s__%s\\n" "__P8E" "${tag}" "$?"\r`;
      const written = await Promise.race([
        shell.stdin(new TextEncoder().encode(line)).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      if (!written) return { label, hung: true, stdinStalled: true };

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = shell.all().slice(start);
        const from = text.indexOf(begin);
        const to = from === -1 ? -1 : text.indexOf(end, from + begin.length);
        if (to !== -1) {
          const status = /^\d+/.exec(text.slice(to + end.length));
          return {
            label,
            status: status === null ? "?" : status[0],
            body: text.slice(from + begin.length, to).replace(/\r/g, "").trim(),
          };
        }
        if (Date.now() >= deadline) {
          return { label, hung: true, reachedCommand: from !== -1 };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    const results = [];
    let index = phases.includes("bisect") ? 0 : cases.length;
    let shell = null;
    let restarts = 0;
    try {
      while (index < cases.length) {
        if (shell === null) {
          shell = await openShell();
          restarts += 1;
        }
        const [label, cmdline, note] = cases[index];
        const started = Date.now();
        const entry = { note, command: cmdline, ...(await runCase(shell, label, cmdline, 15_000)) };
        entry.ms = Date.now() - started;

        if (entry.hung) {
          await shell.session.dispose().catch(() => {});
          shell = null;
        }

        console.log(`[P8] ${JSON.stringify(entry)}`);
        results.push(entry);
        index += 1;
      }
      // Phase C — each option gets a clean shell, since a hang is terminal.
      const options = [];
      for (const [label, setup, cmdline] of phases.includes("options") ? optionCases : []) {
        const fresh = await openShell();
        try {
          const prepared = await runCase(fresh, `${label}setup`, setup, 15_000);
          const entry = { label, setup, command: cmdline, setupOk: !prepared.hung, ...(await runCase(fresh, label, cmdline, 15_000)) };
          console.log(`[P8] ${JSON.stringify(entry)}`);
          options.push(entry);
        } finally {
          await fresh.session.dispose().catch(() => {});
        }
      }

      return { results, restarts, nonInteractive, options };
    } finally {
      await shell?.session.dispose().catch(() => {});
      await controller.dispose();
    }
  }, { bash: BASH, cases: CASES, script: SCRIPT, optionCases: OPTION_CASES, phases: PHASES });

  console.log(`\n--- P8 non-interactive ${SPECIFIER} (uses: ${JSON.stringify(BASH.uses)}) ---`);
  console.log(JSON.stringify(result.nonInteractive, null, 2));

  console.log(`\n--- P8: what hangs a live WASIX bash (${result.restarts} shell(s)) ---`);
  for (const entry of result.results) {
    const status = entry.hung ? "HUNG" : entry.status;
    console.log(`${entry.label.padEnd(14)} ${String(status).padEnd(5)} ${entry.note.padEnd(48)} ${JSON.stringify(entry.body ?? "")}`);
  }
  console.log("\n--- P8: does any shell option avoid it? ---");
  for (const entry of result.options) {
    console.log(`${entry.label.padEnd(14)} ${(entry.hung ? "HUNG" : entry.status).padEnd(5)} after ${JSON.stringify(entry.setup).padEnd(16)} ${JSON.stringify(entry.body ?? "")}`);
  }
  if (errors.length > 0) {
    const unexpected = errors.filter((error) => !error.includes("Unable to initialize the context and store"));
    if (unexpected.length > 0) console.log(`\nbrowser errors: ${JSON.stringify(unexpected)}`);
  }

  if (result.results.length > 0) {
    const byLabel = Object.fromEntries(result.results.map((entry) => [entry.label, entry]));
    if (byLabel.readredir) assert.ok(!byLabel.readredir.hung, "A redirect with no fork hung; the shell is unusable, not just fork-limited");
    if (byLabel.pipeext) assert.equal(byLabel.pipeext.status, "0", "An external pipeline stopped working");
    if (byLabel.backtick) assert.equal(byLabel.backtick.status, "0", "Backtick substitution stopped working");
    if (byLabel.backgroundsub) assert.ok(byLabel.backgroundsub.ms < 2_500, `Foreground subshell waited for a background child (${byLabel.backgroundsub.ms}ms)`);
    if (byLabel.backgroundlist) assert.ok(byLabel.backgroundlist.ms < 2_500, `Foreground list waited for a background child (${byLabel.backgroundlist.ms}ms)`);
    if (SPECIFIER === "sharrattj/bash@1.0.18") {
      if (byLabel.echosub) assert.ok(byLabel.echosub.hung, "$(...) completed; the P8 record needs updating");
    } else {
      if (byLabel.truesub) assert.ok(byLabel.truesub.hung, "Bare interactive $(true) completed; remove the bashrc workaround");
      if (byLabel.echosub) assert.equal(byLabel.echosub.status, "0", "$(...) command substitution did not complete");
    }
  }
  if (result.options.length > 0 && SPECIFIER === "wasmer/bash@1.0.25") {
    const byLabel = Object.fromEntries(result.options.map((entry) => [entry.label, entry]));
    assert.equal(byLabel.aliastrue.setupOk, true, "Could not install the interactive true alias");
    assert.equal(byLabel.aliastrue.status, "0", "The interactive true alias did not avoid the hang");
  }
} finally {
  await browser.close();
}
