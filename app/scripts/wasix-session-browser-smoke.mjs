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
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) errors.push(String(error));
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("DIAG") || text.includes("panicked") || text.includes("RuntimeError") || text.includes("Error")) console.log("[console]", msg.type(), text);
  });
  page.on("workercreated", (worker) => {
    console.log("[worker created]", worker.url());
    worker.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("DIAG") || text.includes("panicked") || text.includes("RuntimeError") || text.includes("Error")) console.log("[worker console]", msg.type(), text);
    });
    worker.on("error", (err) => console.log("[worker error]", String(err)));
  });
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
    try {
      await controller.pod.fs.writeFile(
        "/work/repo/session-write.py",
        [
          "from pathlib import Path",
          "Path('/work/repo/wasix-created.txt').write_text('work-guest\\n')",
          "Path('/home/user/wasix-created.txt').write_text('home-guest\\n')",
          "Path('/tmp/wasix-created.txt').write_text('tmp-guest\\n')",
          "",
        ].join("\n"),
      );
      await controller.pod.fs.writeFile(
        "/work/repo/session-read.py",
        [
          "from pathlib import Path",
          "for path in ['/work/repo/wasix-created.txt', '/home/user/wasix-created.txt', '/tmp/wasix-created.txt']:",
          "    print(Path(path).read_text(), end='')",
          "",
        ].join("\n"),
      );
      await controller.pod.fs.writeFile(
        "/work/repo/session-read-host.py",
        [
          "from pathlib import Path",
          "for path in ['/work/repo/host-created.txt', '/home/user/host-created.txt', '/tmp/host-created.txt']:",
          "    print(Path(path).read_text(), end='')",
          "",
        ].join("\n"),
      );
      const session = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
      try {
        const interactiveBash = await session.installInteractiveBash();
        const control = await session.run(python, ["-c", "from pathlib import Path; print(Path('/work/repo/.wasix-session/bashrc').read_text(), end='')"], { cwd: "/work/repo" });
        const first = await session.run(python, ["/work/repo/session-write.py"], { cwd: "/work/repo" });
        if (first.code !== 0) {
          throw new Error(`guest mount write failed (${first.code}): ${new TextDecoder().decode(first.stderr)}`);
        }
        const hostValues = await Promise.all([
          controller.pod.fs.readFile("/work/repo/wasix-created.txt", "utf8"),
          controller.pod.fs.readFile("/home/user/wasix-created.txt", "utf8"),
          controller.pod.fs.readFile("/tmp/wasix-created.txt", "utf8"),
        ]);
        await Promise.all([
          controller.pod.fs.writeFile("/work/repo/host-created.txt", "work-host\n"),
          controller.pod.fs.writeFile("/home/user/host-created.txt", "home-host\n"),
          controller.pod.fs.writeFile("/tmp/host-created.txt", "tmp-host\n"),
        ]);
        const second = await session.run(python, ["/work/repo/session-read.py"], { cwd: "/work/repo" });
        const third = await session.run(python, ["/work/repo/session-read-host.py"], { cwd: "/work/repo" });
        return {
          interactiveBash,
          controlStdout: new TextDecoder().decode(control.stdout),
          controlLeakedToHost: controller.pod.volume.existsSync("/work/repo/.wasix-session/bashrc"),
          firstCode: first.code,
          hostValues,
          secondCode: second.code,
          secondStdout: new TextDecoder().decode(second.stdout),
          thirdCode: third.code,
          thirdStdout: new TextDecoder().decode(third.stdout),
          capabilities: session.capabilities,
        };
      } finally {
        await session.dispose();
      }
    } finally {
      await controller.dispose();
    }
  }, PYTHON);

  assert.equal(result.firstCode, 0);
  assert.equal(result.interactiveBash.bashrcPath, "/work/repo/.wasix-session/bashrc");
  assert.ok(result.interactiveBash.args.includes("-i"));
  assert.match(result.controlStdout, /OSC 133/);
  assert.match(result.controlStdout, /^alias true=:$/m);
  assert.equal(result.controlLeakedToHost, true);
  assert.deepEqual(result.hostValues, ["work-guest\n", "home-guest\n", "tmp-guest\n"]);
  assert.equal(result.secondCode, 0);
  assert.equal(result.secondStdout, "work-guest\nhome-guest\ntmp-guest\n");
  assert.equal(result.thirdCode, 0);
  assert.equal(result.thirdStdout, "work-host\nhome-host\ntmp-host\n");
  assert.deepEqual(result.capabilities, { pipe: true });
  assert.deepEqual(errors, []);
  console.log("Nodepod and WASIX shared workspace, home, and session-lifetime tmp writes without barriers.");
} finally {
  await browser.close();
}
