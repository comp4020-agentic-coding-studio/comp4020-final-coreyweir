import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

// The participants' mirror must show the host's terminal as the host sees
// it: the same columns and rows, so Claude's TUI lays out the same, and the
// whole of it inside the participant's box. Run both ways round: a desktop
// host watched from a phone, and a phone host watched from a desktop.
//
// What this can't tell apart: it compares the visible screens (the DOM
// renderer's rows), not scrollback; and "fits" is measured from layout
// boxes, not by looking at pixels.

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const desktop = { width: 1920, height: 1080, deviceScaleFactor: 1 };
const phone = { width: 390, height: 844, deviceScaleFactor: 1 };
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

async function openRoomTab(page) {
  await page.waitForSelector(".topbar nav button");
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room");
    button?.click();
  });
}

function screenOf(selector) {
  return (page) => page.$eval(selector, (target) => {
    const rows = [...target.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent.replace(/\u00a0/g, " ").trimEnd());
    const screen = target.querySelector(".xterm-screen").getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return {
      rows,
      cols: Number(target.dataset.cols),
      rowCount: Number(target.dataset.rows),
      screen: { left: screen.left, right: screen.right, top: screen.top, bottom: screen.bottom, width: screen.width },
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width },
    };
  });
}
const hostScreen = screenOf(".terminal-target:not(.readonly-terminal)");
const participantScreen = screenOf(".readonly-terminal");

async function run(hostViewport, participantViewport, label) {
  const pageErrors = [];
  const hostContext = await browser.createBrowserContext();
  const host = await hostContext.newPage();
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.setViewport(hostViewport);
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const hostInputs = await host.$$(".entry-card form input:not([type=radio])");
  await hostInputs[0].type("Size Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(`${baseUrl}/fake-anthropic`);
  await hostInputs[2].type("invalid-size-smoke-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const room = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  await openRoomTab(host);
  await host.locator(".terminal-controls button").click();
  await host.waitForSelector(".terminal-target .xterm", { timeout: 90_000 });
  await host.waitForFunction(
    () => Number(document.querySelector(".terminal-target")?.getAttribute("data-output-size")) > 200,
    { timeout: 90_000 },
  );

  const participantContext = await browser.createBrowserContext();
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => pageErrors.push(String(error)));
  await participant.setViewport(participantViewport);
  await participant.goto(`${baseUrl}/?room=${room.toLowerCase()}`, { waitUntil: "networkidle0" });
  await participant.waitForSelector(".entry-card form");
  const participantInputs = await participant.$$(".entry-card form input");
  await participantInputs[0].type("Size Participant");
  await participant.click(".entry-card form .primary");
  await participant.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await openRoomTab(participant);
  await participant.waitForFunction(
    () => Number(document.querySelector(".readonly-terminal")?.getAttribute("data-checkpoint-renders")) > 0,
    { timeout: 30_000 },
  );
  // The host resizes their window while the participant watches: the host's
  // terminal refits, Claude redraws at the new size, and the mirror follows.
  const before = await hostScreen(host);
  await host.setViewport({ ...hostViewport, width: hostViewport.width - 200, height: hostViewport.height - 100 });
  await host.waitForFunction((cols) => Number(document.querySelector(".terminal-target")?.dataset.cols) !== cols, { timeout: 10_000 }, before.cols);
  await participant.waitForFunction(
    () => Number(document.querySelector(".readonly-terminal")?.getAttribute("data-data-events")) > 0,
    { timeout: 30_000 },
  );

  // The screens settle once the host stops drawing; poll until they agree.
  let hostView;
  let participantView;
  const deadline = Date.now() + 15_000;
  do {
    hostView = await hostScreen(host);
    participantView = await participantScreen(participant);
    if (JSON.stringify(hostView.rows) === JSON.stringify(participantView.rows)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);

  if (process.env.SHOTS) {
    await host.screenshot({ path: `${process.env.SHOTS}/${label.replace(/\W+/g, "-")}-host.png` });
    await participant.screenshot({ path: `${process.env.SHOTS}/${label.replace(/\W+/g, "-")}-participant.png` });
  }
  console.log(`${label}: host ${hostView.cols}x${hostView.rowCount}, participant ${participantView.cols}x${participantView.rowCount}`);
  console.log(`${label}: participant box ${JSON.stringify(participantView.box)} screen ${JSON.stringify(participantView.screen)}`);
  assert.ok(hostView.rows.some((row) => /Yes, I accept/.test(row)), "the host's screen shows Claude's dialog");
  assert.equal(participantView.cols, hostView.cols, "same columns");
  assert.equal(participantView.rowCount, hostView.rowCount, "same rows");
  assert.deepEqual(participantView.rows, hostView.rows, "the participant's screen matches the host's line for line");
  // The whole of the host's screen is inside the participant's box: nothing
  // cut off at the right or the bottom (within a pixel of rounding).
  assert.ok(participantView.screen.left >= participantView.box.left - 1, "not cut off at the left");
  assert.ok(participantView.screen.right <= participantView.box.right + 1, "not cut off at the right");
  assert.ok(participantView.screen.bottom <= participantView.box.bottom + 1, "not cut off at the bottom");

  // "Actual size" is the host's own font size; whatever doesn't fit scrolls.
  await participant.click(".mirror-mode");
  await participant.waitForFunction(() => document.querySelector(".readonly-terminal")?.dataset.mode === "actual");
  await participant.waitForFunction((width) => document.querySelector(".readonly-terminal .xterm-screen").getBoundingClientRect().width > width + 1, { timeout: 5_000 }, participantView.screen.width).catch(() => undefined);
  const actual = await participantScreen(participant);
  const scroll = await participant.$eval(".readonly-terminal", (box) => ({ overflow: getComputedStyle(box).overflow, scrolls: box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight }));
  console.log(`${label}: actual size screen ${actual.screen.width}px wide, box scrolls: ${scroll.scrolls}`);
  assert.deepEqual(actual.rows, hostView.rows, "actual size shows the same lines");
  assert.equal(scroll.overflow, "auto");
  if (actual.screen.width > actual.box.width) assert.equal(scroll.scrolls, true, "what doesn't fit can be scrolled to");
  await participant.click(".mirror-mode");

  await participantContext.close();
  await hostContext.close();
  assert.deepEqual(pageErrors, []);
}

try {
  await run(desktop, phone, "desktop host, phone participant");
  await run(phone, desktop, "phone host, desktop participant");
  console.log("The participant's mirror matched the host's screen line for line, and fit its box, both ways round.");
} finally {
  await browser.close();
}
