#!/usr/bin/env bash
# Apply the WASM build patches to the (nested) submodules. These are source
# changes to external/FNA + its SDL3-CS submodule that can't be committed from
# this fork (they're upstream submodules), so they live as patches and are
# applied before the build. Idempotent: skips a patch that's already applied.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

apply() {
  local sub="$ROOT/$1" patch="$ROOT/build-wasm/patches/$2"
  if ( cd "$sub" && git apply --reverse --check "$patch" ) 2>/dev/null; then
    echo "already applied: $2"
  elif ( cd "$sub" && git apply --check "$patch" ) 2>/dev/null; then
    ( cd "$sub" && git apply "$patch" ); echo "applied: $2"
  else
    echo "ERROR: $2 does not apply cleanly in $1 (stale patch? re-author against the pinned ref)"; exit 1
  fi
}

apply external/FNA/lib/SDL3-CS 001-sdl3cs-wasm-pinvoke-shims.patch
apply external/FNA            002-fna-sdl3platform-wasm.patch
apply external/FNA            003-fna-wasm-aot-callbacks.patch
echo "==> patches applied."
