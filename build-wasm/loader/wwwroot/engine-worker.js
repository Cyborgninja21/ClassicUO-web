// Engine worker (sprint 9) — runs the entire ClassicUO .NET-wasm engine off the
// main thread, rendering to an OffscreenCanvas. The page side is shell.js: it
// forwards input, plays audio, and renders status UI. Spike recipe + findings:
// build-wasm/spike/README.md. Opt-in via ?worker=1 (boot.js picks the mode).
//
// v1 scope: SERVER-HOSTED ART ONLY. If /uo-data has no manifest, the worker
// reports 'fallback' and shell.js reloads into the classic main-thread mode
// (which has the folder picker).
import { UO_FILES_REQUIRED, UO_FILES_RECOMMENDED, checkIntegrity, fetchManifest } from './art-contract.js';

const out = (t, data) => self.postMessage(Object.assign({ t }, data));
const status = (msg) => out('status', { msg });
const log = (msg) => out('log', { msg });

let exports = null;
let canvas = null;

// ── Worker-boot environment (every shim line = a wall found by the spike) ────
function installEnv(width, height) {
  const noop = () => {};
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 });
  canvas.addEventListener = noop;
  canvas.removeEventListener = noop;
  canvas.style = {};
  canvas.focus = noop;
  canvas.setAttribute = noop;
  self.document = {
    querySelector: (sel) => (sel === '#canvas' ? canvas : null),
    getElementById: (id) => (id === 'canvas' ? canvas : null),
    addEventListener: noop, removeEventListener: noop,
    createElement: (tag) => {
      if (tag === 'canvas') {
        const c = new OffscreenCanvas(1, 1);
        try { c.style = {}; c.addEventListener = noop; c.setAttribute = noop; c.toDataURL = () => 'data:,'; } catch {}
        return c;
      }
      return { style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop, getContext: () => null };
    },
    body: { appendChild: noop, removeChild: noop, addEventListener: noop, style: {} },
    documentElement: { style: {} },
    visibilityState: 'visible', hasFocus: () => true, readyState: 'complete',
    currentScript: null, baseURI: self.location.href, title: 'uo',
    fonts: { ready: Promise.resolve() },
    fullscreenEnabled: false, exitPointerLock: noop,
  };
  self.window = self;
  if (!('devicePixelRatio' in self)) self.devicePixelRatio = 1;
  if (!self.screen) self.screen = { width, height };
  // THE key spike discovery: without this, dotnet.js (worker mode) parks forever
  // awaiting .NET's own main-thread asset hand-off. Sidecar mode self-boots.
  globalThis.dotnetSidecar = true;
}

// ── Art (ported from main.js, DOM status → postMessage) ─────────────────────
const RECOMMENDED_SET = new Set(UO_FILES_RECOMMENDED.map((n) => n.toLowerCase()));

async function opfsArtDir(create) {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle('uo-art', { create: !!create });
}
async function opfsHasAll() {
  try {
    const dir = await opfsArtDir(false);
    for (const f of UO_FILES_REQUIRED) await dir.getFileHandle(f);
    return true;
  } catch { return false; }
}
async function opfsWrite(dir, f, buf) {
  const w = await (await dir.getFileHandle(f, { create: true })).createWritable();
  await w.write(buf); await w.close();
}

function splitTiers(entries) {
  const priority = [], deferred = [];
  for (const e of entries) (RECOMMENDED_SET.has(e.name.toLowerCase()) ? deferred : priority).push(e);
  return { priority, deferred };
}

async function fetchValidateWrite(baseUrl, entry, dir, hash, onBytes) {
  let lastBad = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(baseUrl + entry.name, attempt ? { cache: 'reload' } : undefined);
    if (!resp.ok) throw new Error('fetch ' + entry.name + ' -> ' + resp.status);
    let buf;
    if (onBytes && resp.body) {
      const reader = resp.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.byteLength; onBytes(value.byteLength);
      }
      buf = new Uint8Array(got);
      let off = 0; for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    } else {
      buf = new Uint8Array(await resp.arrayBuffer());
      if (onBytes) onBytes(buf.byteLength);
    }
    lastBad = await checkIntegrity(entry, buf, hash);
    if (lastBad) { log('[art] integrity FAIL ' + entry.name + ': ' + lastBad); continue; }
    exports.ClassicUOLoader.WriteUOFile('/uo/' + entry.name, buf);
    try { await opfsWrite(dir, entry.name, buf); } catch {}
    return;
  }
  throw new Error('art ' + entry.name + ' corrupt after refetch: ' + lastBad);
}

