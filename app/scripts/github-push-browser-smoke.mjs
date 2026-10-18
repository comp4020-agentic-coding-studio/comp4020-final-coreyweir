// The browser's side of "GitHub for pushing" (docs/adr/0005): what it
// keeps, where it sends people, and what a host sees when the sealed token
// has gone stale. The server's half (sealing, the session check) is in
// spec/sign-in.test.ts; a real seal needs a real GitHub account, so this
// stands in for /api/me and the two token routes and checks the page
// against that contract. Rooms are real.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const stored = (page) => page.evaluate(() => localStorage.getItem("riff-github-push"));

try {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  const calls = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    const reply = (status, body) => request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/me") return reply(200, { user: { id: 1, login: "ada", avatarUrl: null } });
    if (path === "/api/github/token/seal") {
      calls.push(["seal", JSON.parse(request.postData()).token]);
      return reply(200, { ciphertext: "sealed-abc" });
    }
    if (path === "/api/github/token/unwrap") {
      const { ciphertext } = JSON.parse(request.postData());
      calls.push(["unwrap", ciphertext]);
      return ciphertext === "sealed-abc" ? reply(200, { token: "ghp_from_unwrap" }) : reply(400, { error: "stale_token" });
    }
    return request.continue();
  });

  // Host setup offers both ways in, and Connect leads back to host setup.
  await page.goto(`${baseUrl}/?setup=host`, { waitUntil: "networkidle0" });
  const href = await page.$eval(".github-push a.github-sign-in", (a) => a.getAttribute("href"));
  const connect = new URL(href, baseUrl);
  assert.equal(connect.pathname, "/auth/github/start");
  assert.equal(connect.searchParams.get("purpose"), "push");
  assert.equal(connect.searchParams.get("return"), "/?setup=host");

  // A pasted token is sealed by the server; only the ciphertext is kept.
  await page.locator(".github-push button.link").click();
  await page.type(".github-push-paste input", "github_pat_smoke");
  await page.locator(".github-push-paste button").click();
  await page.waitForFunction(() => document.querySelector(".github-push")?.textContent?.includes("Connected as @ada"));
  assert.deepEqual(calls.shift(), ["seal", "github_pat_smoke"]);
  assert.equal(await stored(page), "sealed-abc");
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes("github_pat_smoke"), "the token itself is never stored");

  await page.locator(".github-push button.link").click();
  assert.equal(await stored(page), null, "Disconnect forgets it");

  // Back from a push sign-in (a fresh document, as after /auth's redirect):
  // the fragment is kept, then wiped from the URL.
  await page.goto("about:blank");
  await page.goto(`${baseUrl}/?setup=host#push=from-fragment`, { waitUntil: "networkidle0" });
  assert.equal(await stored(page), "from-fragment");
  assert.equal(await page.evaluate(() => location.hash), "");
  assert.equal(await page.evaluate(() => location.search), "?setup=host");

  // A stale token (its session ended): the host hears it before Claude
  // starts, and the stale copy is dropped.
  const inputs = await page.$$("form input");
  await inputs[0].type("Ada");
  await inputs[2].type("sk-smoke-not-used");
  await Promise.all([page.waitForNavigation(), page.locator("form button.primary").click()]);
  await page.waitForFunction(() => document.body.textContent?.includes("GitHub for pushing has expired"));
  assert.deepEqual(calls.shift(), ["unwrap", "from-fragment"]);
  assert.equal(await stored(page), null);
  const roomUrl = new URL(page.url());
  const back = await page.$eval(".github-push a.github-sign-in", (a) => new URL(a.href).searchParams.get("return"));
  assert.equal(back, roomUrl.pathname + roomUrl.search, "reconnecting returns to this room");

  // Continue without GitHub opens the room.
  await page.locator(".entry-card > button.link").click();
  await page.waitForSelector(".room-name");
  assert.equal(calls.length, 0);

  // A good token is opened once, before the room starts, without asking.
  await page.evaluate(() => localStorage.setItem("riff-github-push", "sealed-abc"));
  await page.goto(roomUrl.href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".room-name");
  assert.deepEqual(calls, [["unwrap", "sealed-abc"]]);
  assert.equal(await page.evaluate(() => document.body.textContent?.includes("GitHub for pushing")), false);

  assert.deepEqual(errors, []);
  console.log("github push browser smoke passed");
} finally {
  await browser.close();
}
