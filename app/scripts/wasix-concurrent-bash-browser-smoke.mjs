// Concurrent commands in one WASIX session.
//
// Claude Code spawns one `bash -c <cmd>` per Bash tool call — `getSpawnArgs`
// returns ["-c", ...] and the cwd is carried between calls through a temp file,
// so there is no persistent shell — and it auto-backgrounds long-running ones.
// "Start a dev server, then keep editing and testing" is therefore the normal
// shape of an agent session, not an edge case.
//
// Five guarantees, each of which was broken:
//   1. two overlapping commands both run, and actually overlap;
//   2. two overlapping *bridged* commands each get their own response frames.
//      Every top-level instance starts its own process tree at pid 1, and the
//      stub derives its private response pipe from getpid(), so both stubs used
//      to open the same pipe device: the host's exit frame went to whichever
//      read first and the other blocked forever;
//   3. a long-running command keeps running while other commands come and go;
//   4. aborting one command leaves the others alone. Abort used to call
//      failSession, which terminates the worker — one Bash-tool timeout took
//      the whole session down, dev server included;
//   5. an abort that lands *before the command is signallable* still kills it
//      (SESSION_STALL_PLAN §2.4). Guarantee 4 aborts 1.5 s in, by which time
//      the instance exists and its signal handler is bound. Claude Code's real
//      failure is the opposite: the startup probe times out during the cold
//      path, the SIGKILL is dropped on the floor, and the abandoned command
//      runs to completion consuming the runtime the caller already gave up on —
//      which makes a timeout storm feed itself.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  protocolTimeout: 600_000,
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) errors.push(String(error));
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const { ClaudePodController, INTERACTIVE_BASH } = await import("/src/claudePod.ts");
    const controller = new ClaudePodController(
      { baseUrl: "https://api.anthropic.com", token: "unused", repo: "" },
      () => {},
    );
    await controller.boot();
    const { session, bridge } = await controller.ensureWasixSession();
    const env = controller.wasixBaseEnv(bridge);
    const decoder = new TextDecoder();
    const clock = () => Math.round(performance.now());

    const run = (script, options = {}) => {
      let out = "";
      const started = clock();
      return session
        .run(INTERACTIVE_BASH, ["-c", script], {
          cwd: session.root,
          env,
          signal: options.signal,
          onOutput: (_stream, chunk) => {
            out += decoder.decode(chunk, { stream: true });
          },
        })
        .then(
          (r) => ({
            code: r.code,
            out: out.trim(),
            started,
            ended: clock(),
            packageCached: r.timings?.packageCached,
          }),
          (e) => ({ error: String(e), out: out.trim(), started, ended: clock() }),
        );
    };

    // 1. Overlap. Each waits on a flag the other writes, so neither can finish
    //    unless both are live at once; the guard is a bounded sleep loop rather
    //    than a spin, so a serialized pair reports a timeout instead of hanging.
    //    Flag names are unique per run: a shared name plus a cleanup step is a
    //    race against the peer that has already written it.
    const stamp = Date.now();
    const flag = (tag) => `/work/repo/${tag}-${stamp}.flag`;
    const await_ = (peer, tag) =>
      `n=0; while [ ! -f ${flag(peer)} ] && [ $n -lt 40 ]; do sleep 0.25; n=$((n+1)); done; ` +
      `if [ -f ${flag(peer)} ]; then echo ${tag}-saw-peer; else echo ${tag}-timeout; fi`;
    const overlap = await Promise.all([
      run(`echo a > ${flag("a")}; ${await_("b", "a")}`),
      run(`echo b > ${flag("b")}; ${await_("a", "b")}`),
    ]);

    // 2. Two bridged commands at once, each with its own distinctive output.
    const bridged = await Promise.all([
      run("node -e \"console.log('bridge-one')\""),
      run("node -e \"console.log('bridge-two')\""),
    ]);

    // 3. Background-server shape: one command outlives two others.
    const longRunning = run("n=0; while [ $n -lt 24 ]; do sleep 0.5; n=$((n+1)); done; echo server-done");
    const during = [];
    during.push(await run("echo edit-1"));
    during.push(await run("echo edit-2"));
    const longResult = await longRunning;

    // 4. Abort one command; the other must survive, and the session must still
    //    accept work afterwards.
    const controllerA = new AbortController();
    const doomed = run("n=0; while [ $n -lt 200 ]; do sleep 0.5; n=$((n+1)); done; echo never", { signal: controllerA.signal });
    const survivor = run("sleep 3; echo survived");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    controllerA.abort();
    const [doomedResult, survivorResult] = await Promise.all([doomed, survivor]);
    const afterAbort = await run("echo session-still-alive");

    // 5. Abort during the cold path, before the command can be signalled.
    //
    //    The gate is a file the script writes *after* a delay, not the exit
    //    code and not elapsed time. A dropped signal and a delivered one both
    //    end with a non-zero code eventually, and a latency threshold is an
    //    assumption about how long a cold start takes. "Did the second half of
    //    the script ever run" is a fact the store keeps, and it is the actual
    //    thing that was wrong: the abandoned command ran to completion.
    //
    //    The abort is synchronous with the call, so the signal message is
    //    queued directly behind the exec message and *cannot* miss the window —
    //    the worker has not yet awaited anything when it arrives. That makes
    //    this deterministic rather than a stress test.
    const coldStamp = Date.now();
    const coldMarker = `/work/repo/cold-abort-${coldStamp}.txt`;
    const coldController = new AbortController();
    const coldStarted = clock();
    const coldDoomed = run(`sleep 4; echo ran > ${coldMarker}`, { signal: coldController.signal });
    coldController.abort();
    // A witness rather than a fixed sleep: it is dispatched no earlier than the
    // doomed command and sleeps twice as long, so its completion proves the
    // doomed script's write would already have happened.
    const coldWitness = run("sleep 8; echo cold-witness");
    const [coldResult, coldWitnessResult] = await Promise.all([coldDoomed, coldWitness]);
    let coldMarkerWritten = true;
    try {
      await controller.pod.fs.readFile(coldMarker, "utf8");
    } catch {
      coldMarkerWritten = false;
    }
    const coldAfter = await run("echo cold-session-still-alive");

    return {
      overlap, bridged, during, longResult, doomedResult, survivorResult, afterAbort,
      cold: {
        result: coldResult,
        markerWritten: coldMarkerWritten,
        elapsedMs: coldResult.ended - coldStarted,
        witness: coldWitnessResult,
        after: coldAfter,
      },
    };
  });

  console.log(JSON.stringify(result, null, 2));

  // 1. Both ran, and each observed the other's flag — proof of real overlap.
  for (const [index, entry] of result.overlap.entries()) {
    assert.equal(entry.error, undefined, `overlap[${index}] failed: ${entry.error}`);
    assert.equal(entry.code, 0);
  }
  assert.equal(result.overlap[0].out, "a-saw-peer");
  assert.equal(result.overlap[1].out, "b-saw-peer");

  // 2. Bridged commands do not steal each other's frames.
  assert.equal(result.bridged[0].out, "bridge-one");
  assert.equal(result.bridged[1].out, "bridge-two");
  for (const entry of result.bridged) assert.equal(entry.code, 0);

  // 3. The long-running command outlived both short ones and still exited 0.
  assert.equal(result.longResult.out, "server-done");
  assert.equal(result.longResult.code, 0);
  for (const entry of result.during) {
    assert.equal(entry.code, 0, `command during the long run failed: ${entry.error}`);
    assert.ok(entry.ended < result.longResult.ended, "a short command should finish before the long one");
  }

  // 4. Abort is scoped to one command.
  assert.ok(result.doomedResult.error !== undefined || result.doomedResult.code !== 0,
    "the aborted command should not report success");
  assert.equal(result.survivorResult.error, undefined,
    `aborting one command killed another: ${result.survivorResult.error}`);
  assert.equal(result.survivorResult.out, "survived");
  assert.equal(result.afterAbort.out, "session-still-alive");

  // 5. An abort during the cold path kills the command rather than being
  //    dropped. The marker is the assertion; the elapsed time is a diagnostic,
  //    deliberately not a gate.
  assert.equal(result.cold.markerWritten, false,
    `a SIGKILL delivered before the command was signallable was dropped: the abandoned script ran to completion ${result.cold.elapsedMs} ms later`);
  assert.equal(result.cold.witness.out, "cold-witness",
    `the witness command did not survive the cold abort: ${result.cold.witness.error}`);
  assert.equal(result.cold.after.out, "cold-session-still-alive");

  const completed = [
    ...result.overlap,
    ...result.bridged,
    ...result.during,
    result.longResult,
    result.survivorResult,
    result.afterAbort,
  ];
  assert.ok(completed.some((entry) => entry.packageCached === true),
    "concurrent commands did not reuse the retained Bash package");
  assert.ok(completed.filter((entry) => entry.packageCached === false).length <= 1,
    "overlapping startup parsed the Bash package more than once");

  assert.deepEqual(errors, []);
  console.log("Concurrent bash: overlapping runs, independent bridge channels, a long-running command, and scoped abort all pass.");
} finally {
  await browser.close();
}
