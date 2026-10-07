# Corrected WASIX findutils (GNU findutils 4.10.0)

Reproducible build for the corrected `find`/`xargs` modules that replaced the
broken registry package `wasmer/find@4.10.0`. The registry binary completes a
successful traversal and then exits 1 with
`(null): Failed to restore initial working directory: Not a directory`; see
`../README.md` for the original 48-check measurement and
`../../../archive/completed-investigations/SHELL_PACKAGE_COMPATIBILITY.md` for
the full completion record.

## Questions answered

1. Why does `wasmer/find@4.10.0` exit 1 after a successful traversal?
2. Why did a plain cross-compile of findutils 4.10.0 still resolve relative
   operands from `/` instead of the inherited shell cwd?

## Root causes (measured)

1. **No fchdir.** WASIX has `open(directory)` and `chdir` but no native
   `fchdir`. Cross-compiled gnulib assumed `open` cannot visit directories, so
   `save-cwd` registered a descriptor that the `fchdir` replacement cannot map
   back. Forcing `cwd->desc = -1` in `gl/lib/save-cwd.c` makes save/restore use
   `getcwd`+`chdir`, which work on WASIX.
2. **FTS_CWDFD anchors at `/`.** With `save-cwd` fixed, find still failed on
   relative operands: FTS selected `FTS_CWDFD`, and WASIX libc resolves
   `openat(AT_FDCWD, ...)`/`fstatat(AT_FDCWD, ...)` from `/` rather than the
   process cwd. Building find with `FTS_NOCHDIR` under `__wasi__`, routing
   `AT_FDCWD` opens through plain `open` in `rpl_opendirat`, and using
   `stat`/`lstat` in `fts_stat` when `FTS_NOCHDIR` is active fixes traversal.
3. **Startup cwd is not applied.** Even with 1 and 2, a replaced child module
   resolves relative paths from `/` until it performs a `chdir`; WASIX
   `getcwd` reports the inherited path but Preview-1 resolution does not start
   there. `find/ftsfind.c` therefore calls `getcwd(NULL,0)` followed by
   `chdir(result)` at the start of `main` under `__wasi__`. (Nested Bash and
   external `/bin/pwd` already work because maintained bash applies its cwd;
   the standalone find binary needed its own sync.)
4. **getcwd must stay native.** Configure guessed that `getcwd(NULL,0)` is
   broken and linked gnulib `rpl_getcwd`, whose directory-crawling fallback
   reports `/` under mounts. The cache variables
   `gl_cv_func_getcwd_null=yes gl_cv_func_getcwd_path_max=yes
   gl_cv_func_getcwd_succeeds_beyond_4k=yes` keep `REPLACE_GETCWD=0` so the
   binary imports the verified native `wasix_32v1.getcwd`.

Additional mechanical adaptations (same as `wasix-org/wasinix`
`pkgs/overlays/f/findutils/wasix.nix`): mounted-fs configure fallback,
`mount_list = NULL`, `opendirat` -> `rpl_opendirat` rename, `gid_t *` getgroups
stub, socket type guards under `__wasi__` (WASIX libc aliases `S_IFSOCK` and
`S_IFIFO`), fork shim in `wasix-compat/`, and a trimmed build of find/xargs
only. Compile defines `-DDT_SOCK=12 -D_WASI_EMULATED_PROCESS_CLOCKS
-DRLIMIT_NOFILE=7` cover WASIX libc header gaps.

## Reproduce

```sh
probes/find-cwd-restore/findutils-wasix/build.sh
```

Defaults expect the WASI SDK 20 / wasix-libc sysroot layout under
`tmp-work/bash-build/` and Binaryen 131 from the neighbouring spike checkout;
override with `WASI_SDK`, `WASIX_SYSROOT`, `WASM_OPT`, and `WORK` if needed.
The script downloads the tarball, applies
`findutils-4.10.0-wasix.patch`, builds, and asyncifies
(`wasm-opt -O2 --asyncify --fpcast-emu`), producing
`tmp-work/find-build/find-final.wasm` and `xargs-final.wasm`.

## Sysroot selection (2026-09-08)

The original `v2024-07-08.1` sysroot has a defective `execve`: it calls the
no-result `__wasi_proc_exec2` and traps on `unreachable`, so `execvp` cannot
iterate `PATH` and a failed exec kills the caller instead of returning an errno.
`xargs cat` therefore failed while `xargs /bin/cat` worked
([evidence](../../../docs/known-issues.md#guest-programs-cannot-spawn-a-child-by-bare-name)).

Build against the newer wasinix `wasix-sysroot-off` instead, whose `execve`
routes through `__execvpe` -> `__wasi_proc_exec4` and returns an errno:

```sh
S=/nix/store/<hash>-wasix-sysroot-off
D=tmp-work/wasix-sysroot-off-indexed
cp -r "$S/." "$D"; chmod -R u+w "$D"
for a in "$D"/lib/wasm32-wasi/*.a; do llvm-ranlib "$a"; done
WORK=tmp-work/find-build-newlibc WASIX_SYSROOT=$PWD/$D build.sh
```

The `ranlib` pass is required: nix-store archives ship without an archive index
and WASI SDK 20's `wasm-ld` rejects them with `archive has no index`. Use the
`-off` variant; `-eh`/`-exnref` carry exception-handling features the fork
engine rejects. WASI SDK 20's clang 16 compiles against this sysroot without
further changes; only the two pre-existing `-Wformat` warnings in `xargs.c`
appear.

Measured: the rebuilt `xargs` imports `proc_exec4` and reports
`SPAWN_RAN code=127` with `echo: No such file or directory` under
`../../atom-spawn-check/`, where the old atom exited 1 with both streams empty.
`find` is byte-different but behaviourally identical (`code=0`, same listing).

## Packaging into the app shell

The corrected `find`/`xargs` ship inside the vendored app Bash WEBc (identity
`riff/bash-findutils`, version `1.0.25-riff.1`) because the SDK resolves
`uses` entries only as registry strings; local package objects would need an
API expansion. Composite steps:

1. `wasmer package unpack <previous bash-1.0.25-riff.webc> unpacked`
2. In `unpacked/wasmer.toml`: set `name = "riff/bash-findutils"`, add
   `[[module]] name = "find"` / `"xargs"` with `source = "./modules/<name>"`,
   matching `[[command]]` blocks with
   `runner = "https://webc.org/runner/wasi"` and
   `[command.annotations.wasi] atom = <name>`.
3. Copy `find-final.wasm` / `xargs-final.wasm` to `unpacked/modules/`.
4. `wasmer package build unpacked --out <out>.webc`.

Validate imports with `python3 check-package-imports.py <out>.webc` from the
research root; the final composite loads 3 atoms with 27 Preview-1 and 26
WASIX imports against the pinned runtime.

## Measured outcome

The final composite
(sha256 `6da035b3969488095d8b7d42dc887cce0628ae06d44b84ad56b13540bd53964d`)
passes the app acceptance in
`../../../site_poc/riff_oauth/scripts/wasix-claude-bash-browser-smoke.mjs`:
relative and absolute `find` traversal with `-exec`, `xargs`, redirected brace
groups, function redirection, and explicit `exec` redirection all return 0
with the exact expected output. `find` reports its inherited cwd as
`/work/repo` (probe cases 31–33 in `../diag.mjs`), relative operands resolve
from the shell cwd, and stderr is empty.
