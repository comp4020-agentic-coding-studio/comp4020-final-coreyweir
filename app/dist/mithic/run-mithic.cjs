// run-mithic.cjs — GUEST entrypoint for Nodepod: run bash scripts through the
// mithic shell Executor, with KernelClient + FsClient adapters wired to
// Nodepod's own child_process / fs (the VFS).
//
// Usage: node /opt/mithic/run.cjs <script>
//   - script is run via the mithic shell (bash language).
//   - commands that exist in the @mithic/coreutils registry run as pure-TS
//     CommandFns (proper stdin handling for grep/sed/awk/wc/head/tail/sort/...)
//     via a small `fs/*` syscall dispatcher over Nodepod's fs (VFS).
//   - everything else resolves through Nodepod's child_process (so
//     node/npm/git + interpreter builtins + wasm tools all work).
'use strict';

const mithic = require('/opt/mithic/mithic-shell.cjs');
const { Executor, parseCliArgs } = mithic;

// mithic bug workaround: flat pipelines (`cmd1 | cmd2 > file`) drop the
// per-stage stdout redirect on non-first stages (execMultiStagePipeline ignores
// redirects). Route those to execNodePipeline, which applies stage redirects.
const _origExecPipeline = Executor.prototype.execPipeline;
const _origExecNodePipeline = Executor.prototype.execNodePipeline;
Executor.prototype.execPipeline = async function (e, t) {
  if (e && e.stages && e.stages.length > 1) {
    const hasStageRedirect = e.stages.slice(1).some(
      (s) => s.redirects && s.redirects.length > 0,
    );
    if (hasStageRedirect) {
      const stageNodes = e.stages.map((s) => ({
        type: 'Pipeline',
        stages: [{
          type: 'SimpleCommand',
          name: s.name,
          args: s.args,
          redirects: s.redirects || [],
          assignments: s.assignments || [],
        }],
      }));
      return await _origExecNodePipeline.call(this, stageNodes, e.pipeStderr ?? [], t);
    }
  }
  return await _origExecPipeline.call(this, e, t);
};

const cp = require('child_process');
const fs = require('fs');

// ---------- @mithic/coreutils registry ----------
const { REGISTRY } = require('/opt/mithic/mithic-coreutils.cjs');

const AT_FDCWD = -100;

// Commands known to resolve without our REGISTRY (Nodepod interpreter builtins
// + node/npm/git/sh). Used by process/pipeline ENOENT detection: Nodepod's
// execFileSync throws {status:127, code:undefined, stderr:''} for BOTH a
// missing command and a command that genuinely exits 127, so we disambiguate
// by name. Unlisted names that exit 127 are treated as command-not-found.
const KNOWN_EXECUTABLES = new Set([
  'node', 'npm', 'npx', 'git', 'bun', 'sh', 'bash', 'zsh', 'ash', 'dash',
  'echo', 'ls', 'pwd', 'cd', 'which', 'env', 'true', 'false', 'printf',
  'cat', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'chmod', 'chown',
  'ln', 'readlink', 'realpath', 'set', 'export', 'source', 'alias', 'unalias',
  'exit', 'unset', 'shift', 'type', 'command', 'builtin', 'uname', 'date',
  'sleep', 'test', '[', 'basename', 'dirname', 'id', 'whoami', 'hostname',
  'df', 'du', 'ps', 'kill', 'wait', 'history', 'jobs', 'fg', 'bg',
]);
const HOST_EXTERNAL_COMMANDS = new Set(
  String(process.env.NODEPOD_EXTERNAL_COMMANDS || '').split(':').filter(Boolean),
);
function isResolvable(name) {
  return (REGISTRY[name] != null) || KNOWN_EXECUTABLES.has(name) || HOST_EXTERNAL_COMMANDS.has(name);
}

