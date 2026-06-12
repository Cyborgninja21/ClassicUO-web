# Spike 7.1 — engine-in-a-Web-Worker: **GO** (2026-06-11)

ClassicUO (full .NET-wasm bundle, unmodified) boots and **renders the login
screen from a classic Web Worker** onto an OffscreenCanvas: runtime up, art
loaded, FNA3D WebGL2 context created, 600 frames pumped, pixels on the page.
Run it: serve the publish dir, copy these two files in, open `spike-worker.html`.

## The recipe (every line was a discovered wall)

1. **`globalThis.dotnetSidecar = true` BEFORE importing dotnet.js.** In worker
   mode (`Ce` in the loader) dotnet.js parks forever awaiting a main-thread
   asset hand-off (`coreAssetsInMemory.promise` — .NET's own threading
   protocol). The sidecar flag flips it to the self-sufficient path. Without
   it `create()` never resolves and the worker sits idle — no error, no trace.
2. **Full DOM shim installed BEFORE import** (emscripten captures `document`
   during `create()`): `querySelector('#canvas')` → the OffscreenCanvas
   (with expando `clientWidth/Height`, `getBoundingClientRect`, no-op
   listeners), `document.body`/`createElement`/`readyState:'complete'`,
   `window = self`.
3. **`createElement('canvas')` must return a real `new OffscreenCanvas(1,1)`**
   (SDL creates helper canvases and calls `getContext`) **with a stubbed
   `toDataURL`** (SDL builds a CSS cursor data-URL — meaningless in a worker).
4. Canvas arrives via `transferControlToOffscreen()` + postMessage; rAF exists
   in workers — the frame pump works unchanged.

## What this unlocks (the reason for the spike)

- **OPFS sync access handles** (workers only) → WASMFS OPFS backend → the
  1.6 GB art set leaves wasm memory → the 4 GB heap-ceiling problem dies.
- Main thread freed: GC pauses and heavy frames stop janking the page.
- Retail-parity architecture (retail.classicuo.org runs its engine in a worker).

## Productionization checklist (the next work item — NOT this spike)

- Split main.js: thin page shell (input capture → postMessage, audio — no
  AudioContext in workers, picker/banner UI, resize) + worker boot module.
- Input: forward pointer/key events from the page; the JSExports are callable
  in-worker via the same exports object.
- Audio: worker → postMessage → page-side WebAudio (or an AudioWorklet).
- Beacons / fetch / WebSocket: all work natively in workers.
- Firefox verification FIRST (lesson of the heap-ceiling incident).
