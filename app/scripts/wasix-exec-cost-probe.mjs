// Measures where a WASIX exec's wall time goes. SESSION_STALL_PLAN §6.
//
// The question: Claude Code issues one `bash -c` per Bash tool call, and each
// one calls `command.run` with seven `uses:` registry packages. The root Bash
// package is retained by the session; registry dependency bytes are cached by
// package_loader.rs, keyed by webc_sha256.
// Compilation is cached by a *thread-local* cache (runtime.rs), which only hits
// when the scheduler reuses the same pool worker.
//
// So the thing to look for is not the mean. It is:
//
//   * Does `runMs` stay large in steady state? If yes, the composed toolset is
//     being redone per call and the fix is a session-lifetime package (or a
//     pre-composed webc), not a warmer cache.
//   * Is `runMs` bimodal across trials? A fast/slow split with little in
//     between is the signature of thread-local cache hits and misses, i.e. the
//     cache is right but its scope is wrong -- it should be shared and
//     hash-keyed, since WebAssembly.Module is structured-cloneable.
//   * Does `runMs` differ between shapes? `noop` never invokes a composed tool;
//     `tool` does. A gap means packages are compiled on first use rather than
//     at resolution, which changes which fix helps.
//
// This probe cannot see pool thread identity directly -- that needs a fork
// change. Bimodality is the inference available without one, which is why the
// per-trial numbers are printed rather than just a summary.
//
//   RIFF_TRIALS=12      trials per shape (default 12)
//   RIFF_SHAPE=noop     `bash -c 'exit 0'`, pure per-exec overhead
//   RIFF_SHAPE=tool     `bash -c 'ls -la ... >/dev/null'`, uses coreutils
//   RIFF_SHAPE=both     default
//
// Trial 1 of each shape is reported separately and excluded from the summary:
// it pays for whatever the session open did not, and averaging it in hides the
// steady state, which is the number that decides the fix.
import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const trials = Number(process.env.RIFF_TRIALS ?? 12);
const shape = process.env.RIFF_SHAPE ?? "both";
if (!["noop", "tool", "both"].includes(shape)) throw new Error(`RIFF_SHAPE must be noop|tool|both, got ${shape}`);
if (!Number.isInteger(trials) || trials < 2) throw new Error(`RIFF_TRIALS must be an integer >= 2, got ${trials}`);
const shapes = shape === "both" ? ["noop", "tool"] : [shape];

const ms = (value) => `${value.toFixed(1).padStart(8)}`;

/** Median, p90 and spread. Mean hides bimodality, which is the point here. */
function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0], median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

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
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async ({ trials, shapes }) => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const { ClaudePodController, INTERACTIVE_BASH } = await import("/src/claudePod.ts");
    const { WasixSession } = await import("/src/wasixSession.ts");

    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
      githubToken: "",
    }, () => {});
    await controller.boot();

    // Session open is a one-off cost and is reported separately: it is not
    // per-exec, so folding it into trial 1 would misattribute it.
    const openedAt = performance.now();
    const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
    const openMs = performance.now() - openedAt;

    // Deliberately not claudePod's wasixBaseEnv: no bridge is installed here,
    // and `uses:` resolution is a property of the command, not the env. PATH
    // still has to reach the composed tools for the `tool` shape.
    const env = {
      TERM: "xterm-256color",
      PATH: "/usr/local/bin:/bin:/usr/bin",
    };
    const script = {
      noop: "exit 0",
      tool: "ls -la /work/repo > /dev/null",
    };

    const runs = [];
    for (const shape of shapes) {
      for (let trial = 1; trial <= trials; trial++) {
        const startedAt = performance.now();
        const output = await session.run(INTERACTIVE_BASH, ["-c", script[shape]], {
          cwd: "/work/repo",
          env,
        });
        const totalMs = performance.now() - startedAt;
        runs.push({
          shape,
          trial,
          code: output.code,
          totalMs,
          ...(output.timings ?? {}),
        });
      }
    }
    return { openMs, runs };
  }, { trials, shapes });

  if (errors.length > 0) {
    console.error("page errors:");
    for (const error of errors) console.error(`  ${error}`);
  }

  console.log(`session open: ${result.openMs.toFixed(1)} ms (one-off, not per-exec)\n`);
  console.log("shape  trial  code    total     fetch      load       run      wait     drain   package    outcome");
  console.log("-".repeat(103));
  for (const run of result.runs) {
    console.log(
      `${run.shape.padEnd(6)}${String(run.trial).padStart(5)}  ${String(run.code).padStart(4)}`
      + `${ms(run.totalMs)}${ms(run.fetchMs)}${ms(run.loadMs)}${ms(run.runMs)}${ms(run.waitMs)}`
      + `${ms(run.drainMs)}${(run.packageCached ? "cached" : "loaded").padStart(10)}`
      + `${(run.drained ? "  eof" : "  TIMEOUT").padStart(10)}`,
    );
  }

  assert.ok(result.runs.every((run) => run.code === 0), "a probe command failed");
  assert.ok(result.runs.every((run) => run.drained), "a probe command did not reach stream EOF");
  assert.ok(result.runs.filter((run) => run.trial > 1).every((run) => run.packageCached),
    "a steady-state exec reparsed the retained Bash package");

  console.log("\nsteady state (trial 1 excluded)");
  console.log("shape  stage        min    median       p90       max");
  console.log("-".repeat(56));
  let verdict = [];
  for (const shape of shapes) {
    const steady = result.runs.filter((run) => run.shape === shape && run.trial > 1);
    for (const stage of ["totalMs", "loadMs", "runMs", "waitMs", "drainMs"]) {
      const stats = summarise(steady.map((run) => run[stage]));
      console.log(
        `${shape.padEnd(6)}${stage.replace(/Ms$/, "").padEnd(8)}`
        + `${ms(stats.min)}${ms(stats.median)}${ms(stats.p90)}${ms(stats.max)}`,
      );
    }
    const total = summarise(steady.map((r) => r.totalMs)).median;
    const share = (stage) => {
      const median = summarise(steady.map((r) => r[stage])).median;
      return `${stage.replace(/Ms$/, "")} ${median.toFixed(0)} ms (${((median / total) * 100).toFixed(0)}%)`;
    };
    verdict.push(
      `${shape}: of ${total.toFixed(0)} ms median, `
      + ["drainMs", "loadMs", "runMs", "waitMs"].map(share).join(", "),
    );
  }
  console.log("");
  for (const line of verdict) console.log(line);
} finally {
  await browser.close();
}
