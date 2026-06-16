// Mode switch (sprint 11): the engine boots in a Web Worker by DEFAULT
// (shell.js + engine-worker.js — main thread freed, OffscreenCanvas render,
// OPFS-backed art store). ?classic=1 forces the legacy main-thread path;
// browsers without OffscreenCanvas fall back to classic automatically, and
// any worker-mode import failure falls back too, so the page always boots.
//
// A3 (L1) launcher: BEFORE picking a render mode, resolve which shard to connect
// to (presets + optional pre-boot picker). The resolved endpoint record is stashed
// on globalThis.__uoShard so the classic path (main.js) reads it directly, and is
// injected into location's query (?server=/?wt=/?wtcert=) so the worker path
// (shell.js → engine-worker.js, which can't read this thread's globals) inherits it
// through the worker URL it already builds. Resolution lives here because only the
// main thread has the DOM (picker UI) + localStorage (remembered choice).
import { shouldShowPicker, resolveShardForBoot, showPicker, readStoredShard } from './server-picker.js';

async function resolveLauncher() {
  let cfg = null;
  try { cfg = await (await fetch('./uo-config.json')).json(); } catch {}
  let resolved;
  if (shouldShowPicker(cfg, location.search, readStoredShard())) {
    resolved = await showPicker(cfg, location.search);
  } else {
    resolved = resolveShardForBoot(cfg, location.search);
  }
  // Publish for the classic (same-thread) path.
  globalThis.__uoShard = resolved;
  // Inject into the query so the worker path inherits it via the worker URL.
  try {
    const u = new URL(location.href);
    u.searchParams.set('server', resolved.ip);
    if (resolved.wtUrl) u.searchParams.set('wt', resolved.wtUrl); else u.searchParams.delete('wt');
    if (resolved.wtCertUrl) u.searchParams.set('wtcert', resolved.wtCertUrl); else u.searchParams.delete('wtcert');
    history.replaceState(null, '', u.href);
  } catch {}
  console.log('[launcher] shard: ' + resolved.name + ' (' + resolved.ip + ')');
}

(async () => {
  await resolveLauncher();
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
})();
