// Stage 7.E bridge coherence acceptance.
//
// Stage 7.D removes the stale-tree defect entirely: WASIX and bridged Nodepod
// tools address the same store, including within one shell command line.
//
//     printf marker > guest.txt && node reads it and writes host.txt && cat host.txt
//
// No prompt barrier falls between the steps, and the bridge handler goes
// straight to `pod.spawn` with no synchronization policy.
//
// Measured per §7's rule: the claim is "the host-side process saw the guest's
// write", so the assertion reads the *bridged Node process's own stdout*, not
// the WASIX shell's, and not the host volume.
//
// This must pass with no barrier invocation at all: visibility comes from
// shared bytes, not synchronization policy.

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

  // Assembled here, in the harness, so no literal in the page source or in the
  // shell command can satisfy the assertion on its own.
  const marker = `bb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const result = await page.evaluate(async (marker) => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const [{ ClaudePodController, createBridgeHostHandler }, { WasixSession }, bridgeMod] =
      await Promise.all([
        import("/src/claudePod.ts"),
        import("/src/wasixSession.ts"),
        import("/src/wasixBridge.ts"),
      ]);
    const { bridgeServeAll, sessionBridge } = bridgeMod;

    const controller = new ClaudePodController(
      { baseUrl: "https://api.anthropic.com", token: "unused", repo: "" },
      () => {},
    );
    await controller.boot();

    // Host-side probe. Runs as a real Nodepod process through the bridge and
    // reports what the *host* filesystem held at the moment it looked.
    await controller.pod.fs.writeFile(
      "/work/repo/shared-store-probe.js",
      [
        "const fs = require('fs');",
        "let out;",
        "try { out = 'S' + 'AW:' + fs.readFileSync('/work/repo/shared-store-guest.txt', 'utf8').trim(); }",
        "catch (e) { out = 'M' + 'ISS:' + (e && e.code ? e.code : 'unknown'); }",
        "fs.writeFileSync('/work/repo/bridge-return.txt', 'RETURN:' + out.slice(4));",
        "process.stdout.write(out + '\\n');",
        "",
      ].join("\n"),
    );

    const stubBytes = new Uint8Array(
      await (await fetch("/src/assets/wasmer/bridge-stub.wasm")).arrayBuffer(),
    );
    const BASH = {
      packageUrl: "/src/assets/wasmer/bash-1.0.25-riff.webc",
      packageSha256: "6bf621c2561b2d1f0f982fe6aea04f158c81d7e9b7378d8f7ee7f3543b6d3293",
      command: "bash",
      entrypoint: true,
      uses: ["wasmer/coreutils@1.0.25"],
    };

    // Absolute paths throughout: P10 established that a bash root process
    // resolves its own relative paths against `/` until it chdirs, and this
    // test is about bridge coherence, not the path anchor.
    const script = [
      `printf '%s' '${marker}' > /work/repo/shared-store-guest.txt`,
      "node /work/repo/shared-store-probe.js",
      "cat /work/repo/bridge-return.txt",
    ].join(" && ");

    const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
    try {
      await session.installInteractiveBash();
      const bridge = await session.installBridge(new Map([
        ["node", stubBytes],
        ["npm", stubBytes],
        ["git", stubBytes],
      ]));
      const handler = createBridgeHostHandler(controller.pod, () => {});
      void bridgeServeAll(sessionBridge(session), handler).catch(() => {});

      const run = await session.run(BASH, ["-c", script], {
        cwd: "/work/repo",
        env: { ...bridge.pipeEnv, PATH: `${bridge.pathEntry}:/usr/local/bin:/bin:/usr/bin` },
      });
      const onHost = await controller.pod.fs.readFile("/work/repo/shared-store-guest.txt", "utf8");
      return {
        code: run.code,
        stdout: new TextDecoder().decode(run.stdout),
        stderr: new TextDecoder().decode(run.stderr),
        onHostAfterRun: onHost,
      };
    } finally {
      await session.dispose();
      await controller.dispose();
    }
  }, marker);

  console.log(JSON.stringify(result, null, 2));

  const SAW = `${"S"}AW:${marker}`;
  assert.equal(result.code, 0, `bash exited ${result.code}`);
  assert.ok(
    result.stdout.includes(SAW),
    `bridged node did not observe the guest write made earlier in the same command line: ${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes(`RETURN:${marker}`),
    `guest cat did not observe the bridged host write in the same command line: ${result.stdout}`,
  );
  assert.equal(
    result.onHostAfterRun?.trim(),
    marker,
    "the guest write should also be on the host volume after the run",
  );
  assert.deepEqual(errors, []);

  console.log(
    "Bridge visibility: WASIX and bridged Nodepod observe each other's writes in one command with no barriers.",
  );
} finally {
  await browser.close();
}
