# WASM build patches

Source changes to **submodules** (`external/FNA` and its nested `lib/SDL3-CS`)
that the WASM build needs but can't be committed from this fork (they're upstream
submodules). Applied by `../apply-patches.sh` before building. Same pattern as the
ModernUO server port's `build/patches/`.

All patches are guarded so the **desktop build is unaffected** (runtime
`OperatingSystem.IsBrowser()` branches).

| Patch | What / why |
|-------|------------|
| `001-sdl3cs-wasm-pinvoke-shims.patch` | Routes `SDL_CreateWindow` + `SDL_GetWindowFlags` through the uint32 `SDL__CreateWindow` / `SDL__GetWindowFlags` shims (in `../loader/Emscripten.c`). The native SDL3 functions take/return a **64-bit `SDL_WindowFlags`**, which gets legalized across the mono pinvoke boundary and mismatches the native i64 signature (`RuntimeError: function signature mismatch`). The shims take/return uint32 and widen. |
| `002-fna-sdl3platform-wasm.patch` | Routes FNA's `emscripten_set_main_loop` / `emscripten_cancel_main_loop` (declared `DllImport("__Native")`, which doesn't resolve as a static wasm lib) through the named `wasm_set_main_loop` / `wasm_cancel_main_loop` shims in `../loader/Emscripten.c`. Without this the browser game loop can't start (`DllNotFoundException: __Native`). |

## Refreshing a stale patch

If the pinned upstream ref moves and `apply-patches.sh` reports a patch no longer
applies, re-author it by hand: apply the intent to the submodule source, then
`cd <submodule> && git diff > build-wasm/patches/<name>.patch`.