async function fetchTier(entries, baseUrl, dir, hash, label) {
  const totalBytes = entries.reduce((s, e) => s + (e.size || 0), 0);
  let doneBytes = 0;
  const fmtMB = (b) => (b / 1048576).toFixed(0);
  const tick = () => status(label + ' ' + fmtMB(doneBytes) + ' / ' + fmtMB(totalBytes) + ' MB');
  tick();
  const queue = [...entries].sort((a, b) => (a.size || 0) - (b.size || 0));
  let failed = null;
  async function workerFn() {
    for (;;) {
      const entry = queue.shift();
      if (!entry || failed) return;
      let counted = 0;
      const onBytes = (d) => { doneBytes += d; counted += d; tick(); };
      try { await fetchValidateWrite(baseUrl, entry, dir, hash, onBytes); }
      catch (e) { failed = e; return; }
      doneBytes += (entry.size || 0) - counted; tick();
    }
  }
  await Promise.all([0, 1, 2].map(workerFn));
  if (failed) throw failed;
}

async function loadArt(manifest) {
  const dir = await opfsArtDir(true);
  const baseUrl = new URL('/uo-data/', self.location.href).href;
  const hash = !!(typeof crypto !== 'undefined' && crypto.subtle);
  try { if (navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}

  if (await opfsHasAll()) {
    status('loading cached art…');
    const names = [];
    for await (const [name, handle] of dir.entries()) if (handle.kind === 'file') names.push(name);
    let i = 0;
    for (const f of names) {
      if (manifest && manifest.size && !manifest.has(f)) {        // manifest-dropped → prune
        log('[art] pruning cached ' + f);
        try { await dir.removeEntry(f); } catch {}
        continue;
      }
      const buf = new Uint8Array(await (await (await dir.getFileHandle(f)).getFile()).arrayBuffer());
      exports.ClassicUOLoader.WriteUOFile('/uo/' + f, buf);
      status('loading cached art… ' + (++i) + '/' + names.length);
    }
    // top-up newly-added files (required blocks, recommended in background)
    const have = new Set(names);
    const missing = [...manifest.values()].filter((e) => !have.has(e.name));
    const { priority, deferred } = splitTiers(missing);
    if (priority.length) { try { await fetchTier(priority, baseUrl, dir, hash, 'fetching new art…'); } catch (e) { log('[art] ' + e); } }
    if (deferred.length) backgroundTier(deferred, baseUrl, dir, hash);
    return true;
  }

  const entries = [...manifest.values()];
  const { priority, deferred } = splitTiers(entries);
  await fetchTier(priority, baseUrl, dir, hash, 'downloading art (one time)…');
  if (deferred.length) backgroundTier(deferred, baseUrl, dir, hash);
  return true;
}

function backgroundTier(entries, baseUrl, dir, hash) {
  (async () => {
    try {
      await fetchTier(entries, baseUrl, dir, hash, 'extra animations (background)…');
      status('');
      out('banner', { kind: 'refresh' });
    } catch (e) { log('[art] background tier failed (retries next visit): ' + e); status(''); }
  })();
}

// ── Diag beacons (worker-native fetch) ───────────────────────────────────────
const diag = { session: crypto.randomUUID ? crypto.randomUUID() : String(Math.floor(performance.now())), phase: 'boot', frame: 0, build: '' };
let diagEndpoint = '/ingest';
function beacon(type, data) {
  try {
    fetch(diagEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ type, session: diag.session, build_sha: diag.build, phase: diag.phase, frame: diag.frame, mode: 'worker' }, data)) }).catch(() => {});
  } catch {}
}
const setPhase = (p) => { diag.phase = p; out('phase', { phase: p }); };

