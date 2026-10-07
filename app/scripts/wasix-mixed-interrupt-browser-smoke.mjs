import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  const browserMessages = [];
  page.on("console", (message) => browserMessages.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => browserMessages.push(`[pageerror] ${error.stack ?? error.message}`));
  await page.setViewport({ width: 900, height: 900 });
  await page.goto(`${baseUrl}/?setup=host`, { waitUntil: "networkidle0" });
  const inputs = await page.$$(".entry-card input");
  await inputs[0].type("WASIX Mixed Interrupt");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].type("invalid-browser-smoke-token");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click(".entry-card .primary"),
  ]);
  await page.evaluate(() => {
    [...document.querySelectorAll(".topbar nav button")]
      .find((element) => element.textContent === "Room")?.click();
    const button = [...document.querySelectorAll(".terminal-controls button")]
      .find((element) => element.textContent === "Start Bash");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Start Bash control was not found");
    button.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready"),
    { timeout: 120_000 },
  );
  await page.locator(".terminal-target textarea").click();
  const command = "(while true; do echo hi; sleep 1; done) & while true; do echo hello; sleep 3; done";
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".terminal-target .xterm-rows > div")]
      .some((row) => row.textContent?.trim() === "hello"),
    { timeout: 30_000 },
  );
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Control");
  try {
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll(".terminal-target .xterm-rows > div")];
        return document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready")
          && rows.some((row) => row.textContent?.trim().endsWith("I have no name!@wasmer:/work/repo#"));
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      note: document.querySelector(".terminal-note")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`Mixed interrupt did not return to Bash: ${JSON.stringify({ ...diagnostics, browserMessages })}`, { cause: error });
  }
  assert.match(await page.$eval(".terminal-heading", (element) => element.textContent ?? ""), /WASIX Bash ready/);
  assert.doesNotMatch(await page.$eval(".terminal-target .xterm-rows", (element) => element.textContent ?? ""), /restarting session/);

  const afterPrompt = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".terminal-target .xterm-rows > div")];
    return {
      hi: rows.filter((row) => row.textContent?.trim() === "hi").length,
      hello: rows.filter((row) => row.textContent?.trim() === "hello").length,
    };
  });
  await page.waitForFunction(
    (count) => [...document.querySelectorAll(".terminal-target .xterm-rows > div")]
      .filter((row) => row.textContent?.trim() === "hi").length > count,
    { timeout: 4_000 },
    afterPrompt.hi,
  );
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const afterWait = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".terminal-target .xterm-rows > div")];
    return {
      hi: rows.filter((row) => row.textContent?.trim() === "hi").length,
      hello: rows.filter((row) => row.textContent?.trim() === "hello").length,
    };
  });
  assert.ok(afterWait.hi > afterPrompt.hi, "The background loop stopped after Ctrl-C");
  assert.equal(afterWait.hello, afterPrompt.hello, "The foreground loop continued after Ctrl-C");

  await page.keyboard.type("kill $!; wait $! 2>/dev/null; printf '[mixed-interrupt-clean]' ");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("[mixed-interrupt-clean]"),
    { timeout: 30_000 },
  );
  const afterKill = await page.evaluate(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")]
    .filter((row) => row.textContent?.trim() === "hi").length);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const afterKillWait = await page.evaluate(() => [...document.querySelectorAll(".terminal-target .xterm-rows > div")]
    .filter((row) => row.textContent?.trim() === "hi").length);
  assert.equal(afterKillWait, afterKill, "kill $! left the background loop running");
  console.log("Mixed WASIX jobs route Ctrl-C only to the foreground loop.");
} finally {
  await browser.close();
}
