import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const previewPort = 4317;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`${baseUrl}/?poc=blank`, { waitUntil: "networkidle0" });
  await page.evaluate(async () => {
    window.__previewEvents = [];
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {}, (url) => window.__previewEvents.push(url));
    await controller.boot();
    window.__previewController = controller;
  });

  // What the preview relay asks of the host's pod (previewChannel.ts).
  const request = (path) => page.evaluate(async (path) => {
    const response = await window.__previewController.requestPreview({ method: "GET", path, headers: {}, body: null });
    return { status: response.status, type: response.headers["content-type"], body: new TextDecoder().decode(response.body) };
  }, path);

  async function startServer(text) {
    await page.evaluate(async ({ body, port }) => {
      const index = `<link rel="stylesheet" href="./styles.css"><a id="links" href="./links.html">Links</a><h1>${body}</h1>`;
      const links = `<link rel="stylesheet" href="./styles.css"><a id="home" href="./index.html">Home</a><h1>${body} links</h1>`;
      const source = `require('http').createServer((req,res)=>{res.setHeader('content-type',req.url==='/styles.css'?'text/css':'text/html');if(req.url==='/styles.css')return res.end('body{--preview-styled:yes}');if(req.url==='/links.html')return res.end(${JSON.stringify(links)});res.end(${JSON.stringify(index)})}).listen(${port})`;
      window.__previewProcess = await window.__previewController.pod.spawn("node", [
        "-e",
        source,
      ]);
    }, { body: text, port: previewPort });
    await page.waitForFunction(() => Boolean(window.__previewEvents.at(-1)), { timeout: 30_000, polling: 100 });
    assert.match((await request("/")).body, new RegExp(text));
  }

  await startServer("Riff preview ready");
  const firstUrl = await page.evaluate(() => window.__previewEvents.at(-1));
  assert.match(firstUrl, new RegExp(`/__virtual__/[^/]+/${previewPort}$`));
  assert.deepEqual(await request("/links.html"), { status: 200, type: "text/html", body: '<link rel="stylesheet" href="./styles.css"><a id="home" href="./index.html">Home</a><h1>Riff preview ready links</h1>' });
  assert.deepEqual(await request("/styles.css"), { status: 200, type: "text/css", body: "body{--preview-styled:yes}" });

  // A pod's page never loads as a document on Riff's origin (docs/adr/0011):
  // Riff's worker refuses the URL Nodepod reports before Nodepod can serve it.
  // The relay smokes check the preview on its own origin.
  const framed = await page.evaluate(async (src) => {
    const frame = document.createElement("iframe");
    frame.src = src;
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    return frame.contentDocument?.body?.textContent ?? "";
  }, firstUrl);
  assert.match(framed, /Previews open on their own origin/);
  assert.doesNotMatch(framed, /Riff preview ready/);

  await page.evaluate(() => window.__previewProcess.kill());
  await page.waitForFunction(() => window.__previewEvents.at(-1) === null, { timeout: 30_000, polling: 100 });
  await assert.rejects(request("/"), /Preview is offline/);

  await startServer("Riff preview restarted");
  assert.equal(await page.evaluate(() => window.__previewEvents.at(-1)), firstUrl);
  assert.equal(await page.evaluate(() => window.__previewEvents.filter(Boolean).length), 2);
  await page.evaluate(() => window.__previewController.dispose());
  assert.deepEqual(pageErrors, []);
  console.log("Nodepod preview start, stop, serving to the relay, refusal on Riff's origin, and restart passed.");
} finally {
  await browser.close();
}
