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
    const { probeHostPipeInWorker } = await import("/src/wasixFpipeProbe.ts");
    return probeHostPipeInWorker();
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(result.hostToGuestSized.exitedBeforeWrite, false, `head exited before the host wrote: ${JSON.stringify(result.hostToGuestSized)}`);
  assert.ok(result.hostToGuestSized.blockedMs >= 400, `head did not stay blocked long enough: ${result.hostToGuestSized.blockedMs} ms`);
  assert.equal(result.hostToGuestSized.code, 0, `head exit ${result.hostToGuestSized.code} stderr=${result.hostToGuestSized.stderr}`);
  assert.equal(result.hostToGuestSized.stdout, "hello-from-host\n");
  assert.ok(result.hostToGuestSized.writeToExitMs < 2_000, `host→guest still slow after skipping stdin close: ${result.hostToGuestSized.writeToExitMs} ms`);
  assert.equal(result.hostToGuestEof.code, -1, "EOF cat case should stay skipped this run");
  assert.equal(result.guestToHost.readBeforeWrite, false, `host read returned before guest write: ${JSON.stringify(result.guestToHost)}`);
  assert.ok(result.guestToHost.blockedMs >= 400, `host read did not stay blocked long enough: ${result.guestToHost.blockedMs} ms`);
  assert.equal(result.guestToHost.text.trim(), "hello-from-guest");
  assert.equal(result.framed.request, "PING", `framed request ${JSON.stringify(result.framed)}`);
  assert.equal(result.framed.code, 0, `framed exit ${result.framed.code} stderr=${result.framed.stderr}`);
  assert.equal(result.framed.stdout, "PONG");
  assert.ok(result.framed.requestMs < 5_000, `framed request still slow: ${result.framed.requestMs} ms`);
  assert.ok(result.framed.replyToExitMs < 2_000, `framed reply still slow: ${result.framed.replyToExitMs} ms`);
} finally {
  await browser.close();
}
