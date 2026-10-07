import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
let room = "";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const host = await browser.newPage();
  const pageErrors = [];
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.goto(`${baseUrl}/?setup=host`, { waitUntil: "networkidle0" });
  const hostInputs = await host.$$(".entry-card input");
  await hostInputs[0].type("Browser Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(`${baseUrl}/fake-anthropic`);
  await hostInputs[2].type("invalid-browser-smoke-token");
  await Promise.all([
    host.waitForNavigation({ waitUntil: "networkidle0" }),
    host.click(".entry-card .primary"),
  ]);
  room = await host.evaluate(() => new URL(location.href).searchParams.get("room") ?? "");
  assert(room);

  const headers = await host.evaluate(() => ({ isolated: crossOriginIsolated, worker: typeof SharedArrayBuffer !== "undefined" }));
  assert.deepEqual(headers, { isolated: true, worker: true });

  async function openTab(label) {
    await host.evaluate((next) => {
      const button = [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === next);
      button?.click();
    }, label);
  }

  await openTab("Board");
  assert.equal(await host.$eval(".board-wrap", (element) => getComputedStyle(element).display !== "none"), true);
  assert.equal(await host.$eval(".staging", (element) => getComputedStyle(element).display !== "none"), true);
  assert.equal(await host.$eval(".terminal-pane", (element) => element.offsetParent === null), true);

  await openTab("Preview");
  assert.equal(await host.$eval(".preview-pane", (element) => getComputedStyle(element).display !== "none"), true);
  assert.equal(await host.$eval(".terminal-pane", (element) => element.offsetParent === null), true);
  assert.equal((await host.$$(".staging")).length, 0);

  await openTab("Room");
  await host.locator(".terminal-controls button").click();
  await host.waitForSelector(".terminal-target .xterm", { timeout: 90_000 });
  await host.waitForFunction(
    () => Number(document.querySelector(".terminal-target")?.getAttribute("data-output-size")) > 200,
    { timeout: 90_000 },
  );

  const participantContext = await browser.createBrowserContext();
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => pageErrors.push(String(error)));
  await participant.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await participant.goto(baseUrl, { waitUntil: "networkidle0" });
  const participantInputs = await participant.$$(".entry-card input");
  await participantInputs[0].type("Browser Participant");
  await participantInputs[1].type(room);
  await Promise.all([
    participant.waitForNavigation({ waitUntil: "networkidle0" }),
    participant.click(".entry-card .primary"),
  ]);
  assert.equal(await participant.evaluate(() => new URL(location.href).searchParams.get("room")), room);
  assert.equal(await participant.evaluate(() => new URL(location.href).searchParams.has("preview")), false);
  await participant.evaluate(() => {
    const button = [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room");
    button?.click();
  });
  await participant.waitForFunction(
    () => Number(document.querySelector(".readonly-terminal")?.getAttribute("data-data-events")) > 0,
    { timeout: 30_000 },
  );

  assert.equal(await participant.$eval(".terminal-heading", (element) => element.textContent.includes("Host terminal live")), true);
  assert.equal(await participant.$eval(".readonly-terminal", (element) => getComputedStyle(element).overflow), "hidden");
  await participant.waitForFunction(() => [...document.querySelectorAll(".participants span")].some((element) => element.getAttribute("title") === "Browser Participant"));
  assert.equal((await participant.$$(".terminal-controls")).length, 0);
  await participantContext.close();
  assert.deepEqual(pageErrors, []);
  console.log("Tab layouts, one-click Claude rendering, and live participant data passed.");
} finally {
  await browser.close();
}
