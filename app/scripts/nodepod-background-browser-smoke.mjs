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
  const result = await page.evaluate(async () => {
    const { ClaudePodController } = await import("/src/claudePod.ts");
    let previewUrl = null;
    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {}, (url) => { previewUrl = url; });
    await controller.boot();

    const probe = await controller.pod.spawn("node", ["/opt/claude/run.cjs", "--nodepod-shell-probe"]);
    let probeOutput = "";
    probe.on("output", (chunk) => { probeOutput += chunk; });
    await new Promise((resolve, reject) => {
      probe.on("error", reject);
      probe.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Shell probe exited ${code}`)));
    });
    const shell = JSON.parse(probeOutput.trim().split("\n").at(-1));

    const foregroundServer = "const http=require('http');console.log('dev-stdout');console.error('dev-stderr');http.createServer((req,res)=>res.end('background-preview')).listen(4320)";
    await controller.pod.fs.writeFile("/work/repo/package.json", JSON.stringify({ scripts: { dev: "node /work/repo/server.cjs" } }));
    await controller.pod.fs.writeFile("/work/repo/server.cjs", foregroundServer);
    await controller.pod.fs.writeFile("/work/repo/delay.cjs", "setTimeout(() => {}, 10000)");
    const backgroundScript = [
      "npm run dev >dev.log 2>&1 &",
      "dev_pid=$!",
      "printf 'dev-pid=%s\\n' \"$dev_pid\"",
      "jobs",
      "node /work/repo/delay.cjs",
      "kill \"$dev_pid\"",
      "wait \"$dev_pid\"",
      "printf 'wait-complete\\n'",
      "cat dev.log",
      "rm -f dev.log /work/repo/delay.cjs",
    ].join("\n");
    const background = await controller.pod.spawn("node", ["/opt/mithic/run-mithic.cjs", backgroundScript], { cwd: "/work/repo" });
    let backgroundOutput = "";
    background.on("output", (chunk) => { backgroundOutput += chunk; });
    background.on("error", (chunk) => { backgroundOutput += chunk; });
    const backgroundStarted = Date.now();
    while ((!previewUrl || !/dev-pid=\d+/.test(backgroundOutput)) && Date.now() - backgroundStarted < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!previewUrl) {
      const devLog = await controller.pod.fs.exists("/work/repo/dev.log")
        ? await controller.pod.fs.readFile("/work/repo/dev.log", "utf8")
        : null;
      const processes = [...controller.pod.processManager._processes].map(([pid, process]) => ({ pid, state: process.state }));
      throw new Error(`Background dev server did not publish Preview: ${JSON.stringify({ devLog, processes, backgroundOutput: backgroundOutput.slice(0, 500) })}`);
    }
    const pid = Number(backgroundOutput.match(/dev-pid=(\d+)/)?.[1]);
    const pidState = controller.pod.processManager._processes.get(pid)?.state;
    const outputBeforeStop = backgroundOutput;
    const backgroundResponse = await controller.requestPreview({ path: "/" });
    const backgroundBody = new TextDecoder().decode(backgroundResponse.body);
    const waitStarted = Date.now();
    while (!backgroundOutput.includes("wait-complete") && Date.now() - waitStarted < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!backgroundOutput.includes("wait-complete")) {
      throw new Error(`Background shell did not complete kill and wait: ${JSON.stringify(backgroundOutput)}`);
    }
    const backgroundCompletion = await Promise.race([
      background.completion,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Background shell did not exit")), 10_000)),
    ]);
    const backgroundStopped = Date.now();
    while (previewUrl && Date.now() - backgroundStopped < 10_000) await new Promise((resolve) => setTimeout(resolve, 20));
    if (previewUrl) throw new Error("Background dev server remained active after kill and wait");
    const pidStateAfterWait = controller.pod.processManager._processes.get(pid)?.state;
    const cleaned = !(await controller.pod.fs.exists("/work/repo/dev.log")) && !(await controller.pod.fs.exists("/work/repo/delay.cjs"));

    const server = "const fs=require('fs');fs.writeFileSync('/tmp/detached-started','yes');const http=require('http');http.createServer((req,res)=>res.end('detached-preview')).listen(4321)";
    await controller.pod.fs.writeFile("/work/repo/detached.cjs", server);
    const parentSource = "const{spawn}=require('child_process');const child=spawn('node',['/work/repo/detached.cjs'],{detached:true,stdio:'ignore'});child.unref();child.ref();child.unref();process.stdout.write('parent-done\\n')";
    const parent = await controller.pod.spawn("node", ["-e", parentSource]);
    let output = "";
    let exits = 0;
    parent.on("output", (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => parent.on("exit", () => { exits += 1; resolve(); }));
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Unrefed child held parent open")), 10_000)),
    ]);

    const started = Date.now();
    while (!previewUrl && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!previewUrl) {
      const marker = await controller.pod.fs.exists("/tmp/detached-started");
      const processes = [...controller.pod.processManager._processes].map(([pid, process]) => ({ pid, state: process.state }));
      throw new Error(`Detached server did not publish Preview: ${JSON.stringify({ marker, output, parentExited: parent.exited, processes })}`);
    }
    const response = await controller.requestPreview({ path: "/" });
    const body = new TextDecoder().decode(response.body);
    await controller.dispose();
    return {
      backgroundBody,
      backgroundExitCode: backgroundCompletion.exitCode,
      backgroundOutput,
      body,
      cleaned,
      exits,
      output,
      outputBeforeStop,
      parentExited: parent.exited,
      pid,
      pidState,
      pidStateAfterWait,
      shellSpawn: shell.spawn,
    };
  });

  assert.equal(result.backgroundBody, "background-preview");
  assert.equal(result.backgroundExitCode, 0);
  assert.match(result.outputBeforeStop, /dev-pid=\d+/);
  assert.match(result.outputBeforeStop, /\[1\].*Running/);
  assert.doesNotMatch(result.outputBeforeStop, /dev-stdout|> @ dev/);
  assert.equal(result.pid > 0 && result.pid < 100_000, true);
  assert.equal(result.pidState, "running");
  assert.match(result.backgroundOutput, /wait-complete/);
  assert.match(result.backgroundOutput, /dev-stdout/);
  assert.match(result.backgroundOutput, /> @ dev/);
  assert.notEqual(result.pidStateAfterWait, "running");
  assert.equal(result.cleaned, true);
  assert.equal(result.body, "detached-preview");
  assert.equal(result.exits, 1);
  assert.equal(result.output, "parent-done\n");
  assert.equal(result.parentExited, true);
  assert.equal(result.shellSpawn, "spawn_ok\n");
  assert.deepEqual(errors, []);
  console.log("Mithic job control and detached Nodepod Preview lifecycle passed.");
} finally {
  await browser.close();
}
