// The host's workspace survives a reload (docs/adr/0010).
//
// One tab boots a pod for a throwaway room, and changes its filesystem
// every way the room's programs do: WASIX bash (the shared store), a node
// process (Nodepod's worker, synced back), and Nodepod's git (an unpushed
// commit). It waits until OPFS has the changes (reading the manifest the
// page wrote, not a sleep), then reloads with no warning, the way a crash
// or an accidental reload would. A fresh pod for the same room must have
// everything under /work and /home/user back, byte for byte, and nothing
// outside them. Then a second tab takes the workspace over and the first
// stops saving, and Delete leaves nothing in OPFS.
//
// With CLONE_TOKEN (a GitHub token; it stays in the page, the guest gets
// a placeholder) it also clones CLONE_REPO (default octocat/Hello-World)
// at boot, and checks a reload opens the clone rather than cloning again.
//
// Also measured: saving and restoring FILES small files (default 10000,
// about the size of a small node_modules).
//
// Can't tell apart: a save that only reached OPFS's in-memory cache from
// one on disk (a reload doesn't clear it, a browser crash might); a real
// browser crash from a reload.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const FILES = Number(process.env.FILES ?? 10000);
const cloneToken = process.env.CLONE_TOKEN ?? "";
const cloneRepo = process.env.CLONE_REPO ?? "octocat/Hello-World";
const room = `smoke-ws-${Date.now().toString(36)}`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

