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
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  await page.evaluate(async () => {
    window.__previewEvents = [];
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const controller = new ClaudePodController({
      baseUrl: "https://api.anthropic.com",
      token: "unused",
      repo: "",
    }, () => {}, (url) => {
      window.__previewEvents.push(url);
      document.querySelector(".preview-frame")?.remove();
      if (!url) return;
      const iframe = document.createElement("iframe");
      iframe.className = "preview-frame";
      iframe.src = url;
      document.body.append(iframe);
    });
    await controller.boot();
    window.__previewController = controller;
  });

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
    await page.waitForSelector(".preview-frame", { timeout: 30_000 });
    const frame = await page.waitForFrame((candidate) => candidate.url().includes("/__virtual__/") && candidate.url().endsWith(`/${previewPort}`));
    await frame.waitForFunction((expected) => document.body.textContent?.includes(expected), { timeout: 30_000 }, text);
  }

  await startServer("Riff preview ready");
  const firstUrl = await page.$eval(".preview-frame", (frame) => frame.src);
  assert.match(firstUrl, new RegExp(`/__virtual__/[^/]+/${previewPort}$`));
  const firstFrame = await (await page.$(".preview-frame")).contentFrame();
  assert(firstFrame);
  assert.equal(await firstFrame.evaluate(() => document.querySelector("base")?.href), `${firstUrl}/`);
  assert.equal(await firstFrame.$eval("#links", (link) => link.href), `${firstUrl}/links.html`);
  await firstFrame.click("#links");
  await firstFrame.waitForSelector("#home");
  assert.equal(firstFrame.url(), `${baseUrl}/links.html`);
  assert.equal(await firstFrame.$eval("h1", (heading) => heading.textContent), "Riff preview ready links");
  assert.equal(await firstFrame.$eval("#home", (link) => link.href), `${firstUrl}/index.html`);
  await firstFrame.click("#home");
  await firstFrame.waitForSelector("#links");
  assert.equal(firstFrame.url(), `${baseUrl}/index.html`);
  assert.equal(await firstFrame.$eval("h1", (heading) => heading.textContent), "Riff preview ready");
  assert.equal(await firstFrame.evaluate(() => getComputedStyle(document.body).getPropertyValue("--preview-styled")), "yes");

  await page.evaluate(() => window.__previewProcess.kill());
  await page.waitForFunction(
    () => window.__previewEvents.at(-1) === null && !document.querySelector(".preview-frame"),
    { timeout: 30_000 },
  );

  await startServer("Riff preview restarted");
  assert.equal(await page.$eval(".preview-frame", (frame) => frame.src), firstUrl);
  assert.equal(await page.evaluate(() => window.__previewEvents.filter(Boolean).length), 2);
  await page.evaluate(() => window.__previewController.dispose());
  assert.deepEqual(pageErrors, []);
  console.log("Nodepod Preview start, stop, iframe rendering, and restart passed.");
} finally {
  await browser.close();
}
