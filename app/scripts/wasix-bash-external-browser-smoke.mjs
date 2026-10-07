import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const BASH = {
  packageUrl: "https://cdn.wasmer.io/webcimages/2d71072b8f2eff804bba8f3edeadca8d52855f31e474b8c4d40b8b898f5fcb39.webc",
  packageSha256: "2d71072b8f2eff804bba8f3edeadca8d52855f31e474b8c4d40b8b898f5fcb39",
  command: "bash",
  entrypoint: true,
  registrySpecifier: "sharrattj/bash@1.0.18",
  uses: ["sharrattj/coreutils@1.0.16"],
};

const COREUTILS = {
  packageUrl: "https://cdn.wasmer.io/webcimages/5909ce0a168ceba89078bea97c19b22e47807cc21a7097bfb45f58c93d00233a.webc",
  packageSha256: "5909ce0a168ceba89078bea97c19b22e47807cc21a7097bfb45f58c93d00233a",
  command: "cat",
  registrySpecifier: "sharrattj/coreutils@1.0.16",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function eventually(check, message, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      try {
        const value = check();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(tick, 25);
    };
    tick();
  });
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${baseUrl}/?poc=github-auth`, { waitUntil: "networkidle0" });
  const result = await page.evaluate(async ({ bash, coreutils }) => {
    const [{ ClaudePodController }, { WasixSession }] = await Promise.all([
      import("/src/claudePod.ts"),
      import("/src/wasixSession.ts"),
    ]);
    const controller = new ClaudePodController({ baseUrl: "https://api.anthropic.com", token: "unused", repo: "" }, () => {});
    await controller.boot();
    let bashSession;
    let coreutilsSession;
    try {
      await controller.pod.fs.writeFile("/work/repo/x", "before-value\n");
      bashSession = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
      const output = [];
      let write;
      const ready = new Promise((resolve) => { write = resolve; });
      const running = bashSession.run(bash, [], {
        onOutput: (_stream, chunk) => output.push(new TextDecoder().decode(chunk)),
        onReady: (send) => write(send),
      });
      const stdin = await Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Bash did not expose live stdin")), 30_000)),
      ]);
      const send = async (line) => {
        const start = output.join("").length;
        await stdin(new TextEncoder().encode(`${line}\r`));
        return start;
      };
      // Waits for a pattern that the *echo* of the typed command cannot
      // contain. Counting occurrences of a bare marker does not work here:
      // this Bash re-echoes its input line on every prompt redraw (P10 measured
      // 54 redraws for 11 commands), so "marker seen twice" is satisfied by two
      // echoes and the wait returns before the command has produced anything.
      // That is P10's trap 3 — "matching the echo" — and it is why this smoke
      // captured a truncated echo where it expected `cat`'s stderr.
      //
      // `printf "...%s\n" "$?"` echoes the literal `%s` and only ever *prints*
      // a digit, so anchoring on the digit distinguishes output from echo
      // regardless of how many times the line is redrawn.
      const waitForPattern = async (start, pattern, label) => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const text = output.join("").slice(start);
          if (pattern.test(text)) return text;
          if (Date.now() >= deadline) throw new Error(`Missing ${label}: ${text}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const beforeStart = await send('cat x;printf "__RIFF_BEFORE__%s\\n" "$?"');
      let bashBefore;
      try {
        bashBefore = await waitForPattern(beforeStart, /__RIFF_BEFORE__\d/, "__RIFF_BEFORE__<exit>");
      } catch (error) {
        bashBefore = `${output.join("").slice(beforeStart)}\n${error}`;
      }

      await controller.pod.fs.writeFile("/work/repo/external-after.txt", "after-value\n");
      const builtinStart = await send('printf "builtin=%s\\n" "$PWD"');
      const builtin = await waitForPattern(builtinStart, /builtin=\/work\/repo\r?\n/, "builtin=/work/repo");
      const afterStart = await send('cat external-after.txt;printf "__RIFF_AFTER__%s\\n" "$?"');
      let bashAfter;
      try {
        bashAfter = await waitForPattern(afterStart, /__RIFF_AFTER__\d/, "__RIFF_AFTER__<exit>");
      } catch (error) {
        bashAfter = `${output.join("").slice(afterStart)}\n${error}`;
      }

      coreutilsSession = await WasixSession.open({ volume: controller.pod.volume, root: "/work/repo" });
      const standalone = await coreutilsSession.run(coreutils, ["/work/repo/external-after.txt"], { cwd: "/work/repo" });
      return {
        bashBefore,
        builtin,
        bashAfter,
        standalone: { code: standalone.code, stdout: new TextDecoder().decode(standalone.stdout), stderr: new TextDecoder().decode(standalone.stderr) },
      };
    } finally {
      await coreutilsSession?.dispose();
      await bashSession?.dispose();
      await controller.dispose();
    }
  }, { bash: BASH, coreutils: COREUTILS });

  console.log(JSON.stringify(result, null, 2));
  assert.match(result.bashBefore, /cat: x: No such file or directory/);
  assert.match(result.bashAfter, /cat: external-after\.txt: No such file or directory/);
  assert.equal(result.standalone.code, 0, result.standalone.stderr);
  assert.equal(result.standalone.stdout, "after-value\n");
  assert.match(result.builtin, /builtin=\/work\/repo/);
  assert.equal(result.standalone.code, 0, result.standalone.stderr);
  assert.equal(result.standalone.stdout, "after-value\n");
  // The registry Bash worker reports store teardown after the session is
  // intentionally terminated. The command and standalone coreutils results
  // above are the behavior under test.
  if (errors.some((error) => !error.includes("Unable to initialize the context and store"))) {
    throw new Error(`Unexpected browser errors: ${JSON.stringify(errors)}`);
  }
} finally {
  await browser.close();
}
