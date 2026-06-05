#!/usr/bin/env bash
# Hermetic, no-sudo .NET 10 SDK + wasm-tools workload into ./.toolchain/dotnet
# (gitignored). The matched FNA-WASM-Build runtime/emsdk are fetched separately
# by fetch-statics.sh. See BUILD-WASM.md.
set -euo pipefail
cd "$(dirname "$0")"

DEST="$PWD/.toolchain/dotnet"
mkdir -p .toolchain
if [ ! -x "$DEST/dotnet" ]; then
  curl -sSL https://dot.net/v1/dotnet-install.sh -o .toolchain/dotnet-install.sh
  chmod +x .toolchain/dotnet-install.sh
  ./.toolchain/dotnet-install.sh --channel 10.0 --install-dir "$DEST" --no-path
fi

export DOTNET_ROOT="$DEST"; export PATH="$DEST:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
"$DEST/dotnet" --version
"$DEST/dotnet" workload install wasm-tools
echo "==> .NET 10 SDK + wasm-tools ready at $DEST"
