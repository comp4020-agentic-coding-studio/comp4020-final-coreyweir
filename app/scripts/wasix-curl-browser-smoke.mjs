// Live egress acceptance. Requires Internet access as well as the dev server.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
try {
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.text().startsWith("curl acceptance")) console.log(message.text());
  });
  await page.goto(`${process.env.RIFF_URL ?? "http://127.0.0.1:8093"}/?poc=github-auth`, { waitUntil: "networkidle0" });
  const result = await page.evaluate(async () => {
    if (!crossOriginIsolated) throw new Error("Riff is not cross-origin isolated");
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const controller = new ClaudePodController({ baseUrl: "https://api.anthropic.com", token: "unused", repo: "" }, () => {});
    await controller.boot();
    async function bash(command) {
      const proc = await controller.pod.spawn("bash", ["-c", command]);
      return await new Promise((resolve, reject) => {
        let stdout = "", stderr = "";
        const timer = setTimeout(() => reject(new Error(`timeout: ${command}\n${stdout}\n${stderr}`)), 120_000);
        proc.on("output", (chunk) => { stdout += chunk; });
        proc.on("error", (chunk) => { stderr += chunk; });
        proc.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
    }
    try {
      const out = {};
      for (const [name, command] of Object.entries({
        version: "curl --version",
        // Browser fetch enforces CORS, so use a public HTTP origin that
        // explicitly allows it. `127.0.0.1` stays inside SplitNetworking's
        // guest loopback and deliberately never reaches any gateway.
        http: "curl -fsS --max-time 20 http://httpbin.org/get",
        head: "curl -fsSI --max-time 20 http://httpbin.org/get",
        // Curl's TLS session terminates inside this tab using the ephemeral
        // browser-generated CA installed in the WASIX session. Fetch then
        // creates a separate, browser-validated TLS connection to the origin.
        https: "curl -fsS --max-time 20 https://httpbin.org/get",
        recovery: "printf 'after-curl\\n'",
      })) {
        out[name] = await bash(command);
        console.log(`curl acceptance ${name}: ${JSON.stringify(out[name])}`);
      }
      return out;
    } finally {
      await controller.dispose();
    }
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.version.code, 0);
  assert.match(result.version.stdout, /curl 8\.21\.0/);
  assert.equal(result.http.code, 0, result.http.stderr);
  assert.match(result.http.stdout, /"url": "http:\/\/httpbin\.org\/get"/);
  assert.equal(result.head.code, 0, result.head.stderr);
  assert.match(result.head.stdout, /HTTP\/1\.1 200/);
  assert.equal(result.https.code, 0, result.https.stderr);
  assert.match(result.https.stdout, /"url": "https:\/\/httpbin\.org\/get"/);
  assert.equal(result.recovery.code, 0);
  assert.match(result.recovery.stdout, /after-curl/);
  console.log("WASIX curl browser acceptance passed");
} finally {
  await browser.close();
}
