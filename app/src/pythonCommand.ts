import { PYTHON_PACKAGE } from "./wasmerCommandProvider";
import type { BridgeHostHandler, BridgeRequest } from "./wasixBridge";
import { WASIX_SESSION_CONTROL_DIR, WASIX_SESSION_CONTROL_ROOT } from "./wasixSession";

/*
 * `python` and `python3` in the host's WASIX bash.
 *
 * The session runs CPython 3.12 for WASIX (PYTHON_PACKAGE) as a process of
 * its own, so it shares the terminal, the cwd, /work and pipes with bash, and
 * Ctrl-C reaches it like any other program. The package is ~115 MB, so it is
 * not part of the session boot: `python` is a launcher script that, the first
 * time it runs in a session, asks the page (over the bridge) to put the
 * package into the control directory, then execs it. The page keeps the
 * package in Cache Storage, under the same key Nodepod's own `python` uses,
 * so a browser downloads it once.
 */

const CONTROL = `${WASIX_SESSION_CONTROL_ROOT}/${WASIX_SESSION_CONTROL_DIR}`;

/** Bridge command the launcher runs to have the page install the package. */
export const PYTHON_FETCH_COMMAND = "riff-python-fetch";

/** Paths under the control directory (installSessionFile). */
const PACKAGE_PATH = "pkg/python.webc";
// Written after the package, so a launcher never execs a half-written one.
const READY_PATH = "pkg/python.ready";
const SITE_DIR = "python";

// Runs at every interpreter start in the session (PYTHONPATH, below).
//
// WASIX libc keeps its own cwd, which starts at "/" whatever the process was
// started in; getcwd() reports the real one. Without the chdir,
// `open("out.txt")` lands in / while os.getcwd() says /work/repo.
//
// The package reports sys.executable as /bin/python, which doesn't exist in
// the session, so anything that runs "this Python" again (subprocess with
// sys.executable, multiprocessing, venv) failed with ENOEXEC.
//
// subprocess finds a bare program name by exec'ing each PATH entry in the
// child until one works, but in WASIX an exec of a missing file ends the child
// with status 45 instead of failing, so `subprocess.run(["ls"])` exited 45
// whenever ls wasn't in the first PATH directory. Resolve the name in the
// parent instead, and raise FileNotFoundError for a missing program as
// CPython does elsewhere. Popen._execute_child's signature is CPython 3.12's.
//
// A Python server can't be reached: WASIX keeps a guest's listening socket
// inside the runtime, and nothing connects to it there (measured 2026-11-08:
// `python3 -m http.server` printed "Serving HTTP", then curl, the preview
// and Python's own client all failed to connect). So listen() fails, saying
// why and what works instead, rather than a server that looks up but is
// never reachable.
//
// The hint names a server written with node:http, not `npx serve`: on live
// (2026-11-09) the host's tab crashed twice within a minute of Claude
// running `npx serve -l 3000`, while a node:http server.js in the same room
// came up and showed in the participant's preview.
export const PYTHON_LISTEN_REFUSED =
  "Riff: a server started from Python can't be reached here, not by curl and not by the room's preview. " +
  "Serve with Node instead: a small `node server.js` using node:http.";

const SITECUSTOMIZE = `import os, sys
os.chdir(os.getcwd())
sys.executable = sys._base_executable = "${CONTROL}/${PACKAGE_PATH}"

def _riff_resolve_programs():
    import errno, shutil, subprocess
    execute_child = subprocess.Popen._execute_child

    def missing(program):
        return FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), program)

    def resolve(self, args, executable, preexec_fn, close_fds, pass_fds, cwd, env, startupinfo, creationflags, shell, *rest):
        if not shell:
            if not isinstance(args, (str, bytes, os.PathLike)):
                args = list(args)
            program = executable if executable is not None else (args if isinstance(args, (str, bytes, os.PathLike)) else args[0])
            program = os.fsdecode(program)
            if "/" not in program:
                found = shutil.which(program, path=os.pathsep.join(os.get_exec_path(env)))
                if found is None:
                    raise missing(program)
                executable = found
            elif not os.path.exists(os.path.join(os.fsdecode(cwd) if cwd is not None else os.getcwd(), program)):
                raise missing(program)
        return execute_child(self, args, executable, preexec_fn, close_fds, pass_fds, cwd, env, startupinfo, creationflags, shell, *rest)

    subprocess.Popen._execute_child = resolve

_riff_resolve_programs()
del _riff_resolve_programs

def _riff_refuse_listen():
    import errno, socket
    def listen(self, *args):
        raise OSError(errno.EOPNOTSUPP, ${JSON.stringify(PYTHON_LISTEN_REFUSED)})
    socket.socket.listen = listen

_riff_refuse_listen()
del _riff_refuse_listen
`;

