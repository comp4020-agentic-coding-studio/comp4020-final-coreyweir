#!/usr/bin/env bash
# Build the WASIX bridge stub. Needs the wasix-libc sysroot + clang with wasm target.
# Toolchain lives under the research repo's tmp-work/ (NOT /tmp — tmpfs is
# small and wiped): wasix-libc v2024-07-08.1 sysroot32 + wasi-sdk-20 (use the
# SDK's own clang so it matches its resource dir).
set -euo pipefail

RESEARCH_TMP="${RIFF_RESEARCH_TMP:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../nodepod_wasix_fs_research/tmp-work" && pwd)}"
SYSROOT="${WASIX_SYSROOT:-$RESEARCH_TMP/bash-build/wasix-libc/sysroot32}"
RESOURCE_DIR="${CLANG_RESOURCE_DIR:-$RESEARCH_TMP/bash-build/sdk/wasi-sdk-20.0/lib/clang/16}"
CC="${CC:-$RESEARCH_TMP/bash-build/sdk/wasi-sdk-20.0/bin/clang}"
OUT="${1:-tools/stub/bridge.wasm}"

"$CC" --target=wasm32-wasmer-wasi -O2 -pthread -matomics -mbulk-memory -mmutable-globals \
  -ftls-model=local-exec \
  --sysroot="$SYSROOT" \
  -resource-dir="$RESOURCE_DIR" \
  -Wl,--shared-memory \
  -Wl,--max-memory=4294967296 \
  -Wl,--import-memory \
  -Wl,--export-dynamic \
  -Wl,--export=__heap_base \
  -Wl,--export=__stack_pointer \
  -Wl,--export=__data_end \
  -Wl,--export=__wasm_init_tls \
  -Wl,--export=__wasm_signal \
  -Wl,--export=__tls_size \
  -Wl,--export=__tls_align \
  -Wl,--export=__tls_base \
  -lwasi-emulated-mman \
  -Wl,-z,stack-size=8388608 \
  tools/stub/bridge.c -o "$OUT"

echo "built $OUT"
