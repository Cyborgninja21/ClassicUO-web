#!/usr/bin/env bash
# Fetch the prebuilt FNA->WASM native libs + dotnet runtime + frozen emsdk that
# the WASM loader build consumes, into ./statics/ (gitignored).
#
# Source of record is a DURABLE GitHub Release on this fork. The upstream
# r58Playz/FNA-WASM-Build Actions artifacts expire (~90d) and aren't readable from
# CI with the default token, so we mirror them to a fork Release (the default
# token CAN read this fork's own releases — CI works out of the box). Re-mirror
# with ./mirror-statics.sh when bumping the pinned FNA-WASM-Build run id.
set -euo pipefail
cd "$(dirname "$0")"

STATICS_TAG="${STATICS_TAG:-toolchain-26933625837}"   # bump deliberately (see mirror-statics.sh)
# GC-wedge fuse overlay: the pinned upstream pack predates patches/004-mono-interp-lmf-gc-fuse,
# so we overlay a fuse-patched libmono-ee-interp.a from this release onto it. Without it the
# live client can hard-freeze (~frame 976) in longer play (the LMF-chain GC loop). Set empty to
# disable; drop entirely + bump STATICS_TAG once a clean FNA-WASM-Build build carries the patch.
STATICS_FUSE_TAG="${STATICS_FUSE_TAG:-gcfuse-interp-004}"
STATICS_REPO="${STATICS_REPO:-Cyborgninja21/ClassicUO-web}"
STATICS="statics"

if [ -d "$STATICS/emsdk" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "==> statics/ already present (FORCE=1 to refetch)"
  exit 0
fi

echo "==> downloading toolchain statics from $STATICS_REPO release $STATICS_TAG"
gh release download "$STATICS_TAG" -R "$STATICS_REPO" \
  -p 'fna-wasm-statics-*.tar.gz' -D . --clobber

echo "==> extracting (tarball preserves the ST-prefix renames + exec bits)"
tar -xzf fna-wasm-statics-*.tar.gz
rm -f fna-wasm-statics-*.tar.gz

# Overlay the GC-fuse runtime lib onto the base pack (see note above). ABI-compatible —
# patch 004 only adds a bounded loop guard inside interp_mark_no_ref_slots.
if [ -n "$STATICS_FUSE_TAG" ]; then
  echo "==> overlaying GC-fuse libmono-ee-interp.a from release $STATICS_FUSE_TAG"
  gh release download "$STATICS_FUSE_TAG" -R "$STATICS_REPO" -p 'libmono-ee-interp.a' -D . --clobber
  cp -f libmono-ee-interp.a "$STATICS/dotnet/runtimes/browser-wasm/native/libmono-ee-interp.a"
  rm -f libmono-ee-interp.a
  echo "==> fuse overlay applied"
fi

echo "==> done. statics/:"
ls -1 "$STATICS"
