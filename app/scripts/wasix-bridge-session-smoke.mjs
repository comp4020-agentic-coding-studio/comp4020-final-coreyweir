import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) errors.push(String(error));
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("BRIDGE") || text.includes("panicked") || text.includes("RuntimeError") || text.includes("Error")) console.log("[console]", msg.type(), text);
  });
  page.on("workercreated", (worker) => {
    console.log("[worker created]", worker.url());
    worker.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("BRIDGE") || text.includes("panicked") || text.includes("RuntimeError") || text.includes("Error")) console.log("[worker console]", msg.type(), text);
    });
    worker.on("error", (err) => console.log("[worker error]", String(err)));
  });

  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const [{ WasixSession }, { bridgeServeAll, sessionBridge }] = await Promise.all([
      import("/src/wasixSession.ts"),
      import("/src/wasixBridge.ts"),
    ]);
    const { MemoryVolume } = await import("/@id/@scelar/nodepod");
    if (!MemoryVolume) throw new Error("Cannot import MemoryVolume");
    const volume = new MemoryVolume();
    volume.writeFileSync("/work/repo/.keep", "seed\n");

    const session = await WasixSession.open({ volume, root: "/work/repo" });
    try {
      const interactive = await session.installInteractiveBash();
      const stubBytes = new Uint8Array(await (await fetch("/src/assets/wasmer/bridge-stub.wasm")).arrayBuffer());
      const bridge = await session.installBridge(new Map([["node", stubBytes]]));

      // Host dispatcher: respond to requests with a canned echo, no real spawn.
      const requests = [];
      const bridgeIo = sessionBridge(session);
      const serveP = bridgeServeAll(bridgeIo, async (request, output) => {
        requests.push({ pid: request.pid, cwd: request.cwd, argv: request.argv, env: request.env });
        await output.writeStdout(new TextEncoder().encode(`mock-host:${request.argv[0]}\n`));
        return 7;
      });

      // Run a stub through the interactive bash so the bridge pipe env is set.
      const result = await session.run(
        {
          packageUrl: "/src/assets/wasmer/bash-1.0.25-riff.webc",
          packageSha256: "6bf621c2561b2d1f0f982fe6aea04f158c81d7e9b7378d8f7ee7f3543b6d3293",
          command: "bash",
          entrypoint: true,
          uses: ["wasmer/coreutils@1.0.25"],
        },
        ["-c", `PATH=${bridge.pathEntry}:/usr/local/bin:/bin:/usr/bin; cd /work/repo && node one two; echo rc=$?`],
        { cwd: "/work/repo", env: { ...bridge.pipeEnv, PATH: `${bridge.pathEntry}:/usr/local/bin:/bin:/usr/bin` } },
      );
      return {
        interactiveBash: interactive.bashrcPath,
        pipeEnv: bridge.pipeEnv,
        pathEntry: bridge.pathEntry,
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        requests,
        capabilities: session.capabilities,
      };
    } finally {
      await session.dispose();
    }
  });

  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.interactiveBash, "/work/repo/.wasix-session/bashrc");
  assert.ok(result.pathEntry.includes(".wasix-session/bin"));
  assert.equal(result.requests.length, 1, `expected one bridge request, got ${result.requests.length}`);
  assert.equal(result.requests[0].argv[0], "node");
  assert.equal(result.requests[0].argv[1], "one");
  assert.equal(result.requests[0].argv[2], "two");
  assert.equal(result.requests[0].cwd, "/work/repo");
  assert.equal(result.stdout.trim(), "mock-host:node\nrc=7");
  assert.deepEqual(result.capabilities, { pipe: true });
  assert.deepEqual(errors, []);
  console.log("Bridge session: guest stub reached host dispatcher through the worker pipe.");
} finally {
  await browser.close();
}
