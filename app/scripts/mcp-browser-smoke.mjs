// MCP servers for the host's Claude (docs/adr/0012), in real browsers.
//
// The controller, on a blank page: GitHub's MCP turned on at boot puts a
// placeholder in Claude's ~/.claude.json, never the token; GitHub's MCP
// refusing the token raises an MCP notice, never the GitHub reconnect flow;
// applying new settings to a running Claude restarts it on the same
// conversation (Claude reads its MCP servers only at start).
//
// The room, at W x H: only the host has MCPs; without GitHub connected the
// GitHub server can't be turned on; with it (the token's unwrap and Riff's
// own GitHub check are stood in for), turning it on and applying restarts
// the running Claude, which comes back idle, and GitHub's 401 to a made-up
// token shows as an MCP error, not "GitHub no longer accepts the token".
// With GITHUB_TOKEN set, the controller part also lists GitHub's tools.
//
// Needs the network (api.githubcopilot.com). Dev only:
//   RIFF_URL=http://127.0.0.1:8098 W=390 H=844 SHOTS=dir npm run test:mcp-browser
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { startFakeAnthropic } from "./fake-anthropic.mjs";
import { startFakeMcp } from "./fake-mcp.mjs";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const viewport = { width: Number(process.env.W ?? 1920), height: Number(process.env.H ?? 1080), deviceScaleFactor: 1 };
const shots = process.env.SHOTS;
const MADE_UP = "gho_madeup000000000000000000000000000000";
const fake = await startFakeAnthropic({ reply: "Pineapple acknowledged." });
// Custom servers: one that wants its token, one that refuses the one it's
// given, one for the room part. Jina's open server too, if it's reachable.
const SECRET = "Bearer mock-secret-0123456789";
const mock = await startFakeMcp({ secret: SECRET });
const refuser = await startFakeMcp({ secret: "Bearer the-right-one" });
const roomMock = await startFakeMcp({ secret: SECRET });
const JINA = "https://mcp.jina.ai/v1";
const jina = await fetch(JINA, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "http://127.0.0.1:8098" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "riff-smoke", version: "1" } } }),
  signal: AbortSignal.timeout(10_000),
}).then((response) => response.ok && response.headers.get("access-control-allow-origin") === "*", () => false);
console.log(jina ? "jina reachable, with CORS: included" : "jina not reachable: left out");
const custom = [
  { name: "mock", url: mock.url, header: "Authorization", value: SECRET },
  { name: "refuser", url: refuser.url, header: "Authorization", value: "Bearer the-wrong-one" },
  ...(jina ? [{ name: "jina", url: JINA, header: "", value: "" }] : []),
];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 600_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const pageErrors = [];
const shot = (page, name) => shots && page.screenshot({ path: `${shots}/mcp-${name}-${viewport.width}.png` });
const rows = (page, selector) => page.$eval(selector, (element) => element.textContent);
const waitRows = (page, selector, pattern, timeout = 120_000) => page.waitForFunction(
  (sel, source) => new RegExp(source).test(document.querySelector(sel)?.textContent ?? ""),
  { timeout, polling: 300 }, selector, pattern.source,
);

