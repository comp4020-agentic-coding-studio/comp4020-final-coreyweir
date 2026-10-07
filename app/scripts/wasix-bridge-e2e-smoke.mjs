import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  // The evaluate boots Nodepod, a WASIX bash session and three bridge stubs;
  // under the aggregate suite (many wasm heaps already compiled in this
  // browser run) it has exceeded 240 s, which is exactly the old
  // protocolTimeout and produced an aggregate-only callFunctionOn timeout.
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
      const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
      try {
        const interactive = await session.installInteractiveBash();
        const stubBytes = new Uint8Array(await (await fetch("/src/assets/wasmer/bridge-stub.wasm")).arrayBuffer());
        const bridge = await session.installBridge(new Map([
          ["node", stubBytes],
          ["npm", stubBytes],
          ["npx", stubBytes],
          ["pnpm", stubBytes],
          ["yarn", stubBytes],
          ["bun", stubBytes],
          ["bunx", stubBytes],
          ["git", stubBytes],
        ]));

        const bridgeIO = sessionBridge(session);
        const handler = createBridgeHostHandler(controller.pod, () => {});
        const serveP = bridgeServeAll(bridgeIO, handler);

        const script = [
          "set -u",
          `echo \"node: $(node --version)\"`,
          `echo \"npm: $(npm --version)\"`,
          `echo \"git: $(git --version)\"`,
          `echo \"pnpm: $(pnpm --version)\"`,
          `echo \"yarn: $(yarn --version)\"`,
          `echo \"bun: $(bun --version)\"`,
          "npx --help > /dev/null && echo 'npx: ok'",
          // Env passthrough (USABILITY_ROADMAP W5): bridged processes get the
          // guest env verbatim, so a token set on the session env must be
          // visible inside the spawned Nodepod process.
          "node -e \"console.log('token-seen:' + (process.env.GITHUB_TOKEN === 'e2e-fake-token' ? 'yes' : 'no'))\"",
          "node -e \"require('fs').writeFileSync('/work/repo/stub-wrote.txt','hello-from-node\\n')\"",
          "node /work/repo/stub-script.js",
        ].join(" && ");

        await controller.pod.fs.writeFile("/work/repo/stub-script.js", "console.log('script-ran:' + process.cwd())\n");

        const result = await session.run(
          {
            packageUrl: "/src/assets/wasmer/bash-1.0.25-riff.webc",
            packageSha256: "6bf621c2561b2d1f0f982fe6aea04f158c81d7e9b7378d8f7ee7f3543b6d3293",
            command: "bash",
            entrypoint: true,
            uses: ["wasmer/coreutils@1.0.25"],
          },
          ["-c", script],
          {
            cwd: "/work/repo",
            env: {
              TERM: "xterm-256color",
              GITHUB_TOKEN: "e2e-fake-token",
              ...bridge.pipeEnv,
              PATH: `${bridge.pathEntry}:/usr/local/bin:/bin:/usr/bin`,
            },
          },
        );

        let wroteFile;
        try {
          wroteFile = await controller.pod.fs.readFile("/work/repo/stub-wrote.txt", "utf8");
        } catch {
          wroteFile = null;
        }

        return {
          code: result.code,
          stdout: new TextDecoder().decode(result.stdout),
          stderr: new TextDecoder().decode(result.stderr),
          wroteFile,
          capabilities: session.capabilities,
        };
      } finally {
        await session.dispose();
      }
    } finally {
      await controller.dispose();
    }
  });

  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.code, 0, `bash exited ${result.code}`);
  assert.match(result.stdout, /node: v22\.12\.0/);
  assert.match(result.stdout, /npm: 10\.0\.0/);
  assert.match(result.stdout, /git: git version 2\.43\.0/);
  assert.match(result.stdout, /pnpm: 9\.15\.4/);
  assert.match(result.stdout, /yarn: 4\.6\.0/);
  assert.match(result.stdout, /bun: 1\.1\.38/);
  assert.match(result.stdout, /npx: ok/);
  assert.match(result.stdout, /token-seen:yes/);
  assert.match(result.stdout, /script-ran:\/work\/repo/);
  assert.equal(result.wroteFile, "hello-from-node\n");
  assert.equal(result.stderr, "");
  assert.deepEqual(result.capabilities, { pipe: true });
  assert.deepEqual(errors, []);
  console.log("Bridge E2E: guest stubs (node/npm/npx/pnpm/yarn/bun/bunx/git) ran real Nodepod commands through the pipe; env passthrough verified.");
} finally {
  await browser.close();
}
