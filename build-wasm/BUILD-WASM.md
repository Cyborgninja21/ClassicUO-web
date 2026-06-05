# ClassicUO-web — WebAssembly build

In-browser WASM build of ClassicUO, for the Utumno Online T2A shard's browser
client. This fork's `web-wasm` branch carries only the WASM build scaffolding on
top of pinned upstream ClassicUO; the desktop client is untouched.

> **Canonical plan:** `plans/utumno-uo-t2a-web-client.md` in the
> [Utumno-iac repo](https://github.com/Cyborgninja21/Utumno-iac) (phase **W2**).
> All WASM-client build work lives **here in the fork**, not in Utumno-iac.

## Status

| Step | State |
|------|-------|
| Fork pinned to upstream `12ffabda` (ClassicUO-main-release, 2026-06-02) | ✅ |
| Toolchain reverse-engineered from celeste-wasm + FNA-WASM-Build | ✅ |
| Native libs + runtime + emsdk staged (`fetch-statics.sh`) | ✅ |
| `loader/` WASM project builds (custom runtime + emsdk + FNA native libs link) | ✅ 2026-06-05 |
| Runtime boots + runs managed C# in Chrome (smoke `Main`) | ✅ 2026-06-05 |
| FNA + ClassicUO referenced; OPFS art; selective AOT | 🔲 in progress |
| Boots to login screen in Chrome | 🔲 |

## Design decisions

- **Single-threaded** (`WasmEnableThreads=false`). Dodges COOP/COEP + the
  worker/OffscreenCanvas/GL-proxy complexity. FNA-WASM-Build ships a
  `pthread-false` variant of every native lib + the runtime, so this is viable
  without a custom native build. Threaded is the escalation path if frame rate
  demands it (validated W0: single-threaded FNA/SDL→WebGL2 boots fine).
- **No MonoMod / no runtime IL patching.** celeste-wasm needs MonoMod because
  Celeste is a closed binary; ClassicUO is open source, so we patch *source*
  directly (e.g. the W3 `src/Network/` WebSocket transport change) and drop
  celeste's `patcher/`, `corefier/`, MonoMod refs, FMOD, Steam, and Lua.
- **Selective AOT** (the key to taming ClassicUO's reflection). Per celeste's
  `AOTWhitelist` + `AOTOnlyCorlib` MSBuild target: AOT-compile only corlib +
  FNA + the loader; **interpret** the rest. This avoids AOT-trimming the
  reflection-heavy plugin/packet-handler code.

## Toolchain (matched set — do not mix with stock wasm-tools)

The FNA-WASM-Build native `.a` libs were linked against its **own patched .NET 10
runtime + frozen emsdk**. The build must use that matched set, not the stock
`wasm-tools` Emscripten. The loader csproj points the runtime pack at
`statics/dotnet` and emsdk at `statics/emsdk` (celeste pattern).

- **.NET 10 SDK** + `wasm-tools` workload. Install hermetically (no sudo):
  ```bash
  ./install-dotnet.sh                   # -> build-wasm/.toolchain/dotnet (+ wasm-tools)
  ```
- **Statics** (native libs, runtime pack, frozen emsdk) — `pthread-false`:
  ```bash
  ./fetch-statics.sh                    # pulls FNA-WASM-Build run, populates statics/
  ```
- **Submodule patches** (FNA/SDL3-CS source fixes for wasm — see `patches/`):
  ```bash
  ./apply-patches.sh                    # idempotent; required before the first build
  ```
  Produces `statics/{SDL3,SDL2,FNA3D,FAudio,libmojoshader,libcrypto,libopenal}.a`,
  `statics/{liba,hot_reload_detour}.o`, `statics/dotnet/` (runtime pack),
  `statics/emsdk/` (frozen emsdk).

## Build (target)

```bash
export DOTNET_ROOT="$PWD/.toolchain/dotnet"; export PATH="$DOTNET_ROOT:$PATH"
dotnet publish loader -c Release
# -> loader/bin/Release/net10.0/publish/wwwroot/_framework  (serve over HTTP w/ application/wasm)
```

## Reference

- Template: [MercuryWorkshop/celeste-wasm](https://github.com/MercuryWorkshop/celeste-wasm) `threads-v2` (loader csproj, AOT-whitelist, runtime/emsdk override targets).
- Native libs: [r58Playz/FNA-WASM-Build](https://github.com/r58Playz/FNA-WASM-Build).
- ClassicUO entry: `src/ClassicUO.Client/Main.cs`; FNA: `external/FNA/FNA.Core.csproj` (FNA 25.09, SDL2+SDL3 backends).