// fs/* syscall dispatcher over Nodepod's fs (the VFS). The commands pass
// absolute paths (or dirfd AT_FDCWD + relative path) and expect POSIX errno
// codes on failure (errnoText handles ENOENT/…/EISDIR/…).
//
// `parentStdin` = the current command's own stdin bytes, used to give a child
// spawned via process/pipeline the same stdin the parent received (GNU env
// forwards its stdin; xargs already consumed it so the stream is exhausted).
function makeSyscall(cwd, env, parentStdin) {
  const resolve = (p) => {
    if (!p) return p;
    if (p.startsWith('/')) return p;
    const base = cwd && cwd.startsWith('/') ? cwd : '/';
    return base.replace(/\/+$/, '') + '/' + p;
  };
  const ensureErrno = (e, code) => {
    if (e && typeof e === 'object' && !e.code) e.code = code;
    return e;
  };
  return async function syscall(call, args) {
    switch (call) {
      case 'fs/open': {
        const oflags = args.oflags || {};
        const p = resolve(args.path);
        let fd;
        try {
          if (oflags.truncate) {
            fd = fs.openSync(p, 'w');
          } else if (oflags.append) {
            fd = fs.openSync(p, 'a');
          } else if (oflags.write || oflags.create) {
            // O_CREAT without O_TRUNC (touch must not wipe existing files).
            // 'r+' fails with ENOENT if missing → fall back to 'w' (new file).
            try {
              fd = fs.openSync(p, 'r+');
            } catch (e) {
              if (e.code === 'ENOENT') fd = fs.openSync(p, 'w');
              else throw e;
            }
          } else {
            fd = fs.openSync(p, 'r');
          }
        } catch (e) {
          throw ensureErrno(e, 'ENOENT');
        }
        return { fd };
      }
      case 'fs/read': {
        const buf = Buffer.alloc(args.len);
        try {
          const n = fs.readSync(args.fd, buf, 0, args.len, null);
          return new Uint8Array(buf.subarray(0, n));
        } catch (e) {
          throw e;
        }
      }
      case 'fs/write': {
        const data = args.data;
        const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data));
        const n = fs.writeSync(args.fd, buf);
        return { written: n };
      }
      case 'fs/close': {
        try { fs.closeSync(args.fd); } catch {}
        return undefined;
      }
      case 'fs/stat': {
        const p = resolve(args.path);
        let st;
        try {
          st = args.followSymlinks === false ? fs.lstatSync(p) : fs.statSync(p);
        } catch (e) { throw ensureErrno(e, 'ENOENT'); }
        return {
          type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
          size: st.size,
          mode: st.mode,
        };
      }
      case 'fs/readdir': {
        const p = resolve(args.path);
        let names;
        try { names = fs.readdirSync(p); } catch (e) { throw ensureErrno(e, 'ENOENT'); }
        return names.map((name) => ({ name }));
      }
      case 'fs/mkdir': {
        const p = resolve(args.path);
        try { fs.mkdirSync(p, { recursive: args.recursive === true }); } catch (e) { throw ensureErrno(e, 'EEXIST'); }
        return undefined;
      }
      case 'fs/rmdir': {
        const p = resolve(args.path);
        try { fs.rmdirSync(p); } catch (e) { throw ensureErrno(e, 'ENOENT'); }
        return undefined;
      }
      case 'fs/unlink': {
        const p = resolve(args.path);
        try { fs.unlinkSync(p); } catch (e) { throw ensureErrno(e, 'ENOENT'); }
        return undefined;
      }
      case 'fs/rename': {
        const from = resolve(args.path);
        const to = resolve(args.newPath);
        try { fs.renameSync(from, to); } catch (e) { throw ensureErrno(e, 'ENOENT'); }
        return undefined;
      }
      case 'fs/chmod': {
        const p = resolve(args.path);
        try { fs.chmodSync(p, args.mode); } catch (e) { throw ensureErrno(e, 'ENOENT'); }
        return undefined;
      }
      case 'fs/symlink': {
        try { fs.symlinkSync(args.target, resolve(args.path)); } catch (e) { throw ensureErrno(e, 'EEXIST'); }
        return undefined;
      }
      case 'fs/link': {
        try { fs.linkSync(resolve(args.target), resolve(args.path)); } catch (e) { throw ensureErrno(e, 'EEXIST'); }
        return undefined;
      }
      case 'fs/readlink': {
        const p = resolve(args.path);
        try { return { target: fs.readlinkSync(p) }; } catch (e) { throw ensureErrno(e, 'ENOENT'); }
      }
      case 'fs/realpath': {
        const p = resolve(args.path);
        try { return { path: fs.realpathSync(p) }; } catch (e) { throw ensureErrno(e, 'ENOENT'); }
      }
      case 'fs/utimes': {
        const p = resolve(args.path);
        try { fs.utimesSync(p, args.atime ?? Date.now(), args.mtime ?? Date.now()); } catch {}
        return undefined;
      }
      case 'fs/getxattr':
        return undefined;
      case 'fs/setxattr':
        return undefined;
      case 'process/pipeline': {
        // Run each stage as a child of this process (env/xargs/find use single
        // stage). Nodepod can't distinguish command-not-found from exit 127, so
        // treat unlisted names that return 127 as ENOENT for GNU diagnostics.
        const stages = args.stages || [];
        let carry;
        const exitCodes = [];
        let lastStdout = new Uint8Array(0);
        for (let i = 0; i < stages.length; i++) {
          const st = stages[i];
          const name = st.path || (st.argv && st.argv[0]) || '';
          const childArgs = st.argv ? st.argv.slice(1) : [];
          const h = await dispatch(name, childArgs, {
            // Explicit stage env (env -i → {}) must fully replace, not merge.
            env: st.env !== undefined ? st.env : env,
            cwd,
            // Stage 0 inherits the parent command's stdin (GNU env semantics).
            stdinBytes: i === 0 ? (parentStdin && parentStdin.length ? parentStdin : undefined) : carry,
            liveStdin: false,
          });
          if (h.code === 127 && !isResolvable(name)) {
            const e = new Error('ENOENT');
            e.code = 'ENOENT';
            throw e;
          }
          exitCodes.push(h.code);
          if (i === stages.length - 1) lastStdout = h.stdout;
          else carry = h.stdout;
        }
        return { exitCodes, stdout: lastStdout };
      }
      case 'process/getpid':
        return { pid: typeof process.pid === 'number' ? process.pid : 1 };
      default:
        throw new Error(`syscall not implemented: ${call}`);
    }
  };
}

