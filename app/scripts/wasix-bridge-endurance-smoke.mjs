import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 240_000,
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
    if (text.includes("BRIDGE") || text.includes("bridge") || text.includes("panicked") || text.includes("RuntimeError") || text.includes("Error")) console.log("[console]", msg.type(), text);
  });

  const result = await page.evaluate(async () => {
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
    for (const stale of ["bg-a.txt", "bg-b.txt", "bg-c.txt"]) {
      try {
        await controller.pod.fs.unlink(`/work/repo/${stale}`);
      } catch {
        // Not present; fine.
      }
    }
    const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
    const interactive = await session.installInteractiveBash();
    const stubBytes = new Uint8Array(await (await fetch("/src/assets/wasmer/bridge-stub.wasm")).arrayBuffer());
    const bridge = await session.installBridge(new Map([
      ["node", stubBytes],
      ["npm", stubBytes],
      ["git", stubBytes],
    ]));

    const bridgeIO = sessionBridge(session);
    const handler = createBridgeHostHandler(controller.pod, (status) => {
      console.log("[bridge]", status);
    });
    const serveErrors = [];
    const serveP = bridgeServeAll(bridgeIO, handler).catch((error) => {
      serveErrors.push(String(error));
    });

    const bash = {
      packageUrl: "/src/assets/wasmer/bash-1.0.25-riff.webc",
      packageSha256: "6bf621c2561b2d1f0f982fe6aea04f158c81d7e9b7378d8f7ee7f3543b6d3293",
      command: "bash",
      entrypoint: true,
      uses: ["wasmer/coreutils@1.0.25"],
    };
    const runOptions = {
      cwd: "/work/repo",
      env: { ...bridge.pipeEnv, PATH: `${bridge.pathEntry}:/usr/local/bin:/bin:/usr/bin` },
    };
    const run = (script) => session.run(bash, ["-c", script], runOptions);
    const decode = (b) => new TextDecoder().decode(b);

    const report = {};

    const seqCmds = [];
    for (let i = 1; i <= 10; i++) {
      seqCmds.push(`echo "seq-${i}: $(node -e 'process.stdout.write(String(${i}))')"`);
    }
    const leg1 = await run(["set -u", ...seqCmds, "echo seq-done"].join(" && "));
    report.leg1 = {
      code: leg1.code,
      stdout: decode(leg1.stdout),
      stderr: decode(leg1.stderr),
    };

    // Concurrent backgrounded stubs share the request pipe but read their own
    // per-pid response pipes. This is the Claude-Code-under-node + dev-server
    // scenario: several node stubs alive at once.
    const leg2 = await run([
      "set -u",
      "node -e 'process.stdout.write(\"bg-a\\n\")' > /work/repo/bg-a.txt &",
      "node -e 'process.stdout.write(\"bg-b\\n\")' > /work/repo/bg-b.txt &",
      "wait",
      "echo bg-done",
    ].join("\n"));
    report.leg2 = {
      code: leg2.code,
      stdout: decode(leg2.stdout),
      stderr: decode(leg2.stderr),
    };
    let bgA, bgB;
    try {
      bgA = await controller.pod.fs.readFile("/work/repo/bg-a.txt", "utf8");
    } catch {
      bgA = null;
    }
    try {
      bgB = await controller.pod.fs.readFile("/work/repo/bg-b.txt", "utf8");
    } catch {
      bgB = null;
    }
    report.leg2 = { ...report.leg2, bgA, bgB };

    // Foreground command while a background stub is still alive: must not block
    // on the shared request pipe, and both must complete.
    const leg3 = await run([
      "set -u",
      "node -e 'setTimeout(()=>{}, 800)' > /work/repo/bg-c.txt &",
      "node -e 'process.stdout.write(\"fg-done\\n\")'",
      "wait",
      "echo leg3-done",
    ].join("\n"));
    let bgC;
    try {
      bgC = await controller.pod.fs.readFile("/work/repo/bg-c.txt", "utf8");
    } catch {
      bgC = null;
    }
    report.leg3 = {
      code: leg3.code,
      stdout: decode(leg3.stdout),
      stderr: decode(leg3.stderr),
      bgC,
    };

    const disposeStart = performance.now();
    try {
      await session.dispose();
    } finally {
      report.disposeMs = Math.round(performance.now() - disposeStart);
    }

    await controller.dispose();
    report.serveErrors = serveErrors;
    return report;
  });

  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.leg1.code, 0, `leg1 bash exited ${result.leg1.code}`);
  for (let i = 1; i <= 10; i++) {
    assert.match(result.leg1.stdout, new RegExp(`seq-${i}: ${i}`), `leg1 missing seq-${i}`);
  }
  assert.match(result.leg1.stdout, /seq-done/);
  assert.equal(result.leg1.stderr, "", `leg1 stderr: ${result.leg1.stderr}`);

  assert.equal(result.leg2.code, 0, `leg2 bash exited ${result.leg2.code}`);
  assert.match(result.leg2.stdout, /bg-done/);
  assert.equal(result.leg2.bgA, "bg-a\n", `bg-a.txt=${JSON.stringify(result.leg2.bgA)}`);
  assert.equal(result.leg2.bgB, "bg-b\n", `bg-b.txt=${JSON.stringify(result.leg2.bgB)}`);

  assert.equal(result.leg3.code, 0, `leg3 bash exited ${result.leg3.code}`);
  assert.match(result.leg3.stdout, /fg-done/);
  assert.match(result.leg3.stdout, /leg3-done/);
  assert.equal(result.leg3.bgC, "", `bg-c.txt=${JSON.stringify(result.leg3.bgC)}`);
  assert.ok(result.disposeMs < 3000, `dispose took ${result.disposeMs}ms`);
  assert.deepEqual(result.serveErrors, [], `serveErrors: ${JSON.stringify(result.serveErrors)}`);
  assert.deepEqual(errors, [], `pageErrors: ${JSON.stringify(errors)}`);
  console.log("Bridge endurance: concurrent backgrounded stubs, mixed foreground, and in-flight teardown all clean.");
} finally {
  await browser.close();
}
