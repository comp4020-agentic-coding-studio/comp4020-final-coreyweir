import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewport({ width: 620, height: 700 });
  await page.goto(`${baseUrl}/?setup=host`, { waitUntil: "networkidle0" });
  const inputs = await page.$$(".entry-card input");
  await inputs[0].type("WASIX Host");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].type("invalid-browser-smoke-token");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click(".entry-card .primary"),
  ]);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".topbar nav button")].find((element) => element.textContent === "Room");
    button?.click();
  });

  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".terminal-controls button")].find((element) => element.textContent === "Start Bash");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Start Bash control was not found");
    button.click();
  });
  try {
    await page.waitForFunction(
      () => document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready"),
      { timeout: 120_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      error: document.querySelector(".terminal-note strong")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`WASIX Bash did not become ready: ${JSON.stringify({ diagnostics, consoleErrors, pageErrors })}`, { cause: error });
  }
  await page.locator(".terminal-target textarea").click();
  await page.keyboard.type("printf '[tty:%s:%s]' \"$COLUMNS\" \"$LINES\"");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => /\[tty:\d+:\d+\]/.test(document.querySelector(".terminal-target .xterm-rows")?.textContent ?? ""),
    { timeout: 30_000 },
  );
  const initialCols = await page.$eval(".terminal-target .xterm-rows", (element) => Number(element.textContent?.match(/\[tty:(\d+):\d+\]/)?.[1]));
  assert.notEqual(initialCols, 80, "The WASIX shell ignored the xterm's initial non-default width");
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
      return text.lastIndexOf("I have no name!@wasmer:/work/repo#") > text.lastIndexOf("[tty:");
    },
    { timeout: 30_000 },
  );
  await page.keyboard.type("printf 'newline-one\\nnewline-two\\nnewline-three\\n'");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".terminal-target .xterm-rows > div")]
      .some((row) => row.textContent?.endsWith("newline-three")),
    { timeout: 30_000 },
  );
  await page.keyboard.type("touch /work/repo/ctrl-c-should-not-run");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Control");
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
      return text.lastIndexOf("I have no name!@wasmer:/work/repo#")
        > text.lastIndexOf("touch /work/repo/ctrl-c-should-not-run");
    },
    { timeout: 30_000 },
  );
  await page.keyboard.type("test ! -e /work/repo/ctrl-c-should-not-run && printf '[idle-ctrl-c]' ");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("[idle-ctrl-c]"),
    { timeout: 30_000 },
  );
  await page.keyboard.type("cd /work; export P4_VALUE=persisted; p4fn(){ printf '[%s:%s]' \"$PWD\" \"$P4_VALUE\"; }; cd repo; p4fn");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("[/work/repo:persisted]"),
    { timeout: 30_000 },
  );
  await page.keyboard.type("printf wasix-origin > terminal-phase4.txt; cat terminal-phase4.txt");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("wasix-origin"),
    { timeout: 30_000 },
  );
  // Wait for the prompt to return so the previous echo is fully flushed
  // before we type the next line (otherwise keystrokes interleave with the
  // still-rendering echo and corrupt the command, e.g. "-node").
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
      return text.lastIndexOf("I have no name!@wasmer:/work/repo#") > text.lastIndexOf("wasix-origin");
    },
    { timeout: 30_000 },
  );
  // Bridge stubs must reach the host through the live interactive shell, not
  // just in a canned `session.run`. A regression that drops coreutils from
  // PATH must also not silently pass: assert node/npm/git AND a coreutil.
  // (sed/awk are absent from wasmer/coreutils@1.0.25; seq exists there.)
  await page.keyboard.type("node --version; npm --version; git --version; seq 3");
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => {
        const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
        return text.includes("v22.12.0") && text.includes("10.0.0")
          && text.includes("git version 2.43.0") && /1\s*2\s*3/.test(text);
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      error: document.querySelector(".terminal-note strong")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`Bridge stubs did not answer in the interactive shell: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("Terminal ready"),
    { timeout: 30_000 },
  );
  await page.locator(".terminal-target textarea").click();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyL");
  await page.keyboard.up("Control");
  const setup = [
    "printf host-side > nodepod-phase4.txt",
    "printf old > executable-phase4",
    "chmod 755 executable-phase4",
    "ln -s executable-phase4 symlink-phase4",
    "printf '.acceptance-*\\n' > .gitignore",
    "git init -q",
    "git config user.email phase4@example.test",
    "git config user.name Phase4",
    "git add .",
    "git commit -q -m baseline",
    "printf 'nodepod-setup-%s\\n' complete",
  ].join(" && ");
  await page.keyboard.type(setup);
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => {
        const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
        const output = text.lastIndexOf("nodepod-setup-complete");
        return output !== -1 && text.lastIndexOf("nodepod:/work/repo$") > output;
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    const text = await page.$eval(".terminal-target .xterm-rows", (element) => element.textContent ?? "");
    throw new Error(`Nodepod setup did not finish: ${JSON.stringify(text)}`, { cause: error });
  }
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".terminal-controls button")].find((element) => element.textContent === "Start Bash");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Start Bash control was not found");
    button.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("Starting WASIX Bash"),
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready"),
    { timeout: 120_000 },
  );
  await page.locator(".terminal-target textarea").click();
  await page.keyboard.type("printf 'no-op-%s' complete; exit");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("no-op-complete"),
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("Terminal ready"),
    { timeout: 30_000 },
  );
  await page.keyboard.type("git diff --name-only > .acceptance-git-status && git diff --cached --name-only >> .acceptance-git-status");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
      const command = text.lastIndexOf("git diff --name-only");
      return command !== -1 && text.lastIndexOf("nodepod:/work/repo$") > command;
    },
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".terminal-controls button")].find((element) => element.textContent === "Start Bash");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Start Bash control was not found");
    button.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("Starting WASIX Bash"),
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready"),
    { timeout: 120_000 },
  );
  await page.locator(".terminal-target textarea").click();
  // `symlink-phase4` is NOT a symlink by the time WASIX sees it. Probe P10
  // measured the Nodepod workspace directly, immediately after the setup above
  // and before any WASIX session touched it: `ln -s` plus `git add`/`git commit`
  // leave a *regular file* holding the target's bytes, and `chmod 755` does not
  // stick either. So `test -e` correctly answers 0 here, and this line asserts
  // only that a relaunched Bash reads a host-authored file.
  //
  // This assertion previously expected 1, and passed only because Bash resolved
  // every relative path against `/` where nothing exists. Real symlink-exclusion
  // coverage now lives in `test:wasix-shared-store-browser`, which
  // builds its link through the volume API and checks both sides.
  await page.keyboard.type("test ! -s .acceptance-git-status && printf 'git-clean-%s ' after-noop; printf '[%s:%s]' \"$(cat nodepod-phase4.txt)\" \"$(test -e symlink-phase4; printf %s $?)\"; printf rewritten > executable-phase4; exit");
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("[host-side:0]"),
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      error: document.querySelector(".terminal-note strong")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`Relaunched Bash did not read the Nodepod file: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  try {
    await page.waitForFunction(
      () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("git-clean-after-noop"),
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`No-op Bash lifecycle dirtied Git: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("Terminal ready"),
    { timeout: 30_000 },
  );
  await page.locator(".terminal-target textarea").click();
  // This line used to assert `test -x executable-phase4 && test -L
  // symlink-phase4`. Neither holds in the fixture — P10 measured 644 and a
  // regular file before WASIX was involved — so it was asserting Nodepod's
  // `test` builtins rather than anything about reconciliation.
  //
  // What it should have checked all along, and now does, is that the WASIX
  // write above actually reached the host. The old form would have passed
  // unchanged while `printf rewritten > executable-phase4` vanished, which is
  // exactly what happened until the path anchor was fixed.
  await page.keyboard.type("cat executable-phase4");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
      const output = text.lastIndexOf("rewritten");
      return output !== -1 && text.lastIndexOf("nodepod:/work/repo$") > output;
    },
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".terminal-controls button")].find((element) => element.textContent === "Start Bash");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Start Bash control was not found");
    button.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".terminal-heading")?.textContent?.includes("WASIX Bash ready"),
    { timeout: 120_000 },
  );
  await page.locator(".terminal-target textarea").click();
  await page.keyboard.type("export INTERRUPT_STATE=preserved; sleep 30");
  await page.keyboard.press("Enter");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Control");
  try {
    await page.waitForFunction(
      () => {
        const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
        return text.lastIndexOf("I have no name!@wasmer:/work/repo#") > text.lastIndexOf("sleep 30");
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`SIGINT did not return to Bash: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  assert.match(await page.$eval(".terminal-heading", (element) => element.textContent ?? ""), /WASIX Bash ready/);
  assert.doesNotMatch(await page.$eval(".terminal-target .xterm-rows", (element) => element.textContent ?? ""), /restarting session/);
  await page.keyboard.type("test \"$INTERRUPT_STATE\" = preserved && printf 'interrupt-signal-%s\\n' preserved-shell-state");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("interrupt-signal-preserved-shell-state"),
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    const rows = document.querySelector(".terminal-target .xterm-rows");
    if (rows === null) throw new Error("xterm rows were not found");
    const sequences = { bg: 0, fg: 0 };
    const sample = () => {
      for (const row of rows.children) {
        const match = /^(bg|fg)-(\d+)$/.exec(row.textContent?.trim() ?? "");
        if (match) sequences[match[1]] = Math.max(sequences[match[1]], Number(match[2]));
      }
    };
    new MutationObserver(sample).observe(rows, { childList: true, subtree: true, characterData: true });
    window.__riffMixedSequences = sequences;
  });
  await page.keyboard.type("export MIXED_INTERRUPT_STATE=preserved; bg=0; (while true; do bg=$((bg+1)); echo bg-$bg; sleep 1; done) & fg=0; while true; do fg=$((fg+1)); echo fg-$fg; sleep 3; done");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".terminal-target .xterm-rows > div")]
      .some((row) => /^fg-\d+$/.test(row.textContent?.trim() ?? "")),
    { timeout: 30_000 },
  );
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Control");
  try {
    await page.waitForFunction(
      () => {
        const text = document.querySelector(".terminal-target .xterm-rows")?.textContent ?? "";
        return text.lastIndexOf("I have no name!@wasmer:/work/repo#") > text.lastIndexOf("while true; do fg=");
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`SIGINT did not stop mixed foreground/background loops: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  assert.match(await page.$eval(".terminal-heading", (element) => element.textContent ?? ""), /WASIX Bash ready/);
  assert.doesNotMatch(await page.$eval(".terminal-target .xterm-rows", (element) => element.textContent ?? ""), /restarting session/);
  const afterPrompt = await page.evaluate(() => ({ ...window.__riffMixedSequences }));
  // A foreground sample whose sleep completed concurrently with SIGINT can
  // still drain after the prompt. Let that in-flight output settle, then prove
  // the foreground sequence stops while the background sequence advances.
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const settled = await page.evaluate(() => ({ ...window.__riffMixedSequences }));
  await page.waitForFunction(
    (bg) => window.__riffMixedSequences.bg > bg,
    { timeout: 5_000 },
    settled.bg,
  );
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const afterWait = await page.evaluate(() => ({ ...window.__riffMixedSequences }));
  assert.ok(afterWait.bg > afterPrompt.bg, "The background loop stopped after Ctrl-C");
  assert.equal(afterWait.fg, settled.fg, "The foreground loop continued after Ctrl-C");
  await page.locator(".terminal-target textarea").click();
  await page.keyboard.type("test \"$MIXED_INTERRUPT_STATE\" = preserved; kill $!; printf 'mixed-interrupt-preserved-shell-state\\n'");
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => document.querySelector(".terminal-target .xterm-rows")?.textContent?.includes("mixed-interrupt-preserved-shell-state"),
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      heading: document.querySelector(".terminal-heading")?.textContent,
      terminal: document.querySelector(".terminal-target .xterm-rows")?.textContent,
    }));
    throw new Error(`Mixed-job cleanup command did not finish: ${JSON.stringify(diagnostics)}`, { cause: error });
  }

  assert.deepEqual(pageErrors, []);
  console.log("Real terminal preserved Bash state, delivered SIGINT, and observed bidirectional shared-store writes.");
} finally {
  await browser.close();
}
