// The host's Bash takes input as fast as it arrives: typed with no gap
// between keys, typed ahead while a command is still running, typed the
// moment a child process or a background job ends or a signal lands, and
// pasted in one piece. Runs through the real UI, so on live as well as dev:
//
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev [ROUNDS=5] [CASES=typed,pasted] npm run test:terminal-input-browser
//
// A fresh profile hosts a room (board not kept, ended at the end) and
// starts Bash. Each case puts a command in and waits for a marker only that
// command prints, then checks the shell is back at a prompt. A case that
// doesn't finish in WAIT ms (default 20,000) fails; every case runs, so a
// red shows which paths are broken. On a failure it prints the screen,
// whether the session worker still answers, and whether more input or
// Ctrl+C brings the shell back (DEBUG_FAIL=1 also pauses a worker that
// doesn't answer and prints its stack).
//
// Red on wasmer-sdk riff.e56540d (InlineWaker self-deadlock: the session
// worker stops answering) and with stdout and stderr on separate pipes
// (readline's echo overtakes command output and a marker is swallowed
// into an escape sequence).
//
// Can't tell apart: input lost in xterm from input lost in the pod or the
// guest's tty (it reads the screen); a paste from the system clipboard
// from the paste event it dispatches (the same handler in xterm). A
// deadlock is a race: a green run of a few rounds is evidence, not proof.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const viewport = { width: Number(process.env.W ?? 1600), height: Number(process.env.H ?? 1000), deviceScaleFactor: 1 };
const rounds = Number(process.env.ROUNDS ?? 3);
const wait = Number(process.env.WAIT ?? 20_000);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const pageErrors = [];

async function host(context) {
  const tab = await context.newPage();
  tab.on("pageerror", (error) => pageErrors.push(String(error)));
  await tab.setViewport(viewport);
  await tab.goto(baseUrl, { waitUntil: "networkidle0" });
  await tab.click(".entry-card > nav button:nth-child(2)");
  await tab.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await tab.$$(".entry-card form input:not([type=radio])");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type("Wren");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].click({ clickCount: 3 });
  await inputs[2].type("invalid-terminal-input-smoke-token");
  const keep = await tab.$(".entry-card form label.check input[type=checkbox]");
  if (await keep.evaluate((element) => element.checked)) await keep.click();
  // Bash first: keep the new room from booting Claude by itself (autoBoot.ts).
  await tab.evaluateOnNewDocument(() => sessionStorage.removeItem("riff-auto-boot"));
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000, polling: 100 });
  const code = await tab.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  return { tab, code };
}

const screenText = (tab) => tab.$eval(".terminal-target .xterm-rows", (element) => element.innerText.replace(/\u00a0/g, " "));

async function startBash(tab) {
  await tab.waitForSelector(".topbar nav button:nth-child(2)", { timeout: 20_000 });
  await tab.click(".topbar nav button:nth-child(2)");
  await tab.waitForSelector(".terminal-controls button", { timeout: 20_000 });
  const clicked = await tab.$$eval(".terminal-controls button", (buttons) => {
    const button = buttons.find((b) => b.textContent === "Start Bash");
    button?.click();
    return !!button;
  });
  assert.ok(clicked, "Start Bash");
  await tab.waitForFunction(
    () => document.querySelector(".terminal-heading span")?.textContent === "WASIX Bash ready",
    { timeout: 240_000, polling: 200 },
  );
  await atPrompt(tab);
}

