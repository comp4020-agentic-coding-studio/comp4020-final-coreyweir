// Regression (USABILITY_ROADMAP W3, riff.31): a persistent-shell line that
// mixes a streaming external command with buffered builtin output must render
// BOTH — previously the whole shell-done payload was dropped once anything
// had streamed live, so `bash -c 'echo ALPHA' && echo OMEGA` printed only
// ALPHA and looked exactly like a nonzero exit.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => {
    if (!String(error).includes("ProcessExitSentinel: Process exited with code 0")) throw new Error(String(error));
  });
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });

  const result = await page.evaluate(async () => {
    const [{ ClaudePodController }] = await Promise.all([import("/src/claudePod.ts")]);
    const reports = [];
    const controller = new ClaudePodController(
      { baseUrl: "https://api.anthropic.com", token: "unused", repo: "" },
      (s) => reports.push(s),
    );
    await controller.boot();
    try {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const term = controller.pod.createTerminal({
        Terminal: (await import("/node_modules/.vite/deps/@xterm_xterm.js")).Terminal,
        FitAddon: (await import("/node_modules/.vite/deps/@xterm_addon-fit.js")).FitAddon,
        SerializeAddon: (await import("/node_modules/.vite/deps/@xterm_addon-serialize.js")).SerializeAddon,
        prompt: (cwd) => `nodepod:${cwd}$ `,
      });
      term.attach(host);
      await new Promise((r) => setTimeout(r, 400));
      const xterm = term.xterm;
      const dumpLines = () => {
        const buf = xterm.buffer.active;
        const lines = [];
        for (let i = 0; i < buf.length; i++) {
          const l = buf.getLine(i);
          if (l) lines.push(l.translateToString(true).trimEnd());
        }
        return lines;
      };
      // Wait until the persistent shell is idle again after a typed line.
      const waitIdle = async (timeoutMs, needBashReport = false) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const idle = term._running === false && (!needBashReport || reports.some((r) => r.includes("[bash] exited")));
          if (idle) {
            // give the completion paint one frame budget
            await new Promise((r) => setTimeout(r, 300));
            return true;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return false;
      };

      // Warm the WASIX bootstrap with the simplest possible line first.
      term._handleInput("true\r");
      let ok = await waitIdle(180_000);

      reports.length = 0;
      term._handleInput("bash -c 'echo STREAMED' && echo BUFFERED\r");
      ok = await waitIdle(120_000, true);
      if (!ok) return { fail: "mixed line did not settle" };

      const lines = dumpLines().map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
      return {
        lines,
        sawStreamed: lines.some((l) => l === "STREAMED"),
        sawBuffered: lines.some((l) => l === "BUFFERED" && !l.includes("echo")),
      };
    } finally {
      await controller.dispose();
    }
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.fail) throw new Error(result.fail);
  assert.equal(result.sawStreamed, true, "streamed external output missing");
  assert.equal(result.sawBuffered, true, "buffered builtin output dropped after a streamed stage");
  console.log("Terminal tail regression: streamed and buffered output both rendered.");
} finally {
  await browser.close();
}
