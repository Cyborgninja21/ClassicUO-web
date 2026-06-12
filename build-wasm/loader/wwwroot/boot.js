// Mode switch (sprint 11): the engine boots in a Web Worker by DEFAULT
// (shell.js + engine-worker.js — main thread freed, OffscreenCanvas render,
// OPFS-backed art store). ?classic=1 forces the legacy main-thread path;
// browsers without OffscreenCanvas fall back to classic automatically, and
// any worker-mode import failure falls back too, so the page always boots.
const params = new URLSearchParams(location.search);
const wantClassic = params.get('classic') === '1';
const workerCapable = typeof OffscreenCanvas !== 'undefined' &&
  'transferControlToOffscreen' in HTMLCanvasElement.prototype;
if (!wantClassic && workerCapable) {
  import('./shell.js').then((m) => m.boot()).catch((e) => {
    console.error('[boot] worker mode failed, falling back to classic:', e);
    import('./main.js');
  });
} else {
  if (!wantClassic) console.warn('[boot] OffscreenCanvas unsupported — classic mode');
  import('./main.js');
}
