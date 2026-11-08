// Workspace export against a real pod (app/src/workspaceExport.ts,
// ClaudePodController.exportWorkspace): files written the three ways a
// workspace gets them (Nodepod's fs, a node process, WASIX bash), a git
// repo with a pasted-in token, dependencies, Riff's own session folder and a
// Claude transcript. The zip is read back here, outside the page, and
// compared byte for byte, and `python3 -m zipfile -t` checks the archive
// is one a stock tool accepts.
//
// Not told apart: a transcript Claude Code wrote itself (this one is
// written to the path the module expects); and an OPFS-backed pod, since
// this pod is memory-backed until the OPFS workspace lands.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { unzipSync } from "fflate";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8095";
const MODEL = "REAL-MODEL-TOKEN-smoke-0123456789";
const GITHUB = "REAL-GITHUB-TOKEN-smoke-0123456789";

const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
const bigBinary = new Uint8Array(randomBytes(300_000));
const dec = new TextDecoder();

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  protocolTimeout: 900_000,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.goto(`${baseUrl}/?poc=blank`, { waitUntil: "networkidle0" });

  const made = await page.evaluate(async ({ MODEL, GITHUB, allBytes, bigBinary }) => {
    const { ClaudePodController } = await import("/src/claudePod.ts");
    const controller = new ClaudePodController({ baseUrl: "https://example.invalid", token: MODEL, repo: "", githubToken: GITHUB }, () => {});
    window.__controller = controller;
    await controller.boot();
    const pod = controller.pod;
    const run = async (cmd, args, cwd = "/work/repo") => {
      const proc = await pod.spawn(cmd, args, { cwd });
      return await new Promise((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`timeout: ${cmd} ${args.join(" ")}\n${out}`)), 120_000);
        proc.on("output", (c) => { out += c; });
        proc.on("error", (c) => { out += c; });
        proc.on("exit", (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
      });
    };
    const out = {};
    // 1. Nodepod's fs: nested dirs, binary files, an empty file, a name with a space and unicode.
    await pod.fs.mkdir("/work/repo/src/deeply/nested", { recursive: true });
    await pod.fs.writeFile("/work/repo/src/deeply/nested/main.js", "console.log('hi');\n");
    await pod.fs.writeFile("/work/repo/assets-all-bytes.bin", new Uint8Array(allBytes));
    await pod.fs.writeFile("/work/repo/big.bin", new Uint8Array(bigBinary));
    await pod.fs.writeFile("/work/repo/empty.txt", "");
    await pod.fs.mkdir("/work/repo/with space", { recursive: true });
    await pod.fs.writeFile("/work/repo/with space/ünï.txt", "unicode\n");
    // 2. A node process.
    out.node = await run("node", ["-e", "require('fs').writeFileSync('from-node.bin', Buffer.from(Array.from({length:512},(_, i)=>(i*7)&255)))"]);
    // 3. Dependencies, and a token pasted into a remote the way a host might.
    await pod.fs.mkdir("/work/repo/node_modules/left-pad", { recursive: true });
    await pod.fs.writeFile("/work/repo/node_modules/left-pad/index.js", "module.exports = 1;\n");
    out.git = [];
    out.git.push(await run("git", ["init"]));
    out.git.push(await run("git", ["config", "user.email", "host@example.com"]));
    out.git.push(await run("git", ["config", "user.name", "Host"]));
    out.git.push(await run("git", ["remote", "add", "origin", `https://x-access-token:${GITHUB}@github.com/o/r.git`]));
    await pod.fs.writeFile("/work/repo/.gitignore", "node_modules\n");
    out.git.push(await run("git", ["add", "src", "assets-all-bytes.bin", ".gitignore"]));
    out.git.push(await run("git", ["commit", "-m", "unpushed work"]));
    // 4. A real token in a file (a host pasting it into a note).
    await pod.fs.writeFile("/work/repo/notes.txt", `my token: ${MODEL}\n`);
    // 5. WASIX bash: starts Riff's session folder, and writes a binary file the guest's way.
    out.bash = await run("bash", ["-c", "head -c 4096 /dev/urandom > from-bash.bin; (sha256sum from-bash.bin || true)"]);
    // 6. A Claude transcript, where Claude Code keeps them.
    await pod.fs.mkdir("/home/user/.claude/projects/-work-repo", { recursive: true });
    await pod.fs.writeFile("/home/user/.claude/projects/-work-repo/0b1c2d3e.jsonl", `{"type":"user","message":{"content":"build a todo app"}}\n{"type":"assistant","message":{"content":"tool said ${GITHUB}"}}\n`);
    out.sessionDir = await pod.fs.readdir("/work/repo/.wasix-session").catch(() => null);
    out.bashBytes = Array.from(await pod.fs.readFile("/work/repo/from-bash.bin"));
    return out;
  }, { MODEL, GITHUB, allBytes: Array.from(allBytes), bigBinary: Array.from(bigBinary) });

  for (const step of [made.node, ...made.git]) assert.equal(step.code, 0, JSON.stringify(step));
  assert.ok(made.sessionDir?.length, `Riff's session folder exists, so its exclusion is really tested: ${JSON.stringify(made.sessionDir)}`);
  assert.equal(made.bashBytes.length, 4096, `bash wrote 4096 bytes: ${made.bash.out}`);
  const bashSha = made.bash.out.match(/^([0-9a-f]{64})\s+from-bash\.bin/m)?.[1] ?? null;

  async function exportZip(options) {
    const result = await page.evaluate(async (options) => {
      const result = await window.__controller.exportWorkspace(options);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { zip: btoa(binary), manifest: result.manifest, name: result.name };
    }, options);
    const zip = Buffer.from(result.zip, "base64");
    return { zip, files: unzipSync(new Uint8Array(zip)), manifest: result.manifest, name: result.name };
  }

  const stockTool = (zip) => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "riff-ws-")), "export.zip");
    writeFileSync(file, zip);
    const result = spawnSync("python3", ["-m", "zipfile", "-t", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `a stock tool reads the zip: ${result.stdout}${result.stderr}`);
  };

  // --- no dependencies (the default), transcripts unticked
  const plain = await exportZip({ room: "SMOKE1", transcripts: false });
  stockTool(plain.zip);
  const f = plain.files;
  const same = (name, expected) => {
    assert.ok(f[name], `${name} is in the zip`);
    assert.deepEqual(Buffer.from(f[name]), Buffer.from(expected), `${name} is byte for byte what the pod had`);
  };
  same("repo/src/deeply/nested/main.js", "console.log('hi');\n");
  same("repo/assets-all-bytes.bin", allBytes);
  same("repo/big.bin", bigBinary);
  same("repo/empty.txt", "");
  same("repo/with space/ünï.txt", "unicode\n");
  same("repo/from-node.bin", Uint8Array.from({ length: 512 }, (_, i) => (i * 7) & 255));
  same("repo/from-bash.bin", made.bashBytes);
  if (bashSha) assert.equal(createHash("sha256").update(f["repo/from-bash.bin"]).digest("hex"), bashSha, "the zip's bash file matches the hash bash computed in the guest");
  else console.log("note: no sha256sum in the guest; the bash file was compared with what Nodepod read back");
  assert.ok(f["repo/.git/HEAD"] && f["repo/.git/objects/store.json"], "unpushed commits (.git) travel");
  assert.match(dec.decode(f["repo/.git/objects/store.json"]), /unpushed work/);
  assert.equal(Object.keys(f).some((n) => n.includes("node_modules")), false, "dependencies stay out by default");
  assert.equal(Object.keys(f).some((n) => n.includes(".wasix-session")), false, "Riff's session folder stays out");
  assert.equal(Object.keys(f).some((n) => n.startsWith("claude/")), false, "transcripts stay out by default");
  const config = dec.decode(f["repo/.git/config"]);
  assert.match(config, /url = https:\/\/github\.com\/o\/r\.git/, "the remote stays, without its token");
  assert.match(config, /host@example\.com/, "the rest of the config stays");
  assert.match(dec.decode(f["repo/notes.txt"]), /^my token: \*+\n$/, "a real token pasted into a file is overwritten");
  for (const [name, data] of Object.entries(f)) {
    const text = Buffer.from(data).toString("latin1");
    assert.equal(text.includes(MODEL) || text.includes(GITHUB), false, `no real token in ${name}`);
  }
  const manifest = JSON.parse(dec.decode(f["riff-workspace.json"]));
  assert.deepEqual(manifest, plain.manifest);
  assert.ok(manifest.left.some((e) => e.reason === "dependencies" && e.path === "repo/node_modules"));
  assert.ok(manifest.left.some((e) => e.reason === "session" && e.path === "repo/.wasix-session" && e.bytes > 1_000_000), "the session folder is named and sized");
  assert.ok(manifest.left.some((e) => e.reason === "transcripts" && e.files === 1));
  assert.ok(manifest.changed.some((e) => e.path === "repo/.git/config" && e.what === "url-credentials-removed"));
  assert.ok(manifest.changed.some((e) => e.path === "repo/notes.txt"));
  const commit = manifest.history?.commits.find((c) => c.message === "unpushed work");
  assert.ok(commit, "the manifest lists the real commit Nodepod's git made");
  assert.equal(commit.unpushed, true, "and says no remote branch has it");
  assert.equal(manifest.history.branch, "main");
  assert.equal(plain.name, `riff-workspace-smoke1-${manifest.exportedAt.slice(0, 10)}.zip`);
  console.log(`plain export: ${Object.keys(f).length} entries, ${(plain.zip.length / 1024).toFixed(0)} KB zip`);

  // --- the defaults carry the transcript; and with dependencies asked for too
  const byDefault = await exportZip({ room: "SMOKE1" });
  assert.ok(byDefault.files["claude/projects/-work-repo/0b1c2d3e.jsonl"], "transcripts are on by default");
  assert.equal(Object.keys(byDefault.files).some((n) => n.includes("node_modules")), false, "dependencies are off by default");
  const full = await exportZip({ room: "SMOKE1", dependencies: true });
  stockTool(full.zip);
  assert.equal(dec.decode(full.files["repo/node_modules/left-pad/index.js"]), "module.exports = 1;\n");
  const transcript = dec.decode(full.files["claude/projects/-work-repo/0b1c2d3e.jsonl"]);
  assert.match(transcript, /build a todo app/);
  assert.equal(transcript.includes(GITHUB), false, "a token a tool printed into a transcript is overwritten too");
  assert.equal(Object.keys(full.files).some((n) => n.includes(".wasix-session")), false, "Riff's session folder stays out even when dependencies are asked for");
  console.log(`full export: ${Object.keys(full.files).length} entries`);

  // --- exporting reads the pod; it never writes it
  const after = await page.evaluate(async () => Array.from(await window.__controller.pod.fs.readFile("/work/repo/notes.txt")));
  assert.match(Buffer.from(after).toString(), /REAL-MODEL-TOKEN/, "the pod's own file is untouched");
  await page.evaluate(() => window.__controller.dispose());
  console.log("workspace export browser smoke: ok");
} finally {
  await browser.close();
}
