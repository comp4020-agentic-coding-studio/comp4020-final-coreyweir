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
  const consoleErrors = [];
  const allConsole = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    allConsole.push(msg.text());
    if (msg.type() === "error") consoleErrors.push(msg.text());
    const t = msg.text();
    if (t.includes("bridge") || t.includes("Error")) console.log("[console]", msg.type(), t);
  });
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
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".terminal-controls button")].find((element) => element.textContent === "Start Bash");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Start Bash control was not found");
    button.click();
  });
  try {
    await page.waitForFunction(
      () => document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready"),
      { timeout: 120_000 },
    );
  } catch (error) {
    throw new Error(`WASIX Bash did not become ready: ${JSON.stringify({ consoleErrors, pageErrors })}`, { cause: error });
  }
  await page.locator(".terminal-target textarea").click();
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
      return /I have no name!@wasmer:\/work\/repo#/.test(text);
    },
    { timeout: 30_000 },
  );

  // Run a long-running FOREGROUND stub; then Ctrl-C it in the terminal.
  // SIGINT must reach the host bridge on the first attempt (wasix no longer
  // falls back to a stale image's abort handler).
  //
  // The token is assembled at runtime, so the contiguous form can only ever
  // be the stub's real stdout — the echoed command line carries the split
  // source. This matters because the point of the wait is to know the stub is
  // actually running before firing Ctrl-C: interrupting during startup is the
  // one arm this relay misses under (the rate probe's `startup` arm exists as
  // its control).
  //
  // An earlier attempt at this gate counted two occurrences of one literal —
  // echo plus output. Readline redraws the command as it wraps, so the echo
  // alone reached two and the wait returned before the stub had printed
  // anything, which quietly armed every run during startup and flaked under
  // aggregate load. And the runtime-built token could not be used as the
  // repair, because bridged `node -e` buffered all output until exit: a
  // long-running stub produced nothing at all, so any gate honest about real
  // stdout timed out. nodepod riff.41 made evaluated scripts stream; this gate
  // depends on that fix, and will time out here if it ever regresses — which
  // makes it also the canary for that bug.
  await page.keyboard.type(
    "node -e 'console.log(\"stub\" + \"-start\"); setInterval(()=>{},1000)'",
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
      return /stub-start/.test(text);
    },
    { timeout: 30_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 800));

  await page.keyboard.down("Control");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Control");

  await new Promise((resolve) => setTimeout(resolve, 4000));

  const snapshot = await page.evaluate(() => ({
    heading: document.querySelector(".terminal-heading")?.textContent,
    terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
  }));
  console.log(JSON.stringify(snapshot, null, 2));
  const relayed =
    (snapshot.heading ?? "").includes("signal SIGINT") ||
    allConsole.some((line) => line.includes("signal SIGINT"));
  assert.ok(relayed, `no bridge SIGINT relayed: ${JSON.stringify({ consoleErrors, pageErrors })}`);
  // The bash survived Ctrl-C (did not hard-crash the session).
  assert.doesNotMatch(snapshot.heading ?? "", /Aborted|fatal signal|recieved termination/);
  assert.match(snapshot.terminal ?? "", /stub-start/);

  // A background bridge request shares the interactive shell's channel but
  // not its foreground process group. Interrupting a local foreground loop
  // must leave that host process alive and return Bash to a usable prompt.
  await page.keyboard.type("node -e 'setTimeout(()=>console.log(\"bridge-bg-survived\"),2500)' & while true; do sleep 1; done");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("[bridge] pid="),
    { timeout: 10_000 },
  );
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Control");
  try {
    await page.waitForFunction(
      () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("bridge-bg-survived"),
      { timeout: 10_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`background bridge did not survive: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await page.keyboard.type("printf 'local-prompt-returned\\n'");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("local-prompt-returned"),
    { timeout: 10_000 },
  );
  console.log("Interactive Ctrl-C: stub SIGINT reached the host bridge.");
} finally {
  await browser.close();
}
