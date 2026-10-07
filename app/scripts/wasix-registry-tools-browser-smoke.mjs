// Registry-tools composition probe (USABILITY_ROADMAP W4 route 1).
//
// Boots two sessions against the same workspace: one with the stock
// `wasmer/coreutils@1.0.25` uses-set, one with GNU grep/sed/find/tar/gzip/less
// composed on top. Measures first-run wall time and JS heap delta of the
// flagship `bash -c` run in each (package fetch+parse+instantiate dominates
// the first run), then asserts every composed tool actually works and that a
// `sed -i` write lands back in host-visible storage.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

// Byte-pinned interactive Bash (same pair claudePod.ts pins).
const BASH = {
  packageUrl: "/src/assets/wasmer/bash-1.0.25-riff.webc",
  packageSha256: "6bf621c2561b2d1f0f982fe6aea04f158c81d7e9b7378d8f7ee7f3543b6d3293",
  command: "bash",
  entrypoint: true,
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) errors.push(String(error));
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("panicked") || text.includes("RuntimeError")) console.log("[console]", msg.type(), text);
  });
  page.on("workercreated", (worker) => {
    worker.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("panicked") || text.includes("RuntimeError") || text.includes("Error")) console.log("[worker console]", msg.type(), text);
    });
    worker.on("error", (err) => console.log("[worker error]", String(err)));
  });

  const result = await page.evaluate(async (BASH) => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const [{ ClaudePodController }, { WasixSession }] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasixSession.ts"),
    ]);

    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {});
    await controller.boot();
    try {
      // Coreutils-only script (the baseline has no GNU tools).
      const baseScript = [
        "set -e",
        "printf 'alpha\\nwasix-line\\nbeta\\nwasix-again\\n' > /work/repo/tools-fixture.txt",
        "echo \"head-first: $(head -n 1 /work/repo/tools-fixture.txt)\"",
      ].join(" && ");
      const toolsScript = [
        "set -e",
        "rm -f /work/repo/tools-fixture.txt",
        "printf 'alpha\\nwasix-line\\nbeta\\nwasix-again\\n' > /work/repo/tools-fixture.txt",
        "echo \"grep-count: $(grep -c wasix /work/repo/tools-fixture.txt)\"",
        "sed -i 's/alpha/ALPHA/' /work/repo/tools-fixture.txt",
        "echo \"sed-first: $(head -n 1 /work/repo/tools-fixture.txt)\"",
        "mkdir -p /work/repo/tools-sub",
        // touch on an EXISTING file fails in stock uutils (filetime crate
        // stubs set_file_times out on wasm: "Wasm not implemented"), so only
        // create when absent — re-runs must stay green.
        "[ -e /work/repo/tools-sub/marker.txt ] || touch /work/repo/tools-sub/marker.txt",
        "echo \"find-count: $(find /work/repo -name 'tools-fixture.txt' | wc -l)\"",
        "echo \"tar: $(tar --version | head -n 1)\"",
        "echo \"gzip: $(gzip --version | head -n 1)\"",
        "echo \"less: $(less --version | head -n 1)\"",
        "echo \"coreutils-alive: $(ls /work/repo/tools-sub/marker.txt)\"",
      ].join(" && ");

      const heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

      const BASE_USES = ["wasmer/coreutils@1.0.25"];
      const TOOLS_USES = [
        ...BASE_USES,
        "wasmer/grep@3.12.0",
        "wasmer/sed@4.9.0",
        "wasmer/find@4.10.0",
        "wasmer/tar@1.35.0",
        "wasmer/gzip@1.14.0",
        "wasmer/less@685.0.1",
      ];

      async function timedRun(uses, script) {
        const session = await WasixSession.open({
          volume: controller.pod.volume,
          root: "/work/repo",
        });
        try {
          const t0 = Date.now();
          const heap0 = heap();
          const out = await session.run(
            { ...BASH, uses },
            ["-c", script],
            { cwd: "/work/repo", env: { TERM: "xterm-256color" } },
          );
          return {
            ms: Date.now() - t0,
            heapDeltaMb: heap() !== null && heap0 !== null ? heap() - heap0 : null,
            code: out.code,
            stdout: new TextDecoder().decode(out.stdout),
            stderr: new TextDecoder().decode(out.stderr),
          };
        } finally {
          await session.dispose();
        }
      }

      // Cold page: bash+coreutils fetch+parse dominate run 1. Run 2 adds only
      // the six tools (bash/coreutils now cached) — their incremental cold
      // cost. Run 3 is the steady state a long-lived session pays per spawn.
      const baselineCold = await timedRun(BASE_USES, baseScript);
      const toolsCold = await timedRun(TOOLS_USES, toolsScript);
      const toolsWarm = await timedRun(TOOLS_USES, toolsScript);

      let hostSeesSed;
      try {
        hostSeesSed = await controller.pod.fs.readFile("/work/repo/tools-fixture.txt", "utf8");
      } catch {
        hostSeesSed = null;
      }

      return { baselineCold, toolsCold, toolsWarm, hostSeesSed };
    } finally {
      await controller.dispose();
    }
  }, BASH);

  console.log(JSON.stringify(result, null, 2));

  const { baselineCold, toolsCold, toolsWarm, hostSeesSed } = result;
  assert.equal(baselineCold.code, 0, `baseline bash exited ${baselineCold.code}`);
  assert.equal(toolsCold.code, 0, `tools bash exited ${toolsCold.code}: ${toolsCold.stderr}`);
  assert.equal(toolsWarm.code, 0, `warm tools bash exited ${toolsWarm.code}: ${toolsWarm.stderr}`);

  // Functional: every composed tool answers correctly (checked on both runs).
  for (const run of [toolsCold, toolsWarm]) {
    assert.match(run.stdout, /grep-count: 2/);
    assert.match(run.stdout, /sed-first: ALPHA/);
    assert.match(run.stdout, /find-count: 1/);
    assert.match(run.stdout, /tar: tar \(GNU tar\)/);
    assert.match(run.stdout, /gzip: gzip [\d.]+/);
    assert.match(run.stdout, /less: less \d+/);
    assert.match(run.stdout, /coreutils-alive: \/work\/repo\/tools-sub\/marker\.txt/);
  }

  // Coherence: sed -i's rewrite is host-visible after the session ends.
  assert.equal(hostSeesSed, "ALPHA\nwasix-line\nbeta\nwasix-again\n");

  console.log(`timings ms: baseline-cold ${baselineCold.ms}, tools-cold(incremental) ${toolsCold.ms}, tools-warm ${toolsWarm.ms}; heap deltas MB: ${baselineCold.heapDeltaMb}/${toolsCold.heapDeltaMb}/${toolsWarm.heapDeltaMb}`);
  console.log("Registry tools: grep/sed/find/tar/gzip/less composed into WASIX bash, functional, coherent.");
} finally {
  await browser.close();
}