// The last line of the screen is a bare prompt.
async function atPrompt(tab, timeout = wait) {
  await tab.waitForFunction(() => {
    const rows = document.querySelector(".terminal-target .xterm-rows")?.innerText.replace(/\u00a0/g, " ") ?? "";
    return /[$#] $/.test(rows.trimEnd() + " ");
  }, { timeout, polling: 100 });
}

async function sawMarker(tab, marker, timeout = wait) {
  try {
    await tab.waitForFunction(
      (marker) => document.querySelector(".terminal-target .xterm-rows")?.innerText.includes(marker),
      { timeout, polling: 100 }, marker,
    );
    return true;
  } catch {
    return false;
  }
}

async function focus(tab) {
  await tab.bringToFront();
  await tab.focus(".terminal-target .xterm-helper-textarea");
}

async function paste(tab, text) {
  await tab.evaluate((text) => {
    const target = document.querySelector(".terminal-target .xterm-helper-textarea");
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

// The marker is printed as $((n+0)) so the echoed command line can't match it.
let sequence = 0;
async function chained(tab, first) {
  const n = ++sequence;
  await focus(tab);
  await tab.keyboard.type(`${first}${first.endsWith("&") ? "" : ";"} echo @X$((${n}+0))`, { delay: 0 });
  await tab.keyboard.press("Enter");
  if (!(await sawMarker(tab, `@X${n}`))) return false;
  await tab.keyboard.type(`echo second; echo @Y$((${n}+0))`, { delay: 0 });
  await tab.keyboard.press("Enter");
  return sawMarker(tab, `@Y${n}`);
}

// Says whether the session worker (it runs the guest's TTY) still answers,
// and, when it doesn't, where its thread is blocked (wasm frames are
// $funcN unless the SDK was built with names).
async function diagnose(tab) {
  // (the guest's own threads park in Atomics.wait when idle, so only the
  // session worker's silence means something)
  for (const worker of tab.workers().filter((w) => w.url().includes("wasixSessionWorker"))) {
    const name = worker.url().split("/").pop().split("?")[0];
    const answer = await Promise.race([
      worker.evaluate(() => "answers").catch((error) => `error ${error}`),
      new Promise((resolve) => setTimeout(() => resolve("NO ANSWER in 3 s"), 3000)),
    ]);
    if (answer === "answers") { console.log(`  worker ${name}: answers`); continue; }
    console.log(`  worker ${name}: ${answer}`);
    if (!process.env.DEBUG_FAIL) continue;
    try {
      const client = worker.client;
      const paused = new Promise((resolve) => client.once("Debugger.paused", resolve));
      await client.send("Debugger.enable");
      await client.send("Debugger.pause");
      const event = await Promise.race([paused, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
      if (event) console.log(event.callFrames.slice(0, 20).map((f) => `    ${f.functionName || "?"}`).join("\n"));
      await client.send("Debugger.resume").catch(() => {});
    } catch (error) {
      console.log(`    could not pause it: ${error}`);
    }
  }
}

const cases = {
  // every key of a command, then Enter, with no gap, at a prompt
  async typed(tab) {
    const n = ++sequence;
    await focus(tab);
    await tab.keyboard.type(`echo one; echo "$(echo sub)"; echo @T$((${n}+0))`, { delay: 0 });
    await tab.keyboard.press("Enter");
    return sawMarker(tab, `@T${n}`);
  },
  // typed, at full speed, while the previous command is still running:
  // the shell has to pick it up when that command finishes
  async typedAhead(tab) {
    const n = ++sequence;
    await focus(tab);
    await tab.keyboard.type("sleep 2", { delay: 0 });
    await tab.keyboard.press("Enter");
    await tab.keyboard.type(`echo ahead; echo @A$((${n}+0))`, { delay: 0 });
    await tab.keyboard.press("Enter");
    return sawMarker(tab, `@A${n}`);
  },
  // one paste: a command and its Enter arrive as one piece of input
  async pasted(tab) {
    const n = ++sequence;
    await focus(tab);
    await paste(tab, `echo pasted; echo "$(echo sub)"; echo @P$((${n}+0))\n`);
    return sawMarker(tab, `@P${n}`);
  },
  // a command the pod runs for the guest (node, git: bridged), then the
  // next command typed the moment the first one's marker shows
  async bridged(tab) {
    const n = ++sequence;
    await focus(tab);
    await tab.keyboard.type(`node -e "console.log(6*7)"; echo @N$((${n}+0))`, { delay: 0 });
    await tab.keyboard.press("Enter");
    if (!(await sawMarker(tab, `@N${n}`))) return false;
    await tab.keyboard.type(`echo "$(node -e 'console.log(6*8)')"; git --version; echo @M$((${n}+0))`, { delay: 0 });
    await tab.keyboard.press("Enter");
    return sawMarker(tab, `@M${n}`);
  },
  // typed ahead while a bridged command runs
  async bridgedAhead(tab) {
    const n = ++sequence;
    await focus(tab);
    await tab.keyboard.type(`node -e "setTimeout(() => {}, 1500)"`, { delay: 0 });
    await tab.keyboard.press("Enter");
    await tab.keyboard.type(`echo ahead; echo @G$((${n}+0))`, { delay: 0 });
    await tab.keyboard.press("Enter");
    return sawMarker(tab, `@G${n}`);
  },
  // the next command typed the moment the previous one's marker shows,
  // while its child process is still being torn down
  afterExternal: (tab) => chained(tab, "ls / >/dev/null"),
  afterBridged: (tab) => chained(tab, "node -e 1"),
  afterSubshell: (tab) => chained(tab, "x=$(echo sub)"),
  // a background job that ends, and a signal that arrives, mid-typing
  afterBackgroundJob: (tab) => chained(tab, "(sleep 0.05) &"),
  afterSignal: (tab) => chained(tab, "trap : USR1; (sleep 0.05; kill -USR1 $$) &"),
  // a paste of two lines: both commands run, in order
  async pastedLines(tab) {
    const n = ++sequence;
    await focus(tab);
    await paste(tab, `echo @L$((${n}+0))a\necho @L$((${n}+0))b\n`);
    return (await sawMarker(tab, `@L${n}a`)) && sawMarker(tab, `@L${n}b`);
  },
};

const context = await browser.createBrowserContext();
let room = null;
const results = [];
try {
  room = await host(context);
  const { tab, code } = room;
  console.log(`hosting room ${code}`);
  await startBash(tab);
  for (let round = 1; round <= rounds; round++) {
    for (const [name, run] of Object.entries(cases)) {
      if (process.env.CASES && !process.env.CASES.split(",").includes(name)) continue;
      const started = Date.now();
      const ok = await run(tab);
      // the shell must be back at a prompt and still taking input
      const alive = ok && (await atPrompt(tab).then(() => true, () => false));
      results.push({ round, name, ok: ok && alive, ms: Date.now() - started });
      console.log(`round ${round} ${name}: ${ok && alive ? "ok" : ok ? "ran, but no prompt after" : "STALLED"} (${Date.now() - started} ms)`);
      if (!ok) {
        console.log(`screen:\n${await screenText(tab)}`);
        await diagnose(tab);
        // a lost wakeup takes more input; a deadlock takes nothing

        const k = ++sequence;
        await focus(tab);
        await tab.keyboard.type(`echo @K$((${k}+0))`, { delay: 20 });
        await tab.keyboard.press("Enter");
        const woke = await sawMarker(tab, `@K${k}`, 5_000);
        let interrupted = false;
        if (!woke) {
          await tab.keyboard.down("Control"); await tab.keyboard.press("c"); await tab.keyboard.up("Control");
          const j = ++sequence;
          await tab.keyboard.type(`echo @J$((${j}+0))`, { delay: 20 });
          await tab.keyboard.press("Enter");
          interrupted = await sawMarker(tab, `@J${j}`, 5_000);
        }
        console.log(`  more input brought it back: ${woke}; Ctrl+C then input: ${interrupted}`);
        if (!woke && !interrupted) break;
      }
    }
  }
} finally {
  if (room) {
    try {
      const { tab, code } = room;
      if (!(await tab.$(".people-panel"))) await tab.click(".participants");
      await tab.waitForSelector(".people-panel");
      await tab.click(".end-room > button");
      await tab.waitForSelector(".end-room.asking");
      await Promise.all([tab.waitForNavigation({ waitUntil: "networkidle0" }), tab.click(".end-room button.danger")]);
      console.log(`ended room ${code}`);
    } catch (error) {
      console.log(`could not end the room: ${error}`);
    }
  }
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
assert.deepEqual(pageErrors, [], "no page errors");
assert.equal(failed.length, 0, `${failed.length} of ${results.length} inputs stalled: ${failed.map((f) => `${f.name}#${f.round}`).join(", ")}`);
console.log(`terminal input smoke passed: ${results.length} inputs at full speed, typed ahead and pasted`);
