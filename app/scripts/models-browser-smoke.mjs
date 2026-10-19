// Riff's own free models, end to end (docs/adr/0009): a host who brings
// no key creates a room with the default choice, Claude Code starts in
// their browser, a prompt goes through /api/model to OpenRouter, and the
// answer shows on a participant's read-only terminal.
//
// This makes one real model call on Riff's key (free model, counted
// against the shared daily limit). Works on dev or live (RIFF_URL).
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const [width, height] = [Number(process.env.W ?? 1920), Number(process.env.H ?? 1080)];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const screenText = (page, selector) => page.$eval(selector, (element) => element.querySelector(".xterm-rows")?.textContent ?? "").catch(() => "");

let host;
let roomId = "";
let secret = "";
try {
  host = await browser.newPage();
  await host.setViewport({ width, height, deviceScaleFactor: 1 });
  const pageErrors = [];
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");

  // The default needs no endpoint and no token.
  await host.waitForSelector(".model-choice", { timeout: 5_000 });
  assert.equal(await host.$eval(".model-choice label:nth-of-type(1) input", (input) => input.checked), true);
  assert.equal(await host.$("input[type=password]"), null, "no token field with Riff's models");
  assert.equal(await host.$("input[type=url]"), null, "no endpoint field with Riff's models");
  await host.type(".entry-card form input:not([type=radio])", "Model Host");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  roomId = await host.evaluate(() => new URL(location.href).searchParams.get("id"));
  secret = await host.evaluate((id) => localStorage.getItem(`riff-member:${id}`), roomId);
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  const code = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  // The config kept in the browser holds no model key: the key comes from
  // the server for this room, each time the host opens it.
  const saved = await host.evaluate(() => JSON.parse(localStorage.getItem("riff-host-config")));
  assert.deepEqual({ models: saved.models, token: saved.token }, { models: "riff", token: "" });

  await host.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room")?.click());
  await host.locator(".terminal-controls button").click();
  await host.waitForSelector(".terminal-target .xterm", { timeout: 90_000 });

  // Claude Code's first screens: accept bypass-permissions mode once, then
  // wait for its input box.
  const started = Date.now();
  let pressed = 0;
  for (;;) {
    const text = await screenText(host, ".terminal-target");
    // Keys typed while the dialog is still drawing can be lost: press again
    // while it stays up. Down stops at the last option.
    if (/Yes, I accept/.test(text) && Date.now() - pressed > 4_000) {
      await host.click(".terminal-target .xterm");
      await host.keyboard.press("ArrowDown");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await host.keyboard.press("Enter");
      pressed = Date.now();
    } else if (/for shortcuts|bypass permissions on/i.test(text)) {
      break;
    }
    if (Date.now() - started > 150_000) throw new Error(`Claude Code didn't reach its prompt:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await host.click(".terminal-target .xterm");
  await host.keyboard.type("Reply with the word pong spelled backwards in capital letters, and nothing else.");
  await host.keyboard.press("Enter");
  await host.waitForFunction(
    () => /GNOP/.test(document.querySelector(".terminal-target .xterm-rows")?.textContent ?? ""),
    { timeout: 180_000, polling: 500 },
  ).catch(async (error) => {
    console.error(await screenText(host, ".terminal-target"));
    throw error;
  });
  const hostScreen = await screenText(host, ".terminal-target");
  assert.match(hostScreen, /nemotron/i, "the status line names the free model");

  // Measured on the far side: a participant's mirror shows the answer.
  const participantContext = await browser.createBrowserContext();
  const participant = await participantContext.newPage();
  participant.on("pageerror", (error) => pageErrors.push(String(error)));
  await participant.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await participant.goto(`${baseUrl}/?room=${code.toLowerCase()}`, { waitUntil: "networkidle0" });
  await participant.type(".entry-card form input", "Model Watcher");
  await participant.click(".entry-card form .primary");
  await participant.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await participant.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room")?.click());
  await participant.waitForFunction(
    () => /GNOP/.test(document.querySelector(".readonly-terminal .xterm-rows")?.textContent ?? ""),
    { timeout: 30_000, polling: 250 },
  );
  await participantContext.close();
  assert.deepEqual(pageErrors, []);
  console.log("A host with no key: Riff's free model answered through /api/model, and a participant saw it.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (roomId && secret) {
    await fetch(`${baseUrl}/api/rooms/${roomId}/end`, { method: "POST", headers: { authorization: `Bearer ${secret}`, origin: baseUrl } }).catch(() => {});
  }
  await browser.close();
}
