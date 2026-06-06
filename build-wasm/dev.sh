#!/usr/bin/env bash
#
# ClassicUO-web dev/debug harness. One reliable loop instead of ad-hoc thrash.
# See DEBUGGING.md for the why behind each piece.
#
#   ./dev.sh clean                 kill every stray dotnet/chrome/server/bridge
#   ./dev.sh build [debug]         robust build (auto-kills the post-publish hang); debug = wasm symbols+map
#   ./dev.sh boot [secs]           serve + headless-boot + capture filtered console + screenshot, then tear down
#   ./dev.sh e2e [secs]            boot WITH the WS bridge + ./.run/uo-config.json (autologin etc.)
#   ./dev.sh shot [out.png]        CDP screenshot of a currently-running boot
#   ./dev.sh logs                  print the last captured console (filtered)
#   ./dev.sh sym '<idx ...>'       map wasm-function indices -> names (needs a debug build)
#
# Env overrides: HTTP_PORT, CHROME, BOOT_SECS, KEEP=1 (don't tear down after boot).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DOTNET_ROOT="$HERE/.toolchain/dotnet"
DOTNET="$DOTNET_ROOT/dotnet"
PUB="$HERE/loader/bin/Release/net10.0/publish/wwwroot"
CHROME="${CHROME:-$HOME/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome}"
RUN="$HERE/.run"                       # gitignored scratch: pidfiles + logs
HTTP_PORT="${HTTP_PORT:-8138}"
BRIDGE_PORT=8770
DBG_PORT=9229
BOOT_SECS="${BOOT_SECS:-90}"
# Chrome/headless noise we never care about.
NOISE='dbus|Fontconfig|GpuMemory|swiftshader|GroupMarker|UPower|sandbox_linux|idle_linux|sqlite_persistent|DEPRECATED_ENDPOINT|vkCreate|maxDynamic(Uniform|Storage)|gpu_blocklist|on_device_model|GetVSyncParameters|Failed to connect to the bus|registration_request|VulkanError'

mkdir -p "$RUN"
log(){ printf '\033[36m[dev]\033[0m %s\n' "$*" >&2; }
err(){ printf '\033[31m[dev]\033[0m %s\n' "$*" >&2; }

# Strip chrome's "[pid:pid:date:INFO:CONSOLE:line] " prefix + the source suffix, drop noise.
filter_console(){
  grep -aiE 'INFO:CONSOLE|ERROR:CONSOLE|out of bounds|Uncaught|abort\(' 2>/dev/null \
    | grep -avE "$NOISE" \
    | sed -E 's/^\[[0-9:./ ]*(INFO|ERROR|WARNING):CONSOLE[0-9:]*\] //; s/", source:.*$/"/'
}

pids_kill(){ for f in "$RUN"/*.pid; do [ -f "$f" ] && kill "$(cat "$f" 2>/dev/null)" 2>/dev/null; rm -f "$f"; done; }

clean(){
  pkill -9 -f 'dotnet publish loader'   2>/dev/null
  pkill    -f "remote-debugging-port=$DBG_PORT" 2>/dev/null
  pkill    -f "http.server $HTTP_PORT"   2>/dev/null
  pkill    -f 'dev-ws-bridge'            2>/dev/null
  pids_kill
  log "cleaned all dotnet/chrome/server/bridge processes"
}

build(){
  local cfg="${1:-release}" extra="" t0=$SECONDS logf="$RUN/build.log"
  if [ "$cfg" = debug ]; then
    # Keep the wasm name section + emit an index->name symbol map so traps symbolicate.
    extra="-p:WasmNativeStrip=false -p:WasmNativeDebugSymbols=true -p:WasmEmitSymbolMap=true"
    log "DEBUG build (wasm symbols + symbol map)"
  fi
  command -v "$DOTNET" >/dev/null || { err "no SDK at $DOTNET — run install-dotnet.sh"; return 1; }
  export DOTNET_ROOT DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
  export PATH="$DOTNET_ROOT:$PATH"
  pkill -9 -f 'dotnet publish loader' 2>/dev/null; sleep 1
  : > "$logf"
  log "building... (tail: $logf)"
  "$DOTNET" publish loader -c Release $extra > "$logf" 2>&1 &
  local bpid=$!
  # `dotnet publish` HANGS after the final "publish/" line (known emscripten/dotnet
  # quirk) — wait for that line (or an error), then kill it so we don't wait forever.
  while ! grep -qE 'ClassicUOLoader -> .*/publish/$|error (CS|MSB)|: error' "$logf" 2>/dev/null; do
    kill -0 "$bpid" 2>/dev/null || break
    sleep 2
  done
  sleep 3
  pkill -9 -f 'dotnet publish loader' 2>/dev/null
  if grep -qE 'error (CS|MSB)[0-9]|: error' "$logf"; then
    err "BUILD FAILED:"; grep -aiE 'error (CS|MSB)[0-9]|: error' "$logf" | grep -avi warning | head -8 >&2
    return 1
  fi
  [ -d "$PUB/_framework" ] || { err "no _framework output"; return 1; }
  # Stamp build-info.json into the bundle (Layer 1 §3.5): the SHA flows into every
  # diag beacon so the sidecar symbolicates against the matching symbol map.
  local sha; sha="$(git -C "$HERE/.." rev-parse --short HEAD 2>/dev/null || echo dev)"
  printf '{"sha":"%s","cfg":"%s","built":%s}\n' "$sha" "$cfg" "$SECONDS" > "$PUB/build-info.json"
  log "build ok in $((SECONDS-t0))s (sha $sha)"
}