// In the page: boot a pod for the room, with a terminal, and helpers.
async function bootPod(page, { repo = "", githubToken } = {}) {
  await page.goto(`${baseUrl}/?poc=blank`, { waitUntil: "networkidle0" });
  return page.evaluate(async ({ room, repo, githubToken }) => {
    const started = performance.now();
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const statuses = [];
    const controller = new ClaudePodController(
      { baseUrl: "https://api.anthropic.com", token: "smoke", repo, githubToken, workspaceRoom: room },
      (status) => statuses.push(status),
    );
    window.__controller = controller;
    window.__statuses = statuses;
    await controller.boot();
    const booted = performance.now() - started;
    const target = document.createElement("div");
    target.style.cssText = "width:900px;height:500px";
    document.body.append(target);
    controller.attach(target);
    await controller.startWasixBash();
    window.__run = async (cmd, args) => {
      const proc = await controller.pod.spawn(cmd, args, { cwd: "/work/repo" });
      return new Promise((resolve) => {
        let out = "";
        proc.on("output", (c) => { out += c; });
        proc.on("error", (c) => { out += c; });
        proc.on("exit", (code) => resolve({ code, out: out.trim() }));
      });
    };
    window.__text = () => {
      const buffer = controller.terminal.xterm.buffer.active;
      const lines = [];
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n");
    };
    // What OPFS holds for the room, read the way the next boot will.
    window.__saved = async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("riff-workspaces").then((d) => d.getDirectoryHandle(room)).catch(() => null);
      if (!dir) return null;
      const read = async (slot) => {
        try { return JSON.parse(await (await (await dir.getFileHandle(`manifest-${slot}.json`)).getFile()).text()); } catch { return null; }
      };
      const [a, b] = await Promise.all([read(0), read(1)]);
      return !a ? b : !b ? a : a.seq >= b.seq ? a : b;
    };
    window.__waitSaved = async (paths, gone = [], timeout = 120_000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const manifest = await window.__saved();
        if (manifest && paths.every((p) => p in manifest.entries) && gone.every((p) => !(p in manifest.entries))) return manifest;
        if (Date.now() > deadline) throw new Error(`not saved: ${paths.filter((p) => !manifest || !(p in manifest.entries)).join(", ")}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    return { booted };
  }, { room, repo, githubToken });
}

try {
  // ---- first tab: make changes, wait for OPFS, reload ----
  const page = await browser.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await bootPod(page);
  const first = await page.evaluate(async (FILES) => {
    const run = window.__run;
    const steps = {};
    steps.bash = await run("bash", ["-c", [
      "mkdir -p /work/repo/src /work/repo/a/b /tmp/scratch",
      "echo from-bash > /work/repo/src/bash.txt",
      "echo inner > /work/repo/a/b/file.txt",
      "echo doomed > /work/repo/gone.txt",
      "echo scratch > /tmp/scratch/note.txt",
      "mkdir -p /home/user/.claude/projects/-work-repo && echo '{\"t\":1}' > /home/user/.claude/projects/-work-repo/session.jsonl",
    ].join(" && ")]);
    // A mode, set from the page in the same tick as the write: chmod in
    // WASIX bash doesn't reach the store (no chmod in WASIX), and a chmod
    // alone isn't reported by the volume, so it's saved with the file's
    // next change.
    window.__controller.pod.volume.writeFileSync("/work/repo/run.sh", "#!/bin/sh\necho hi\n");
    window.__controller.pod.volume.chmodSync("/work/repo/run.sh", 0o755);
    steps.node = await run("node", ["-e", `const fs = require("fs");
      fs.writeFileSync("/work/repo/node.txt", "from-node");
      fs.writeFileSync("/work/repo/bytes.bin", Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
      fs.mkdirSync("/work/repo/node_modules/pkg", { recursive: true });
      fs.writeFileSync("/work/repo/node_modules/pkg/index.js", "module.exports = 1");`]);
    steps.git = [
      await run("git", ["init"]),
      await run("git", ["config", "user.name", "Smoke"]),
      await run("git", ["config", "user.email", "smoke@example.com"]),
      await run("git", ["add", "src/bash.txt", "node.txt"]),
      await run("git", ["commit", "-m", "unpushed work"]),
    ];
    // A removal and a directory rename after they were first saved.
    await window.__waitSaved(["/work/repo/gone.txt", "/work/repo/a/b/file.txt"]);
    steps.remove = await run("bash", ["-c", "rm /work/repo/gone.txt && mv /work/repo/a /work/repo/c"]);
    const manifest = await window.__waitSaved([
      "/work/repo/src/bash.txt", "/work/repo/node.txt", "/work/repo/bytes.bin", "/work/repo/run.sh",
      "/work/repo/c/b/file.txt", "/work/repo/.git/HEAD", "/work/repo/node_modules/pkg/index.js",
      "/home/user/.claude/projects/-work-repo/session.jsonl",
    ], ["/work/repo/gone.txt", "/work/repo/a", "/work/repo/a/b/file.txt"]);
    steps.log = await run("git", ["log", "--oneline"]);

    // Many small files, as an install writes them: time until all are in OPFS.
    const t0 = performance.now();
    await run("node", ["-e", `const fs = require("fs");
      for (let d = 0; d < ${Math.ceil(FILES / 100)}; d++) {
        fs.mkdirSync("/work/repo/node_modules/many/d" + d, { recursive: true });
        for (let f = 0; f < 100 && d * 100 + f < ${FILES}; f++) fs.writeFileSync("/work/repo/node_modules/many/d" + d + "/f" + f + ".js", "module.exports = " + (d * 100 + f) + ";\\n".repeat(20));
      }`]);
    const written = performance.now() - t0;
    const last = Math.ceil(FILES / 100) - 1;
    const lastFile = `/work/repo/node_modules/many/d${last}/f${FILES - 1 - last * 100}.js`;
    const big = await window.__waitSaved([lastFile], [], 600_000);
    const savedAt = performance.now() - t0;
    return { steps, entries: Object.keys(manifest.entries).length, many: { written, savedAt, files: big.files, bytes: big.bytes } };
  }, FILES);
  console.log("first tab", JSON.stringify({ ...first, steps: { ...first.steps, git: first.steps.git.map((s) => s.code) } }));
  assert.equal(first.steps.bash.code, 0, first.steps.bash.out);
  assert.equal(first.steps.node.code, 0, first.steps.node.out);
  for (const step of first.steps.git) assert.equal(step.code, 0, step.out);
  assert.match(first.steps.log.out, /unpushed work/);

  // No dispose, no flush: as abrupt as a reload gets.
  await page.reload({ waitUntil: "networkidle0" });
  const { booted } = await bootPod(page);
  const second = await page.evaluate(async () => {
    const run = window.__run;
    const volume = window.__controller.pod.volume;
    const bytes = volume.readFileSync("/work/repo/bytes.bin");
    return {
      bash: await run("bash", ["-c", "cat /work/repo/src/bash.txt /work/repo/node.txt /work/repo/c/b/file.txt /home/user/.claude/projects/-work-repo/session.jsonl; ls /work/repo; ls /tmp/scratch 2>&1; /work/repo/run.sh"]),
      git: await run("git", ["log", "--oneline"]),
      status: await run("git", ["status", "--short"]),
      bytesOk: bytes.length === 256 && Array.from(bytes).every((b, i) => b === i),
      mode: (volume.statSync("/work/repo/run.sh").mode & 0o777).toString(8),
      gone: volume.existsSync("/work/repo/gone.txt"),
      oldDir: volume.existsSync("/work/repo/a"),
      many: volume.readdirSync("/work/repo/node_modules/many").length,
      text: window.__text(),
    };
  });
  console.log("after reload", JSON.stringify({ ...second, status: undefined, text: undefined }));
  console.log("boot with the workspace restored (ms)", Math.round(booted));
  assert.equal(second.bash.code, 0, second.bash.out);
  assert.match(second.bash.out, /from-bash\s+from-node\s*inner\s+\{"t":1\}/);
  assert.match(second.bash.out, /No such file|cannot access/, "/tmp isn't saved");
  assert.match(second.bash.out, /\bhi$/, "run.sh still runs");
  assert.match(second.git.out, /unpushed work/, "the unpushed commit is back");
  assert.equal(second.bytesOk, true, "binary bytes intact");
  assert.equal(second.mode, "755");
  assert.equal(second.gone, false, "a deleted file stays deleted");
  assert.equal(second.oldDir, false, "a renamed directory isn't back under its old name");
  assert.equal(second.many, Math.ceil(FILES / 100));
  assert.match(second.text, /Restored this room's workspace/);
  assert.match(second.text, /Saved in this browser/);

  // ---- a second tab takes it over ----
  const other = await browser.newPage();
  other.on("dialog", (dialog) => void dialog.accept());
  await bootPod(other);
  const lost = await page.evaluate(async () => {
    const deadline = Date.now() + 10_000;
    while (!window.__text().includes("no longer saved") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await window.__run("bash", ["-c", "echo late > /work/repo/late.txt"]);
    return window.__text().includes("no longer saved");
  });
  assert.equal(lost, true, "the first tab says it stopped saving");
  const takenOver = await other.evaluate(async () => {
    await window.__run("bash", ["-c", "echo second > /work/repo/second.txt"]);
    const manifest = await window.__waitSaved(["/work/repo/second.txt"]);
    return { late: "/work/repo/late.txt" in manifest.entries, commit: (await window.__run("git", ["log", "--oneline"])).out };
  });
  console.log("takeover", JSON.stringify(takenOver));
  assert.equal(takenOver.late, false, "the first tab no longer writes the workspace");
  assert.match(takenOver.commit, /unpushed work/);

  // ---- delete ----
  const deleted = await other.evaluate(async (room) => {
    await window.__controller.dispose();
    const { deleteWorkspace, listWorkspaces } = await import("/src/workspace.ts");
    const before = (await listWorkspaces()).some((w) => w.room === room);
    await deleteWorkspace(room);
    const root = await navigator.storage.getDirectory();
    const left = await root.getDirectoryHandle("riff-workspaces").then((d) => d.getDirectoryHandle(room)).then(() => true, () => false);
    return { before, after: (await listWorkspaces()).some((w) => w.room === room), left };
  }, room);
  console.log("delete", JSON.stringify(deleted));
  assert.deepEqual(deleted, { before: true, after: false, left: false });
  await page.close();
  await other.close();

  // ---- clone at boot ----
  if (cloneToken) {
    const clonePage = await browser.newPage();
    const cloneRoom = `${room}-clone`;
    const bootClone = (p) => p.evaluate(async ({ room, repo, githubToken }) => {
      const { ClaudePodController } = await import("/src/claudePod.ts");
      const controller = new ClaudePodController(
        { baseUrl: "https://api.anthropic.com", token: "smoke", repo, githubToken, workspaceRoom: room }, () => {},
      );
      window.__controller = controller;
      await controller.boot();
      const target = document.createElement("div");
      target.style.cssText = "width:900px;height:500px";
      document.body.append(target);
      controller.attach(target);
      await controller.startWasixBash();
      const buffer = controller.terminal.xterm.buffer.active;
      const lines = [];
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
      const proc = await controller.pod.spawn("git", ["log", "--oneline"], { cwd: "/work/repo" });
      const log = await new Promise((resolve) => { let s = ""; proc.on("output", (c) => { s += c; }); proc.on("exit", () => resolve(s)); });
      return { text: lines.join("\n"), files: controller.pod.volume.readdirSync("/work/repo"), log };
    }, { room: cloneRoom, repo: cloneRepo, githubToken: cloneToken });
    await clonePage.goto(`${baseUrl}/?poc=blank`, { waitUntil: "networkidle0" });
    const cloned = await bootClone(clonePage);
    assert.match(cloned.text, /Cloning https:\/\/github\.com\//);
    assert.ok(cloned.files.includes(".git"), "cloned");
    assert.ok(!cloned.files.includes(".keep"), "no .keep in the clone");
    await clonePage.evaluate(async () => {
      const deadline = Date.now() + 60_000;
      const { listWorkspaces } = await import("/src/workspace.ts");
      // the first save of a fresh clone
      while (Date.now() < deadline && !(await listWorkspaces()).some((w) => w.files > 0)) await new Promise((r) => setTimeout(r, 100));
      await window.__controller.workspace.flush();
    });
    await clonePage.reload({ waitUntil: "networkidle0" });
    const reopened = await bootClone(clonePage);
    console.log("clone", JSON.stringify({ files: cloned.files, log: cloned.log.trim(), reopenedLog: reopened.log.trim() }));
    assert.doesNotMatch(reopened.text, /Cloning/, "an existing workspace isn't cloned again");
    assert.match(reopened.text, /Restored this room's workspace/);
    assert.equal(reopened.log.trim(), cloned.log.trim());
    await clonePage.evaluate(async (room) => {
      await window.__controller.dispose();
      const { deleteWorkspace } = await import("/src/workspace.ts");
      await deleteWorkspace(room);
    }, cloneRoom);
  } else {
    console.log("clone: skipped (no CLONE_TOKEN)");
  }
  console.log("workspace smoke passed");
} finally {
  await browser.close();
}
