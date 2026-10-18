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
  // Host through the landing page: the server creates the room, and the
  // page moves to ?id=<room id>. The join code is shown in the top bar.
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  const hostInputs = await host.$$(".entry-card form input");
  await hostInputs[0].type("Browser Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(`${baseUrl}/fake-anthropic`);
  await hostInputs[2].type("invalid-browser-smoke-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  room = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  assert.match(room, /^[A-Z2-9]{6}$/);

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
  // Join from the share link alone, as a pod member would: the code is
  // prefilled, so a name is all it takes.
  await participant.goto(`${baseUrl}/?room=${room.toLowerCase()}`, { waitUntil: "networkidle0" });
  await participant.waitForSelector(".entry-card form");
  const participantInputs = await participant.$$(".entry-card form input");
  await participantInputs[0].type("Browser Participant");
  await participant.click(".entry-card form .primary");
  await participant.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  assert.equal(
    await participant.evaluate(() => new URL(location.href).searchParams.get("id")),
    await host.evaluate(() => new URL(location.href).searchParams.get("id")),
  );
  assert.equal(await participant.evaluate(() => new URL(location.href).searchParams.has("preview")), false);
  await participant.evaluate(() => {
    const button = [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room");
    button?.click();
  });
  // A late joiner first gets the host's latest snapshot. Claude may be idle
  // by then (the fake endpoint fails at once), so live data only follows
  // once the host's screen changes: type into the host's terminal.
  await participant.waitForFunction(
    () => Number(document.querySelector(".readonly-terminal")?.getAttribute("data-checkpoint-renders")) > 0,
    { timeout: 30_000 },
  );
  await host.click(".terminal-target .xterm");
  await host.keyboard.type("riff smoke");
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
