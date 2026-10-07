import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const token = "github_pat_browser_smoke_token";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  const errors = [];
  const authorizations = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url() !== "https://api.github.com/user") {
      request.continue();
      return;
    }
    if (request.method() === "OPTIONS") {
      request.respond({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "accept, authorization, x-github-api-version",
        },
      });
      return;
    }
    authorizations.push(request.headers().authorization);
    request.respond({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        id: 42,
        login: "pat-user",
        name: "PAT User",
        avatar_url: "https://example.invalid/avatar.png",
        html_url: "https://github.com/pat-user",
      }),
    });
  });

  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  await page.locator(".github-auth-pat-toggle").click();
  await page.type(".github-auth-pat input", token);
  await page.locator(".github-auth-pat .primary").click();
  await page.waitForFunction(() => document.querySelector(".github-auth-user h2")?.textContent === "PAT User");

  assert.deepEqual(authorizations, [`Bearer ${token}`]);
  assert.equal(await page.evaluate((secret) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), token), false);
  await page.reload({ waitUntil: "networkidle0" });
  assert.equal((await page.$$(".github-auth-pat input")).length, 0);
  assert.equal(await page.$eval(".github-auth-pat-toggle", (element) => element.textContent), "Provide GitHub PAT");
  assert.deepEqual(errors, []);
  console.log("Session-only GitHub PAT authentication passed.");
} finally {
  await browser.close();
}
