import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8094";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  const workerRequests = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().includes("/__worker__.js?")) workerRequests.push(request.url());
    if (!request.url().startsWith("https://api.github.com/")) {
      request.continue();
      return;
    }
    const headers = request.headers();
    delete headers.authorization;
    request.continue({ headers });
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  await page.evaluate(async () => {
    const target = document.createElement("div");
    target.className = "terminal-target";
    target.style.cssText = "position:fixed;inset:0;background:#171816";
    document.body.append(target);
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
      githubToken: "deliberately-invalid-smoke-token",
    }, () => {});
    await controller.boot();
    controller.attach(target);
    window.__gitSmokeController = controller;
  });
  await page.waitForSelector(".terminal-target .xterm", { timeout: 90_000 });

  await page.$eval(".terminal-target .xterm-helper-textarea", (element) => element.focus());
  await page.keyboard.type("bash -lc 'git init delegated'", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target")?.textContent?.includes("Initialized empty Git repository"),
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => window.__gitSmokeController.terminal._running === false,
    { timeout: 30_000 },
  );

  await page.keyboard.type("bash -lc 'git clone https://github.com/comp4020-agentic-coding-studio/comp4020-crit1-coreyweir.git'", { delay: 2 });
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => window.__gitSmokeController?.pod?.fs.exists("/work/repo/comp4020-crit1-coreyweir/.git"),
      { timeout: 90_000 },
    );
  } catch (error) {
    const terminalText = await page.$eval(".terminal-target", (element) => element.textContent ?? "");
    throw new Error(`${String(error)}\nTerminal output:\n${terminalText}`);
  }
  await page.waitForFunction(
    () => window.__gitSmokeController.terminal._running === false,
    { timeout: 90_000 },
  );
  await page.keyboard.type("test -d comp4020-crit1-coreyweir/.git && echo clone_visible", { delay: 2 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target")?.textContent?.includes("clone_visible"),
    { timeout: 30_000 },
  );

  const terminalText = await page.$eval(".terminal-target", (element) => element.textContent ?? "");
  const heading = await page.evaluate(async () => {
    const bytes = await window.__gitSmokeController.pod.fs.readFile("/work/repo/comp4020-crit1-coreyweir/index.html");
    return new TextDecoder().decode(bytes).match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1] ?? "";
  });
  assert(heading.includes("🔁 THE LOOP 🔁"), heading);
  assert(!terminalText.includes("sync-supported git command"), terminalText);
  assert(workerRequests.some((url) => /\/__worker__\.js\?dev=\d+$/.test(url)), workerRequests);
  assert.deepEqual(pageErrors, []);
  console.log("Browser Mithic Git commands delegate to Nodepod workers");
} finally {
  await browser.close();
}
