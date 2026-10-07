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
    const { probePipeWriteInWorker } = await import("/src/wasixPipeWriteProbe.ts");
    return probePipeWriteInWorker();
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(result.directBash.hostGot, "hello-from-guest", `host got ${JSON.stringify(result.directBash.hostGot)}`);
  assert.equal(result.directBash.code, 0, `directBash exit ${result.directBash.code} stderr=${result.directBash.stderr}`);

  assert.equal(result.viaWasm.code, 0, `viaWasm exit ${result.viaWasm.code} stderr=${JSON.stringify(result.viaWasm.stderr)}`);
  assert.equal(result.viaWasm.hostGot, "hello-from-wasm\n", `viaWasm host got ${JSON.stringify(result.viaWasm.hostGot)}`);
} finally {
  await browser.close();
}
