import { Directory, Wasmer, init } from "@wasmer/sdk";
import interactiveBashUrl from "./assets/wasmer/bash-1.0.25-riff.webc?url";
import stubUrl from "./assets/wasmer/argv-stub.wasm?url";

type WasixCommand = { run: (opts: Record<string, unknown>) => Promise<WasixInstance> };
type WasixInstance = {
  wait: () => Promise<{ code: number; stdout: string; stderr: string }>;
  stdin?: WritableStream<Uint8Array> | null;
};

/** Empty stdin so `Instance.wait()` skips WritableStream.close() on a live stdin pipe. */
const CLOSED_STDIN = "";

export type StubSpawnLeg = {
  shell: string;
  exit: boolean;
  code: number;
  stdout: string;
  stderr: string;
  note: string;
};

export type StubSpawnResult = {
  log: string[];
  direct: StubSpawnLeg;
  viaBash: StubSpawnLeg;
};

function note(log: string[], message: string): void {
  const line = `${Date.now()} ${message}`;
  log.push(line);
  console.log(`[STUB] ${line}`);
}

/**
 * Can bash spawn a raw .wasm stub placed inside the mounted Directory?
 * Covers both the direct `command.run` path and the bash `-c` path, with
 * args, env, cwd, stdout, stderr, and exit code reaching the stub.
 * Must run in a worker.
 */
export async function probeStubSpawn(): Promise<StubSpawnResult> {
  const log: string[] = [];
  note(log, "init");
  await init();
  const bashBytes = new Uint8Array(await (await fetch(interactiveBashUrl)).arrayBuffer());
  const bashPkg = await Wasmer.fromFile(bashBytes);
  const bash = bashPkg.entrypoint ?? bashPkg.commands["bash"];
  if (!bash) throw new Error("bash webc has no bash command");

  const stubBytes = new Uint8Array(await (await fetch(stubUrl)).arrayBuffer());
  note(log, `stub ${stubBytes.byteLength} bytes`);

  // Direct: run the raw wasm as a command, no bash wrapper.
  const dirDirect = new Directory();
  await dirDirect.writeFile("/argv", stubBytes);
  note(log, "direct.run");
  const direct = await runDirect(log, dirDirect);

  // Via bash -c with the stub on PATH under a control dir.
  const dirBash = new Directory();
  await dirBash.createDir("/.wasix-session");
  await dirBash.createDir("/.wasix-session/bin");
  await dirBash.writeFile("/.wasix-session/bin/argv", stubBytes);
  note(log, "bash.run");
  const viaBash = await runViaBash(log, dirBash);

  return { log, direct, viaBash };
}

async function runDirect(log: string[], dir: Directory): Promise<StubSpawnLeg> {
  const startedAt = Date.now();
  const instance = await Wasmer.fromFile(new Uint8Array(await (await fetch(stubUrl)).arrayBuffer()))
    .then((pkg) => {
      const command = pkg.entrypoint ?? Object.values(pkg.commands)[0];
      if (!command) throw new Error("stub package has no command");
      return command.run({
        mount: { "/work": dir },
        cwd: "/work",
        args: ["argv", "one", "two"],
        env: { RIFF_STUB_PROBE: "via-direct" },
        stdin: CLOSED_STDIN,
      });
    });
  const output = await instance.wait();
  const ms = Date.now() - startedAt;
  note(log, `direct exited ${output.code} after ${ms}ms`);
  return {
    shell: "none",
    exit: true,
    code: output.code,
    stdout: output.stdout,
    stderr: output.stderr,
    note: `direct ${ms}ms`,
  };
}

async function runViaBash(log: string[], dir: Directory): Promise<StubSpawnLeg> {
  const startedAt = Date.now();
  const bashBytes = new Uint8Array(await (await fetch(interactiveBashUrl)).arrayBuffer());
  const bashPkg = await Wasmer.fromFile(bashBytes);
  const bash = bashPkg.entrypoint ?? bashPkg.commands["bash"];
  if (!bash) throw new Error("bash webc has no bash command");
  const instance = await bash.run({
    mount: { "/mounted": dir },
    cwd: "/mounted",
    args: ["-c", "PATH=/mounted/.wasix-session/bin:$PATH; cd /mounted && argv one two"],
    env: { RIFF_STUB_PROBE: "via-bash" },
    uses: ["wasmer/coreutils@1.0.25"],
    stdin: CLOSED_STDIN,
  });
  const output = await instance.wait();
  const ms = Date.now() - startedAt;
  note(log, `bash exited ${output.code} after ${ms}ms`);
  return {
    shell: "bash",
    exit: true,
    code: output.code,
    stdout: output.stdout,
    stderr: output.stderr,
    note: `bash ${ms}ms`,
  };
}

export function probeStubSpawnInWorker(): Promise<StubSpawnResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./wasixStubProbeWorker.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Stub spawn probe timed out after 180s"));
    }, 180_000);
    worker.onmessage = (event: MessageEvent<{ kind: string; result?: StubSpawnResult; error?: string }>) => {
      if (event.data.kind === "log") return;
      clearTimeout(timer);
      worker.terminate();
      if (event.data.kind === "done" && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "Stub worker failed"));
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage("start");
  });
}
