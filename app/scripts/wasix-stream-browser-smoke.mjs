// Regression: `npm run <script>` output must reach the session WHILE the
// child runs, not be dumped when it exits (USABILITY_ROADMAP W3 / B1).
//
// Full production path: WASIX bash -> bridge stub -> createBridgeHostHandler
// -> pod.spawn("npm", ["run", "tickle"]) -> runScript streams via sinks.
// The tickler prints every 300 ms for ~2.4 s; we require a tick frame to
// arrive at least 500 ms before the run resolves.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const BASH = {
  packageUrl: "/src/assets/wasmer/bash-1.0.25-riff.webc",
  packageSha256: "6bf621c2561b2d1f0f982fe6aea04f158c81d7e9b7378d8f7ee7f3543b6d3293",
  command: "bash",
  entrypoint: true,
  uses: ["wasmer/coreutils@1.0.25"],
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) errors.push(String(error));
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async (BASH) => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const [{ ClaudePodController, createBridgeHostHandler }, { WasixSession }, { bridgeServeAll, sessionBridge }] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasixSession.ts"),
      import("/src/wasixBridge.ts"),
    ]);

    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {});
    await controller.boot();
    try {
      await controller.pod.fs.writeFile(
        "/work/repo/package.json",
        JSON.stringify({ name: "stream-fixture", version: "1.0.0", scripts: { tickle: "node ./tickler.js" } }),
      );
      await controller.pod.fs.writeFile(
        "/work/repo/tickler.js",
        "let n = 0;\nconst t = setInterval(() => { console.log('tick-' + ++n); if (n >= 8) { clearInterval(t); } }, 300);\n",
      );

      const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
      try {
        const stubBytes = new Uint8Array(await (await fetch("/src/assets/wasmer/bridge-stub.wasm")).arrayBuffer());
        const bridge = await session.installBridge(new Map([["node", stubBytes], ["npm", stubBytes]]));
        bridgeServeAll(sessionBridge(session), createBridgeHostHandler(controller.pod, () => {}));

        const decoder = new TextDecoder();
        let sawFirstTickAt = null;
        let resolvedAt = null;
        let streamedText = "";
        const t0 = Date.now();
        const out = await session.run(
          BASH,
          ["-c", "npm run tickle"],
          {
            cwd: "/work/repo",
            env: { TERM: "xterm-256color", ...bridge.pipeEnv, PATH: `${bridge.pathEntry}:/usr/local/bin:/bin:/usr/bin` },
            onOutput: (_stream, chunk) => {
              streamedText += decoder.decode(chunk, { stream: true });
              if (sawFirstTickAt === null && streamedText.includes("tick-1")) sawFirstTickAt = Date.now();
            },
          },
        );
        resolvedAt = Date.now();

        return {
          code: out.code,
          stdout: new TextDecoder().decode(out.stdout),
          stderr: new TextDecoder().decode(out.stderr),
          sawFirstTickAt,
          firstTickLeadMs: sawFirstTickAt !== null ? resolvedAt - sawFirstTickAt : null,
          totalMs: resolvedAt - t0,
          drainMs: out.timings?.drainMs,
          drained: out.timings?.drained,
          streamedHadBanner: streamedText.includes("> stream-fixture@"),
        };
      } finally {
        await session.dispose();
      }
    } finally {
      await controller.dispose();
    }
  }, BASH);

  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.code, 0, `bash exited ${result.code}: ${result.stderr}`);
  assert.match(result.stdout, /tick-8/);
  // The banner and ticks must have been OBSERVED live during execution.
  assert.ok(result.sawFirstTickAt !== null, "no tick frame arrived while the child ran");
  assert.ok(result.firstTickLeadMs >= 500, `first tick led exit by only ${result.firstTickLeadMs} ms`);
  assert.ok(result.streamedHadBanner, "npm banner missing from live stream");
  assert.equal(result.drained, true, `stdout/stderr did not reach EOF (drain ${result.drainMs} ms)`);
  assert.deepEqual(errors, []);
  console.log(`Stream E2E: first tick led exit by ${result.firstTickLeadMs} ms over ${result.totalMs} ms total.`);
} finally {
  await browser.close();
}
