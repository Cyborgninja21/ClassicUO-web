#!/usr/bin/env bash
# RE-MIRROR tool: pull the upstream FNA-WASM-Build Actions artifacts, post-process
# into ./statics/, then tar + upload to a durable Release on this fork so the build
# (fetch-statics.sh) + CI can consume them after the upstream artifacts expire.
#
# Run when bumping the pinned FNA-WASM-Build run id:
#   FNA_WASM_RUN=<id> ./mirror-statics.sh            # fetch + post-process + tarball
#   FNA_WASM_RUN=<id> UPLOAD=1 ./mirror-statics.sh   # ...and create/upload the Release
# Then bump STATICS_TAG in fetch-statics.sh + the CI workflow to toolchain-<id>.
#
# Needs gh auth that can read the UPSTREAM repo's artifacts (a PAT, not the CI token).
set -euo pipefail
cd "$(dirname "$0")"

FNA_WASM_REPO="r58Playz/FNA-WASM-Build"
FNA_WASM_RUN="${FNA_WASM_RUN:-26933625837}"   # 2026-06-04 build; bump deliberately
MIRROR_REPO="${MIRROR_REPO:-Cyborgninja21/ClassicUO-web}"
STATICS="statics"

rm -rf "$STATICS"
mkdir -p "$STATICS" && cd "$STATICS"

echo "==> fetching FNA-WASM-Build artifacts (run $FNA_WASM_RUN, single-threaded)"
gh run download "$FNA_WASM_RUN" -R "$FNA_WASM_REPO" -n WASM-libs-pthread-false   -D _libs
gh run download "$FNA_WASM_RUN" -R "$FNA_WASM_REPO" -n WASM-dotnet-pthread-false -D _dotnet
gh run download "$FNA_WASM_RUN" -R "$FNA_WASM_REPO" -n WASM-emsdk               -D _emsdk

echo "==> native libs (drop ST- prefix to match loader csproj NativeFileReference)"
for f in _libs/ST-*.a; do mv -f "$f" "$(basename "${f#_libs/ST-}")"; done
mv -f _dotnet/ST-liba.o liba.o
mv -f _dotnet/ST-hot_reload_detour.o hot_reload_detour.o

echo "==> dotnet runtime pack"
python3 -c "import zipfile; zipfile.ZipFile('_dotnet/ST-dotnet.zip').extractall('dotnet')"

echo "==> frozen emsdk (large; ~1GB)"
python3 -c "import zipfile; zipfile.ZipFile('_emsdk/emsdk.zip').extractall('emsdk')"

echo "==> restore exec bits (python zipfile.extractall drops them)"
chmod -R +x emsdk/emsdk/bin emsdk/emsdk/node emsdk/emsdk/emscripten 2>/dev/null || true
chmod +x dotnet/cross/mono-aot-cross 2>/dev/null || true

rm -rf _libs _dotnet _emsdk
echo "==> statics/ assembled:"
ls -1
cd ..

# Tarball (preserves the ST-prefix renames + exec bits, unlike a zip) + mirror.
TAG="toolchain-${FNA_WASM_RUN}"
TARBALL="fna-wasm-statics-${FNA_WASM_RUN}.tar.gz"
echo "==> tarring -> $TARBALL"
tar -czf "$TARBALL" "$STATICS"
ls -lh "$TARBALL"

if [ "${UPLOAD:-0}" = "1" ]; then
  echo "==> creating/uploading Release $TAG on $MIRROR_REPO"
  if gh release view "$TAG" -R "$MIRROR_REPO" >/dev/null 2>&1; then
    gh release upload "$TAG" -R "$MIRROR_REPO" "$TARBALL" --clobber
  else
    gh release create "$TAG" -R "$MIRROR_REPO" \
      --title "FNA-WASM-Build toolchain statics (run $FNA_WASM_RUN)" \
      --notes "Durable mirror of the r58Playz/FNA-WASM-Build single-threaded statics (libs + dotnet runtime pack + frozen emsdk). CI + fetch-statics.sh pull this. Bump deliberately." \
      "$TARBALL"
  fi
  echo "==> mirrored. Now bump STATICS_TAG=$TAG in fetch-statics.sh + the CI workflow."
else
  echo "==> tarball ready ($TARBALL). Re-run with UPLOAD=1 to publish the Release."
fi