function makeIo(name, args, { env, cwd, stdinBytes }) {
  const outChunks = [];
  const errChunks = [];
  const input = stdinBytes ? Buffer.from(stdinBytes) : Buffer.alloc(0);
  let i = 0;
  const stdin = new ReadableStream({
    pull(ctrl) {
      if (i >= input.length) { ctrl.close(); return; }
      const end = Math.min(i + 65536, input.length);
      ctrl.enqueue(new Uint8Array(input.subarray(i, end)));
      i = end;
    },
  });
  return {
    io: {
      args: [name, ...args],
      env: env || {},
      cwd: (cwd && cwd.startsWith('/')) ? cwd : '/work/repo',
      stdin,
      stdout: new WritableStream({
        write(chunk) { outChunks.push(Buffer.from(chunk)); },
        close() {}, abort() {},
      }),
      stderr: new WritableStream({
        write(chunk) { errChunks.push(Buffer.from(chunk)); },
        close() {}, abort() {},
      }),
      syscall: makeSyscall((cwd && cwd.startsWith('/')) ? cwd : '/work/repo', env || {}, stdinBytes),
      isatty: () => false,
    },
    getStdout: () => Buffer.concat(outChunks),
    getStderr: () => Buffer.concat(errChunks),
  };
}

async function runCoreutils(name, args, opts) {
  const fn = REGISTRY[name];
  if (!fn) return null;
  const h = makeIo(name, args, opts);
  const code = await fn(h.io);
  return { pid: ++nextPid, stdout: h.getStdout(), stderr: h.getStderr(), code };
}

// ---------- FsClient over Nodepod's fs (VFS) ----------
function resolveShellPath(path) {
  if (path.startsWith('/')) return path;
  return `${process.cwd().replace(/\/+$/, '')}/${path}`;
}

