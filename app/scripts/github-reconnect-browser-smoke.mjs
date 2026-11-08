// A host whose GitHub token is refused connects GitHub again in another tab,
// and the running pod uses the new token without a reload (docs/adr/0007:
// the guest keeps its placeholder; the service worker forgets the old value
// and asks the page again).
//
// Dev only: the host's session is seeded into the dev database, and the
// refused token is sealed here with the dev server's SESSION_SECRET, because
// a smoke can't sign in through GitHub. The new token is a real one (yours,
// from GITHUB_TEST_TOKEN or `gh auth token`), pasted through the real page,
// so the server checks it is the signed-in user's; it only ever leaves this
// machine for api.github.com.
//
//   mise exec -- npm run test:github-reconnect-browser   (dev server, RIFF_URL)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const dbPath = process.env.RIFF_DB ?? new URL("../.data/riff.sqlite", import.meta.url).pathname;
assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:/, "seeds the dev database, so dev only");
const secret = process.env.SESSION_SECRET;
assert.ok(secret, "needs the dev server's SESSION_SECRET (run through mise exec)");
const realToken = process.env.GITHUB_TEST_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const me = await (await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${realToken}`, "user-agent": "riff-smoke" } })).json();
assert.ok(me.id && me.login, "the test token names a GitHub user");

function signIn(githubId, login) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  db.prepare(`INSERT INTO users (github_id, login, avatar_url, created_at, last_seen) VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT (github_id) DO UPDATE SET login = excluded.login`).run(githubId, login, now, now);
  const { id } = db.prepare("SELECT id FROM users WHERE github_id = ?").get(githubId);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(tokenHash, id, now, now, now + 3_600_000);
  db.close();
  return { token, tokenHash };
}

// server/auth.mjs's seal(), for a token GitHub will refuse (the server
// won't seal one itself: it checks the token with GitHub first).
function seal(token, tokenHash) {
  const key = Buffer.from(hkdfSync("sha256", secret, tokenHash, "riff push token v1", 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  defaultViewport: { width: 1400, height: 900 },
});
const pageErrors = [];
const screenText = (tab) => tab.$eval(".terminal-target .xterm-rows", (element) => element.innerText.replace(/\u00a0/g, " "));
const noteText = (tab) => tab.$eval(".terminal-note", (element) => element.textContent.replace(/\s+/g, " "));

let sequence = 100;
async function run(tab, command) {
  const n = ++sequence;
  await tab.bringToFront();
  await tab.focus(".terminal-target .xterm-helper-textarea");
  await tab.keyboard.type(`printf '\\033[H\\033[2J'; echo @B$((${n}+0)); ${command}; echo @E$((${n}+0))`, { delay: 20 });
  await tab.keyboard.press("Enter");
  await tab.waitForFunction((n) => document.querySelector(".terminal-target .xterm-rows")?.innerText.includes(`@E${n}`), { timeout: 60_000, polling: 100 }, n);
  const text = (await screenText(tab)).replace(/\n/g, "");
  return text.slice(text.indexOf(`@B${n}`) + `@B${n}`.length, text.indexOf(`@E${n}`)).trim();
}

const status = "node -e \"fetch('https://api.github.com/user',{headers:{authorization:'token '+process.env.GITHUB_TOKEN,'user-agent':'riff-smoke'}}).then(r=>console.log('GH-STATUS-'+r.status))\"";

let tab;
try {
  const session = signIn(me.id, me.login);
  const context = await browser.createBrowserContext();
  await context.setCookie({ name: "__Host-riff-session", value: session.token, domain: "127.0.0.1", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  tab = await context.newPage();
  tab.on("pageerror", (error) => pageErrors.push(String(error)));
  await tab.goto(baseUrl, { waitUntil: "networkidle0" });
  // GitHub was connected once; the token has since been revoked.
  await tab.evaluate((sealed) => localStorage.setItem("riff-github-push", sealed), seal(`gho_riffSmokeRevoked${randomBytes(10).toString("hex")}`, session.tokenHash));
  await tab.reload({ waitUntil: "networkidle0" });

  // ---- host a room, Bash in it
  await tab.click(".entry-card > nav button:nth-child(2)");
  await tab.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await tab.$$(".entry-card form input:not([type=radio]):not([type=checkbox])");
  for (const [index, value] of [[0, "Wren"], [1, `${baseUrl}/fake-anthropic`], [2, "invalid-reconnect-smoke-token"]]) {
    await inputs[index].click({ clickCount: 3 });
    await inputs[index].type(value);
  }
  const keep = await tab.$(".entry-card form label.check input[type=checkbox]");
  if (keep && await keep.evaluate((element) => element.checked)) await keep.click();
  await tab.click(".entry-card form .primary");
  await tab.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
  await tab.waitForFunction(() => document.querySelector(".room-name i")?.className === "connected", { timeout: 15_000, polling: 100 });
  const code = await tab.$eval(".room-name span", (element) => element.textContent.replace("Room ", ""));
  await tab.click(".topbar nav button:nth-child(2)");
  await tab.waitForSelector(".terminal-controls button", { timeout: 20_000 });
  await tab.$$eval(".terminal-controls button", (buttons) => buttons.find((b) => b.textContent === "Start Bash")?.click());
  await tab.waitForFunction(() => document.querySelector(".terminal-heading span")?.textContent === "WASIX Bash ready", { timeout: 240_000, polling: 200 });
  await tab.waitForFunction(() => /# $/m.test(document.querySelector(".terminal-target .xterm-rows")?.innerText.replace(/\u00a0/g, " ").trimEnd() + " "), { timeout: 30_000, polling: 100 });

  // ---- the revoked token is refused, and the host is told where to fix it
  const placeholderBefore = await run(tab, "printenv GITHUB_TOKEN");
  assert.match(placeholderBefore, /^riff-placeholder-github-[0-9a-f]{32}$/, "the guest holds a placeholder");
  assert.match(await run(tab, status), /GH-STATUS-401/, "GitHub refuses the revoked token");
  await tab.waitForFunction(() => /GitHub has revoked the token Riff connected for you/.test(document.querySelector(".terminal-note")?.textContent ?? ""), { timeout: 10_000, polling: 100 });
  const href = await tab.$eval(".terminal-note a", (a) => ({ href: a.getAttribute("href"), target: a.target }));
  assert.deepEqual(href, { href: "/?github=reconnect", target: "_blank" }, "the banner opens reconnecting in a new tab");
  console.log("refused:", await noteText(tab));
  assert.equal(await tab.evaluate(() => localStorage.getItem("riff-github-push")), null, "the refused token is forgotten");

  // ---- connect again in another tab: paste a token (the real page, the real check)
  const other = await context.newPage();
  other.on("pageerror", (error) => pageErrors.push(String(error)));
  await other.goto(`${baseUrl}${href.href}`, { waitUntil: "networkidle0" });
  assert.match(await other.$eval(".entry-card", (e) => e.textContent), /GitHub refused the token Riff had for you/);
  await other.evaluate(() => [...document.querySelectorAll(".github-push button")].find((b) => /paste a token/.test(b.textContent))?.click());
  await other.waitForSelector(".github-push-paste input");
  await other.type(".github-push-paste input", realToken);
  await other.click(".github-push-paste button");
  await other.waitForFunction(() => /Connected\. Your room's tab is using it already/.test(document.querySelector(".entry-card")?.textContent ?? ""), { timeout: 20_000, polling: 100 });

  // ---- the room's tab swapped it in: same pod, same placeholder, now accepted
  await tab.bringToFront();
  await tab.waitForFunction(() => /GitHub connected again: git uses the new token/.test(document.querySelector(".terminal-note")?.textContent ?? ""), { timeout: 15_000, polling: 100 });
  assert.doesNotMatch(await noteText(tab), /revoked the token/, "the refusal banner is gone");
  console.log("reconnected:", await noteText(tab));
  assert.equal(await run(tab, "printenv GITHUB_TOKEN"), placeholderBefore, "the guest kept its placeholder: nothing restarted");
  assert.match(await run(tab, status), /GH-STATUS-200/, "GitHub accepts the request now");
  const whoami = await run(tab, "node -e \"fetch('https://api.github.com/user',{headers:{authorization:'token '+process.env.GITHUB_TOKEN,'user-agent':'riff-smoke'}}).then(r=>r.json()).then(u=>console.log('LOGIN-'+u.login))\"");
  assert.match(whoami, new RegExp(`LOGIN-${me.login}`), "as the user who reconnected");
  assert.equal((await screenText(tab)).includes(realToken), false, "the real token never shows in the terminal");
  assert.deepEqual(pageErrors, []);

  // a board nobody needs afterwards: end the room, which deletes it
  if (!(await tab.$(".people-panel"))) await tab.click(".participants");
  await tab.waitForSelector(".people-panel");
  await tab.click(".end-room > button");
  await tab.waitForSelector(".end-room.asking");
  await Promise.all([tab.waitForNavigation({ waitUntil: "networkidle0" }), tab.click(".end-room button.danger")]);
  console.log(`room ${code} ended`);
  console.log("github reconnect smoke passed");
} catch (error) {
  if (tab) console.log("terminal:\n" + await screenText(tab).catch(() => "?"), "\nnote:", await noteText(tab).catch(() => "?"));
  throw error;
} finally {
  await browser.close();
}