// ── Tick stats (lives here; shell proxies snapshots) ─────────────────────────
const _tickDur = new Float32Array(600);
let _tickDurN = 0, _tickDurI = 0;
function tickStats() {
  const n = Math.min(_tickDurN, _tickDur.length);
  if (!n) return { n: 0 };
  const a = Array.from(_tickDur.slice(0, n)).sort((x, y) => x - y);
  const q = (f) => a[Math.min(n - 1, Math.floor(f * n))];
  return { n, mean: a.reduce((s, v) => s + v, 0) / n, p50: q(0.5), p95: q(0.95), max: a[n - 1] };
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot(msg) {
  canvas = msg.canvas;
  installEnv(msg.width, msg.height);
  try {
    diag.build = (await (await fetch('build-info.json', { cache: 'no-store' })).json()).sha || '';
  } catch {}
  setPhase('runtime-loading');
  const { dotnet } = await import('./_framework/dotnet.js');
  const api = await dotnet
    .withModuleConfig({ canvas, print: (t) => log(t), printErr: (t) => log(t) })
    .create();
  const cfg = api.getConfig();
  exports = await api.getAssemblyExports(cfg.mainAssemblyName);

  // WS lives IN the worker (plain WebSocket works here).
  let ws = null;
  api.setModuleImports('uo-ws', {
    wsOpen: (url) => {
      try { ws && ws.close(); } catch {}
      try {
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => { try { exports.ClassicUOLoader.WsOnOpen(); } catch (e) { log('WsOnOpen EX ' + e); } };
        ws.onmessage = (ev) => { try { exports.ClassicUOLoader.WsOnMessage(new Uint8Array(ev.data)); } catch (e) { log('WsOnMessage EX ' + e); } };
        ws.onclose = () => { try { exports.ClassicUOLoader.WsOnClose(); } catch {} };
        ws.onerror = () => { try { exports.ClassicUOLoader.WsOnError(); } catch {} };
      } catch (e) { log('wsOpen EX ' + e); try { exports.ClassicUOLoader.WsOnError(); } catch {} }
    },
    wsSend: (data) => { try { if (ws && ws.readyState === 1) ws.send(data); } catch (e) { log('wsSend EX ' + e); } },
    wsClose: () => { try { ws && ws.close(); } catch {} ws = null; },
  });
  // Audio bridges to the page (no AudioContext in workers).
  api.setModuleImports('uo-audio', {
    audioPlay: (id, volume) => out('audio', { op: 'play', id, volume }),
    audioMusic: (name, volume, loop) => out('audio', { op: 'music', name, volume, loop }),
    audioMusicStop: () => out('audio', { op: 'musicStop' }),
    audioMusicVolume: (volume) => out('audio', { op: 'musicVolume', volume }),
    audioStopAll: () => out('audio', { op: 'stopAll' }),
  });

  exports.ClassicUOLoader.Init();
  exports.ClassicUOLoader.MkUODir();

  setPhase('art');
  const manifest = await fetchManifest();
  if (!manifest || !manifest.size) { out('fallback', {}); return; }
  await loadArt(manifest);

  // Login background: createImageBitmap + OffscreenCanvas 2D both work in workers.
  try {
    const bgResp = await fetch('game-background.png');
    if (bgResp.ok) {
      const bmp = await createImageBitmap(await bgResp.blob());
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = cv.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const px = cx.getImageData(0, 0, bmp.width, bmp.height).data;
      exports.ClassicUOLoader.SetLoginBackground(new Uint8Array(px.buffer.slice(0)), bmp.width, bmp.height);
    }
  } catch (e) { log('[boot] login background skipped: ' + e); }

  let settings = { ip: '172.16.2.154', port: 2593, ultimaonlinedirectory: '/uo',
    clientversion: '7.0.114.65', lang: 'ENU', encryption: 0, use_verdata: false };
  try { settings = Object.assign(settings, await (await fetch('./uo-config.json')).json()); } catch {}
  if (settings.diag_endpoint) { diagEndpoint = settings.diag_endpoint; delete settings.diag_endpoint; }

  if (msg.chunkmesh) { try { exports.ClassicUOLoader.SetChunkMeshEnabled(true); } catch {} }

  setPhase('starting');
  try { exports.ClassicUOLoader.StartClassicUO(JSON.stringify(settings)); }
  catch (e) { if (!String(e).includes('unwind')) { out('fatal', { msg: 'StartClassicUO: ' + e }); beacon('crash', { message: String(e) }); return; } }

  setPhase('login-init');
  out('ready', {});

  // Frame pump (rAF works in workers) — resilient like main.js's.
  let consec = 0;
  const pump = () => {
    let alive = true;
    const t0 = performance.now();
    try {
      alive = exports.ClassicUOLoader.TickFrame();
      _tickDur[_tickDurI] = performance.now() - t0;
      _tickDurI = (_tickDurI + 1) % _tickDur.length; _tickDurN++;
      diag.frame++; consec = 0;
    } catch (e) {
      if (('' + e).includes('unwind')) { requestAnimationFrame(pump); return; }
      consec++;
      if (consec === 1) beacon('frame-error', { message: String((e && e.message) || e), stack: (e && e.stack) || '' });
      if (consec >= 30) { out('fatal', { msg: 'TickFrame persistent: ' + e }); beacon('crash', { message: String(e) }); return; }
    }
    if (alive) requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
  setPhase('rendering');

  // perf beacon + stats snapshot for the shell
  setInterval(() => {
    const t = tickStats();
    out('stats', { stats: t });
    if (diag.phase === 'rendering' && t.n) {
      beacon('perf', { tick_mean: +t.mean.toFixed(2), tick_p50: +t.p50.toFixed(2), tick_p95: +t.p95.toFixed(2), tick_max: +t.max.toFixed(2), n: t.n });
    }
  }, 5000);
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.t === 'boot') { boot(m).catch((ex) => out('fatal', { msg: 'boot: ' + ex + ' :: ' + ((ex && ex.stack) || '').slice(0, 500) })); }
    else if (m.t === 'in') { const fn = exports && exports.ClassicUOLoader[m.fn]; if (fn) fn(...m.a); }
    else if (m.t === 'resize') { try { exports.ClassicUOLoader.SetCanvasSize(m.w, m.h); } catch {} }
  } catch (ex) { log('msg EX ' + ex); }
};
