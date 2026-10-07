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
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  const errors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) errors.push(String(error));
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const [{ ClaudePodController }, { createRiffWasmerProvider, WasmerCommandProvider }] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasmerCommandProvider.ts"),
    ]);
    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {});
    await controller.boot();
    await controller.pod.fs.writeFile("/work/repo/input.txt", "from-nodepod");
    await controller.pod.fs.writeFile("/work/repo/delete-me.txt", "remove-me");
    await controller.pod.fs.writeFile(
      "/work/repo/read-result.cjs",
      "const fs=require('fs');process.stdout.write('node-read:'+fs.readFileSync('/work/repo/renamed.txt','utf8'))",
    );
    await controller.pod.fs.writeFile(
      "/work/repo/read-stdin.cjs",
      "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>process.stdout.write('node-pipe:'+input))",
    );
    await controller.pod.fs.writeFile(
      "/work/repo/python-capability.py",
      [
        "import json, pathlib, sqlite3, subprocess, sys, threading",
        "root = pathlib.Path('/work/repo')",
        "values = []",
        "thread = threading.Thread(target=lambda: values.append('thread-ok'))",
        "thread.start()",
        "thread.join()",
        "connection = sqlite3.connect(root / 'python.sqlite3')",
        "connection.execute('create table result(value text)')",
        "connection.execute('insert into result values (?)', ('sqlite-ok',))",
        "sqlite_value = connection.execute('select value from result').fetchone()[0]",
        "connection.close()",
        "subprocess_value = subprocess.run([sys.executable, '-c', 'print(\"subprocess-ok\")'], check=True, capture_output=True, text=True).stdout.strip()",
        "stdin_value = sys.stdin.read()",
        "(root / 'python-binary.bin').write_bytes(bytes([0, 1, 2, 255]))",
        "print(json.dumps({'python': sys.version_info[:2], 'sqlite': sqlite_value, 'thread': values[0], 'subprocess': subprocess_value, 'stdin': stdin_value}), flush=True)",
      ].join("\n"),
    );
    await controller.pod.fs.writeFile("/work/repo/python-loop.py", "while True:\n    pass\n");
    await controller.pod.fs.writeFile("/work/repo/python-recovery.py", "print('python-recovered', flush=True)\n");

    const script = [
      "wasm-fs-probe /work/repo | node /work/repo/read-stdin.cjs",
      "printf 'python-stdin' | python /work/repo/python-capability.py",
      "node /work/repo/read-result.cjs",
    ].join(" && ");
    const process = await controller.pod.spawn("node", ["/bin/bash", "-lc", script], {
      cwd: "/work/repo",
    });
    // Direct child spawns are interactive by default; this batch pipeline has
    // no interactive input, so close stdin so the shell can complete.
    process.end();
    const output = [];
    process.on("output", (chunk) => output.push(chunk));
    const completion = await Promise.race([
      process.completion,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Wasmer command timed out: ${JSON.stringify({
        output: output.join(""),
        processes: controller.pod.processManager.listProcesses(),
      })}`)), 60_000)),
    ]);
    const hasRenamed = await controller.pod.fs.exists("/work/repo/renamed.txt");
    const hasNested = await controller.pod.fs.exists("/work/repo/nested/child.bin");
    const renamed = hasRenamed
      ? await controller.pod.fs.readFile("/work/repo/renamed.txt", "utf8")
      : null;
    const nested = hasNested
      ? [...await controller.pod.fs.readFile("/work/repo/nested/child.bin")]
      : null;
    const deleted = !(await controller.pod.fs.exists("/work/repo/delete-me.txt"));
    const pythonBinary = [...await controller.pod.fs.readFile("/work/repo/python-binary.bin")];
    const pythonDatabase = await controller.pod.fs.exists("/work/repo/python.sqlite3");
    await controller.pod.fs.writeFile("/work/repo/input.txt", "direct-input");
    const directProbe = await controller.pod.spawn("wasm-fs-probe", ["/work/repo"], {
      cwd: "/work/repo",
    });
    directProbe.end();
    const directProbeResult = await directProbe.completion;
    const directProbeFile = await controller.pod.fs.readFile("/work/repo/renamed.txt", "utf8");
    const directPython = await controller.pod.spawn("python", ["/work/repo/python-recovery.py"], {
      cwd: "/work/repo",
    });
    directPython.end();
    const directPythonResult = await directPython.completion;

    // Binary stdout must survive Wasmer -> host bridge -> guest child_process.
    // The guest hex encodes so the assertion never rides the text surface.
    await controller.pod.fs.writeFile(
      "/work/repo/python-binary-stdout.py",
      "import sys\nsys.stdout.buffer.write(bytes([0, 1, 128, 254, 255, 65]))\n",
    );
    await controller.pod.fs.writeFile(
      "/work/repo/read-binary.cjs",
      `const { spawn } = require("child_process");
const child = spawn("python", ["/work/repo/python-binary-stdout.py"]);
const chunks = [];
child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
child.on("close", () => process.stdout.write("hex:" + Buffer.concat(chunks).toString("hex")));
// The provider reads stdin to EOF before running, so the writer must close it.
child.on("spawn", () => child.stdin.end());`,
    );
    const binaryStdout = await controller.pod.spawn("node", ["/work/repo/read-binary.cjs"], {
      cwd: "/work/repo",
    });
    const binaryStdoutResult = await binaryStdout.completion;

    await controller.pod.fs.writeFile(
      "/work/repo/python-stream.py",
      "import time\nprint('stream-start', flush=True)\ntime.sleep(2)\nprint('stream-end', flush=True)\n",
    );
    await controller.pod.fs.writeFile(
      "/work/repo/read-stream.cjs",
      `const { spawn } = require("child_process");
const started = Date.now();
const child = spawn("python", ["/work/repo/python-stream.py"]);
let firstDataMs = null;
let output = "";
child.stdout.on("data", (chunk) => {
  if (firstDataMs === null) firstDataMs = Date.now() - started;
  output += chunk;
});
child.on("close", () => process.stdout.write(JSON.stringify({ firstDataMs, output })));
child.on("spawn", () => child.stdin.end());`,
    );
    const streamProcess = await controller.pod.spawn("node", ["/work/repo/read-stream.cjs"], {
      cwd: "/work/repo",
    });
    const streamResult = await streamProcess.completion;

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
 child.stdout.on("data", (chunk) => {
   output += chunk;
   if (!sent && output.includes("ready\\n")) {
     sent = true;
     child.stdin.write("interactive-input\\n");
     child.stdin.end();
   }
 });
child.on("close", () => process.stdout.write(output));
child.on("spawn", () => {});`,
    );
    const interactiveProcess = await controller.pod.spawn("node", ["/work/repo/interactive.cjs"], {
      cwd: "/work/repo",
    });
    const interactiveResult = await interactiveProcess.completion;

    // Live stdin must be byte exact: the guest writes non-UTF-8 bytes into a
    // running Python which echoes them back, and the guest hex encodes so the
    // assertion never rides the text surface.
    const liveBinaryBytes = [0x80, 0xfe, 0xff, 0x41, 0x00];
    await controller.pod.fs.writeFile(
      "/work/repo/python-echo-bytes.py",
      "import sys\nimport os\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n",
    );
    await controller.pod.fs.writeFile(
      "/work/repo/live-binary.cjs",
      `const { spawn } = require("child_process");
const child = spawn("python", ["/work/repo/python-echo-bytes.py"]);
const chunks = [];
let sent = false;
child.stdout.on("data", (chunk) => {
  chunks.push(Buffer.from(chunk));
});
child.on("spawn", () => {
  if (sent) return;
  sent = true;
  child.stdin.write(Buffer.from(${JSON.stringify(liveBinaryBytes)}));
  child.stdin.end();
});
child.on("close", () => process.stdout.write("live-binary:" + Buffer.concat(chunks).toString("hex")));`,
    );
    const liveBinaryProcess = await controller.pod.spawn("node", ["/work/repo/live-binary.cjs"], {
      cwd: "/work/repo",
    });
    const liveBinaryResult = await liveBinaryProcess.completion;
    let duplicateName = null;
    try {
      await WasmerCommandProvider.create({
        volume: controller.pod.volume,
        commands: [
          { name: "duplicate", packageUrl: "/one.webc", packageSha256: "0".repeat(64), command: "one" },
          { name: "duplicate", packageUrl: "/two.webc", packageSha256: "1".repeat(64), command: "two" },
        ],
      });
    } catch (error) {
      duplicateName = error instanceof Error ? error.message : String(error);
    }
    const cancellationProvider = await createRiffWasmerProvider(controller.pod.volume);
    const abortController = new AbortController();
    let abortStarted = 0;
    const cancelled = cancellationProvider.run("python", ["/work/repo/python-loop.py"], {
      cwd: "/work/repo",
      signal: abortController.signal,
    });
    setTimeout(() => {
      abortStarted = performance.now();
      abortController.abort();
    }, 6_000);
    let cancellationName = null;
    try {
      await cancelled;
    } catch (error) {
      cancellationName = error instanceof Error ? error.name : String(error);
    }
    const cancellationMs = performance.now() - abortStarted;
    const postCancel = await cancellationProvider.run("python", ["/work/repo/python-recovery.py"], {
      cwd: "/work/repo",
    });
    await cancellationProvider.dispose();
    await controller.dispose();
    return {
      completion,
      renamed,
      nested,
      deleted,
      pythonBinary,
      pythonDatabase,
      directProbeCode: directProbeResult.exitCode,
      directProbeFile,
      directPythonCode: directPythonResult.exitCode,
      directPythonStdout: directPythonResult.stdout,
      binaryStdoutCode: binaryStdoutResult.exitCode,
      binaryStdout: binaryStdoutResult.stdout,
      streamCode: streamResult.exitCode,
      streamResult: streamResult.stdout,
      interactiveCode: interactiveResult.exitCode,
      interactiveStdout: interactiveResult.stdout,
      liveBinaryCode: liveBinaryResult.exitCode,
      liveBinaryStdout: liveBinaryResult.stdout,
      duplicateName,
      cancellationName,
      cancellationMs,
      postCancelCode: postCancel.code,
      postCancelStdout: new TextDecoder().decode(postCancel.stdout),
      postCancelPackageCached: postCancel.diagnostics.packageCached,
      postCancelPackageMs: postCancel.diagnostics.packageMs,
      postCancelLoadMs: postCancel.diagnostics.loadMs,
      isolated: crossOriginIsolated,
    };
  });

  assert.equal(result.isolated, true);
  assert.equal(result.completion.exitCode, 0, JSON.stringify(result.completion));
  assert.match(result.completion.stdout, /node-pipe:.*"input":"from-nodepod"/);
  assert.match(result.completion.stdout, /"sqlite": "sqlite-ok"/);
  assert.match(result.completion.stdout, /"thread": "thread-ok"/);
  assert.match(result.completion.stdout, /"subprocess": "subprocess-ok"/);
  assert.match(result.completion.stdout, /"stdin": "python-stdin"/);
  assert.match(result.completion.stdout, /node-read:wasix:from-nodepod/);
  assert.equal(result.renamed, "wasix:from-nodepod");
  assert.deepEqual(result.nested, [0, 1, 2, 255]);
  assert.equal(result.deleted, true);
  assert.deepEqual(result.pythonBinary, [0, 1, 2, 255]);
  assert.equal(result.pythonDatabase, true);
  assert.equal(result.directProbeCode, 0);
  assert.equal(result.directProbeFile, "wasix:direct-input");
  assert.equal(result.directPythonCode, 0);
  assert.equal(result.directPythonStdout, "python-recovered\n");
  assert.equal(result.binaryStdoutCode, 0);
  assert.equal(result.binaryStdout, "hex:000180feff41", "binary stdout was not byte exact");
  assert.equal(result.streamCode, 0);
  const streamResult = JSON.parse(result.streamResult);
  assert.match(streamResult.output, /stream-start\nstream-end\n/);
  assert.ok(streamResult.firstDataMs < 1_500, `first stream output arrived after ${streamResult.firstDataMs}ms`);
  assert.equal(result.interactiveCode, 0);
  // The interactive child runs on a terminal, so the typed input is echoed
  // back (ready\ninteractive-input\nreply:...). Assert the exchange happened
  // and the reply is the final line.
  assert.match(result.interactiveStdout, /ready\n/);
  assert.match(result.interactiveStdout, /reply:interactive-input\n$/);
  assert.ok(
    !result.interactiveStdout.includes("timed out") && result.interactiveStdout.includes("reply:interactive-input"),
    `interactive output malformed: ${JSON.stringify(result.interactiveStdout)}`,
  );
  assert.equal(result.liveBinaryCode, 0);
  assert.equal(result.liveBinaryStdout, "live-binary:80feff4100", "live binary stdin was not byte exact");
  assert.equal(result.duplicateName, "Duplicate Wasmer command: duplicate");
  assert.equal(result.cancellationName, "AbortError");
  assert.ok(result.cancellationMs < 5_000, `Cancellation took ${result.cancellationMs}ms`);
  assert.equal(result.postCancelCode, 0);
  assert.equal(result.postCancelStdout, "python-recovered\n");
  assert.equal(result.postCancelPackageCached, true);
  assert.deepEqual(errors, []);
  console.log(`Repeat Wasmer package resolve ${Math.round(result.postCancelPackageMs)}ms, load ${Math.round(result.postCancelLoadMs)}ms.`);
  console.log("Riff dispatched immutable Wasmer packages and Nodepod commands over one canonical workspace.");
} finally {
  await browser.close();
}
