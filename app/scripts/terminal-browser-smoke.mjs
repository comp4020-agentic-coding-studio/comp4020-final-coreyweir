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
  // Riff's own models are the default when the server has a key; this
  // smoke runs Claude against a fake endpoint of its own.
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const hostInputs = await host.$$(".entry-card form input:not([type=radio])");
  await hostInputs[0].type("Browser Host");
  await hostInputs[1].click({ clickCount: 3 });
  await hostInputs[1].type(`${baseUrl}/fake-anthropic`);
  await hostInputs[2].type("invalid-browser-smoke-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  await host.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 10_000 });
  room = await host.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  assert.match(room, /^[A-Z2-9]{6}$/);

  // A room just created boots Claude by itself while the host is still on
  // the Board, and says so there (autoBoot.ts).
  await host.waitForFunction(() => /Starting Claude for the room/.test(document.querySelector(".room-banner.booting")?.textContent ?? ""), { timeout: 10_000, polling: 100 });
  assert.equal(await host.$eval(".board-wrap", (element) => element.offsetParent !== null), true, "on the Board");

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

  // Claude came up in the hidden Room tab; showing it fits it to the box.
  await host.waitForSelector(".terminal-target .xterm", { timeout: 180_000 });
  await openTab("Room");
  assert.equal(await host.$(".room-banner.booting"), null, "the Room tab shows the boot itself");
  await host.waitForFunction(() => !document.querySelector(".terminal-empty"), { timeout: 10_000, polling: 100 });
  await host.waitForFunction(() => {
    const target = document.querySelector(".terminal-target");
    const screen = target?.querySelector(".xterm-screen");
    return screen && screen.getBoundingClientRect().width > target.clientWidth * 0.8;
  }, { timeout: 10_000, polling: 100 });
  await host.waitForFunction(
    () => Number(document.querySelector(".terminal-target")?.getAttribute("data-output-size")) > 200,
    { timeout: 90_000 },
  );
  // No "Installed via npm (deprecated)" for the room: claudePod sets
  // DISABLE_INSTALLATION_CHECKS. Claude shows it once its install check
  // (an npm probe) answers, some seconds after its prompt, so watch a while.
  await host.waitForFunction(() => /bypass permissions on/.test(document.querySelector(".terminal-target .xterm-rows")?.textContent ?? ""), { timeout: 90_000, polling: 200 });
  const deprecation = await host.waitForFunction(() => /Installed via npm/.test(document.querySelector(".terminal-target .xterm-rows")?.textContent ?? ""), { timeout: 15_000, polling: 200 }).then(() => true, () => false);
  assert.equal(deprecation, false, "Claude's npm deprecation notice stays out of the shared terminal");

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
  // A late joiner first gets the host's latest snapshot; one who joins
  // while Claude is still drawing (the workspace makes boot slower) gets
  // the live stream from its start instead, and needs none. Either way
  // the mirror shows something, and once the host's screen changes (type
  // into the host's terminal) more live data must follow.
  const mirror = () => participant.$eval(".readonly-terminal", (element) => ({
    checkpoints: Number(element.dataset.checkpointRenders),
    data: Number(element.dataset.dataEvents),
  }));
  await participant.waitForFunction(() => {
    const element = document.querySelector(".readonly-terminal");
    return Number(element?.getAttribute("data-checkpoint-renders")) > 0 || Number(element?.getAttribute("data-data-events")) > 0;
  }, { timeout: 30_000 });
  const before = await mirror();
  await host.click(".terminal-target .xterm");
  await host.keyboard.type("riff smoke");
  await participant.waitForFunction(
    (count) => Number(document.querySelector(".readonly-terminal")?.getAttribute("data-data-events")) > count,
    { timeout: 30_000 },
    before.data,
  );

  // A prompt's trip as far as the queue: the participant stages it, the
  // host queues it, and it shows in both queues; only the host has Send.
  // The host removes it instead. Sending, by hand and automatically, is
  // test:queue-release-browser.
  await participant.type(".new-prompt textarea", "riff queue smoke");
  await participant.click(".new-prompt button");
  await host.waitForFunction(() => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === "riff queue smoke"), { timeout: 10_000 });
  await host.evaluate(() => {
    const card = [...document.querySelectorAll(".prompt-card")].find((element) => element.querySelector("textarea")?.value === "riff queue smoke");
    card.querySelector("footer button").click();
  });
  const queuedOn = (page) => page.waitForFunction(() => [...document.querySelectorAll(".queue-row p")].some((element) => element.textContent === "riff queue smoke"), { timeout: 10_000 });
  await Promise.all([queuedOn(host), queuedOn(participant)]);
  assert.equal(await participant.$(".send-prompt"), null);
  assert.ok(await host.$(".send-prompt"));
  await host.click(".queue-row button[aria-label='Remove queued prompt']");
  const emptyOn = (page) => page.waitForFunction(() => document.querySelectorAll(".queue-row").length === 0, { timeout: 10_000 });
  await Promise.all([emptyOn(host), emptyOn(participant)]);

  assert.equal(await participant.$eval(".terminal-heading", (element) => element.textContent.includes("Host terminal live")), true);
  assert.equal(await participant.$eval(".readonly-terminal", (element) => getComputedStyle(element).overflow), "hidden");
  await participant.waitForFunction(() => [...document.querySelectorAll(".participants span")].some((element) => element.getAttribute("title") === "Browser Participant"));
  // A participant has none of the host's terminal controls, only the mirror's size.
  assert.equal((await participant.$$(".terminal-controls button:not(.mirror-mode)")).length, 0);
  // On a phone the views share one scrolling page. Scrolled down to the
  // staging list, then Board, then Room: the terminal is in sight again,
  // not scrolled away above.
  await participant.evaluate(() => {
    const workspace = document.querySelector(".workspace");
    workspace.scrollTo(0, workspace.scrollHeight);
    scrollTo(0, document.body.scrollHeight);
  });
  for (const label of ["Board", "Room"]) {
    await participant.evaluate((next) => [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === next)?.click(), label);
  }
  await participant.waitForSelector(".readonly-terminal");
  assert.equal(await participant.$(".terminal-empty"), null, "a live mirror has no empty-terminal note over it");
  const terminalTop = await participant.$eval(".terminal-pane", (element) => element.getBoundingClientRect().top);
  assert.ok(terminalTop >= 0 && terminalTop < 120, `the Room tab opens with the terminal in sight (top at ${terminalTop}px)`);
  await participantContext.close();

  // Only a new room boots by itself: a reload of it waits for the host.
  await host.reload({ waitUntil: "networkidle0" });
  await openTab("Room");
  await host.waitForSelector(".terminal-heading");
  assert.equal(await host.$eval(".terminal-controls button", (element) => [element.textContent, element.disabled].join()), "Start Claude,false");
  assert.match(await host.$eval(".terminal-empty", (element) => element.textContent), /Start Claude to run Claude Code/);
  assert.equal(await host.$(".room-banner.booting"), null);
  // The Board says so too, and starts it from there.
  await openTab("Board");
  await host.waitForSelector(".room-banner.claude-off", { timeout: 10_000 });
  assert.match(await host.$eval(".room-banner.claude-off", (element) => element.textContent), /Claude isn't running.*Start Claude/);
  await host.evaluate(() => document.querySelector(".room-banner.claude-off button").click());
  await host.waitForFunction(() => !document.querySelector(".room-banner.claude-off") && document.querySelector(".room-banner.booting"), { timeout: 10_000, polling: 100 });
  await host.waitForFunction(() => document.querySelector(".terminal-heading > div > span")?.textContent === "Claude running", { timeout: 240_000, polling: 200 });
  assert.equal(await host.$(".room-banner.claude-off"), null, "gone once Claude runs");
  assert.deepEqual(pageErrors, []);
  console.log("Tab layouts, one-click Claude rendering, live participant data, and a prompt from staging to the queue passed.");
} finally {
  await browser.close();
}
