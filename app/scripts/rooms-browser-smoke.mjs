// Your rooms, invites and colleagues in real browsers (docs/adr/0008),
// against the dev server only: the signed-in invitee is seeded straight into
// the dev database, because a smoke can't go through GitHub's sign-in.
// The invitee is a real GitHub account (octocat, id 583231) since the server
// really asks GitHub who a username is.
//
//   npm run test:rooms-browser   (dev server on 127.0.0.1:8093, started via mise)
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const dbPath = process.env.RIFF_DB ?? new URL("../.data/riff.sqlite", import.meta.url).pathname;
const width = Number(process.env.W ?? 1920);
const height = Number(process.env.H ?? 1080);
assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:/, "seeds the dev database, so dev only");

function signIn(githubId, login) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  db.prepare(`INSERT INTO users (github_id, login, avatar_url, created_at, last_seen) VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT (github_id) DO UPDATE SET login = excluded.login`).run(githubId, login, now, now);
  const { id } = db.prepare("SELECT id FROM users WHERE github_id = ?").get(githubId);
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(createHash("sha256").update(token).digest("hex"), id, now, now, now + 3_600_000);
  db.close();
  return token;
}

const text = (page, selector) => page.$eval(selector, (element) => element.textContent.replace(/\s+/g, " ").trim());
const waitText = (page, selector, pattern, timeout = 5000) =>
  page.waitForFunction(
    (sel, source) => [...document.querySelectorAll(sel)].some((element) => new RegExp(source).test(element.textContent.replace(/\s+/g, " "))),
    { timeout, polling: 100 },
    selector,
    pattern.source,
  );
