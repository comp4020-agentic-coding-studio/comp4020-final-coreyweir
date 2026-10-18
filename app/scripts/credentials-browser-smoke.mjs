// The guest never holds the host's tokens (docs/adr/0007): it sees
// placeholders, and public/riff-sw.js swaps the real value in on the way
// out, only for that credential's own origins.
//
// Plays an upstream that echoes the Authorization header it received. By
// default that's a local mock on this machine's first non-loopback
// address. Against the live https app, set
// ECHO_BASE=https://httpbin.org, since the page upgrades plain http.
//
// Checks: what the guest's environment shows; that requests from a node
// process (fetch and the http module), a Basic credential (as git sends
// it) and WASIX curl (through the in-tab gateway) arrive with the real
// value; that a streamed reply stays streamed; that a placeholder sent to
// another origin is refused without being sent; that a stopped service
// worker asks again; that a page which stopped serving the credential
// gets a refusal; and that a tab still on Nodepod's old worker moves over.
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
let echoBase = process.env.ECHO_BASE;
// Not loopback: Nodepod's http module and WASIX networking both keep
// 127.0.0.0/8 inside the guest, so the mock must sit on a real interface.
function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  throw new Error("No non-loopback IPv4 address for the mock upstream; set ECHO_BASE");
}
let mock = null;
if (!echoBase) {
  mock = http.createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*, authorization", "access-control-allow-methods": "*" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (req.url.startsWith("/drip")) {
      res.writeHead(200, { ...cors, "content-type": "application/octet-stream" });
      let n = 0;
      const timer = setInterval(() => {
        res.write("*");
        if (++n === 5) { clearInterval(timer); res.end(); }
      }, 400);
      return;
    }
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ headers: { Authorization: req.headers.authorization ?? null } }));
  });
  await new Promise((resolve) => mock.listen(0, "0.0.0.0", resolve));
  echoBase = `http://${lanAddress()}:${mock.address().port}`;
}
const MODEL = "REAL-MODEL-TOKEN-smoke";
const GITHUB = "REAL-GITHUB-TOKEN-smoke";

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
try {
  const page = await browser.newPage();
  // A returning host's tab is controlled by Nodepod's own worker, which
  // knows nothing of placeholders. Start there.
  await page.goto(`${baseUrl}/?poc=blank`, { waitUntil: "networkidle0" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/__sw__.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "networkidle0" });
  assert.match(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""), /\/__sw__\.js$/);

  const result = await page.evaluate(async ({ echoBase, MODEL, GITHUB }) => {
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const controller = new ClaudePodController({ baseUrl: echoBase, token: MODEL, repo: "", githubToken: GITHUB }, () => {});
    window.__controller = controller;
    await controller.boot();
    const run = async (cmd, args) => {
      const proc = await controller.pod.spawn(cmd, args);
      return await new Promise((resolve, reject) => {
        let stdout = "", stderr = "";
        const timer = setTimeout(() => reject(new Error(`timeout ${args.join(" ")}\n${stdout}\n${stderr}`)), 120_000);
        proc.on("output", (c) => { stdout += c; });
        proc.on("error", (c) => { stderr += c; });
        proc.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr }); });
      });
    };
    // Each node -e prints one line of JSON. A pending fetch keeps a node
    // process alive in Nodepod, a body being read doesn't, hence the timer.
    const node = async (body) => {
      const { stdout, stderr } = await run("node", ["-e", `const keep = setInterval(() => {}, 1000);
        const base = ${JSON.stringify(echoBase)}; const model = process.env.ANTHROPIC_AUTH_TOKEN; const github = process.env.GITHUB_TOKEN;
        const auth = async (r) => { const j = await r.json(); return j.headers?.Authorization ?? null; };
        (async () => { ${body} })().then((v) => console.log(JSON.stringify(v)), (e) => console.log(JSON.stringify({ error: String(e) }))).finally(() => clearInterval(keep));`]);
      try { return JSON.parse(stdout.split("\n").pop()); } catch { return { unparsed: stdout, stderr }; }
    };
    const out = {};
    out.env = await node(`return { model, github, gh: process.env.GH_TOKEN }`);
    out.fetch = await node(`return auth(await fetch(base + "/headers", { headers: { authorization: "Bearer " + model } }))`);
    out.basic = await node(`return auth(await fetch(base + "/headers", { headers: { authorization: "Basic " + Buffer.from("x-access-token:" + model).toString("base64") } }))`);
    out.httpModule = await node(`const mod = require(base.startsWith("https") ? "https" : "http");
      return await new Promise((resolve, reject) => {
        const req = mod.request(new URL(base + "/headers"), { headers: { authorization: "Bearer " + model } }, (res) => {
          let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(JSON.parse(b).headers?.Authorization ?? null));
        });
        req.on("error", reject); req.end();
      })`);
    out.stream = await node(`const t0 = Date.now(); const r = await fetch(base + "/drip?duration=2&numbytes=5&delay=0", { headers: { authorization: "Bearer " + model } });
      const reader = r.body.getReader(); const times = [];
      for (;;) { const { done } = await reader.read(); if (done) break; times.push(Date.now() - t0); }
      return times`);
    out.modelElsewhere = await node(`const r = await fetch("https://api.github.com/zen", { headers: { authorization: "Bearer " + model } }); return { status: r.status, body: await r.json() }`);
    out.githubElsewhere = await node(`const r = await fetch(base + "/headers", { headers: { authorization: "token " + github } }); return { status: r.status, body: await r.json() }`);
    out.bashEnv = await run("bash", ["-c", "env"]);
    const model = controller.modelCredential.placeholder;
    out.curl = await run("bash", ["-c", `curl -sS --max-time 20 -H 'Authorization: Bearer ${model}' ${echoBase}/headers`]);
    window.__model = model;
    out.workerUrl = navigator.serviceWorker.controller?.scriptURL ?? null;
    return out;
  }, { echoBase, MODEL, GITHUB });

  // A browser may stop an idle service worker; its cache goes with it.
  const cdp = await page.createCDPSession();
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const afterStop = await page.evaluate(async (echoBase) => {
    const proc = await window.__controller.pod.spawn("node", ["-e", `const keep = setInterval(() => {}, 1000);
      fetch(${JSON.stringify(echoBase)} + "/headers", { headers: { authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN } })
        .then((r) => r.json()).then((j) => console.log(j.headers?.Authorization ?? null), (e) => console.log(String(e))).finally(() => clearInterval(keep));`]);
    return await new Promise((resolve) => { let s = ""; proc.on("output", (c) => { s += c; }); proc.on("exit", () => resolve(s.trim())); });
  }, echoBase);
  const afterDispose = await page.evaluate(async (echoBase) => {
    await window.__controller.dispose();
    const r = await fetch(`${echoBase}/headers`, { headers: { authorization: `Bearer ${window.__model}` } });
    return { status: r.status, body: await r.json() };
  }, echoBase);

  console.log(JSON.stringify({ ...result, afterStop, afterDispose }, null, 2));
  const placeholder = /^riff-placeholder-model-[0-9a-f]{32}$/;
  assert.match(result.workerUrl, /\/riff-sw\.js$/, "the tab moved to Riff's worker");
  assert.match(result.env.model, placeholder);
  assert.match(result.env.github, /^riff-placeholder-github-[0-9a-f]{32}$/);
  assert.equal(result.env.gh, result.env.github);
  assert.equal(result.bashEnv.code, 0);
  assert.doesNotMatch(result.bashEnv.stdout, /REAL-/, "no real token in the shell's environment");
  assert.match(result.bashEnv.stdout, /^GITHUB_TOKEN=riff-placeholder-github-/m);
  assert.equal(result.fetch, `Bearer ${MODEL}`);
  assert.equal(Buffer.from(result.basic.replace(/^Basic /, ""), "base64").toString(), `x-access-token:${MODEL}`);
  assert.equal(result.httpModule, `Bearer ${MODEL}`);
  assert.equal(JSON.parse(result.curl.stdout).headers.Authorization, `Bearer ${MODEL}`);
  assert.ok(Array.isArray(result.stream) && result.stream.length >= 2, `streamed in pieces: ${JSON.stringify(result.stream)}`);
  assert.ok(result.stream.at(-1) - result.stream[0] >= 800, `pieces arrived over time, not at once: ${JSON.stringify(result.stream)}`);
  assert.equal(result.modelElsewhere.status, 403);
  assert.equal(result.modelElsewhere.body.error, "riff_credential_wrong_origin");
  assert.equal(result.githubElsewhere.status, 403);
  assert.equal(result.githubElsewhere.body.error, "riff_credential_wrong_origin");
  assert.equal(afterStop, `Bearer ${MODEL}`, "a restarted worker asks the page again");
  assert.equal(afterDispose.status, 401);
  assert.equal(afterDispose.body.error, "riff_credential_unavailable");
  console.log("credentials browser smoke passed");
} finally {
  await browser.close();
  mock?.close();
}
