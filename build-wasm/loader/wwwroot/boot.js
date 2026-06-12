// Mode switch (sprint 9): ?worker=1 boots the engine in a Web Worker
// (shell.js + engine-worker.js — main thread freed, OffscreenCanvas render);
// default remains the proven main-thread path (main.js). Any worker-mode
// import failure falls back to classic so the page always boots.
const wantWorker = new URLSearchParams(location.search).get('worker') === '1';
const workerCapable = typeof OffscreenCanvas !== 'undefined' &&
  'transferControlToOffscreen' in HTMLCanvasElement.prototype;
if (wantWorker && workerCapable) {
  import('./shell.js').then((m) => m.boot()).catch((e) => {
    console.error('[boot] worker mode failed, falling back to classic:', e);
    import('./main.js');
  });
} else {
  if (wantWorker) console.warn('[boot] worker mode requested but unsupported here — classic mode');
  import('./main.js');
}
