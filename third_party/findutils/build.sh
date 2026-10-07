#!/usr/bin/env bash
# Rebuild GNU findutils 4.10.0 for WASIX with the measured source adaptations
# (see README.md and findutils-4.10.0-wasix.patch).
#
# Outputs (under $WORK): find-final.wasm and xargs-final.wasm, asyncified.
# Generated files stay under tmp-work/; this probe ships only the patch,
# this script, and the README.
#
# Toolchain defaults match the layout documented in docs/maintenance.md:
#   WASI_SDK       WASI SDK 20 clang/binutils   (tmp-work/bash-build/sdk/...)
#   WASIX_SYSROOT  wasix-libc sysroot32         (tmp-work/bash-build/wasix-libc/...)
#   WASM_OPT       Binaryen 131                 (../nodepod_wasm_research/...)
#   WASMER         Wasmer CLI for packaging     (~/.wasmer/bin/wasmer)
set -euo pipefail

RESEARCH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="${WORK:-$RESEARCH_ROOT/tmp-work/find-build}"
WASI_SDK="${WASI_SDK:-$RESEARCH_ROOT/tmp-work/bash-build/sdk/wasi-sdk-20.0}"
WASIX_SYSROOT="${WASIX_SYSROOT:-$RESEARCH_ROOT/tmp-work/bash-build/wasix-libc/sysroot32}"
WASM_OPT="${WASM_OPT:-$RESEARCH_ROOT/../nodepod_wasm_research/spikes/wasix-filesystem/node_modules/.bin/wasm-opt}"
TARBALL_URL="https://ftp.gnu.org/gnu/findutils/findutils-4.10.0.tar.xz"
SRC="$WORK/findutils-4.10.0"
PATCH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/findutils-4.10.0-wasix.patch"

mkdir -p "$WORK"
cd "$WORK"

if [ ! -f findutils-4.10.0.tar.xz ]; then
  echo ">> downloading $TARBALL_URL"
  curl -fLO "$TARBALL_URL"
fi

rm -rf "$SRC"
tar -xf findutils-4.10.0.tar.xz
cd "$SRC"
echo ">> applying $(basename "$PATCH")"
patch -p1 < "$PATCH"

echo ">> building wasix-compat (fork shim)"
"$WASI_SDK/bin/clang" --target=wasm32-wasmer-wasi --sysroot="$WASIX_SYSROOT" \
  -c wasix-compat/proc.c -o wasix-compat/proc.o
"$WASI_SDK/bin/llvm-ar" rcs wasix-compat/libwasix-compat.a wasix-compat/proc.o

CC="$WASI_SDK/bin/clang --target=wasm32-wasmer-wasi --sysroot=$WASIX_SYSROOT" \
CPP="$WASI_SDK/bin/clang --target=wasm32-wasmer-wasi --sysroot=$WASIX_SYSROOT -E" \
AR="$WASI_SDK/bin/llvm-ar" \
RANLIB="$WASI_SDK/bin/llvm-ranlib" \
CFLAGS="-O2 -matomics -mbulk-memory -mmutable-globals -pthread -mthread-model posix -ftls-model=local-exec -DDT_SOCK=12 -D_WASI_EMULATED_PROCESS_CLOCKS -DRLIMIT_NOFILE=7 -I$SRC/wasix-compat" \
LDFLAGS="-L$SRC/wasix-compat -lwasix-compat -Wl,--shared-memory -Wl,--max-memory=4294967296 -Wl,--import-memory -Wl,--export-dynamic -Wl,--export=__heap_base -Wl,--export=__stack_pointer -Wl,--export=__data_end -Wl,--export=__wasm_init_tls -Wl,--export=__wasm_signal -Wl,--export=__tls_size -Wl,--export=__tls_align -Wl,--export=__tls_base -lwasi-emulated-mman -lwasi-emulated-process-clocks -Wl,-z,stack-size=8388608" \
gl_cv_func_getcwd_null=yes \
gl_cv_func_getcwd_path_max=yes \
gl_cv_func_getcwd_succeeds_beyond_4k=yes \
ac_cv_func_getgroups=yes \
ac_cv_func_fork=yes \
ac_cv_func_vfork=yes \
./configure --host=wasm32-wasmer-wasi --prefix="$SRC/install"

echo ">> make"
make -j"$(nproc)" V=1

echo ">> asyncifying"
"$WASM_OPT" -O2 --asyncify --fpcast-emu find/find -o "$WORK/find-final.wasm"
"$WASM_OPT" -O2 --asyncify --fpcast-emu xargs/xargs -o "$WORK/xargs-final.wasm"

sha256sum "$WORK/find-final.wasm" "$WORK/xargs-final.wasm"
echo ">> done: $WORK/find-final.wasm $WORK/xargs-final.wasm"
echo ">> composite packaging steps are documented in README.md"