_serve(){
  pkill -f "http.server $HTTP_PORT" 2>/dev/null; sleep 1
  python3 -m http.server "$HTTP_PORT" --bind 127.0.0.1 --directory "$PUB" >"$RUN/http.log" 2>&1 &
  echo $! > "$RUN/http.pid"
  sleep 1
}
_bridge(){
  pkill -f dev-ws-bridge 2>/dev/null; sleep 1
  python3 "$HERE/dev-ws-bridge.py" >"$RUN/bridge.log" 2>&1 &
  echo $! > "$RUN/bridge.pid"
  log "WS bridge up (ws://127.0.0.1:$BRIDGE_PORT -> shard)"
}

# boot [secs] [withbridge]
boot(){
  local secs="${1:-$BOOT_SECS}" withbridge="${2:-}"
  [ -d "$PUB/_framework" ] || { err "no build — run ./dev.sh build first"; return 1; }
  # art symlink (served at /uo-data)
  [ -L "$PUB/uo-data" ] || ln -sfn "$HERE/.uo-test-data" "$PUB/uo-data" 2>/dev/null
  # optional e2e config from ./.run/uo-config.json
  if [ -n "$withbridge" ] && [ -f "$RUN/uo-config.json" ]; then
    cp -f "$RUN/uo-config.json" "$PUB/uo-config.json"; _bridge
  else
    rm -f "$PUB/uo-config.json" 2>/dev/null
  fi
  _serve
  local clog="$RUN/console.log"; : > "$clog"
  pkill -f "remote-debugging-port=$DBG_PORT" 2>/dev/null; sleep 1
  log "booting headless chrome for ${secs}s (console: $clog)"
  "$CHROME" --headless=new --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader \
    --enable-logging=stderr --v=0 --remote-debugging-port="$DBG_PORT" --remote-allow-origins='*' \
    --window-size=900,650 "http://127.0.0.1:$HTTP_PORT/index.html" >"$clog" 2>&1 &
  echo $! > "$RUN/chrome.pid"
  # stream the filtered console live while it boots
  ( timeout "$secs" tail -f "$clog" 2>/dev/null | filter_console ) || true
  # auto-screenshot at the end (best-effort) if still alive
  shot "$RUN/boot.png" 2>/dev/null || true
  if [ "${KEEP:-0}" = 1 ]; then
    log "KEEP=1 — leaving chrome/server up (./dev.sh clean to stop)"
  else
    kill "$(cat "$RUN/chrome.pid" 2>/dev/null)" 2>/dev/null; rm -f "$RUN/chrome.pid"
    pkill -f "http.server $HTTP_PORT" 2>/dev/null; rm -f "$RUN/http.pid"
    pkill -f dev-ws-bridge 2>/dev/null; rm -f "$RUN/bridge.pid"
  fi
  echo
  if grep -qaE 'out of bounds|Uncaught|abort\(|\[fatal' "$clog"; then
    err "=== TRAP/FATAL detected — see $clog ; for names: ./dev.sh sym '<indices>' (debug build) ==="
    grep -aE 'out of bounds|Uncaught|\[fatal|wasm-function\[' "$clog" | grep -avE "$NOISE" | tail -25 >&2
  fi
}

shot(){
  local out="${1:-$RUN/shot.png}"
  python3 "$HERE/cdp-screenshot.py" "$DBG_PORT" "$out" 3 >&2 && log "screenshot -> $out"
}

logs(){ filter_console < "$RUN/console.log" | tail -60; }

# sym '<idx idx ...>' : map wasm function indices (from a [fatal] stack) to names.
# The map (index:name) is emitted as dotnet.native.js.symbols under obj/. If it's
# missing, force a native relink: rm -rf loader/obj/.../wasm && ./dev.sh build debug.
sym(){
  local map; map="$(ls -t "$HERE"/loader/obj/Release/net10.0/wasm/for-publish/dotnet.native.js.symbols 2>/dev/null | head -1)"
  if [ ! -f "$map" ]; then
    # fall back to regenerating it from the wasm
    local w; w="$(ls "$PUB"/_framework/dotnet.native.*.wasm 2>/dev/null | head -1)"
    [ -f "$w" ] || { err "no wasm — build first"; return 1; }
    map="$RUN/funcmap.txt"
    "$HERE"/statics/emsdk/emsdk/bin/wasm-opt --print-function-map --quiet "$w" \
      --enable-threads --enable-bulk-memory --enable-exception-handling --enable-multivalue \
      --enable-mutable-globals --enable-reference-types --enable-sign-ext --enable-simd 2>/dev/null > "$map"
  fi
  for idx in $1; do printf '[%6s] %s\n' "$idx" "$(awk -F: -v i="$idx" '$1==i{print $2; exit}' "$map")"; done
}

cmd="${1:-}"; shift || true
case "$cmd" in
  clean) clean ;;
  build) build "$@" ;;
  boot)  boot "${1:-}" ;;
  e2e)   boot "${1:-$BOOT_SECS}" withbridge ;;
  shot)  shot "$@" ;;
  logs)  logs ;;
  sym)   sym "${1:-}" ;;
  rebuild) clean; build "$@" ;;
  *) sed -n '3,18p' "$0"; exit 1 ;;
esac