const FsClient = {
  fsOpen(path, flags) {
    try {
      return fs.openSync(resolveShellPath(path), flags.write ? 'w' : flags.append ? 'a' : flags.read ? 'r' : 'r+');
    } catch (e) {
      throw e;
    }
  },
  fsWrite(fd, data) {
    fs.writeSync(fd, data);
  },
  fsRead(fd) {
    const buf = Buffer.alloc(1 << 20);
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  },
  fsClose(fd) {
    try { fs.closeSync(fd); } catch {}
  },
  fsReaddir(path) {
    return fs.readdirSync(resolveShellPath(path));
  },
  fsStat(path) {
    try {
      const s = fs.statSync(resolveShellPath(path));
      return { dir: s.isDirectory(), type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs };
    } catch { return undefined; }
  },
};

// ---------- KernelClient over Nodepod child_process ----------
let nextPid = 1000;
// mithic passes numeric pids back to wait/kill, so retain each live Nodepod
// handle and its completion promise until the shell has observed completion.
const pidRegistry = new Map();

function drainReadable(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const reader = stream.getReader();
    const pump = () => {
      reader.read().then(({ done, value }) => {
        if (done) return resolve(Buffer.concat(chunks));
        if (value && value.byteLength > 0) chunks.push(Buffer.from(value));
        pump();
      }, reject);
    };
    pump();
  });
}

function bytesToStream(buf) {
  const data = Buffer.from(buf || []);
  return new ReadableStream({
    start(controller) {
      if (data.length > 0) controller.enqueue(new Uint8Array(data));
      controller.close();
    },
  });
}

async function stdinBytes(params) {
  if (params.stdinStream) return drainReadable(params.stdinStream);
  const fd = params.fds?.[0];
  if (fd?.action === 'bytes') return Buffer.from(fd.data);
  if (fd?.action === 'open') return fs.readFileSync(fd.path);
  return undefined;
}

function childReadable(stream) {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(new Uint8Array(Buffer.from(chunk))));
      stream.on('end', () => controller.close());
      stream.on('error', (error) => controller.error(error));
    },
  });
}

async function spawnExternal(name, args, params) {
  const child = cp.spawn(name, args, {
    cwd: params.cwd || '/work/repo',
    env: params.env !== undefined ? params.env : { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: params.background === true,
    // Nodepod children are interactive by default. Mithic pipeline stages
    // always provide their complete input through stdinStream/stdinBytes, so
    // they must be batch mode: close stdin once the input is written so the
    // external provider receives EOF and the pipeline can complete. A direct
    // interactive command (no complete input) stays open for a later reply.
    liveStdin: params.liveStdin !== false,
  });
  const stderr = drainReadable(childReadable(child.stderr));
  const completion = new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: typeof code === 'number' ? code : 1 });
    };
    child.on('error', () => finish(127));
    child.on('exit', finish);
  });
  const spawned = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  const pid = spawned && typeof child.pid === 'number' ? child.pid : ++nextPid;
  pidRegistry.set(pid, { child, completion });

  if (params.stdinStream) {
    void (async () => {
      const reader = params.stdinStream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) child.stdin.write(Buffer.from(value));
        }
      } catch {
        // The child may close stdin before the producer reaches EOF.
      } finally {
        child.stdin.end?.();
      }
    })();
  } else if (params.stdinBytes?.byteLength) {
    child.stdin.write(Buffer.from(params.stdinBytes));
    child.stdin.end();
  } else if (params.liveStdin !== false) {
    // Interactive direct command with no pre-supplied input: keep stdin open
    // for a later reply rather than sending EOF immediately.
  } else {
    child.stdin.end();
  }

  if (params.background === true) {
    child.unref();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
  }
  return { pid, child, stderr, completion };
}

async function dispatch(name, args, { env, cwd, stdinBytes, liveStdin }) {
  // coreutils first (proper stdin handling), then Nodepod child_process.
  const cu = await runCoreutils(name, args, { env, cwd, stdinBytes });
  if (cu) {
    pidRegistry.set(cu.pid, { code: cu.code });
    return cu;
  }
  const spawned = await spawnExternal(name, args, { env, cwd, stdinBytes, liveStdin });
  const [stdout, stderr, completion] = await Promise.all([
    drainReadable(childReadable(spawned.child.stdout)),
    spawned.stderr,
    spawned.completion,
  ]);
  return { pid: spawned.pid, stdout, stderr, code: completion.code };
}

