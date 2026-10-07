import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const PYTHON = {
  packageUrl: "https://cdn.wasmer.io/webcimages/fc2d303b48e6d0f4ce3d7d199c57b55190788fda685b54f1506378a72e5a5d6c.webc",
  packageSha256: "fc2d303b48e6d0f4ce3d7d199c57b55190788fda685b54f1506378a72e5a5d6c",
  command: "python",
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) {
      errors.push(String(error));
    }
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async (python) => {
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

    const root = "/work/repo";
    const modulePath = `${root}/node_modules/riff-overlay/index.js`;
    const headPath = `${root}/.git/OVERLAY_HEAD`;
    const readerScript = `${root}/read-overlay.py`;
    let session = null;

    try {
      controller.pod.volume.mkdirSync(`${root}/node_modules/riff-overlay`, { recursive: true });
      controller.pod.volume.mkdirSync(`${root}/.git`, { recursive: true });
      await controller.pod.fs.writeFile(modulePath, "initial-module\n");
      await controller.pod.fs.writeFile(headPath, "initial-head\n");
      await controller.pod.fs.writeFile(
        readerScript,
        "from pathlib import Path\n"
          + `print(Path('${modulePath}').read_text(), end='')\n`
          + `print(Path('${headPath}').read_text(), end='')\n`,
      );

      session = await WasixSession.open({
        volume: controller.pod.volume,
        root,
      });

      const first = await session.run(python, [readerScript], { cwd: root });

      await controller.pod.fs.writeFile(modulePath, "refreshed-module\n");
      await controller.pod.fs.writeFile(headPath, "refreshed-head\n");
      const second = await session.run(python, [readerScript], { cwd: root });

      return {
        firstCode: first.code,
        firstStdout: new TextDecoder().decode(first.stdout),
        firstStderr: new TextDecoder().decode(first.stderr),
        secondCode: second.code,
        secondStdout: new TextDecoder().decode(second.stdout),
        secondStderr: new TextDecoder().decode(second.stderr),
        capabilities: session.capabilities,
      };
    } finally {
      await session?.dispose();
      await controller.dispose();
    }
  }, PYTHON);

  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.firstCode, 0);
  assert.equal(result.firstStdout, "initial-module\ninitial-head\n");
  assert.equal(result.secondCode, 0);
  assert.equal(result.secondStdout, "refreshed-module\nrefreshed-head\n");
  assert.deepEqual(result.capabilities, { pipe: true });
  assert.deepEqual(errors, []);
  console.log("A real WASIX process read live Nodepod node_modules and .git content from the shared store.");
} finally {
  await browser.close();
}
