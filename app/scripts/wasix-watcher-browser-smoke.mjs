// Does a detached Nodepod process observe a Bash-originated edit?
//
// This is S1's core loop: the agent edits a file in the WASIX shell and a dev
// server running as a Nodepod process rebuilds. Phase 4 recorded that the
// watcher did not fire, but probe P10 showed that Bash's writes were never
// reaching the workspace at all, so there was nothing to observe. With the path
// anchor fixed the question is finally answerable.
//
// The control matters as much as the case. A watcher that never fires for
// anything would make a negative WASIX result unattributable — the mistake this
// investigation has now made in three different forms.
//
//   control   host write via pod.fs      -> watcher must fire
//   case      direct shared-store write  -> watcher must fire
//
// Framing follows P10: OSC 133 `C`/`D` only (this Bash re-emits `A`/`B` on
// prompt redraws), and markers are assembled by printf at runtime so the
// command echo cannot contain them.

import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  protocolTimeout: 900_000,
});

try {
  const page = await browser.newPage();
  const browserMessages = [];
  page.on("console", (message) => {
    const text = `[${message.type()}] ${message.text()}`;
    browserMessages.push(text);
    if (message.text().startsWith("[W]")) console.log(text);
  });
  page.on("pageerror", (error) => {
    const text = String(error);
    if (!text.includes("ProcessExitSentinel: Process exited with code 0")) {
      browserMessages.push(`[pageerror] ${error.stack ?? error.message}`);
    }
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const report = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const [{ ClaudePodController, INTERACTIVE_BASH }, { WasixSession }, { Osc133Parser }] =
      await Promise.all([
        import("/src/claudePod.ts"),
        import("/src/wasixSession.ts"),
        import("/src/osc133.ts"),
      ]);

    const note = (message) => console.log(`[W] ${message}`);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const controller = new ClaudePodController(
      { baseUrl: "https://api.anthropic.com", token: "unused", repo: "" },
      () => {},
    );
    await controller.boot();

    const root = "/work/repo";
    const observations = [];
    let watcherOutput = "";
    let session = null;

    try {
      // The watcher lives outside the synced root so that its own existence
      // cannot perturb the tree it is watching.
      await controller.pod.fs.writeFile(
        "/opt/watch-probe.cjs",
        [
          "const fs = require('fs');",
          "const root = '/work/repo';",
          "try {",
          "  fs.watch(root, { recursive: true }, (event, filename) => {",
          "    console.log('EVENT ' + event + ' ' + filename + ' ' + Date.now());",
          "  });",
          "  console.log('READY');",
          "} catch (error) {",
          "  console.log('WATCH-FAILED ' + error.message);",
          "}",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );

      const watcher = await controller.pod.spawn("node", ["/opt/watch-probe.cjs"], { cwd: root });
      const collect = (chunk) => {
        watcherOutput += String(chunk);
        for (const line of String(chunk).split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("EVENT ") || trimmed.startsWith("READY") || trimmed.startsWith("WATCH-FAILED")) {
            observations.push({ line: trimmed, at: Date.now() });
          }
        }
      };
      watcher.on("output", collect);
      watcher.on("error", collect);

      const waitForWatcher = async (predicate, ms, label) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (predicate()) return true;
          await sleep(50);
        }
        return false;
      };

      const started = await waitForWatcher(
        () => observations.some((item) => item.line === "READY" || item.line.startsWith("WATCH-FAILED")),
        30_000,
        "the watcher to start",
      );
      const watchSupported = observations.some((item) => item.line === "READY");
      note(`watcher started=${started} supported=${watchSupported}`);

      // --- Control: a host write must be observed ---------------------------
      const controlBefore = observations.length;
      const controlAt = Date.now();
      await controller.pod.fs.writeFile(`${root}/host-touched.txt`, "host-touched\n");
      const controlSeen = await waitForWatcher(
        () => observations.slice(controlBefore).some((item) => item.line.includes("host-touched")),
        15_000,
        "the control event",
      );
      const controlLatency = controlSeen
        ? observations.slice(controlBefore).find((item) => item.line.includes("host-touched")).at - controlAt
        : null;
      note(`control observed=${controlSeen} latency=${controlLatency}`);

      // --- Case: a Bash write observed from the shared store ----------------
      session = await WasixSession.open({ volume: controller.pod.volume, root, cols: 80, rows: 24 });
      const interactive = await session.installInteractiveBash();

      const decoder = new TextDecoder();
      const parsers = { stdout: new Osc133Parser(), stderr: new Osc133Parser() };
      const seen = { A: 0, B: 0, C: 0, D: 0 };
      let terminal = "";
      let write = null;
      let shellExited = false;

      const shell = session.run(INTERACTIVE_BASH, interactive.args, {
        cwd: root,
        env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
        onReady: (writer) => {
          write = writer;
        },
        onOutput: (stream, chunk) => {
          const parser = parsers[stream];
          if (parser !== undefined) for (const event of parser.push(chunk)) seen[event.code] += 1;
          terminal += decoder.decode(chunk, { stream: true });
        },
      });
      void shell.then(() => {
        shellExited = true;
      }, () => {
        shellExited = true;
      });

      const waitFor = async (predicate, ms, label) => {
        const deadline = Date.now() + ms;
        for (;;) {
          if (predicate()) return true;
          if (shellExited) throw new Error(`Bash exited while waiting for ${label}`);
          if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${label}`);
          await sleep(50);
        }
      };

      note("waiting for the first Bash prompt");
      await waitFor(() => write !== null && seen.B >= 1, 180_000, "the first Bash prompt");

      const caseBefore = observations.length;
      const caseAt = Date.now();
      const beforeC = seen.C;
      const beforeD = seen.D;
      await write(new TextEncoder().encode("printf bash-touched > bash-touched.txt\n"));
      await waitFor(() => seen.C > beforeC, 60_000, "the Bash write to start");
      await waitFor(() => seen.D > beforeD, 60_000, "the Bash write to finish");
      const promptAt = Date.now();

      // The MemoryVolume generation observer turns the guest-side mutation
      // into the same watcher event used by Nodepod's process bridge.
      const caseSeen = await waitForWatcher(
        () => observations.slice(caseBefore).some((item) => item.line.includes("bash-touched")),
        20_000,
        "the Bash-originated event",
      );
      const caseEvent = observations.slice(caseBefore).find((item) => item.line.includes("bash-touched"));
      note(`case observed=${caseSeen}`);

      // Did the write reach the host at all? Separates visibility from watcher
      // notification if this regression ever returns.
      const onHost = controller.pod.volume.existsSync(`${root}/bash-touched.txt`);

      // --- Lapse: an overwritten content event is recovered exactly --------
      const lapsePath = `${root}/lapse-touched.txt`;
      await controller.pod.fs.writeFile(lapsePath, "same-size\n");
      await waitForWatcher(
        () => observations.some((item) => item.line.includes("lapse-touched")),
        15_000,
        "the lapse seed event",
      );
      await sleep(100);
      const lapseBefore = observations.filter((item) => item.line.includes("lapse-touched")).length;
      const sharedStore = controller.pod.volume.sharedStore;
      if (!sharedStore) throw new Error("The Nodepod volume has no shared store");
      const eventBytes = Math.max(4096, Math.ceil(sharedStore.byteLength / 512 / 8) * 8);
      const mutationCount = Math.ceil(eventBytes / 16) + 8;
      const lapseAt = Date.now();
      for (let index = 0; index < mutationCount; index += 1) {
        sharedStore.chmod(lapsePath, index % 2 === 0 ? 0o600 : 0o644, true);
      }
      const lapseSeen = await waitForWatcher(
        () => observations.filter((item) => item.line.includes("lapse-touched")).length > lapseBefore,
        20_000,
        "the lapsed content event",
      );
      const lapseEvent = observations
        .filter((item) => item.line.includes("lapse-touched"))
        .at(lapseBefore);
      note(`lapse observed=${lapseSeen} mutations=${mutationCount}`);

      return {
        watchSupported,
        control: { observed: controlSeen, latencyMs: controlLatency },
        case: {
          observed: caseSeen,
          latencyFromCommandMs: caseEvent ? caseEvent.at - caseAt : null,
          latencyFromPromptMs: caseEvent ? caseEvent.at - promptAt : null,
          onHost,
        },
        lapse: {
          observed: lapseSeen,
          latencyMs: lapseEvent ? lapseEvent.at - lapseAt : null,
          mutationCount,
        },
        observations: observations.map((item) => item.line),
        watcherOutputTail: watcherOutput.slice(-600),
        terminalTail: terminal.slice(-300),
      };
    } finally {
      try {
        await session?.dispose();
      } catch {
        // A live command forces worker teardown; that is the documented path.
      }
      await controller.dispose();
    }
  });

  console.log(JSON.stringify(report, null, 2));

  assert.ok(report.watchSupported, `Nodepod fs.watch did not start: ${JSON.stringify(report.observations)}`);
  assert.ok(
    report.control.observed,
    "The watcher did not observe a plain host write, so nothing else in this test is attributable",
  );
  assert.ok(
    report.case.onHost,
    "The Bash write was not visible through the host shared-store facade",
  );
  assert.ok(
    report.case.observed,
    "A detached Nodepod watcher did not observe a Bash-originated edit that did reach the workspace",
  );
  assert.ok(
    report.lapse.observed,
    "A detached Nodepod watcher did not recover an in-place mutation after the event ring lapped",
  );

  console.log("A detached Nodepod watcher observes Bash edits and lapsed in-place mutations.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
