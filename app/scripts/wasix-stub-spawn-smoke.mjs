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
    const { probeStubSpawnInWorker } = await import("/src/wasixStubProbe.ts");
    return probeStubSpawnInWorker();
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join("\n"));

  assert.equal(result.direct.exit, true, `direct stub did not exit: ${result.direct.note}`);
  assert.equal(result.direct.code, 42, `direct exit ${result.direct.code}`);
  assert.match(result.direct.stdout, /cwd=\/work/, `direct cwd wrong: ${result.direct.stdout}`);
  assert.match(result.direct.stdout, /argv\[1\]=argv/, `direct argv1 wrong: ${result.direct.stdout}`);
  assert.match(result.direct.stdout, /argv\[2\]=one/, `direct argv2 wrong: ${result.direct.stdout}`);
  assert.match(result.direct.stdout, /argv\[3\]=two/, `direct argv3 wrong: ${result.direct.stdout}`);
  assert.match(result.direct.stdout, /RIFF_STUB_PROBE=via-direct/, `direct env wrong: ${result.direct.stdout}`);
  assert.match(result.direct.stderr, /stderr-here/, `direct stderr wrong: ${result.direct.stderr}`);

  assert.equal(result.viaBash.exit, true, `bash stub did not exit: ${result.viaBash.note}`);
  assert.equal(result.viaBash.code, 42, `bash exit ${result.viaBash.code}`);
  assert.match(result.viaBash.stdout, /cwd=\/mounted/, `bash cwd wrong: ${result.viaBash.stdout}`);
  assert.match(result.viaBash.stdout, /argv\[1\]=one/, `bash argv1 wrong: ${result.viaBash.stdout}`);
  assert.match(result.viaBash.stdout, /argv\[2\]=two/, `bash argv2 wrong: ${result.viaBash.stdout}`);
  assert.match(result.viaBash.stdout, /argv\[1\]=one/, `bash argv1 wrong: ${result.viaBash.stdout}`);
  assert.match(result.viaBash.stdout, /argv\[2\]=two/, `bash argv2 wrong: ${result.viaBash.stdout}`);
  assert.match(result.viaBash.stdout, /RIFF_STUB_PROBE=via-bash/, `bash env wrong: ${result.viaBash.stdout}`);
  assert.match(result.viaBash.stderr, /stderr-here/, `bash stderr wrong: ${result.viaBash.stderr}`);
} finally {
  await browser.close();
}
