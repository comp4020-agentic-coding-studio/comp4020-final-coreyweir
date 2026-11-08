import assert from "node:assert/strict";
import { utimes } from "node:fs/promises";
import puppeteer from "puppeteer-core";

// ADR 0001's redeploy gap: a restarted relay has no snapshot, and the host
// used to skip a snapshot identical to the last one it sent, so until the
// host's screen changed a latecomer saw nothing. And a participant who was
// already watching ignored the restarted relay's events, whose numbering
// starts at 1 again. Claude sits idle on its first dialog here, so the
// host's screen doesn't change on its own.
//
// The restart is the dev server's: touching a server file makes Vite
// restart it, which drops the relay's rooms as a redeploy does. So this runs
// against a dev server started from this checkout (RIFF_URL, default
// http://127.0.0.1:8093), not against live. A deployed page has no Vite
// client; a dev page's would reload itself once the server is back, which a
// redeploy doesn't do, so the pages here get a Vite client that doesn't.
//
// What this can't tell apart: a restart on fly also restarts nginx and the
// proxy (sockets close ~3 s later there); this one closes them at once.

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const serverFile = new URL("../server/riff.mjs", import.meta.url);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

async function withoutViteReload(page) {
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    if (!new URL(request.url()).pathname.endsWith("/@vite/client")) return request.continue();
    const original = await fetch(request.url());
    const body = (await original.text()).replaceAll("location.reload()", "void 0");
    await request.respond({ status: 200, contentType: "text/javascript", body });
  });
}

async function openRoomTab(page) {
  await page.waitForSelector(".topbar nav button");
  await page.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room")?.click());
}

const rows = (selector) => (page) => page.$eval(selector, (target) => [...target.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent.replace(/\u00a0/g, " ").trimEnd()));
const hostRows = rows(".terminal-target:not(.readonly-terminal)");
const mirrorRows = rows(".readonly-terminal");
const renders = (page) => page.$eval(".readonly-terminal", (element) => Number(element.dataset.checkpointRenders));

async function join(room, name) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await withoutViteReload(page);
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/?room=${room.toLowerCase()}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".entry-card form");
  await (await page.$(".entry-card form input")).type(name);
  await page.click(".entry-card form .primary");
  await page.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await openRoomTab(page);
  return page;
}

async function sameScreen(host, participant, label) {
  const deadline = Date.now() + 10_000;
  let expected;
  let actual;
  do {
    expected = await hostRows(host);
    actual = await mirrorRows(participant);
    if (JSON.stringify(expected) === JSON.stringify(actual)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, expected, label);
}

const pageErrors = [];
try {
  const host = await browser.newPage();
  await withoutViteReload(host);
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.setViewport({ width: 1280, height: 900 });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const hostInputs = await host.$$(".entry-card form input:not([type=radio])");
  await hostInputs[0].type("Redeploy Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(`${baseUrl}/fake-anthropic`);
  await hostInputs[2].type("invalid-redeploy-smoke-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const room = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  await openRoomTab(host);
  await host.locator(".terminal-controls button").click();
  await host.waitForFunction(() => /Yes, I accept/.test(document.querySelector(".terminal-target .xterm-rows")?.textContent ?? ""), { timeout: 90_000 });

  const early = await join(room, "Early Participant");
  // The host's first snapshot, or its output from the first byte if that
  // snapshot hasn't been sent yet: either way the screen is drawn.
  await early.waitForFunction(() => Number(document.querySelector(".readonly-terminal")?.dataset.checkpointRenders) + Number(document.querySelector(".readonly-terminal")?.dataset.dataEvents) > 0, { timeout: 30_000 });
  await sameScreen(host, early, "the early participant sees the host's screen");
  // Let the host's screen settle into "already sent" before the restart.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const rendersBefore = await renders(early);
  const sequenceBefore = await early.$eval(".readonly-terminal", (element) => Number(element.dataset.sequence));

  const now = new Date();
  await utimes(serverFile, now, now);
  // Vite restarts the server and the pages reconnect (every 1.2 s). There's
  // nothing on the page to wait on that the restart changes for certain, so
  // give it a few seconds; the waits below are what's checked.
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  // A latecomer to the restarted relay sees the host's screen, though it
  // hasn't changed since before the restart.
  const late = await join(room, "Late Participant");
  await late.waitForFunction(() => Number(document.querySelector(".readonly-terminal")?.dataset.checkpointRenders) > 0, { timeout: 15_000 })
    .catch(async (error) => {
      const state = {
        host: await host.evaluate(() => ({ heading: document.querySelector(".terminal-heading")?.textContent, note: document.querySelector(".terminal-note")?.textContent })),
        late: await late.evaluate(() => ({ heading: document.querySelector(".terminal-heading")?.textContent, note: document.querySelector(".terminal-note")?.textContent, data: { ...document.querySelector(".readonly-terminal")?.dataset } })),
      };
      throw new Error(`A latecomer after the restart saw no snapshot: ${JSON.stringify(state)}`, { cause: error });
    });
  await sameScreen(host, late, "the latecomer sees the host's screen");

  // The early participant took the restarted relay's snapshot too, rather
  // than ignoring its lower sequence numbers.
  await early.waitForFunction((before) => Number(document.querySelector(".readonly-terminal")?.dataset.checkpointRenders) > before, { timeout: 15_000 }, rendersBefore)
    .catch((error) => { throw new Error("The early participant ignored the restarted relay", { cause: error }); });
  const sequenceAfter = await early.$eval(".readonly-terminal", (element) => Number(element.dataset.sequence));
  console.log(`early participant: sequence ${sequenceBefore} before the restart, ${sequenceAfter} after`);
  await sameScreen(host, early, "the early participant still sees the host's screen");

  assert.deepEqual(pageErrors, []);
  console.log("After a relay restart, a latecomer and an earlier participant both saw the host's unchanged screen.");
} finally {
  await browser.close();
}