const KernelClient = {
  async spawn(params) {
    const name = params.args[0];
    const input = await stdinBytes(params);
    const cu = await runCoreutils(name, params.args.slice(1), { ...params, stdinBytes: input });
    if (cu) {
      pidRegistry.set(cu.pid, { completion: Promise.resolve({ pid: cu.pid, code: cu.code }) });
      return { pid: cu.pid, stdout: Promise.resolve(cu.stdout), stderr: Promise.resolve(cu.stderr) };
    }
    const h = await spawnExternal(name, params.args.slice(1), { ...params, stdinBytes: input });
    return { pid: h.pid, stdout: drainReadable(childReadable(h.child.stdout)), stderr: h.stderr };
  },
  async spawnStream(params) {
    const name = params.args[0];
    const input = REGISTRY[name] ? await stdinBytes(params) : undefined;
    const cu = await runCoreutils(name, params.args.slice(1), { ...params, stdinBytes: input });
    if (cu) {
      pidRegistry.set(cu.pid, { completion: Promise.resolve({ pid: cu.pid, code: cu.code }) });
      return { pid: cu.pid, stdout: bytesToStream(cu.stdout), stderr: Promise.resolve(cu.stderr) };
    }
    const h = await spawnExternal(name, params.args.slice(1), params);
    return { pid: h.pid, stdout: childReadable(h.child.stdout), stderr: h.stderr };
  },
  async runPipeline(stages) {
    let carry = '';
    const pids = [];
    const stderr = [];
    for (let i = 0; i < stages.length; i++) {
      const st = stages[i];
      const name = st.args[0];
      let stdinBytes = i === 0 ? undefined : Buffer.from(carry);
      const f0 = st.fds && st.fds[0];
      if (f0) {
        if (f0.action === 'bytes') stdinBytes = Buffer.from(f0.data);
        else if (f0.action === 'open') stdinBytes = fs.readFileSync(f0.path);
      }
      const h = await dispatch(name, st.args.slice(1), { ...st, stdinBytes, liveStdin: false });
      pids.push(h.pid);
      const out = h.stdout.toString('utf8');
      const err = h.stderr.toString('utf8');
      if (err) stderr.push(Promise.resolve(h.stderr));
      if (i === stages.length - 1) {
        return { pids, exitCodes: [h.code], lastStdout: Promise.resolve(h.stdout), stderr };
      }
      carry = out;
    }
  },
  async wait(pidOrHandle) {
    const pid = typeof pidOrHandle === 'number' ? pidOrHandle : pidOrHandle?.pid;
    const entry = pid !== undefined ? pidRegistry.get(pid) : undefined;
    if (entry) {
      const outcome = await entry.completion;
      pidRegistry.delete(pid);
      return { pid, code: outcome?.code ?? entry.code ?? 0 };
    }
    return { pid, code: typeof pidOrHandle === 'object' ? pidOrHandle?._code ?? 0 : 0 };
  },
  kill(pid, signal) {
    return pidRegistry.get(pid)?.child?.kill(signal) ?? false;
  },
};

// ---------- run ----------
const script = process.argv[2] || 'echo "no script given"';
const cli = parseCliArgs(['bash', '-c', script]);

let out = '';
let err = '';
const executor = new Executor(
  KernelClient,
  { cwd: process.cwd(), env: { ...process.env, SHELL: 'bash' }, name: 'bash' },
  {
    resolve: (name) => (name ? name : undefined), // pass through; Nodepod owns resolution
    fs: FsClient,
    onStdout: (s) => { out += s; process.stdout.write(s); },
    onStderr: (s) => { err += s; process.stderr.write(s); },
  },
);

for (const o of cli.options) executor.setOption(o, true);

const executionKeepAlive = setInterval(() => {}, 1000);
executor.exec(script).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error('mithic shell error:', e?.message ?? e);
    process.exitCode = 2;
  },
).finally(() => clearInterval(executionKeepAlive));
