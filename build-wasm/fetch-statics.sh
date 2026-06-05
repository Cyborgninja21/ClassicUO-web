#!/usr/bin/env bash
# Fetch the prebuilt FNA->WASM native libs + dotnet runtime + frozen emsdk that
# the WASM loader build consumes, into ./statics/ (gitignored). Mirrors the
# celeste-wasm Makefile `statics:` target, but pulls the SINGLE-THREADED
# (pthread-false) variant — see BUILD-WASM.md for why ClassicUO-web is
# single-threaded.
#
# Source: r58Playz/FNA-WASM-Build GitHub Actions artifacts. Pin the run id so
# builds are reproducible; bump it deliberately (and re-test) like an upstream ref.
set -euo pipefail
cd "$(dirname "$0")"

FNA_WASM_REPO="r58Playz/FNA-WASM-Build"
FNA_WASM_RUN="${FNA_WASM_RUN:-26933625837}"   # 2026-06-04 build; bump deliberately
STATICS="statics"

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
echo "==> done. statics/:"
ls -1