try {
  // 1. The controller. (ONLY=room skips it, to rerun the room part.)
  if (process.env.ONLY !== "room") {
  const blank = await (await browser.createBrowserContext()).newPage();
  blank.on("pageerror", (error) => pageErrors.push(String(error)));
  await blank.goto(`${baseUrl}/?poc=blank`, { waitUntil: "networkidle0" });
  await blank.evaluate(async () => { await navigator.serviceWorker.register("/riff-sw.js", { scope: "/" }); await navigator.serviceWorker.ready; });
  await blank.reload({ waitUntil: "networkidle0" });
  const token = process.env.GITHUB_TOKEN || MADE_UP;
  await blank.evaluate(async ({ url, token }) => {
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const { DEFAULT_TOOLSETS } = await import("/src/mcp.ts");
    window.__log = [];
    const controller = new ClaudePodController(
      { baseUrl: url, token: "x", repo: "", githubToken: token, mcp: { github: { on: true, readOnly: true, toolsets: DEFAULT_TOOLSETS }, custom: [] } },
      () => {}, () => {}, () => {}, (kind) => window.__log.push(`refused:${kind}`),
    );
    controller.onNotice = (text) => window.__log.push(`notice:${text}`);
    window.__c = controller;
    await controller.boot();
    const div = document.createElement("div");
    div.style.cssText = "width:1300px;height:800px";
    document.body.append(div);
    controller.attach(div);
    await controller.startClaude();
    // Applying while Claude is still drawing itself (it drops typing then)
    // still restarts it, rather than waiting forever for an /exit it lost.
    const started = Date.now();
    window.__early = { restarted: await controller.applyMcp(controller.config?.mcp ?? { github: { on: true, readOnly: true, toolsets: DEFAULT_TOOLSETS }, custom: [] }), ms: Date.now() - started };
  }, { url: fake.url, token });
  const early = await blank.evaluate(() => window.__early);
  assert.equal(early.restarted, true);
  console.log(`applied while Claude was starting: restarted in ${early.ms} ms`);
  await waitRows(blank, ".xterm-rows", /bypass permissions on/, 180_000);
  const config = await blank.evaluate(() => window.__c.pod.volume.readFileSync("/home/user/.claude.json", "utf8"));
  const github = JSON.parse(config).mcpServers.github;
  assert.equal(github.url, "https://api.githubcopilot.com/mcp/");
  assert.match(github.headers.Authorization, /^Bearer riff-placeholder-mcp-[0-9a-f]{32}$/);
  assert.equal(github.headers["X-MCP-Readonly"], "true");
  assert.equal(config.includes(token), false, "the token never reaches the guest's config");

  // /mcp's line for each server: "<name> · ✔ connected · N tools" or failed.
  const mcpLines = async (names) => {
    await blank.click(".xterm");
    await blank.keyboard.type("/mcp", { delay: 30 });
    await blank.keyboard.press("Enter");
    const pattern = names.map((name) => `(?=[\\s\\S]*${name} · (✔|✘))`).join("");
    await waitRows(blank, ".xterm-rows", new RegExp(pattern), 60_000);
    const screen = await rows(blank, ".xterm-rows");
    const lines = Object.fromEntries(names.map((name) => [name, screen.match(new RegExp(`${name} · [^\\n]*?(?:tools?|failed|auth)`))?.[0] ?? null]));
    await blank.keyboard.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 800));
    return lines;
  };
  const mcpLine = async () => (await mcpLines(["github"])).github;
  const before = await mcpLine();
  await blank.click(".xterm");
  await blank.keyboard.type("remember the word pineapple", { delay: 20 });
  await blank.keyboard.press("Enter");
  await waitRows(blank, ".xterm-rows", /Pineapple acknowledged/);
  // A built-in server (Riff's own `web`, webTools.ts, added at boot) survives Apply.
  const BUILT_IN = { type: "stdio", command: "node", args: ["/opt/claude/web-mcp.mjs", "--stdio"], env: {} };
  assert.deepEqual(JSON.parse(config).mcpServers.web, BUILT_IN, "the built-in web server is there from boot");
  await blank.evaluate((entries) => { window.__custom = entries; }, custom);
  const restarted = await blank.evaluate(async () => {
    const { DEFAULT_TOOLSETS } = await import("/src/mcp.ts");
    return window.__c.applyMcp({ github: { on: true, readOnly: false, toolsets: DEFAULT_TOOLSETS }, custom: window.__custom });
  });
  assert.equal(restarted, true);
  await blank.waitForFunction(() => window.__c.isRunning(), { timeout: 30_000, polling: 100 });
  await waitRows(blank, ".xterm-rows", /bypass permissions on/);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  // The next turn carries the first one with it: --continue kept the conversation.
  const turnsBefore = fake.turns.length;
  await blank.click(".xterm");
  await blank.keyboard.type("which word?", { delay: 20 });
  await blank.keyboard.press("Enter");
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    const poll = () => fake.turns.length > turnsBefore ? resolve() : Date.now() > deadline ? reject(new Error("no turn after the restart")) : setTimeout(poll, 200);
    poll();
  });
  const next = fake.turns.at(-1);
  assert.deepEqual(next.blocks.at(-1), "which word?");
  assert.ok(next.messages >= 3, `the turn after the restart carries the conversation (${next.messages} messages)`);
  await waitRows(blank, ".xterm-rows", /which word\?[\s\S]*Pineapple acknowledged/);
  const lines = await mcpLines(["github", "web", ...custom.map((entry) => entry.name)]);
  assert.match(lines.web ?? "", /web · ✔ connected · 2 tools/, "the built-in web server, after Apply");
  const after = lines.github;
  const log = await blank.evaluate(() => window.__log);
  // Custom servers: a placeholder per server in the config, the real value
  // only at that server, and a refusal that names its server.
  const servers = JSON.parse(await blank.evaluate(() => window.__c.pod.volume.readFileSync("/home/user/.claude.json", "utf8"))).mcpServers;
  assert.deepEqual(servers.web, BUILT_IN, "Apply keeps the built-in server it didn't create");
  assert.match(servers.mock.headers.Authorization, /^riff-placeholder-mcp-[0-9a-f]{32}$/);
  assert.notEqual(servers.mock.headers.Authorization, servers.refuser.headers.Authorization, "one credential per server");
  assert.equal(JSON.stringify(servers).includes("mock-secret"), false, "the token never reaches the guest's config");
  assert.match(lines.mock ?? "", /mock · ✔ connected · 1 tool/);
  assert.ok(mock.seen.some((request) => request.rpc === "initialize" && request.carried === SECRET), "the real token reached its server");
  assert.equal([...mock.seen, ...refuser.seen].some((request) => /riff-placeholder/.test(request.carried ?? "")), false, "no placeholder left the browser");
  assert.equal(refuser.seen.some((request) => request.carried === SECRET), false, "a server never sees another's token");
  assert.match(lines.refuser ?? "", /refuser · ✘/);
  assert.ok(log.some((line) => line.startsWith("notice:The MCP server \"refuser\" refused")), JSON.stringify(log));
  if (jina) assert.match(lines.jina ?? "", /jina · ✔ connected · \d+ tools/);
  console.log(`custom: ${JSON.stringify(lines)}`);
  if (token === MADE_UP) {
    assert.match(before, /failed/);
    assert.ok(log.some((line) => line.startsWith("notice:The MCP server \"github\" refused")), JSON.stringify(log));
  } else {
    const count = (line) => Number(line.match(/(\d+) tools/)?.[1]);
    assert.ok(count(before) > 0 && count(after) > count(before), `${before} then ${after}`);
  }
  assert.equal(log.includes("refused:github"), false, "an MCP refusal never starts the GitHub reconnect flow");
  console.log(`controller: placeholder in the config; ${before} -> ${after} after Apply, conversation kept; log ${JSON.stringify(log)}`);
  await blank.close();
  }

  // 2. The room.
  const context = await browser.createBrowserContext();
  const host = await context.newPage();
  host.on("pageerror", (error) => pageErrors.push(String(error)));
  await host.setViewport(viewport);
  // Stand in for the sealed push token and Riff's own GitHub check, so the
  // host has "GitHub connected" with a token GitHub's MCP will refuse.
  await host.setRequestInterception(true);
  host.on("request", (request) => {
    const url = new URL(request.url());
    const reply = (status, body) => request.respond({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (url.pathname === "/api/github/token/unwrap") return reply(200, { token: MADE_UP });
    if (url.href === "https://api.github.com/user") return reply(200, { login: "mcp-smoke" });
    return request.continue();
  });
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.evaluate(() => localStorage.setItem("riff-github-push", "sealed-smoke"));
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await host.$$(".entry-card form input:not([type=radio])");
  await inputs[0].type("Mia");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(fake.url);
  await inputs[2].type("fake-token");
  await host.click(".entry-card form .primary");
  await host.waitForFunction(() => location.search.startsWith("?id="), { timeout: 15_000 });
  await host.waitForSelector(".room-name span");
  const code = (await rows(host, ".room-name span")).replace("Room ", "");
  await host.evaluate(() => [...document.querySelectorAll(".topbar nav button")].find((button) => button.textContent === "Room")?.click());
  await host.waitForFunction(() => document.querySelector(".claude-state")?.dataset.state === "idle", { timeout: 240_000, polling: 200 });
  await waitRows(host, ".terminal-target .xterm-rows", /bypass permissions on/, 60_000);

  const guest = await (await browser.createBrowserContext()).newPage();
  guest.on("pageerror", (error) => pageErrors.push(String(error)));
  await guest.setViewport(viewport);
  await guest.goto(`${baseUrl}/?room=${code}`, { waitUntil: "networkidle0" });
  await guest.type(".entry-card form input", "Bo");
  await guest.click(".entry-card form .primary");
  await guest.waitForSelector(".terminal-heading");
  assert.equal(await guest.$(".mcp-open"), null, "only the host has MCPs");

  // Riff's own web server is listed, not counted: the button counts what
  // the host added (none yet).
  assert.equal(await rows(host, ".mcp-open"), "MCPs", "nothing added, no count");
  await host.click(".mcp-open");
  await host.waitForSelector(".mcp-settings");
  assert.match(await rows(host, ".mcp-builtin"), /web\s*\(built in\).*Jina Reader/);
  assert.equal(await host.$(".mcp-builtin input"), null, "the built-in server isn't a switch");
  const githubBox = ".mcp-github .ws-export-option input";
  assert.equal(await host.$eval(githubBox, (input) => input.disabled || input.checked), false, "GitHub is there to turn on, off by default");
  await host.click(githubBox);
  await host.waitForSelector(".mcp-toolsets input");
  assert.equal(await host.$eval(".mcp-mode input", (input) => input.checked), true, "read only first");
  const fits = await host.$eval(".mcp-settings", (element) => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0; });
  assert.ok(fits, "the dialog fits the window");
  await shot(host, "github");
  await host.click(".mcp-settings .ws-export-go");
  await waitRows(host, ".mcp-settings .mcp-done", /Claude restarted on the same conversation/, 60_000);
  await shot(host, "applied");
  await host.click(".mcp-settings .ws-export-actions button:not(.ws-export-go)");
  assert.equal(await host.$eval(".mcp-open", (button) => [button.textContent, button.getAttribute("aria-label")].join("|")), "MCPs1|MCPs, 1 added");
  await host.waitForFunction(() => document.querySelector(".claude-state")?.dataset.state === "idle", { timeout: 60_000, polling: 200 });
  await waitRows(host, ".terminal-note", /MCP server "github" refused its token/, 60_000);
  assert.doesNotMatch(await rows(host, ".terminal-note"), /no longer accepts/, "GitHub's MCP refusing isn't GitHub refusing");
  assert.equal(await host.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("riff-mcp:"))), true, "kept in this browser");
  await shot(host, "refused");
  console.log(`room ${code}: host-only MCPs, GitHub turned on and applied to a running Claude (back to idle), its 401 an MCP notice`);

  // A custom server, through the form: refused names and URLs, then added,
  // applied to the running Claude, and its token swapped in on the way.
  await host.click(".mcp-open");
  await host.waitForSelector(".mcp-settings .mcp-add-open");
  await host.click(".mcp-settings .mcp-add-open");
  const field = (index) => `.mcp-add label:nth-of-type(${index}) input`;
  await host.type(field(1), "GitHub");
  await host.type(field(2), roomMock.url);
  await host.click(".mcp-add-actions button[type=submit]");
  await waitRows(host, ".mcp-add .form-error", /GitHub's own server/, 5_000);
  await host.click(field(1), { clickCount: 3 });
  await host.type(field(1), "web");
  await host.click(".mcp-add-actions button[type=submit]");
  await waitRows(host, ".mcp-add .form-error", /"web" is Riff's own server/, 5_000);
  await host.click(field(1), { clickCount: 3 });
  await host.type(field(1), "Mock");
  await host.type(field(4), SECRET);
  await host.click(".mcp-add-actions button[type=submit]");
  await waitRows(host, ".mcp-add .form-error", /which header/, 5_000);
  assert.equal(await host.$eval(".mcp-settings .ws-export-go", (button) => button.disabled), true, "Apply waits for the form");
  await host.type(field(3), "Authorization");
  await shot(host, "custom-form");
  await host.click(".mcp-add-actions button[type=submit]");
  await waitRows(host, ".mcp-custom-list", /mock.*token in Authorization/, 5_000);
  const custFits = await host.$eval(".mcp-settings", (element) => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; });
  assert.ok(custFits, "the dialog with the form fits the window's width");
  await host.click(".mcp-settings .ws-export-go");
  await waitRows(host, ".mcp-settings .mcp-done", /Claude restarted on the same conversation/, 60_000);
  await shot(host, "custom-applied");
  await host.click(".mcp-settings .ws-export-actions button:not(.ws-export-go)");
  assert.equal(await host.$eval(".mcp-open", (button) => button.getAttribute("aria-label")), "MCPs, 2 added");
  await host.waitForFunction(() => document.querySelector(".claude-state")?.dataset.state === "idle", { timeout: 60_000, polling: 200 });
  const reached = Date.now() + 60_000;
  while (!roomMock.seen.some((request) => request.carried === SECRET)) {
    if (Date.now() > reached) throw new Error(`the room's custom server never got its token: ${JSON.stringify(roomMock.seen)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(roomMock.seen.some((request) => /riff-placeholder/.test(request.carried ?? "")), false);
  const kept = await host.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith("riff-mcp:"))?.[1] ?? "");
  assert.match(kept, /"name":"Mock"/, "the custom server is kept in this browser");
  console.log("room: custom server added through the form (bad name and missing header refused), applied, its token swapped in");

  await guest.close();
  // Claude's own requests timing out inside the guest (an AxiosError from
  // its bundle, seen twice at 390 on dev) surface as page errors; they're
  // Claude's, not Riff's, so they're reported but don't fail the smoke.
  const claudeOwn = pageErrors.filter((error) => /^\w+: AxiosError: timeout/.test(error));
  if (claudeOwn.length) console.log(`Claude's own request timeouts (not Riff's): ${claudeOwn.length}`);
  assert.deepEqual(pageErrors.filter((error) => !claudeOwn.includes(error)), []);
  console.log(`mcp browser smoke passed at ${viewport.width}x${viewport.height}`);
} catch (error) {
  for (const page of await browser.pages()) {
    const seen = await page.evaluate(() => ({
      url: location.href,
      dialog: document.querySelector(".mcp-settings")?.textContent,
      note: document.querySelector(".terminal-note")?.textContent,
      state: document.querySelector(".claude-state")?.dataset.state,
      heading: document.querySelector(".terminal-heading")?.textContent,
      screen: document.querySelector(".terminal-target .xterm-rows")?.textContent?.slice(-1500),
    })).catch(() => null);
    if (seen) console.log(JSON.stringify(seen));
  }
  throw error;
} finally {
  await browser.close();
  await fake.close?.();
  await Promise.all([mock.close(), refuser.close(), roomMock.close()]);
}
