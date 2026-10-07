import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  protocolTimeout: 240_000,
});

try {
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  const errors = [];
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) {
      errors.push(String(error));
    }
  });
  page.on("workercreated", (worker) => {
    console.log(`[worker created] ${worker.url()}`);
    worker.on("console", (message) => console.log(`[worker] ${message.text()}`));
    worker.on("error", (error) => console.log(`[worker error] ${String(error)}`));
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const { probeBridgeRpcInWorker } = await import("/src/wasixBridgeRpcProbe.ts");
    return probeBridgeRpcInWorker();
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join("\n"));

  assert.equal(result.echo.exit, true, `echo did not exit: ${result.echo.stderr}`);
  assert.ok(Object.keys(result.echo.request).length > 0, `echo request never arrived; stderr=${JSON.stringify(result.echo.stderr)}`);
  assert.equal(result.echo.code, 7, `echo exit code not propagated: ${result.echo.code}`);
  assert.match(result.echo.stdout, /mock argv=/, `echo stdout wrong: ${result.echo.stdout}`);
  assert.match(result.echo.stdout, /mock cwd=\/mounted/, `echo cwd wrong: ${result.echo.stdout}`);
  assert.equal(result.echo.request.argv[0], "argv", `echo argv0 ${result.echo.request.argv}`);
  assert.equal(result.echo.request.argv[1], "one", `echo argv1 ${result.echo.request.argv}`);
  assert.equal(result.echo.request.cwd, "/mounted", `echo cwd ${result.echo.request.cwd}`);

  assert.equal(result.exit.exit, true, `exit did not exit: ${result.exit.stderr}`);
  assert.ok(Object.keys(result.exit.request).length > 0, `exit request never arrived; stderr=${JSON.stringify(result.exit.stderr)}`);
  assert.equal(result.exit.code, 42, `exit code not propagated: ${result.exit.code}`);
  assert.equal(result.exit.stdout.trim(), "after=42", `exit stdout ${JSON.stringify(result.exit.stdout)}`);
  assert.equal(result.exit.stderr, "", `exit stderr ${JSON.stringify(result.exit.stderr)}`);
} finally {
  await browser.close();
}
