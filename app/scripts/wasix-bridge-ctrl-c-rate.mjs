// Measures the miss rate of the bridge Ctrl-C relay.
//
// The regular smoke (wasix-bridge-ctrl-c-smoke.mjs) is a single-shot pass/fail.
// This classifies each Ctrl-C independently.
//
//   RIFF_TRIALS=20    number of trials (default 20)
//   RIFF_MODE=session all trials in one booted Bash (default)
//   RIFF_MODE=fresh   one trial per freshly booted page/session
//   RIFF_ARM=post     fire Ctrl-C ~800 ms after the stub's real stdout (default)
//   RIFF_ARM=startup  fire Ctrl-C immediately after Enter, before the stub has
//                     reached main()'s signal() calls
//
// Two things this measures that the docs' "~1/5" figure did not:
//
//  * ARM. The original rate was taken with a broken wait that fired Ctrl-C
//    during stub startup. `post` is the honest steady-state arm; `startup`
//    deliberately reproduces the old condition, and is the control for the
//    registration-window hypothesis (libc's __sigaction_inner tells the runtime
//    a handler exists *before* storing it in its own table).
//  * MODE. `session` reuses one Bash, so trial N sees whatever state trials
//    1..N-1 left in the runtime's process tree and the host bridge. `fresh`
//    isolates each trial. A large gap between the two modes means the fault is
//    accumulated session state, not a per-signal race.
//
// Gating notes (both were wrong in the first cut and inverted the result):
//  * "at a prompt" cannot be tested by matching the prompt in the scrollback --
//    it is already there from the previous trial, so the wait returns instantly
//    and the next command is typed into a shell that has not come back. Each
//    trial instead makes the shell echo a fresh token.
//  * the libc abort banner cannot be tested by presence, for the same reason.
//    Trials classify on the count delta.
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const trials = Number(process.env.RIFF_TRIALS ?? 20);
const arm = process.env.RIFF_ARM ?? "post";
const mode = process.env.RIFF_MODE ?? "session";
if (arm !== "post" && arm !== "startup") throw new Error(`RIFF_ARM must be post|startup, got ${arm}`);
if (mode !== "session" && mode !== "fresh") throw new Error(`RIFF_MODE must be session|fresh, got ${mode}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 240_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const results = [];

/** Boot a page all the way to a live WASIX Bash prompt. */
async function bootPage() {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewport({ width: 620, height: 700 });
  await page.goto(`${baseUrl}/?setup=host`, { waitUntil: "networkidle0" });
  const inputs = await page.$$(".entry-card input");
  await inputs[0].type("WASIX Host");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].type("invalid-browser-smoke-token");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click(".entry-card .primary"),
  ]);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room");
    button?.click();
  });

  // Every report() overwrites the same heading element, so a poll after the
  // fact can miss a transient status. Record the history instead.
  await page.evaluate(() => {
    window.__headings = [];
    setInterval(() => {
      const text = document.querySelector(".terminal-heading")?.textContent ?? "";
      const last = window.__headings[window.__headings.length - 1];
      if (text && text !== last) window.__headings.push(text);
    }, 20);
  });

  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".terminal-controls button")].find((element) => element.textContent === "Start Bash");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Start Bash control was not found");
    button.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready"),
    { timeout: 180_000 },
  );
  await page.locator(".terminal-target textarea").click();
  await page.waitForFunction(
    () => /I have no name!@wasmer:\/work\/repo#/.test(document.querySelector(".terminal-target .xterm-rows")?.textContent ?? ""),
    { timeout: 30_000 },
  );
  return { page, pageErrors };
}

const terminalTextOf = (page) =>
  page.evaluate(() => document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "");
const countIn = (text, re) => [...text.matchAll(re)].length;
const ABORT_RE = /recieved termination signal|fatal signal: Aborted/g;

/** Prove the shell is live and accepting input by making it echo a fresh token. */
async function waitForLivePrompt(page, tag) {
  const token = `rdy${tag}z`;
  await page.keyboard.type(`echo ${token}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (t) => {
      const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
      return [...text.matchAll(new RegExp(t, "g"))].length >= 2;
    },
    { timeout: 30_000 },
    token,
  );
}

/** One Ctrl-C trial against a foreground bridged stub. */
async function runTrial(page, trial) {
  const before = await page.evaluate(() => window.__headings.length);
  const abortsBefore = countIn(await terminalTextOf(page), ABORT_RE);

  // The marker is assembled at runtime, so the contiguous form can only be
  // real stdout. This used to wait for two occurrences of one literal — echo
  // plus output — which readline defeats by redrawing the line as it wraps:
  // the echo alone reached two, the wait returned before the stub had printed
  // anything, and `post` silently measured `startup`, the arm it exists to be
  // the control for. Depends on nodepod riff.41 making evaluated scripts
  // stream; if that regresses this reports NO_START rather than a false RELAY.
  const printed = `stubstart${trial}x`;
  await page.keyboard.type(
    `node -e 'console.log("stubstart" + "${trial}x"); setInterval(()=>{},1000)'`,
  );
  await page.keyboard.press("Enter");

  if (arm === "post") {
    try {
      await page.waitForFunction(
        (m) => {
          const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
          return new RegExp(m).test(text);
        },
        { timeout: 30_000 },
        printed,
      );
    } catch {
      return { trial, outcome: "NO_START" };
    }
    await sleep(800);
  } else {
    await sleep(Number(process.env.RIFF_STARTUP_DELAY ?? 0));
  }

  await page.keyboard.down("Control");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Control");

  let relayed = false;
  for (let i = 0; i < 60 && !relayed; i++) {
    await sleep(100);
    relayed = await page.evaluate(
      (n) => window.__headings.slice(n).some((h) => h.includes("signal SIGINT")),
      before,
    );
  }
  if (!relayed) await sleep(2000);

  const abortsAfter = countIn(await terminalTextOf(page), ABORT_RE);
  const outcome = relayed ? "RELAY" : abortsAfter > abortsBefore ? "MISS_ABORT" : "MISS_OTHER";
  return { trial, outcome };
}

const report = (trial, result) => {
  console.log(`trial ${trial + 1}/${trials} [${arm}/${mode}]: ${result.outcome}`);
};

try {
  if (mode === "session") {
    const { page, pageErrors } = await bootPage();
    for (let trial = 0; trial < trials; trial++) {
      try {
        await waitForLivePrompt(page, trial);
      } catch {
        results.push({ trial, outcome: "SESSION_LOST" });
        console.log(`--- terminal at SESSION_LOST (trial ${trial + 1}) ---`);
        console.log(await terminalTextOf(page));
        break;
      }
      const result = await runTrial(page, trial);
      results.push(result);
      report(trial, result);
    }
    if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 5));
  } else {
    for (let trial = 0; trial < trials; trial++) {
      const { page, pageErrors } = await bootPage();
      try {
        const result = await runTrial(page, trial);
        results.push(result);
        report(trial, result);
        if (pageErrors.length) console.log("  page errors:", pageErrors.slice(0, 3));
      } finally {
        await page.close();
      }
    }
  }

  const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  const scored = results.filter((r) => r.outcome === "RELAY" || r.outcome.startsWith("MISS"));
  const misses = scored.filter((r) => r.outcome.startsWith("MISS")).length;
  console.log("\n=== summary ===");
  console.log(JSON.stringify({
    arm,
    mode,
    trials: results.length,
    scored: scored.length,
    counts,
    missRate: scored.length === 0 ? null : misses / scored.length,
    sequence: results.map((r) => r.outcome).join(","),
  }, null, 2));
} finally {
  await browser.close();
}
