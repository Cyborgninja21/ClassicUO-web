# Debugging ClassicUO-web (WASM)

A reliable loop instead of ad-hoc thrash. Everything runs through **`./dev.sh`**.

## The loop

```bash
./dev.sh build            # build (auto-handles the post-publish hang); ~3 min
./dev.sh boot 90          # serve + headless-boot 90s + live filtered console + screenshot
./dev.sh e2e 90           # same, but with the WS bridge + ./.run/uo-config.json (autologin)
./dev.sh clean            # kill every stray process
```

Outputs land in `build-wasm/.run/` (gitignored): `build.log`, `console.log` (filtered live),
`boot.png`, `bridge.log`. `./dev.sh logs` reprints the last filtered console.

## Getting a stack on a wasm trap  ← the big one

A hard wasm trap prints **`Uncaught RuntimeError: memory access out of bounds`** with **no
stack and no managed frame**. Two tools, in order:

1. **`main.js` already captures context.** It keeps a 60-line log ring and an
   `onerror`/`unhandledrejection` handler that prints the JS stack **plus the last 20 log
   lines** as `[fatal] …`. So the console (and `console.log`) shows *where you were* even
   when the trap itself is opaque. Look for `[fatal]`.
2. **Symbolicate wasm frames.** Build with symbols and map the `wasm-function[N]` indices:
   ```bash
   ./dev.sh build debug          # adds WasmNativeDebugSymbols + WasmEmitSymbolMap
   ./dev.sh boot 90
   ./dev.sh sym '3833 3745 3735' # -> function names from the .wasm.symbols map
   ```
   Caveat: managed (C#) code runs in the **interpreter**, so its frames show as the
   interpreter function, not the C# method. Symbolication mainly names **native** frames
   (FNA/SDL/FNA3D/runtime). For "which C# line", breadcrumbs are still fastest (below).

3. **Breadcrumbs** — the pragmatic tool for "which managed call traps". Drop
   `Console.WriteLine("[bc] X")` before/after suspect calls, `./dev.sh build && ./dev.sh boot`,
   read the trail (the last `[bc]` printed is the line that trapped). Mechanical but reliable;
   the harness makes the build+boot cycle ~5 min total.

## More runtime detail

- **Mono runtime asserts** (e.g. `loader.c:NNNN ... not met`) print to console already.
- For verbose runtime logging add to `Init()` (or via the env): `MONO_LOG_LEVEL=debug`,
  `MONO_LOG_MASK=all` — noisy, but surfaces dllimport/assembly resolution failures.
- ClassicUO's own `Log.Trace/Warn/Error` already stream to console (that's the
  `Loading file: …`, `Done!`, etc. you see).

## Gotchas burned in (don't relearn these)

- **`dotnet publish` hangs after it finishes.** The final `ClassicUOLoader -> …/publish/`
  line prints, then the process never exits (emscripten/dotnet quirk) — it spawns several
  `dotnet` workers that pile up across builds and masquerade as "still compiling". `dev.sh
  build` watches for that line then `pkill`s it. If a build ever seems stuck >5 min, it's
  zombies: `./dev.sh clean`. Our changes are managed-only, so the output is complete when
  that line prints.
- **Publish accumulates stale hashed assemblies** (`cuo.*.dll`, `dotnet.native.*.wasm`) — it
  doesn't clean old ones. The boot manifest references the current build's hashes, so it's
  harmless; ignore the pile (or `./dev.sh clean` + delete `loader/bin` for a pristine run).
- **Headless chrome + the agent sandbox throws SIGURG (exit 144)** on backgrounded launches
  and can orphan the http server. `dev.sh` runs chrome in the foreground with a `timeout`
  and tears down via pidfiles, which sidesteps it. Run `dev.sh` directly, not piecemeal.
- **`--screenshot` can't capture the rAF main loop** (the page never "loads"); use CDP
  (`cdp-screenshot.py`, wired into `dev.sh shot`).
- **Console noise** (dbus, swiftshader, Vulkan, gpu_blocklist, …) is filtered by `dev.sh`;
  the raw stream is still in `.run/console.log` if you need it.

## End-to-end (browser → bridge → live shard)

```bash
# write ./.run/uo-config.json with the ws:// proxy + (optional) autologin creds, then:
./dev.sh e2e 120
```
`uo-config.json` is merged over the defaults by `main.js`. The bridge
(`dev-ws-bridge.py`) maps `ws://127.0.0.1:8770` → the live shard `:2593`. Password for
autologin must be in ClassicUO's `Crypter` format (XOR `Environment.MachineName`, which is
`localhost` in wasm; `1-` + hex). Keep creds out of git — `.run/` is gitignored.