const LAUNCHER = `#!/bin/bash
# Riff: CPython 3.12 for WASIX (wasmer/python). See app/src/pythonCommand.ts.
riff=${CONTROL}
if [ ! -e "$riff/${READY_PATH}" ]; then
  "$riff/bin/${PYTHON_FETCH_COMMAND}" || exit $?
fi
export PYTHONPATH="$riff/${SITE_DIR}\${PYTHONPATH:+:$PYTHONPATH}"
export SSL_CERT_FILE="\${SSL_CERT_FILE:-$riff/ca.pem}"
# pip carries its own CA list, which doesn't know the tab's gateway CA.
export PIP_CERT="\${PIP_CERT:-$riff/ca.pem}"
exec "$riff/${PACKAGE_PATH}" "$@"
`;

/** Launcher scripts for installBinaries. */
export function pythonLaunchers(): Map<string, Uint8Array> {
  const bytes = new TextEncoder().encode(LAUNCHER);
  return new Map([["python", bytes], ["python3", bytes]]);
}

/** Session files the launcher relies on (installSessionFile). */
export function pythonSessionFiles(): Map<string, Uint8Array> {
  return new Map([[`${SITE_DIR}/sitecustomize.py`, new TextEncoder().encode(SITECUSTOMIZE)]]);
}

export function isPythonFetch(request: BridgeRequest) {
  const name = request.argv[0] ?? "";
  return name.slice(name.lastIndexOf("/") + 1) === PYTHON_FETCH_COMMAND;
}

// Shared with wasmerCommandWorker.ts, so both find each other's download.
const PACKAGE_CACHE_NAME = "riff-wasmer-packages-v1";

async function digestHex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The package bytes, from Cache Storage when they are there and still match
 * their digest, otherwise from the CDN. `onDownload` runs only before a
 * network fetch, so a cached start prints nothing.
 */
export async function fetchPythonPackage(onDownload: () => Promise<void> | void): Promise<Uint8Array> {
  const cache = typeof caches === "undefined" ? null : await caches.open(PACKAGE_CACHE_NAME).catch(() => null);
  const cached = await cache?.match(PYTHON_PACKAGE.url).catch(() => undefined);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (await digestHex(bytes) === PYTHON_PACKAGE.sha256) return bytes;
    await cache?.delete(PYTHON_PACKAGE.url).catch(() => undefined);
  }
  await onDownload();
  const response = await fetch(PYTHON_PACKAGE.url);
  if (!response.ok) throw new Error(`the download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await digestHex(bytes) !== PYTHON_PACKAGE.sha256) throw new Error("the download did not match its digest");
  await cache?.put(PYTHON_PACKAGE.url, new Response(bytes.slice())).catch(() => undefined);
  return bytes;
}

type SessionFiles = { installSessionFile(path: string, data: Uint8Array): Promise<void> };

/**
 * Bridge handler for PYTHON_FETCH_COMMAND, for one session. Concurrent first
 * runs share one install; a failed one is retried by the next run.
 */
export function createPythonFetchHandler(
  session: SessionFiles,
  fetchPackage: typeof fetchPythonPackage = fetchPythonPackage,
): BridgeHostHandler {
  const encoder = new TextEncoder();
  let install: Promise<void> | null = null;
  return async (_request, output) => {
    install ??= (async () => {
      const bytes = await fetchPackage(() =>
        output.writeStderr(encoder.encode("riff: downloading Python 3.12 (115 MB, once per browser)...\n")));
      await session.installSessionFile(PACKAGE_PATH, bytes);
      await session.installSessionFile(READY_PATH, new Uint8Array());
    })().catch((error) => {
      install = null;
      throw error;
    });
    try {
      await install;
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await output.writeStderr(encoder.encode(`riff: python is not available: ${message}\n`));
      return 1;
    }
  };
}
