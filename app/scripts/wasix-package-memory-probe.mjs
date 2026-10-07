// Measures the intended package lifetimes: Bash remains parsed in the WASIX
// session worker, while Python runs in the existing disposable command worker.
// This deliberately does not invoke Python from Bash; that bridge does not yet
// exist. `measureUserAgentSpecificMemory()` includes same-origin workers when
// Chromium exposes it. The performance.memory fallback covers only this page's
// JavaScript isolate and is reported as such rather than treated as a total.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const repeats = Number(process.env.RIFF_PYTHON_TRIALS ?? 3);
if (!Number.isInteger(repeats) || repeats < 2) {
  throw new Error(`RIFF_PYTHON_TRIALS must be an integer >= 2, got ${repeats}`);
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--enable-precise-memory-info"],
});

async function chromiumRssBytes(rootPid) {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const processes = new Map();
  await Promise.all(pids.map(async (name) => {
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      processes.set(Number(name), { parent: Number(fields[1]), rssPages: Number(fields[21]) });
    } catch {
      // The process exited between readdir and readFile.
    }
  }));
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, process] of processes) {
      if (!included.has(pid) && included.has(process.parent)) {
        included.add(pid);
        changed = true;
      }
    }
  }
  return [...included].reduce((total, pid) => total + (processes.get(pid)?.rssPages ?? 0) * 4096, 0);
}

try {
  const page = await browser.newPage();
  let phase = "startup";
  const processSamples = new Map();
  const sampleProcessMemory = async (samplePhase = phase) => {
    const bytes = await chromiumRssBytes(browser.process().pid);
    const samples = processSamples.get(samplePhase) ?? [];
    samples.push(bytes);
    processSamples.set(samplePhase, samples);
    return bytes;
  };
  await page.exposeFunction("__riffMemoryMark", async (nextPhase) => {
    phase = nextPhase;
    return sampleProcessMemory(nextPhase);
  });
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      await sampleProcessMemory();
      await sleep(50);
    }
  })();
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  const result = await page.evaluate(async (repeats) => {
    const [{ ClaudePodController, INTERACTIVE_BASH }, { WasixSession }, { createRiffWasmerProvider }] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasixSession.ts"),
      import("/src/wasmerCommandProvider.ts"),
    ]);
    const memory = async () => {
      const detailed = performance.measureUserAgentSpecificMemory;
      if (typeof detailed === "function") {
        return { bytes: (await detailed.call(performance)).bytes, scope: "page and same-origin workers" };
      }
      return {
        bytes: performance.memory?.usedJSHeapSize ?? null,
        scope: "page JavaScript isolate only",
      };
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {});
    await controller.boot();
    const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
    const provider = await createRiffWasmerProvider(controller.pod.volume);
    try {
      await globalThis.__riffMemoryMark("baseline");
      await sleep(500);
      const baseline = await memory();
      await globalThis.__riffMemoryMark("bash-load");
      const firstBash = await session.run(INTERACTIVE_BASH, ["-c", "exit 0"]);
      const secondBash = await session.run(INTERACTIVE_BASH, ["-c", "exit 0"]);
      await globalThis.__riffMemoryMark("bash-resident");
      await sleep(500);
      const bashResident = await memory();
      const python = [];
      for (let trial = 1; trial <= repeats; trial += 1) {
        await globalThis.__riffMemoryMark(`python-${trial}`);
        const output = await provider.run("python", ["-c", `print('python-${trial}')`]);
        await globalThis.__riffMemoryMark(`python-${trial}-after`);
        await sleep(1_000);
        const after = await memory();
        python.push({
          trial,
          code: output.code,
          stdout: new TextDecoder().decode(output.stdout).trim(),
          afterBytes: after.bytes,
          packageMs: output.diagnostics.packageMs,
          loadMs: output.diagnostics.loadMs,
        });
      }
      return {
        baseline,
        bashResident,
        firstBash: firstBash.timings,
        secondBash: secondBash.timings,
        python,
      };
    } finally {
      await provider.dispose();
      await session.dispose();
      await controller.dispose();
    }
  }, repeats);
  sampling = false;
  await sampler;

  const browserProcessMemory = Object.fromEntries([...processSamples].map(([name, samples]) => [name, {
    minBytes: Math.min(...samples),
    maxBytes: Math.max(...samples),
    lastBytes: samples.at(-1),
    samples: samples.length,
  }]));

  assert.equal(result.firstBash.packageCached, false);
  assert.equal(result.secondBash.packageCached, true);
  assert.ok(result.python.every((run) => run.code === 0 && run.stdout === `python-${run.trial}`));
  console.log(JSON.stringify({ ...result, browserProcessMemory }, null, 2));
  console.log(`Memory scope: ${result.baseline.scope}. Bash remained live while Python used separate disposable workers.`);
} finally {
  await browser.close();
}