async function clickText(page, selector, label) {
  await page.waitForFunction(
    (sel, wanted) => [...document.querySelectorAll(sel)].some((element) => element.textContent.trim() === wanted && !element.disabled),
    { timeout: 5000, polling: 100 },
    selector,
    label,
  );
  await page.evaluate((sel, wanted) => {
    [...document.querySelectorAll(sel)].find((element) => element.textContent.trim() === wanted && !element.disabled).click();
  }, selector, label);
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  defaultViewport: { width, height },
});
const errors = [];
const shot = (page, name) => process.env.SHOTS && page.screenshot({ path: `${process.env.SHOTS}/${name}-${width}x${height}.png` });
async function newPage(cookie) {
  const context = await browser.createBrowserContext();
  if (cookie) {
    await context.setCookie({ name: "__Host-riff-session", value: cookie, domain: "127.0.0.1", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  return page;
}

try {
  // The host is a guest: hosting, and inviting, need no account.
  const host = await newPage();
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  const inputs = await host.$$(".entry-card form input");
  await inputs[0].type("Hana");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].type("rooms-browser-smoke");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  const roomId = new URL(host.url()).searchParams.get("id");
  await host.waitForFunction(() => /^Room [A-Z2-9]{6}$/.test(document.querySelector(".room-name span")?.textContent ?? ""), { timeout: 10_000 });
  const code = (await text(host, ".room-name span")).replace("Room ", "");
  console.log(`room ${code} (${roomId})`);

  // A signed-in invitee with the landing page open sees the invite arrive.
  const octocat = await newPage(signIn(583231, "octocat"));
  await octocat.goto(baseUrl, { waitUntil: "networkidle0" });
  await waitText(octocat, ".account", /Signed in as @octocat/);

  await host.click("button.participants");
  await host.waitForSelector(".invite-box input");
  await host.type(".invite-box input", "riff-no-such-user-zz9-plural-z-alpha");
  await host.click(".invite-box form button");
  await waitText(host, ".invite-box .form-error", /No GitHub user called riff-no-such-user-zz9-plural-z-alpha/, 10_000);
  console.log("typo: says there's no such GitHub user");

  await host.click(".invite-box input", { clickCount: 3 });
  await host.type(".invite-box input", "@Octocat");
  await host.click(".invite-box form button");
  await waitText(host, ".invite-sent", /Invited @octocat\. They'll see it when they sign in\./, 10_000);
  await waitText(host, ".pending-invites li", /@octocat/);
  console.log("host: invited, pending invite listed");

  const arrived = Date.now();
  await waitText(octocat, ".your-rooms .invite", new RegExp(`Hana invited you to ${code}`));
  await shot(octocat, "invite-arrived");
  await shot(host, "host-invited");
  console.log(`invitee: invite arrived without a reload (${Date.now() - arrived}ms after the reply)`);

  // A guest who joined by code sees the room in their list, with the host.
  const bo = await newPage();
  await bo.goto(`${baseUrl}/?room=${code}`, { waitUntil: "networkidle0" });
  // Bo takes the invitee's name, so accepting has to ask for another.
  await bo.type(".entry-card form input", "Octocat");
  await bo.click(".entry-card form .primary");
  await bo.waitForFunction(() => location.search.startsWith("?id="), { timeout: 10_000 });
  const boLanding = await bo.browserContext().newPage();
  await boLanding.goto(baseUrl, { waitUntil: "networkidle0" });
  await waitText(boLanding, ".your-rooms li", new RegExp(`Room ${code}\\s*Hana is hosting`));
  console.log("guest: the room is in their list, host present");

  // Accepting joins under the name on the landing page (the GitHub login);
  // taken in that room, it asks for another. The invite is used up.
  await clickText(octocat, ".your-rooms .invite button", "Join");
  await waitText(octocat, ".your-rooms .form-error", /already goes by that name/);
  await octocat.waitForSelector(".your-rooms .invite form input");
  await shot(octocat, "invite-name-taken");
  await octocat.click(".your-rooms .invite form input", { clickCount: 3 });
  await octocat.type(".your-rooms .invite form input", "Octo");
  await octocat.click(".your-rooms .invite form button");
  await octocat.waitForFunction((id) => new URL(location.href).searchParams.get("id") === id, { timeout: 10_000 }, roomId);
  await waitText(host, ".people-panel li", /Octo\s*@octocat/);
  await host.waitForFunction(() => !document.querySelector(".pending-invites"), { timeout: 5000, polling: 100 });
  console.log("accepted: name taken, asked for another, in the room as Octo (@octocat), invite gone from the host's panel");

  // Colleagues: private, added by username, removed again.
  const octocatLanding = await octocat.browserContext().newPage();
  await octocatLanding.goto(baseUrl, { waitUntil: "networkidle0" });
  await waitText(octocatLanding, ".your-rooms li", new RegExp(`Room ${code}\\s*Hana is hosting`));
  await clickText(octocatLanding, ".account button", "Colleagues");
  await octocatLanding.waitForSelector(".colleagues form input");
  await octocatLanding.type(".colleagues form input", "octocat");
  await octocatLanding.click(".colleagues form button");
  await waitText(octocatLanding, ".colleagues .form-error", /That's you/);
  await octocatLanding.click(".colleagues form input", { clickCount: 3 });
  await octocatLanding.type(".colleagues form input", "torvalds");
  await octocatLanding.click(".colleagues form button");
  await waitText(octocatLanding, ".colleagues li", /@torvalds/, 10_000);
  await shot(octocatLanding, "colleagues");
  await clickText(octocatLanding, ".colleagues li button", "Remove");
  await waitText(octocatLanding, ".colleagues li", /No colleagues yet/);
  await clickText(octocatLanding, ".colleagues button", "Done");
  console.log("colleagues: refuses yourself, adds and removes");

  // The host leaving shows as away in everyone's list, live.
  await host.close();
  await waitText(boLanding, ".your-rooms li", new RegExp(`Room ${code}\\s*Host away for 1 min`), 10_000);
  await waitText(octocatLanding, ".your-rooms li", new RegExp(`Room ${code}\\s*Host away`), 10_000);
  console.log("host left: both lists say the host is away");

  await shot(boLanding, "rooms-list");

  // Signing out offers to delete the boards this browser kept, and does it
  // with the room still open in another tab (which has to let go).
  await octocatLanding.reload({ waitUntil: "networkidle0" });
  await waitText(octocatLanding, ".local-boards li", new RegExp(`Room ${code}`));
  await clickText(octocatLanding, ".account button", "Sign out");
  await waitText(octocatLanding, ".signing-out", /This browser has a copy of 1 board you've been in\. Delete it too\?/);
  await shot(octocatLanding, "sign-out-copies");
  const reloaded = octocatLanding.waitForNavigation({ waitUntil: "networkidle0", timeout: 10_000 });
  await clickText(octocatLanding, ".signing-out button", "Sign out and delete");
  await reloaded;
  await octocatLanding.waitForSelector(".account .github-sign-in");
  const kept = await octocatLanding.evaluate(async () => ({
    boards: Boolean(document.querySelector(".local-boards")),
    databases: (await indexedDB.databases()).filter((database) => database.name.startsWith("room/")).length,
    secrets: Object.keys(localStorage).filter((key) => key.startsWith("riff-member:")).length,
  }));
  assert.deepEqual(kept, { boards: false, databases: 0, secrets: 0 });
  // The open room tab let go of its copy cleanly: an edit there now
  // doesn't throw from a closed database (copies.ts openCopy).
  // A background tab takes no typing in headless Chrome ("Target closed").
  await octocat.bringToFront();
  await octocat.type(".new-prompt textarea", "after the copy went");
  await octocat.click(".new-prompt button");
  await octocat.waitForFunction(() => [...document.querySelectorAll(".prompt-card textarea")].some((element) => element.value === "after the copy went"), { timeout: 5_000, polling: 100 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(errors, []);
  console.log("signed out and deleted this browser's copies, with the room open in another tab, which carries on");

  assert.deepEqual(errors, []);
  console.log(`rooms browser smoke passed at ${width}x${height}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
