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

echo "==> done. statics/:"
ls -1 "$STATICS"
