import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

// RIFF_S1_ITERATIONS scales §1.1 step 4 beyond the core three iterations for
// watcher, git, and memory-growth coverage.
const ITERATIONS = Math.max(1, Number.parseInt(process.env.RIFF_S1_ITERATIONS ?? "3", 10));

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) {
      pageErrors.push(String(error));
    }
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const report = await page.evaluate(async (iterationCount) => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");

    const [
      { ClaudePodController, INTERACTIVE_BASH, createBridgeHostHandler },
      { WasixSession },
      { Osc133Parser },
      { bridgeServeAll, sessionBridge },
    ] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasixSession.ts"),
      import("/src/osc133.ts"),
      import("/src/wasixBridge.ts"),
    ]);

    const root = "/work/repo";
    const sourcePath = `${root}/s1-source.txt`;
    const serverPath = `${root}/s1-dev-server.cjs`;
    const serverPort = 4326;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const withTimeout = async (promise, ms, label) => {
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${label}`)), ms);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    };

    const serverSource = [
      "const fs = require('fs');",
      "const http = require('http');",
      `const source = ${JSON.stringify(sourcePath)};`,
      "let value = fs.readFileSync(source, 'utf8');",
      "let generation = 0;",
      "fs.watch(source, () => {",
      "  value = fs.readFileSync(source, 'utf8');",
      "  generation += 1;",
      "  console.log('S1_WATCH ' + generation + ' ' + value);",
      "});",
      "http.createServer((request, response) => {",
      "  response.setHeader('content-type', 'application/json');",
      "  response.end(JSON.stringify({ value, generation }));",
      `}).listen(${serverPort}, () => console.log('S1_DEV_READY'));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n");

    const controller = new ClaudePodController(
      { baseUrl: "https://api.anthropic.com", token: "unused", repo: "" },
      () => {},
    );
    const startedAt = Date.now();
    let session = null;
    let shell = null;
    let shellExited = false;
    let writeStdin = null;
    const bridgeErrors = [];
    const bridgeStatuses = [];

    try {
      await controller.boot();
      await controller.pod.fs.writeFile(sourcePath, "initial-source\n");
      await controller.pod.fs.writeFile(serverPath, serverSource);

      session = await WasixSession.open({
        volume: controller.pod.volume,
        root,
        cols: 80,
        rows: 24,
      });
      const stubBytes = new Uint8Array(
        await (await fetch("/src/assets/wasmer/bridge-stub.wasm")).arrayBuffer(),
      );
      const bridge = await session.installBridge(new Map([
        ["node", stubBytes],
        ["npm", stubBytes],
        ["git", stubBytes],
      ]));
      const handler = createBridgeHostHandler(controller.pod, (status) => {
        bridgeStatuses.push(status);
      });
      void bridgeServeAll(sessionBridge(session), handler).catch((error) => {
        bridgeErrors.push(`bridge: ${String(error)}`);
      });

      const interactive = await session.installInteractiveBash();
      const parsers = { stdout: new Osc133Parser(), stderr: new Osc133Parser() };
      const seen = { A: 0, B: 0, C: 0, D: 0 };
      let terminal = "";
      shell = session.run(INTERACTIVE_BASH, interactive.args, {
        cwd: root,
        env: {
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          ...bridge.pipeEnv,
          PATH: `${bridge.pathEntry}:/usr/local/bin:/bin:/usr/bin`,
        },
        onReady: (write) => {
          writeStdin = write;
        },
        onOutput: (stream, chunk) => {
          const parser = parsers[stream];
          if (parser !== undefined) {
            for (const event of parser.push(chunk)) seen[event.code] += 1;
          }
          terminal += decoder.decode(chunk, { stream: true });
        },
      });
      void shell.then(
        () => { shellExited = true; },
        () => { shellExited = true; },
      );

      const waitFor = async (predicate, ms, label) => {
        const deadline = Date.now() + ms;
        for (;;) {
          if (predicate()) return;
          if (shellExited) throw new Error(`Bash exited while waiting for ${label}`);
          if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${label}`);
          await sleep(50);
        }
      };
      await waitFor(() => writeStdin !== null && seen.B >= 1, 180_000, "the first Bash prompt");

      const runCommand = async (line, label) => {
        if (writeStdin === null) throw new Error("Bash did not expose live stdin");
        const beforeC = seen.C;
        const beforeD = seen.D;
        const terminalStart = terminal.length;
        await writeStdin(encoder.encode(`${line}\n`));
        await waitFor(() => seen.C > beforeC, `${label} to start`);
        await waitFor(() => seen.D > beforeD, `${label} to finish`);
        await sleep(400);
        return terminal.slice(terminalStart);
      };

      const requestServer = async () => {
        const response = await controller.pod.request(serverPort, { path: "/" });
        return JSON.parse(decoder.decode(response.body));
      };
      const waitForServer = async (predicate, label) => {
        let lastError = null;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            const response = await requestServer();
            if (predicate(response)) return response;
          } catch (error) {
            lastError = error;
          }
          await sleep(100);
        }
        throw new Error(`Timed out waiting for ${label}: ${String(lastError ?? "no matching response")}`);
      };

      // Start the real server as a background bridged `node` process. The
      // server's fs.watch callback is the dev-server side of this acceptance.
      await runCommand("node /work/repo/s1-dev-server.cjs &", "background dev server");
      const initial = await waitForServer(
        (response) => response.value === "initial-source\n" && response.generation === 0,
        "the dev server",
      );

      // Duration-leg instrumentation. performance.memory exists in Chromium.
      const heapMb = () => (performance.memory === undefined ? null : Math.round(performance.memory.usedJSHeapSize / 1048576));
      const heapSamples = [{ at: "session-open", mb: heapMb() }];

      const iterations = [];
      for (let index = 1; index <= iterationCount; index += 1) {
        const sourceValue = `wasix-source-${index}\n`;
        await runCommand(
          `printf '%s\\n' ${sourceValue.trim()} | tee s1-source.txt > /dev/null`,
          `WASIX source edit ${index}`,
        );
        const served = await waitForServer(
          (response) => response.value === sourceValue && response.generation >= index,
          `the dev server watcher after WASIX edit ${index}`,
        );

        const hostValue = `host-file-${index}`;
        const hostPath = `${root}/s1-host-${index}.txt`;
        await controller.pod.fs.writeFile(hostPath, `${hostValue}\n`);
        const output = await runCommand(`cat s1-host-${index}.txt`, `host file read ${index}`);
        iterations.push({
          index,
          servedGeneration: served.generation,
          hostVisibleInWasix: output.includes(hostValue),
        });
        heapSamples.push({ at: `iteration-${index}`, mb: heapMb() });
      }

      const hostFiles = Array.from(
        { length: iterationCount },
        (_, index) => `s1-host-${index + 1}.txt`,
      );

      await runCommand(
        `git init -q && git config user.email s1@example.test && git config user.name S1 && git add s1-source.txt ${hostFiles.join(" ")} && git commit -q -m s1-acceptance`,
        "bridged git commit",
      );
      const gitProcess = await controller.pod.spawn(
        "git",
        ["show", "--format=", "--name-only", "HEAD"],
        { cwd: root },
      );
      const gitCompletion = await gitProcess.completion;

      const beforeInterrupt = await requestServer();
      if (writeStdin === null) throw new Error("Bash stdin disappeared before Ctrl-C");
      const beforeB = seen.B;
      const beforeC = seen.C;
      await writeStdin(encoder.encode("sleep 30\n"));
      await waitFor(() => seen.C > beforeC, "foreground sleep to start");
      await sleep(1_000);
      await writeStdin(Uint8Array.of(3));
      await waitFor(() => seen.B > beforeB, "the Bash prompt after Ctrl-C");
      const afterInterrupt = await waitForServer(
        (response) => response.value === beforeInterrupt.value && response.generation === beforeInterrupt.generation,
        "the dev server after Ctrl-C",
      );
      const shellSurvivedInterrupt = !shellExited;

      await writeStdin(encoder.encode("exit\n"));
      await withTimeout(shell, 30_000, "Bash teardown");

      const processManager = controller.pod.processManager;
      const processesBeforeDispose = processManager._processes.size;
      await session.dispose();
      session = null;
      await controller.dispose();
      const processesAfterDispose = processManager._processes.size;

      heapSamples.push({ at: "pre-dispose", mb: heapMb() });
      const promptCompletions = seen.D;
      const distinctPids = [...new Set(
        bridgeStatuses
          .map((status) => /pid=(\d+)/.exec(status)?.[1])
          .filter((pid) => pid !== undefined),
      )];

      return {
        iterationCount,
        iterations,
        initial,
        git: {
          exitCode: gitCompletion.exitCode,
          stdout: gitCompletion.stdout,
          stderr: gitCompletion.stderr,
        },
        interrupt: {
          before: beforeInterrupt,
          after: afterInterrupt,
          shellSurvived: shellSurvivedInterrupt,
        },
        duration: {
          wallMs: Date.now() - startedAt,
          heapSamples,
          distinctBridgedPids: distinctPids.length,
          promptCompletions,
        },
        bridgeStatuses,
        bridgeErrors,
        processesBeforeDispose,
        processesAfterDispose,
      };
    } finally {
      if (shell !== null && !shellExited) {
        try {
          writeStdin?.(encoder.encode("exit\n"));
        } catch {
          // Session disposal below is the fallback for an unresponsive shell.
        }
      }
      try {
        await session?.dispose();
      } catch {
        // A live WASIX process uses the documented worker-teardown fallback.
      }
      await controller.dispose();
    }
  }, ITERATIONS);

  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.initial.value, "initial-source\n");
  assert.equal(report.initial.generation, 0);
  assert.equal(report.iterations.length, report.iterationCount);
  const heaps = report.duration.heapSamples.filter((sample) => sample.mb !== null).map((sample) => sample.mb);
  if (heaps.length > 0) {
    const growth = heaps[heaps.length - 1] - heaps[0];
    assert.ok(
      growth < 256,
      `JS heap grew ${growth} MB across the run; possible runtime accumulation`,
    );
  }
  for (const iteration of report.iterations) {
    assert.ok(iteration.servedGeneration >= iteration.index, `iteration ${iteration.index}: watcher generation lagged`);
    assert.equal(iteration.hostVisibleInWasix, true, `WASIX could not read host-file-${iteration.index}.txt`);
  }
  assert.equal(report.git.exitCode, 0, report.git.stderr || report.git.stdout);
  for (let index = 1; index <= report.iterationCount; index += 1) {
    const path = `s1-host-${index}.txt`;
    assert.ok(report.git.stdout.includes(path), `git commit did not contain ${path}`);
  }
  assert.ok(report.git.stdout.includes("s1-source.txt"), "git commit did not contain s1-source.txt");
  assert.equal(report.interrupt.shellSurvived, true, "Ctrl-C did not return to the same Bash session");
  assert.deepEqual(report.interrupt.after, report.interrupt.before, "the dev server changed while Ctrl-C was handled");
  assert.deepEqual(report.bridgeErrors, []);
  assert.ok(report.bridgeStatuses.some((status) => status.includes("node /work/repo/s1-dev-server.cjs")));
  assert.ok(report.processesBeforeDispose > 0, "the background dev server was not alive before teardown");
  assert.equal(report.processesAfterDispose, 0, "Nodepod processes leaked after teardown");
  assert.deepEqual(pageErrors, []);
  console.log("S1 acceptance: bridged dev server, mixed filesystem authorship, git commit, Ctrl-C, and teardown passed.");
} finally {
  await browser.close();
}
