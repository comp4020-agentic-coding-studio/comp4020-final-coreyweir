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
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  const result = await page.evaluate(async () => {
    const [{ ClaudePodController }, { createRiffWasmerProvider }] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasmerCommandProvider.ts"),
    ]);
    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {});
    await controller.boot();
    await controller.pod.fs.writeFile(
      "/work/repo/python-interactive.py",
      "import sys\nprint('ready', flush=True)\nline = sys.stdin.readline()\nprint('reply:' + line.strip(), flush=True)\n",
    );
    await controller.pod.fs.writeFile(
      "/work/repo/interactive.cjs",
      `const { spawn } = require("child_process");
const child = spawn("python", ["/work/repo/python-interactive.py"]);
 let output = "";
 let sent = false;
 let ended = false;
 child.stdout.on("data", (chunk) => {
   output += chunk;
   if (!sent && output.includes("ready\\n")) {
     sent = true;
     child.stdin.write("interactive-input\\r\\n");
   }
   if (!ended && output.includes("reply:interactive-input\\n")) {
     ended = true;
     child.stdin.end();
   }
 });
      child.on("close", () => process.stdout.write(output));`,
    );
    const provider = await createRiffWasmerProvider(controller.pod.volume);
    const directOutput = [];
    const direct = await Promise.race([provider.run("python", ["/work/repo/python-interactive.py"], {
      cwd: "/work/repo",
      onReady: async (write, end) => {
        await write(new TextEncoder().encode("direct-input\r\n"));
        await end();
      },
      onOutput: (_stream, chunk) => {
        const text = new TextDecoder().decode(chunk);
        directOutput.push(text);
      },
    }), new Promise((_, reject) => setTimeout(() => reject(new Error(`direct Tier B timed out: ${directOutput.join("")}`)), 20_000))]);
    await provider.dispose();
    const process = await controller.pod.spawn("node", ["/work/repo/interactive.cjs"], {
      cwd: "/work/repo",
    });
    const output = [];
    process.on("output", (chunk) => output.push(chunk));
    const completion = await Promise.race([
      process.completion,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Tier B timed out: ${JSON.stringify({
        output: output.join(""),
        processes: controller.pod.processManager.listProcesses(),
      })}`)), 30_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await controller.dispose();
    return { completion, output: output.join(""), direct: new TextDecoder().decode(direct.stdout) };
  });
  assert.equal(result.completion.exitCode, 0);
  assert.match(result.output, /^ready\n/);
  assert.equal((result.output.match(/reply:interactive-input\n/g) ?? []).length, 1);
  assert.match(result.output, /reply:interactive-input\n$/);
  assert.match(result.direct, /ready\n/);
  assert.equal((result.direct.match(/reply:direct-input\n/g) ?? []).length, 1);
  assert.match(result.direct, /reply:direct-input\n$/);
  console.log("Tier B interactive stdin round trip passed.");
} finally {
  await browser.close();
}
