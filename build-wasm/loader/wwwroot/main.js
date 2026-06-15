// Boot the ClassicUO-web WASM client (single-threaded), library mode.
// UO art is fetched in JS and written to MEMFS via a synchronous JSExport (AOT-safe).
import { dotnet } from './_framework/dotnet.js'

// ===========================================================================
// Layer 1 — client self-diagnosis (plan §3.5, "the anti-guessing layer").
// Turns opaque wasm traps + silent hangs into self-reports that name the phase
// + frame + (symbolicatable) wasm frames. In dev this prints to the console; in
// the container it POSTs to the diag-sidecar (set diag_endpoint in uo-config /
// settings) which symbolicates against the build SHA and pushes to Loki.
// ===========================================================================
const diag = {
  session: (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('s' + Date.now() + Math.random()),
  build_sha: 'dev',                 // overwritten from /build-info.json below
  phase: 'boot',
  phaseTs: performance.now(),
  frame: 0,
  lastTickTs: performance.now(),
  endpoint: null,                   // diag-sidecar /ingest URL; null = console-only (dev)
  stallReported: false,
  crashed: false,
};

// Known ClassicUO/boot log substrings → phase, so we get rich phases without
// instrumenting every managed call site. Explicit "[phase] x" lines also work.
const PHASE_SIGNALS = [
  ['UO files written', 'assets-fetched'],
  ['Files loaded in', 'uo-files-loaded'],
  ['FNA3D Driver', 'graphics-init'],
  ['Done!', 'login-init'],
  ['first frame ticked', 'rendering'],
  ['Connecting to', 'ws-connecting'],
  ['Connected WebSocket', 'ws-open'],
  ['Selecting', 'server-select'],
  ['in game', 'in-world'],
];

function setPhase(p) {
  if (p && p !== diag.phase) { diag.phase = p; diag.phaseTs = performance.now(); _log('[phase] ' + p); }
}

// Ring of recent log lines + phase detection. Hard wasm traps print with no
// stack; the ring is how we recover "where you were". See DEBUGGING.md.
const _ring = [];
let _wd = null;   // freeze-watchdog worker (created later in the pump section); declared up here so the console.log override can forward [step] breadcrumbs to it in real time
// Bind the ORIGINAL console methods up front; every override below emits through these
// (never through another override), so capture happens exactly once — no recursion, no
// double-logging into the ring.
const _log  = console.log.bind(console);
const _warn = console.warn.bind(console);
const _err  = console.error.bind(console);
const _info = console.info.bind(console);
function _join(a) { try { return a.join(' '); } catch { return ''; } }

// Single capture path for EVERY log line — stdout, native stderr (printErr below), AND
// the browser's own console.warn/console.error (WebGL/CSP/etc). Pushes to the ring (crash/
// stall beacon context) and runs phase detection, so ALL streams feed one diag pipeline.
// setPhase emits via _log (the original console.log), which bypasses this — no recursion.
function _captureLine(line) {
  try {
    _ring.push(line); if (_ring.length > 80) _ring.shift();
    if (!line.startsWith('[phase] ')) {            // avoid recursion on our own emit
      const m = line.match(/\[phase\]\s+(\S+)/);
      if (m) { diag.phase = m[1]; diag.phaseTs = performance.now(); }
      else for (const [sig, ph] of PHASE_SIGNALS) if (line.includes(sig)) { setPhase(ph); break; }
    }
  } catch {}
}

// Known-benign, high-volume browser warnings → downgrade to info so they don't flag
// yellow (still captured in the ring). FNA3D probes MSAA sample counts via
// glGetInternalformativ; WebGL2's getInternalformatParameter rejects some formats with
// INVALID_ENUM — harmless (FNA3D clears the error and proceeds with no MSAA for that
// format). NOTE: Chrome may emit this WebGL warning natively (not via the page's
// console.warn); if so this override can't intercept it and an FNA3D patch is the only fix.
const _BENIGN_WARN = /INVALID_ENUM:\s*getInternalformatParameter/;

console.log = (...a) => { const l = _join(a); _captureLine(l); _log(...a); };
console.warn = (...a) => { const l = _join(a); _captureLine(l); (_BENIGN_WARN.test(l) ? _info : _warn)(...a); };
console.error = (...a) => { _captureLine(_join(a)); _err(...a); };

// Pull wasm-function[N] indices out of a stack — the diag-sidecar symbolicates
// these against the symbol map for diag.build_sha (so Loki shows real names).
function wasmFrames(stack) {
  const out = []; const re = /wasm-function\[(\d+)\]/g; let m;
  while ((m = re.exec(stack || '')) && out.length < 24) out.push(+m[1]);
  return out;
}

// Emit a structured beacon. Console always (dev); POST when an endpoint is set
// and we're not on localhost (keepalive so a crash beacon survives teardown).
function beacon(type, extra) {
  const env = {
    type, ts: new Date().toISOString(), session: diag.session, build_sha: diag.build_sha,
    phase: diag.phase, phase_ms: Math.round(performance.now() - diag.phaseTs),
    frame: diag.frame, ua: navigator.userAgent, ...extra,
  };
  _log('[beacon] ' + type + ' ' + JSON.stringify({ phase: env.phase, frame: env.frame, ...(extra && extra.tag ? { tag: extra.tag } : {}) }));
  const onLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (diag.endpoint && !onLocalhost) {
    try { fetch(diag.endpoint, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) }).catch(() => {}); } catch {}
  }
  return env;
}

function _fatal(tag, e) {
  const stack = (e && (e.stack || e.message)) || String(e);
  const msg = String((e && e.message) || e);
  // The .NET runtime probes for optional resources (satellite assemblies, etc.) and
  // handles the 404 itself, but the rejection still bubbles here. Not an app crash —
  // log quietly, and crucially DON'T latch (else it suppresses the real error).
  if (/Failed to fetch/i.test(msg) && /dotnet(\.native)?\.js/.test(stack)) {
    _log('[diag] benign runtime fetch rejection ignored: ' + msg);
    return;
  }
  // Always log every fatal (a later, different error must still surface); beacon once.
  _log(`[fatal] ${tag}: ${stack}\n--- last ${Math.min(_ring.length, 20)} log lines ---\n${_ring.slice(-20).join('\n')}\n--- end ---`);
  if (diag.crashed) return;
  diag.crashed = true;
  beacon('crash', { tag, message: msg, stack, wasm_frames: wasmFrames(stack), ring: _ring.slice(-20) });
  // Surface a one-click BugPin report pre-filled with this envelope (plan §3.5).
  try { window.UO_onFatal && window.UO_onFatal({ tag, stack, phase: diag.phase, frame: diag.frame, session: diag.session, build_sha: diag.build_sha }); } catch {}
}
addEventListener('error', e => _fatal('window.onerror', e.error || e));
addEventListener('unhandledrejection', e => _fatal('unhandledrejection', e.reason));

// [inputtrace] DOM-level input confirmation for real-browser input debugging (link 1
// of the click chain). Capture phase so we see the event even if something downstream
// consumes it; capped to avoid flooding. Tells us whether clicks/keys reach the canvas.
{
  let _itc = 0;
  const _itr = (kind, e) => { if (_itc++ < 300) console.log(`[inputtrace] ${kind} target=${e.target && e.target.tagName} @ ${e.clientX || 0},${e.clientY || 0} ${e.key ? 'key=' + e.key : 'btn=' + e.button}`); };
  addEventListener('pointerdown', e => _itr('pointerdown', e), true);
  addEventListener('mousedown', e => _itr('mousedown', e), true);
  addEventListener('keydown', e => _itr('keydown', e), true);
}

// Watchdog: a silent hang (no trap) is the worst case — DrawTiled froze the
// first frame, the blocking while-loop froze the thread. If frames stop (and
// we're not yet in-world) or a phase sits too long, self-report once.
setInterval(() => {
  if (diag.crashed) return;
  const now = performance.now();
  const sincePhase = now - diag.phaseTs;
  const sinceTick = now - diag.lastTickTs;
  const ticking = diag.frame > 0;
  // A "waiting" network phase that never advances = the login handshake wedged (e.g.
  // connected but no server list). Frames keep ticking, so the frame-stop check misses it.
  const WAITING = ['ws-connecting', 'ws-open', 'server-select'];
  const stalled =
    (ticking && diag.phase !== 'in-world' && sinceTick > 5000) ||       // frames stopped
    (!ticking && sincePhase > 12000) ||                                 // never reached the loop
    (WAITING.includes(diag.phase) && sincePhase > 15000);               // handshake wedged
  if (stalled && !diag.stallReported) {
    diag.stallReported = true;
    beacon('stall', { since_phase_ms: Math.round(sincePhase), since_tick_ms: Math.round(sinceTick), ticking, ring: _ring.slice(-20) });
  }
  if (ticking && diag.phase !== 'in-world' && sinceTick < 2000) diag.stallReported = false; // recovered
}, 2000);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
try { diag.build_sha = (await (await fetch('/build-info.json')).json()).sha || 'dev'; } catch {}
// Production default: ship beacons to the same-origin diag sidecar so real-player
// crashes/stalls reach Loki (dev stays console-only; uo-config can override).
// Only ship beacons to /ingest from the real (Traefik-routed) domain. On the raw dev
// IP (http://<ip>:8080) there is no /ingest route → POSTs 405; stay console-only there.
const _isRawIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(location.hostname);
if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && !_isRawIp) diag.endpoint = '/ingest';
_log('[boot] build ' + diag.build_sha + ' session ' + diag.session);

// Native stderr (emscripten `err`): FNA3D / SDL drivers / FAudio / wasm-runtime traps
// all land here. Route every line through the SAME _captureLine pipeline as stdout, so
// the diag ring (and therefore crash/stall beacons) and phase detection see native
// output too — this is where the most diagnostic lines (driver errors, aborts) appear,
// and previously they bypassed the ring entirely. Then classify for color: known info
// banners (e.g. "FNA3D Driver: OpenGL", which PHASE_SIGNALS already maps to graphics-init)
// print as info, not a red error; everything else stays console.error so genuine native
// faults still stand out AND are now captured. Pattern-keyed — whitelist more as needed.
// FNA3D's GL device-info banners (Renderer/Driver/Vendor = GL_RENDERER/VERSION/VENDOR)
// come through here too — same benign info class, just queried right after the driver line.
// MojoShader (FNA3D's shader translator) prints "MojoShader Profile: glsles3" etc. to
// stderr at graphics-init — benign info, NOT a fault. It was being tagged console.error,
// which made devtools attach the scary native (mono_wasm_invoke_jsexport) stack trace.
const _NATIVE_INFO = /^(FNA3D Driver:|OpenGL (Renderer|Driver|Vendor):|MojoShader )/;
function _printErr(line) {
  const s = typeof line === 'string' ? line : String(line);
  _captureLine(s);
  if (_NATIVE_INFO.test(s)) { _info(s); return; }
  _err(s);
}

const { getAssemblyExports, getConfig, setModuleImports } =
  await dotnet.withModuleConfig({ printErr: _printErr, canvas: document.getElementById('canvas') }).create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName);
setPhase('runtime-up');

// JS-interop WebSocket (module "uo-ws", driven by WasmWebSocketBridge in managed code).
// A plain JS WebSocket owned here, bytes crossing synchronously — bypasses
// ClientWebSocket whose async dies on the .NET-WASM threadpool reverse-pinvoke under AOT.
let _ws = null;
setModuleImports('uo-ws', {
  wsOpen: (url) => {
    try { _ws && _ws.close(); } catch {}
    try {
      _ws = new WebSocket(url);
      _ws.binaryType = 'arraybuffer';
      _ws.onopen = () => { try { exports.ClassicUOLoader.WsOnOpen(); } catch (e) { _fatal('WsOnOpen', e); } };
      _ws.onmessage = (ev) => { try { exports.ClassicUOLoader.WsOnMessage(new Uint8Array(ev.data)); } catch (e) { _fatal('WsOnMessage', e); } };
      _ws.onclose = () => { try { exports.ClassicUOLoader.WsOnClose(); } catch {} };
      _ws.onerror = () => { try { exports.ClassicUOLoader.WsOnError(); } catch {} };
    } catch (e) { _fatal('wsOpen', e); try { exports.ClassicUOLoader.WsOnError(); } catch {} }
  },
  wsSend: (data) => { try { if (_ws && _ws.readyState === 1) _ws.send(data); } catch (e) { _fatal('wsSend', e); } },
  wsClose: () => { try { _ws && _ws.close(); } catch {} _ws = null; },
});

// ── JS-interop audio (module "uo-audio", driven by WasmAudioBridge) ──────────────
// The browser does the audio work: sound-effect PCM (16-bit mono) decodes ONCE per
// id into a cached WebAudio AudioBuffer; music streams as mp3 via an <audio>
// element from /uo-data/music/. FNA's streamed playback hangs the single WASM
// thread, so this is the audio twin of the WS / PNG-decode inversions.
let _ac = null;                 // AudioContext — lazy; browsers gate on a user gesture
const _audioBuffers = new Map(); // sound id -> AudioBuffer
const _livePlays = new Set();    // active effect source nodes (for stopAll)
let _musicEl = null;            // HTMLAudioElement for the current track
let _musicVol = 1.0;
let _playCount = 0;             // diagnostics
window.__cuoAudioStats = () => ({ buffers: _audioBuffers.size, plays: _playCount,
  ctx: _ac ? _ac.state : 'none', music: _musicEl ? (_musicEl.paused ? 'paused' : 'playing') : 'none',
  musicSrc: _musicEl ? _musicEl.src : null, musicErr: _musicEl && _musicEl.error ? _musicEl.error.code : null });
function _audioCtx() {
  if (!_ac) {
    try { _ac = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { _log('[audio] AudioContext unavailable: ' + e); return null; }
  }
  return _ac;
}
// Autoplay policy: a suspended context resumes only inside a user gesture.
// Hook ONE listener set; harmless if the context was never suspended.
for (const evName of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(evName, () => {
    if (_ac && _ac.state === 'suspended') _ac.resume().catch(() => {});
    if (_musicEl && _musicEl.paused && _musicEl.dataset.wantsPlay === '1')
      _musicEl.play().catch(() => {});
  }, { passive: true });
}
// Lazy PCM fetch: each effect streams as a tiny raw file (16-bit mono 22050 Hz,
// extracted server-side from the sound UOP) on FIRST play and caches as a decoded
// AudioBuffer. The 161 MB sound UOP must NEVER enter MEMFS — every MEMFS byte is
// wasm-heap, and it pushed the heap past Firefox's growth ceiling (the 2026-06-11
// live "index out of bounds" crash).
const _audioFetching = new Set();
function _fetchEffect(id) {
  if (_audioFetching.has(id)) return;
  _audioFetching.add(id);
  (async () => {
    try {
      const resp = await fetch('uo-data/sounds/' + id + '.pcm');
      if (!resp.ok) { _audioBuffers.set(id, null); return; }   // absent — never retry
      const pcm = new Uint8Array(await resp.arrayBuffer());
      const ac = _audioCtx();
      if (!ac) return;
      const n = pcm.byteLength >> 1;
      const buf = ac.createBuffer(1, n, 22050);
      const ch = buf.getChannelData(0);
      const view = new DataView(pcm.buffer);
      for (let i = 0; i < n; i++) ch[i] = view.getInt16(i << 1, true) / 32768;
      _audioBuffers.set(id, buf);
    } catch (e) { _log('[audio] fetch ' + id + ' failed: ' + e); }
    finally { _audioFetching.delete(id); }
  })();
}
setModuleImports('uo-audio', {
  audioPlay: (id, volume) => {
    try {
      const buf = _audioBuffers.get(id);
      if (buf === undefined) { _fetchEffect(id); return; }   // first use — plays next time (<200ms later typically)
      if (buf === null) return;                              // known-absent
      const ac = _audioCtx();
      if (!ac || ac.state !== 'running') return;
      const src = ac.createBufferSource();
      const gain = ac.createGain();
      gain.gain.value = volume;
      src.buffer = buf;
      src.connect(gain).connect(ac.destination);
      _livePlays.add(src);
      src.onended = () => _livePlays.delete(src);
      src.start();
      _playCount++;
    } catch (e) { _log('[audio] play ' + id + ' failed: ' + e); }
  },
  audioMusic: (name, volume, loop) => {
    try {
      const src = 'uo-data/music/' + String(name).toLowerCase() + '.mp3';
      if (!_musicEl) { _musicEl = new Audio(); _musicEl.preload = 'auto'; }
      _musicVol = volume;
      const want = new URL(src, location.href).href;
      if (_musicEl.src !== want) _musicEl.src = src;
      _musicEl.loop = !!loop;
      _musicEl.volume = Math.max(0, Math.min(1, volume));
      _musicEl.dataset.wantsPlay = '1';
      _musicEl.play().catch(() => { /* autoplay-gated — the gesture hook retries */ });
    } catch (e) { _log('[audio] music ' + name + ' failed: ' + e); }
  },
  audioMusicStop: () => {
    try { if (_musicEl) { _musicEl.dataset.wantsPlay = '0'; _musicEl.pause(); _musicEl.removeAttribute('src'); _musicEl.load(); } } catch {}
  },
  audioMusicVolume: (volume) => {
    try { _musicVol = volume; if (_musicEl) _musicEl.volume = Math.max(0, Math.min(1, volume)); } catch {}
  },
  audioStopAll: () => {
    try { for (const src of _livePlays) { try { src.stop(); } catch {} } _livePlays.clear(); } catch {}
  },
});
exports.ClassicUOLoader.Init();
// Sprint 11: js-memory /uo store — art bytes leave the wasm heap (the
// js_file wasmfs backend is synchronous, so classic mode benefits too).
let uoJsStore = false;
try { uoJsStore = !!exports.ClassicUOLoader.MountUOStore(); } catch (e) { console.warn('[art] js-store mount threw:', e); }
if (!uoJsStore) exports.ClassicUOLoader.MkUODir();
console.log('[art] /uo store: ' + (uoJsStore ? 'js-memory (off-heap)' : 'MEMFS (heap)'));

// ===========================================================================
// UO art onboarding (plan §W5). UO art is EA-owned and NOT shipped — the player
// supplies it once from a UO install (T2A / 7.0.x). It's cached in OPFS (persists
// across sessions), so the folder picker only shows the first time. Dev keeps the
// /uo-data/ server fallback so the harness e2e needs no picker. Nothing is uploaded.
// ===========================================================================
// Shared with engine-worker.js — single source of truth (sprint 9).
import { UO_FILES, UO_FILES_REQUIRED, UO_FILES_RECOMMENDED, sha256Hex, checkIntegrity, parseManifest, fetchManifest, computeArtDelta, serializeArtState, parseArtState, ART_STATE_NAME } from './art-contract.js';

// L2 (D1) in-memory mirror of the persisted "validated" sidecar (name ->
// {size, sha256} the cached bytes were last verified against). Loaded once per
// session, updated as files are (re)written, persisted after each fetch tier.
let _artValidated = null;
function recordValidated(entry, buf) {
  if (!_artValidated) _artValidated = new Map();
  _artValidated.set(entry.name, { size: entry.size != null ? entry.size : (buf ? buf.length : null), sha256: entry.sha256 || null });
}
// Optional — loaded if the player's folder/cache has them (mobiles/items render with
// these; the world still loads without them, just no animations). Not required by the
// picker so partial installs work; the render loop skips anything it can't draw.
const UO_FILES_OPTIONAL = [
  "AnimationFrame1.uop", "AnimationFrame2.uop", "AnimationFrame3.uop", "AnimationFrame4.uop",
  "anim.mul", "anim.idx", "anim2.mul", "anim2.idx", "anim3.mul", "anim3.idx",
  "multi.mul", "multi.idx", "Multimap.rle", "verdata.mul",
];

// Tiered art contract for completeness validation. UO_FILES (the base world set) plus
// the BASE BODY ANIMATIONS: without anim.mul/anim.idx the client renders NO mobiles —
// the player and humanoid NPCs are invisible (body 0x191 lives in anim.mul, not the
// AnimationFrame*.uop UOP frames). They were previously mis-classified OPTIONAL, which
// is exactly how a bodyless world shipped silently. A missing/corrupt REQUIRED file is
// now surfaced loudly (console + on-screen banner), never a silent partial load.

// --- Art integrity. The manifest may carry {name, size, sha256} per file (see
// .run/gen-art-manifest.py). We verify size on every load and sha256 on download in a
// secure context (crypto.subtle needs https/localhost; raw-IP HTTP dev degrades to
// size-only). A truncated/corrupt download is rejected and refetched rather than
// written, so corruption never reaches the game's virtual filesystem. ---

function artStatus(msg) { const el = document.getElementById('art-status'); if (el) el.textContent = msg; _log('[art] ' + msg); }

async function opfsArtDir(create) {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle('uo-art', { create: !!create });
}
async function opfsHasAllArt() {
  try {
    const dir = await opfsArtDir(false);
    for (const f of UO_FILES) await dir.getFileHandle(f);   // throws if any missing
    return true;
  } catch { return false; }
}
async function opfsWrite(dir, f, buf) {
  const w = await (await dir.getFileHandle(f, { create: true })).createWritable();
  await w.write(buf); await w.close();
}

async function loadFromOpfs(manifest) {
  artStatus('loading cached art…');
  const dir = await opfsArtDir(false);
  // Load everything cached (required + any optional the player provided).
  const names = [];
  for await (const [name, handle] of dir.entries()) if (handle.kind === 'file') names.push(name);
  let i = 0;
  for (const f of names) {
    if (f === ART_STATE_NAME) continue;   // the L2 sidecar is metadata, not art
    // A file the SERVER manifest no longer lists must not enter MEMFS (every
    // MEMFS byte is wasm-heap — a stale 161 MB soundLegacyMUL.uop pushed the
    // heap past Firefox's growth ceiling). Server-managed caches prune it;
    // picker-supplied caches (no manifest) load everything as before.
    if (manifest && manifest.size && !manifest.has(f)) {
      _log('[art] pruning cached ' + f + ' (no longer in the server manifest)');
      try { await dir.removeEntry(f); } catch {}
      continue;
    }
    const buf = new Uint8Array(await (await (await dir.getFileHandle(f)).getFile()).arrayBuffer());
    exports.ClassicUOLoader.WriteUOFile('/uo/' + f, buf);
    artStatus('loading cached art… ' + (++i) + '/' + names.length);
  }
}
async function opfsArtKeys() {
  try {
    const dir = await opfsArtDir(false);
    const names = [];
    for await (const [name, handle] of dir.entries()) if (handle.kind === 'file' && name !== ART_STATE_NAME) names.push(name);
    return names;
  } catch { return []; }
}
async function opfsSizeOf(name) {
  try { return (await (await (await opfsArtDir(false)).getFileHandle(name)).getFile()).size; }
  catch { return null; }
}

// IndexedDB art cache — the persistent store for INSECURE contexts (plain-HTTP LAN
// dev, e.g. http://172.16.2.154:8080). OPFS (navigator.storage) only exists in secure
// contexts (https / localhost), so on raw-IP HTTP it's unavailable and the art would
// otherwise re-fetch /uo-data/ on every load. IndexedDB IS available over plain HTTP,
// so it gives the same one-time-cache contract there — and storage reads aren't HTTP
// fetches, so the cache even survives a hard-refresh (which bypasses the HTTP cache).
const IDB_DB = 'uo-art-cache', IDB_STORE = 'files';
function idbOpen() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(IDB_DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
    rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error);
  });
}
function idbPut(db, key, val) {
  return new Promise((resolve, reject) => {
    const rq = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(val, key);
    rq.onsuccess = () => resolve(); rq.onerror = () => reject(rq.error);
  });
}
function idbKeys(db) {
  return new Promise((resolve, reject) => {
    const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
    rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error);
  });
}

// Pick the best persistent art cache ONCE: OPFS in a secure context, else IndexedDB
// (plain-HTTP dev), else null (no persistence — fetch each load as a last resort).
// Uniform interface: { hasAll(), load(), write(name, buf) }. Memoized.
let _artCache;
async function artCache() {
  if (_artCache !== undefined) return _artCache;
  if (navigator.storage && navigator.storage.getDirectory) {
    _artCache = {
      kind: 'opfs',
      hasAll: opfsHasAllArt,
      load: (manifest) => loadFromOpfs(manifest),
      keys: opfsArtKeys,
      sizeOf: opfsSizeOf,
      write: async (f, buf) => { const d = await opfsArtDir(true); await opfsWrite(d, f, buf); },
      readState: async () => {
        try { const fh = await (await opfsArtDir(false)).getFileHandle(ART_STATE_NAME); return parseArtState(await (await fh.getFile()).text()); }
        catch { return new Map(); }
      },
      writeState: async (map) => {
        try { const d = await opfsArtDir(true); await opfsWrite(d, ART_STATE_NAME, new TextEncoder().encode(serializeArtState(map))); } catch {}
      },
    };
    return _artCache;
  }
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await idbOpen();
      _artCache = {
        kind: 'idb',
        hasAll: async () => { try { const keys = new Set(await idbKeys(db)); return UO_FILES.every(f => keys.has(f)); } catch { return false; } },
        load: async () => {
          const keys = await idbKeys(db); let i = 0;
          artStatus('loading cached art…');
          for (const f of keys) {
            const v = await idbGet(db, f); if (!v) continue;
            exports.ClassicUOLoader.WriteUOFile('/uo/' + f, v instanceof Uint8Array ? v : new Uint8Array(v));
            artStatus('loading cached art… ' + (++i) + '/' + keys.length);
          }
        },
        write: (f, buf) => idbPut(db, f, buf),
        keys: async () => { try { return (await idbKeys(db)).filter(k => k !== ART_STATE_NAME); } catch { return []; } },
        sizeOf: async (n) => { try { const v = await idbGet(db, n); return v ? (v.byteLength ?? v.length ?? null) : null; } catch { return null; } },
        readState: async () => { try { const v = await idbGet(db, ART_STATE_NAME); return parseArtState(v ? new TextDecoder().decode(v instanceof Uint8Array ? v : new Uint8Array(v)) : null); } catch { return new Map(); } },
        writeState: async (map) => { try { await idbPut(db, ART_STATE_NAME, new TextEncoder().encode(serializeArtState(map))); } catch {} },
      };
      return _artCache;
    } catch { /* IndexedDB blocked (private mode etc.) — fall through to no-cache */ }
  }
  _artCache = null;
  return _artCache;
}

// Operator-hosted art (Plan W7): the `/uo-data/` server set. Guarded — returns
// false if the path 404s to the SPA fallback (no server art configured), so it
// never crashes and the picker still takes over. On success it ALSO caches every
// file into the persistent store (OPFS or IndexedDB), so the *next* visit loads
// instantly from cache with no re-download — the same one-time cost the picker pays.
// Tier split (sprint 4.1): the client BOOTS on the required tier (~40% of the bytes);
// the recommended tier (the big AnimationFrame*/anim2/anim3/multi set, ~60%) streams in
// the BACKGROUND after the login screen is up. Late-arriving files are OPFS-cached but
// only bind at the next page load (ClassicUO's loaders open files at boot), so when the
// background tier finishes on a first visit we offer a one-click refresh.
const _RECOMMENDED_SET = new Set(UO_FILES_RECOMMENDED.map(n => n.toLowerCase()));
function splitTiers(entries) {
  const priority = [], deferred = [];
  for (const e of entries) (_RECOMMENDED_SET.has(e.name.toLowerCase()) ? deferred : priority).push(e);
  return { priority, deferred };
}

// Parallel fetch pool (sprint 4.2) with byte-accurate progress. Concurrency 3 keeps the
// transient ArrayBuffer footprint bounded (biggest priority file is ~155 MB); files are
// ordered small-first so the bar moves immediately.
async function fetchTier(entries, baseUrl, cache, hash, label) {
  const totalBytes = entries.reduce((s, e) => s + (e.size || 0), 0);
  let doneBytes = 0;
  const fmtMB = (b) => (b / 1048576).toFixed(0);
  const tick = () => artStatus(label + ' ' + fmtMB(doneBytes) + ' / ' + fmtMB(totalBytes) + ' MB');
  tick();
  const queue = [...entries].sort((a, b) => (a.size || 0) - (b.size || 0));
  let failed = null;
  async function worker() {
    for (;;) {
      const entry = queue.shift();
      if (!entry || failed) return;
      let counted = 0;
      const onBytes = (d) => { doneBytes += d; counted += d; tick(); };
      const resetBytes = () => { doneBytes -= counted; counted = 0; };
      try { await fetchValidateWrite(baseUrl, entry, cache, hash, onBytes, resetBytes); }
      catch (e) { failed = e; return; }
      // settle to the manifest size so rounding/missing-stream never skews the bar
      doneBytes += (entry.size || 0) - counted; tick();
    }
  }
  await Promise.all([0, 1, 2].map(worker));
  if (failed) throw failed;
}

async function loadFromDevServer(cache, manifest) {
  try {
    const entries = [...(manifest || new Map()).values()];
    if (!entries.length) return false;
    const baseUrl = new URL('/uo-data/', location.href).href;
    // "(one time)" only when there's a persistent cache to write into; without one we
    // don't over-promise — the fetch would repeat each load.
    const once = cache ? ' (one time)' : '';
    const hash = !!(typeof crypto !== 'undefined' && crypto.subtle);
    const { priority, deferred } = splitTiers(entries);
    await fetchTier(priority, baseUrl, cache, hash, 'downloading art' + once + '…');
    await persistArtState(cache);   // L2: record the first-download validation state
    if (deferred.length) backgroundFetch(deferred, baseUrl, cache, hash);
    return true;
  } catch (e) { _log('[art] dev-server load failed: ' + e); return false; }
}

// Fire-and-forget background download of the recommended tier (extra animations,
// multis). Non-fatal on error — the game is already playable; next visit retries via
// the top-up path. On success we offer a refresh (the running game can't late-bind).
let _bgArtDone = false;
function backgroundFetch(entries, baseUrl, cache, hash) {
  (async () => {
    try {
      await fetchTier(entries, baseUrl, cache, hash, 'extra animations (background)…');
      await persistArtState(cache);   // L2: record the background-tier validation state
      _bgArtDone = true;
      artStatus('');
      _log('[art] background tier complete (' + entries.length + ' files)');
      showRefreshBanner();
    } catch (e) { _log('[art] background tier failed (retries next visit): ' + e); artStatus(''); }
  })();
}
function showRefreshBanner() {
  try {
    let el = document.getElementById('art-refresh-banner');
    if (!el) {
      el = document.createElement('div'); el.id = 'art-refresh-banner';
      el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99998;background:#1f4d2e;color:#fff;' +
        'font:13px/1.4 system-ui,sans-serif;padding:8px 14px;text-align:center;box-shadow:0 -1px 6px rgba(0,0,0,.5)';
      document.body.appendChild(el);
    }
    el.innerHTML = '✓ Extra animations downloaded — <span style="text-decoration:underline;cursor:pointer" ' +
      'onclick="location.reload()">refresh to enable them</span>' +
      ' &nbsp;<span style="text-decoration:underline;cursor:pointer;opacity:.7" onclick="this.parentElement.remove()">later</span>';
  } catch {}
}
// Fetch one art file, verify integrity, then write to /uo + cache. On a size/hash
// mismatch it refetches once cache-bypassed; if it STILL fails the file is corrupt at
// the source and we throw rather than write garbage the game will choke on.
async function fetchValidateWrite(baseUrl, entry, cache, hash, onBytes, resetBytes) {
  let lastBad = null;
  // L2 content-addressed URL: version the request by content hash so a changed
  // file (same name, new bytes) is a distinct browser-cache key — it fetches
  // fresh on the FIRST attempt instead of returning a stale long-cached copy,
  // while unchanged content stays aggressively cacheable. nginx ignores the
  // query for static files.
  const url = baseUrl + entry.name + (entry.sha256 ? '?v=' + entry.sha256.slice(0, 16) : '');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt && resetBytes) resetBytes();   // don't double-count refetched bytes
    const resp = await fetch(url, attempt ? { cache: 'reload' } : undefined);
    if (!resp.ok) throw new Error('fetch ' + entry.name + ' -> ' + resp.status);
    let buf;
    if (onBytes && resp.body) {
      // stream so the progress bar moves DURING big files, not only between them
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
    if (lastBad) { _log('[art] integrity FAIL ' + entry.name + ': ' + lastBad + (attempt ? ' (giving up)' : ' — refetching')); continue; }
    exports.ClassicUOLoader.WriteUOFile('/uo/' + entry.name, buf);
    if (cache) { try { await cache.write(entry.name, buf); } catch {} }
    recordValidated(entry, buf);   // L2: remember the {size,sha256} we just verified
    return;
  }
  throw new Error('art ' + entry.name + ' corrupt after refetch: ' + lastBad);
}

// Incremental top-up after a cache hit: if the /uo-data manifest lists files the cache
// doesn't have yet (e.g. art added to the server set since the last visit), fetch ONLY
// those — so adding art never forces a full multi-hundred-MB re-download. No-ops if the
// dev server isn't serving art or the cache already has everything.
// L2 (D1) content-addressed delta sync after a cache hit. Subsumes the old
// "fetch missing files" top-up AND re-fetches files whose CONTENT changed on the
// server (same name, new sha256/size) — which name-only presence never caught,
// so a shard art update silently never reached cached clients. Required-tier
// gaps/changes block boot (they bind into MEMFS before the engine starts);
// recommended-tier ones stream in the background and bind at the next load.
async function reconcileArt(cache, manifest) {
  if (!cache || !cache.keys || !manifest || !manifest.size) return;
  try {
    const present = new Set(await cache.keys());
    if (_artValidated == null) _artValidated = cache.readState ? await cache.readState() : new Map();
    const { refetch } = await computeArtDelta(manifest, present, _artValidated, cache.sizeOf);
    if (!refetch.length) { await persistArtState(cache); return; }
    const changed = refetch.filter(e => present.has(e.name)).map(e => e.name);
    const missing = refetch.length - changed.length;
    _log('[art] delta: ' + changed.length + ' changed, ' + missing + ' missing → re-syncing' +
      (changed.length ? ' (' + changed.slice(0, 6).join(', ') + (changed.length > 6 ? ', +' + (changed.length - 6) : '') + ')' : ''));
    const baseUrl = new URL('/uo-data/', location.href).href;
    const hash = !!(typeof crypto !== 'undefined' && crypto.subtle);
    const { priority, deferred } = splitTiers(refetch);
    if (priority.length) {
      try { await fetchTier(priority, baseUrl, cache, hash, 'updating art…'); }
      catch (e) { _log('[art] ' + e); }
    }
    await persistArtState(cache);
    if (deferred.length) backgroundFetch(deferred, baseUrl, cache, hash);
  } catch (e) { _log('[art] delta sync failed: ' + e); }
}

async function persistArtState(cache) {
  try { if (cache && cache.writeState && _artValidated) await cache.writeState(_artValidated); } catch {}
}

// First-run folder picker (webkitdirectory — works in Firefox + Chrome, unlike
// showDirectoryPicker). Resolves once the player's art is imported + cached.
function showArtPicker(cache) {
  return new Promise((resolve, reject) => {
    setPhase('awaiting-art');
    const ov = document.createElement('div');
    ov.id = 'art-picker';
    ov.style.cssText = 'position:fixed;inset:0;background:#0b0b0b;color:#ddd;font:14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;z-index:9999';
    ov.innerHTML =
      '<div style="max-width:540px;padding:28px;text-align:center;line-height:1.55">' +
      '<h2 style="color:#fff;font-weight:600;margin:0 0 12px">Load your Ultima Online art</h2>' +
      '<p style="color:#9aa0a6;margin:0 0 18px">This browser client needs the art files from a UO install (T2A&nbsp;/&nbsp;7.0.x). They stay in your browser (OPFS) — you only do this once, and nothing is uploaded.</p>' +
      '<label style="display:inline-block;padding:10px 18px;background:#3b6ea5;color:#fff;border-radius:6px;cursor:pointer">Select your UO folder' +
      '<input id="uo-folder" type="file" webkitdirectory multiple style="display:none"></label>' +
      '<div id="art-status" style="margin-top:16px;color:#9aa0a6;min-height:1.4em"></div></div>';
    document.body.appendChild(ov);
    ov.querySelector('#uo-folder').addEventListener('change', async (ev) => {
      try {
        const byName = new Map();
        for (const file of ev.target.files) byName.set((file.name || '').toLowerCase(), file);
        const missing = UO_FILES_REQUIRED.filter(f => !byName.has(f.toLowerCase()));
        if (missing.length) {
          artStatus('that folder is missing ' + missing.length + ' required file(s) (e.g. ' + missing.slice(0, 3).join(', ') + ') — pick your UO root folder.');
          return;
        }
        // Required + any recommended/optional files the folder actually has (body + item art).
        const toImport = [...new Set(UO_FILES_REQUIRED.concat(UO_FILES_OPTIONAL))].filter(f => byName.has(f.toLowerCase()));
        let i = 0;
        for (const f of toImport) {
          const buf = new Uint8Array(await byName.get(f.toLowerCase()).arrayBuffer());
          if (cache) { try { await cache.write(f, buf); } catch {} }  // persist for next visit
          exports.ClassicUOLoader.WriteUOFile('/uo/' + f, buf);
          artStatus('importing ' + (++i) + '/' + toImport.length + ' (' + f + ')…');
        }
        artStatus('done — starting the client…');
        await validateAndReport(cache, null);   // completeness check (no server manifest to size-verify against)
        ov.remove();
        resolve();
      } catch (e) { artStatus('import failed: ' + ((e && e.message) || e)); reject(e); }
    });
  });
}

// Post-load gate: confirm the loaded set is COMPLETE (every required + recommended file
// present) and, where the manifest provides sizes, intact. Required problems are
// surfaced loudly — console + an on-screen banner — because the alternative (what shipped
// before) is a silent partial load that renders a broken, bodyless world. Downloads are
// already sha256-verified at write time; this pass additionally catches a cache that was
// truncated/evicted under storage pressure, and a server manifest missing required files.
async function validateAndReport(cache, manifest) {
  const present = new Set(cache && cache.keys ? await cache.keys() : []);
  const problems = [];
  for (const n of UO_FILES_REQUIRED) if (!present.has(n)) problems.push({ name: n, level: 'required', why: 'missing' });
  for (const n of UO_FILES_RECOMMENDED) if (!present.has(n)) problems.push({ name: n, level: 'recommended', why: 'missing' });
  if (manifest && cache && cache.sizeOf) {
    for (const [name, entry] of manifest) {
      if (!present.has(name) || entry.size == null) continue;
      const sz = await cache.sizeOf(name);
      if (sz != null && sz !== entry.size) problems.push({ name, level: 'required', why: 'size ' + sz + '≠' + entry.size });
    }
  }
  const req = problems.filter(p => p.level === 'required');
  const rec = problems.filter(p => p.level === 'recommended');
  if (!req.length && !rec.length) {
    _log('[art] ✓ validation OK — ' + present.size + ' files present + size-verified');
  } else {
    _log('[art] ⚠ validation — ' + present.size + ' files, ' + req.length + ' REQUIRED problem(s), ' + rec.length + ' recommended missing');
    for (const p of problems) _log('[art]   ' + (p.level === 'required' ? '✗' : '·') + ' ' + p.name + ': ' + p.why);
  }
  if (req.length) showArtBanner(req);
  return req.length === 0;
}
function showArtBanner(req) {
  try {
    const names = req.slice(0, 6).map(p => p.name + (p.why !== 'missing' ? ' (' + p.why + ')' : '')).join(', ') +
      (req.length > 6 ? ', +' + (req.length - 6) + ' more' : '');
    let el = document.getElementById('art-banner');
    if (!el) {
      el = document.createElement('div'); el.id = 'art-banner';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7a1f1f;color:#fff;' +
        'font:13px/1.4 system-ui,sans-serif;padding:8px 14px;text-align:center;box-shadow:0 1px 6px rgba(0,0,0,.5)';
      document.body.appendChild(el);
    }
    el.innerHTML = '⚠ Art set incomplete — bodies/world may not render. Missing/corrupt: ' + names +
      ' &nbsp;<span style="text-decoration:underline;cursor:pointer" onclick="this.parentElement.remove()">dismiss</span>';
  } catch {}
}

// Persistent cache (OPFS on https, IndexedDB on plain-HTTP dev) -> /uo-data/ server
// -> first-run picker. Never crashes on absent art. The manifest (when the dev server
// provides one) is the integrity contract; every load path validates against it.
// Ask the browser to PROTECT the (1.5 GB) art cache from storage-pressure eviction.
// Chromium grants silently on engaged origins; Firefox may prompt. Best-effort.
async function persistStorage() {
  try {
    if (!(navigator.storage && navigator.storage.persist)) return;
    if (await navigator.storage.persisted()) { _log('[art] storage already persistent'); return; }
    const ok = await navigator.storage.persist();
    _log('[art] storage persist ' + (ok ? 'GRANTED — cache protected from eviction' : 'denied (cache may be evicted under pressure)'));
  } catch {}
}

async function loadArt() {
  const cache = await artCache();
  const manifest = await fetchManifest();
  if (cache && await cache.hasAll()) {
    await cache.load(manifest);
    if (_artValidated == null && cache.readState) _artValidated = await cache.readState();
    persistStorage();
    await reconcileArt(cache, manifest);   // L2: pull missing + re-sync changed files
    await validateAndReport(cache, manifest);          // completeness + integrity gate
    return;
  }
  if (manifest && manifest.size && await loadFromDevServer(cache, manifest)) {
    persistStorage();
    await validateAndReport(cache, manifest);
    return;
  }
  await showArtPicker(cache);
  persistStorage();
}
await loadArt();
// Default settings render the login screen. An optional (gitignored) ./uo-config.json
// overrides them — e.g. a ws:// proxy URL + autologin creds for an end-to-end test.
// `diag_endpoint` (optional) points the beacons at the diag-sidecar /ingest URL.
let settings = {
  ip: "172.16.2.154", port: 2593,
  // clientversion: must be >= the ModernUO shard's clientVerification minimum
  // (7.0.114.65 as of 2026-06) or the server kicks "bad version" ~20s after world
  // entry. The reported version only drives the protocol handshake; ClassicUO speaks
  // the modern protocol fine, and the T2A *content* is the server's expansion, not this.
  ultimaonlinedirectory: "/uo", clientversion: "7.0.114.65",
  lang: "ENU", encryption: 0, use_verdata: false
};
try { settings = Object.assign(settings, await (await fetch('./uo-config.json')).json()); } catch {}
if (settings.diag_endpoint) { diag.endpoint = settings.diag_endpoint; delete settings.diag_endpoint; }
// Decode the login background in the BROWSER (canvas) and hand RGBA to managed —
// both FNA3D's stb_image callbacks and ImageSharp's PNG decoder trap under WASM AOT.
try {
  const bgResp = await fetch('game-background.png');
  if (bgResp.ok) {
    const bmp = await createImageBitmap(await bgResp.blob());
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const px = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    exports.ClassicUOLoader.SetLoginBackground(new Uint8Array(px.buffer.slice(0)), bmp.width, bmp.height);
    console.log('[boot] login background decoded (' + bmp.width + 'x' + bmp.height + ')');
  }
} catch (e) { console.log('[boot] login background decode skipped: ' + e); }

console.log('[boot] UO files written; starting ClassicUO (ip=' + settings.ip + ')');
// A/B lever: ?chunkmesh=1 enables the GPU chunk-mesh renderer for this session
// (off by default in-browser — no rebuild needed for dense-scene perf comparisons).
if (new URLSearchParams(location.search).get('chunkmesh') === '1') {
  try { exports.ClassicUOLoader.SetChunkMeshEnabled(true); console.log('[boot] chunk-mesh renderer ENABLED via ?chunkmesh=1'); }
  catch (e) { console.log('[boot] SetChunkMeshEnabled failed: ' + e); }
}
setPhase('starting');
try {
  // Returns after init now — the main loop is JS-driven (single-threaded WASM AOT can't
  // wire emscripten_set_main_loop's reverse-pinvoke callback). We pump frames below.
  exports.ClassicUOLoader.StartClassicUO(JSON.stringify(settings));
} catch (e) {
  // emscripten simulate_infinite_loop throws "unwind" to hand the stack to rAF — expected.
  if (!('' + e).includes('unwind')) {
    let d = 'ctor=' + (e && e.constructor && e.constructor.name);
    try { d += ' | msg=' + e.message; } catch {}
    try { d += ' | keys=' + Object.getOwnPropertyNames(e).join(','); } catch {}
    try { d += ' | stack=' + String(e.stack).slice(0, 600); } catch {}
    try { const g = globalThis.getDotnetRuntime && globalThis.getDotnetRuntime(0); const M = g && g.Module; if (M && M.getExceptionMessage) d += ' | EH=' + M.getExceptionMessage(e).join('::'); } catch (ee) { d += ' | EHerr=' + ee; }
    _err('[crashdetail] ' + d);
    _fatal('StartClassicUO', e);
  }
}

// Size the FNA backbuffer to the viewport so the canvas fills the page: SDL only listens
// for input on #canvas, so a small top-left canvas let clicks below it land on <html> and
// never reach SDL. Driving the backbuffer from innerWidth/innerHeight keeps it full + 1:1
// with click coords (and re-asserts size if emscripten resets the canvas CSS). Keep the
// canvas focused so SDL's keyboard listener (bound to #canvas) receives keys, not <body>.
{
  const _canvas = document.getElementById('canvas');
  const _resize = () => { try { exports.ClassicUOLoader.SetCanvasSize(window.innerWidth, window.innerHeight); } catch {} };
  const _focus = () => { try { _canvas.focus(); } catch {} };
  _resize(); _focus();
  addEventListener('resize', _resize);
  addEventListener('pointerdown', _focus, true);   // refocus on any click so keystrokes keep landing

  // SDL's emscripten event callbacks don't enqueue discrete events under single-threaded
  // WASM AOT, so JS owns the canvas mouse input and feeds it through JSExports (same bypass
  // as the WebSocket + frame loop). Mouse POSITION is polled SDL-side (it drives the cursor);
  // we inject only the discrete button/wheel. DOM button → SDL button (left 1, middle 2,
  // right 3, x1 4, x2 5).
  const _sdlBtn = b => b === 1 ? 2 : b === 2 ? 3 : b === 3 ? 4 : b === 4 ? 5 : 1;
  _canvas.addEventListener('pointerdown', e => { try { _canvas.setPointerCapture(e.pointerId); } catch {} try { exports.ClassicUOLoader.InjectMouseButton(_sdlBtn(e.button), true); } catch {} });
  _canvas.addEventListener('pointerup',   e => { try { exports.ClassicUOLoader.InjectMouseButton(_sdlBtn(e.button), false); } catch {} });
  // Motion: SDL's emscripten mousemove events are dead under AOT, so the MOUSE_MOTION path
  // (where gump/world dragging runs) never fires from SDL. Feed it on every pointermove so
  // dragging works (the cursor itself follows via Mouse.Update's position poll).
  _canvas.addEventListener('pointermove', () => { try { exports.ClassicUOLoader.InjectMouseMotion(); } catch {} });
  _canvas.addEventListener('contextmenu', e => e.preventDefault());   // right-click goes to the game, not the browser menu

  // ── Touch input (sprint 5.3) ────────────────────────────────────────────────
  // A finger has no SDL-pollable cursor, so JS owns the whole touch gesture and
  // feeds position via InjectMousePosition (Mouse.Update consumes it while a touch
  // sequence is active). Mapping:
  //   tap                → left click   (two fast taps = double-click, ClassicUO's
  //                                      own click timing detects it)
  //   move while held    → WALK: right-button hold toward the finger
  //   stationary ≥550 ms → DRAG: left-button hold (pick up items / move gumps)
  //   second finger tap  → right click (close gumps etc.)
  // Mouse events clear the injected position, so hybrids switch seamlessly.
  {
    const WALK_MOVE_PX = 14, DRAG_HOLD_MS = 550, TAP_MAX_MS = 300;
    let t = null;   // active primary-touch state
    const pos = (e) => { const r = _canvas.getBoundingClientRect(); return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]; };
    const send = (fn, ...a) => { try { exports.ClassicUOLoader[fn](...a); } catch {} };
    const setPos = (e) => { const [x, y] = pos(e); send('InjectMousePosition', x, y); send('InjectMouseMotion'); };
    _canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') { send('SetTouchPointerActive', false); return; }
      e.preventDefault();
      if (t) {   // second finger while one is active → right click
        if (t.mode === 'walk') { send('InjectMouseButton', 3, false); }
        if (t.mode === 'drag') { send('InjectMouseButton', 1, false); }
        t.mode = 'cancelled';
        send('InjectMouseButton', 3, true); send('InjectMouseButton', 3, false);
        return;
      }
      setPos(e);
      t = { id: e.pointerId, t0: performance.now(), mode: 'pending',
            holdTimer: setTimeout(() => {
              if (t && t.mode === 'pending') { t.mode = 'drag'; send('InjectMouseButton', 1, true); }
            }, DRAG_HOLD_MS),
            x0: e.clientX, y0: e.clientY };
      try { _canvas.setPointerCapture(e.pointerId); } catch {}
    }, { passive: false });
    _canvas.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch' || !t || e.pointerId !== t.id || t.mode === 'cancelled') return;
      e.preventDefault();
      setPos(e);
      if (t.mode === 'pending' &&
          Math.hypot(e.clientX - t.x0, e.clientY - t.y0) > WALK_MOVE_PX) {
        clearTimeout(t.holdTimer);
        t.mode = 'walk';
        send('InjectMouseButton', 3, true);   // hold right = walk toward finger
      }
    }, { passive: false });
    const endTouch = e => {
      if (e.pointerType !== 'touch' || !t || e.pointerId !== t.id) return;
      e.preventDefault();
      clearTimeout(t.holdTimer);
      setPos(e);
      if (t.mode === 'walk') send('InjectMouseButton', 3, false);
      else if (t.mode === 'drag') send('InjectMouseButton', 1, false);
      else if (t.mode === 'pending' && performance.now() - t.t0 <= TAP_MAX_MS + DRAG_HOLD_MS) {
        send('InjectMouseButton', 1, true); send('InjectMouseButton', 1, false);
      }
      t = null;
      // keep the injected position one frame so the click lands, then hand back to SDL
      setTimeout(() => { if (!t) send('SetTouchPointerActive', false); }, 50);
    };
    _canvas.addEventListener('pointerup', endTouch, { passive: false });
    _canvas.addEventListener('pointercancel', endTouch, { passive: false });

    // Virtual keyboard for chat on touch devices: a small ⌨ button focuses a hidden
    // input; characters forward through InjectText, Enter/Backspace through InjectKey.
    if (matchMedia('(pointer: coarse)').matches) {
      const kb = document.createElement('button');
      kb.textContent = '⌨';
      kb.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99997;width:46px;height:46px;' +
        'border-radius:50%;border:none;background:#3b6ea5;color:#fff;font-size:22px;opacity:.75';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.style.cssText = 'position:fixed;bottom:-100px;left:0;width:10px;height:10px;opacity:0';
      kb.addEventListener('click', e => { e.preventDefault(); inp.focus(); });
      inp.addEventListener('input', () => {
        if (inp.value) { try { exports.ClassicUOLoader.InjectText(inp.value); } catch {} inp.value = ''; }
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === 'Backspace') {
          const code = e.key === 'Enter' ? 13 : 8;
          try { exports.ClassicUOLoader.InjectKey(code, 0, true); exports.ClassicUOLoader.InjectKey(code, 0, false); } catch {}
          e.preventDefault();
        }
      });
      document.body.appendChild(kb);
      document.body.appendChild(inp);
    }
  }
  _canvas.addEventListener('wheel', e => { try { exports.ClassicUOLoader.InjectMouseWheel(e.deltaY < 0 ? 1 : -1); } catch {} e.preventDefault(); }, { passive: false });

  // Keyboard: SDL's emscripten key callbacks are dead under AOT too, so JS feeds keys in.
  // Every keydown/up sends an SDL key event (special keys map to SDLK_* below); printable
  // chars also fire InjectText so they type into focused fields. JS modifiers → SDL_Keymod.
  const _SDLK = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Delete: 127, ' ': 32,
    ArrowRight: 0x4000004F, ArrowLeft: 0x40000050, ArrowDown: 0x40000051, ArrowUp: 0x40000052,
    Home: 0x4000004A, End: 0x4000004D, PageUp: 0x4000004B, PageDown: 0x4000004E,
    Shift: 0x400000E1, Control: 0x400000E0, Alt: 0x400000E2,
  };
  const _sdlKeycode = e => _SDLK[e.key] !== undefined ? _SDLK[e.key] : (e.key && e.key.length === 1 ? e.key.toLowerCase().charCodeAt(0) : 0);
  const _sdlMod = e => (e.shiftKey ? 0x0003 : 0) | (e.ctrlKey ? 0x00C0 : 0) | (e.altKey ? 0x0300 : 0) | (e.metaKey ? 0x0C00 : 0);
  const _gameKey = e => !e.ctrlKey && !e.metaKey && (e.key.length === 1 || ['Tab', 'Backspace', 'Delete', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key));
  // Track held keys so they can be released on blur — the browser DROPS keyup when the window
  // loses focus (alt-tab / click away), otherwise leaving movement/keys stuck down in-game.
  const _heldKeys = new Map();
  _canvas.addEventListener('keydown', e => {
    try {
      exports.ClassicUOLoader.InjectKey(_sdlKeycode(e), _sdlMod(e), true);
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) exports.ClassicUOLoader.InjectText(e.key);
    } catch {}
    _heldKeys.set(e.key, { kc: _sdlKeycode(e), mod: _sdlMod(e) });
    // Stop the browser stealing keys the game uses (Tab focus-move, Space/arrow scroll, quick-find),
    // but leave Ctrl/Meta/Function combos alone so browser shortcuts (refresh, devtools) still work.
    if (_gameKey(e)) e.preventDefault();
  });
  _canvas.addEventListener('keyup', e => { _heldKeys.delete(e.key); try { exports.ClassicUOLoader.InjectKey(_sdlKeycode(e), _sdlMod(e), false); } catch {} });
  // Window blur (alt-tab, click outside the page) — release every still-held key so nothing sticks.
  addEventListener('blur', () => { for (const k of _heldKeys.values()) { try { exports.ClassicUOLoader.InjectKey(k.kc, k.mod, false); } catch {} } _heldKeys.clear(); });
}

// Off-thread freeze watchdog. The diag setInterval above shares the game's single thread,
// so a HARD wedge (a blocking loop inside one frame) freezes it too — a silent death with no
// self-report. A Web Worker runs on its own thread: the pump pings it each frame with the
// live frame/phase/ring, and if the pings stop for >4s the Worker reports the freeze — to its
// own console (which still surfaces in DevTools while the main thread is frozen) and to
// /ingest if configured — with the last-known state. Silent wedges become diagnosable.
function _wdPing() {
  if (!_wd) return;
  try { _wd.postMessage({ t: 'hb', frame: diag.frame, phase: diag.phase, endpoint: diag.endpoint, build: diag.build_sha, hidden: (typeof document!=='undefined'&&document.hidden), vis: (typeof document!=='undefined'?document.visibilityState:'?'), ring: _ring.slice(-15) }); } catch {}
}
try {
  const _wdSrc =
    "let last=Date.now(),s={},step='?',fired=false;" +
    "onmessage=function(e){var d=e.data;if(d){if(d.t==='hb'){last=Date.now();s=d;fired=false;}else if(d.t==='step'){last=Date.now();step=d.s;fired=false;}}};" +
    "setInterval(function(){var dt=Date.now()-last;" +
    "if(!fired&&dt>4000){fired=true;" +
    "console.error('[FREEZE] main thread wedged '+dt+'ms — STEP='+step+' — frame '+s.frame+' phase '+s.phase+' hidden='+s.hidden+' vis='+s.vis+' (build '+s.build+')\\n--- last log lines ---\\n'+((s.ring||[]).join('\\n')));" +
    "if(s.endpoint){try{fetch(s.endpoint,{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'freeze',since_ms:dt,frozen_step:step,frozen_frame:s.frame,frozen_phase:s.phase,build_sha:s.build,ring:s.ring||[]})}).catch(function(){});}catch(_){}}}" +
    "},1000);";
  _wd = new Worker(URL.createObjectURL(new Blob([_wdSrc], { type: 'application/javascript' })));
  _wdPing();
  // Throttle-immune heartbeat. The per-frame _wdPing (in the rAF pump) STOPS when the tab is
  // backgrounded (browsers pause rAF), which fired FALSE [FREEZE]s every time a test tab lost
  // focus. A timer still fires on a backgrounded-but-idle thread (clamped to ~1s, well under the
  // 4s threshold) but CANNOT fire on a truly wedged thread — so [FREEZE] now signals only real
  // main-thread wedges, not tab throttling.
  setInterval(() => { try { _wdPing(); } catch {} }, 1000);
} catch (e) { _log('[diag] freeze watchdog unavailable: ' + e); }

// Drive FNA's frame loop from requestAnimationFrame. RESILIENT: one bad frame (an exception
// in a single Update/Draw) is logged + beaconed and SKIPPED — the pump keeps running rather
// than dying. Only SUSTAINED failure trips the circuit breaker and stops us, so a transient
// glitch can't kill the client and a recurring one can't flood the log. TickFrame() returns
// false on a clean game exit.
// Perf telemetry (sprint 6.2): every 5 minutes in-game, ship the tick-time
// distribution as a beacon — Grafana trends p95 per session and alerts on
// regressions against the Sprint-2 baseline (p95 ~2 ms, budget 16.7 ms).
setInterval(() => {
  try {
    if (diag.phase !== 'rendering' || !window.__cuoTickStats) return;
    const t = window.__cuoTickStats();
    if (t && t.n) beacon('perf', { tick_mean: +t.mean.toFixed(2), tick_p50: +t.p50.toFixed(2),
                                   tick_p95: +t.p95.toFixed(2), tick_max: +t.max.toFixed(2), n: t.n });
  } catch {}
}, 300000);

console.log('[boot] starting rAF frame pump');
let _consecErrors = 0;
const _MAX_CONSEC_ERRORS = 30;   // ~0.5s of unbroken failure before we give up
// Per-tick wall-time stats (perf baseline instrument — sprint plan 2b). Ring of the
// last 600 tick durations; window.__cuoTickStats() returns {n, mean, p50, p95, max}.
const _tickDur = new Float32Array(600);
let _tickDurN = 0, _tickDurI = 0;
window.__cuoTickStats = function () {
  const n = Math.min(_tickDurN, _tickDur.length);
  if (!n) return { n: 0 };
  const a = Array.from(_tickDur.slice(0, n)).sort((x, y) => x - y);
  const q = (f) => a[Math.min(n - 1, Math.floor(f * n))];
  return { n, mean: a.reduce((s, v) => s + v, 0) / n, p50: q(0.5), p95: q(0.95), max: a[n - 1] };
};
function _pump() {
  let alive = true;
  try {
    const _t0 = performance.now();
    alive = exports.ClassicUOLoader.TickFrame();
    _tickDur[_tickDurI] = performance.now() - _t0;
    _tickDurI = (_tickDurI + 1) % _tickDur.length;
    _tickDurN++;
    _consecErrors = 0;           // a clean frame resets the breaker
  } catch (e) {
    if (('' + e).includes('unwind')) { requestAnimationFrame(_pump); return; }
    diag.frameErrors = (diag.frameErrors || 0) + 1;
    _consecErrors++;
    if (_consecErrors <= 2 || _consecErrors === _MAX_CONSEC_ERRORS)   // first of a burst + the trip
      _log('[frame-error] #' + diag.frameErrors + ' at frame ' + diag.frame + ' (consec ' + _consecErrors + '): ' + ((e && e.stack) || e));
    if (_consecErrors === 1)
      beacon('frame-error', { frame: diag.frame, message: String((e && e.message) || e), stack: (e && e.stack) || '', wasm_frames: wasmFrames((e && e.stack) || ''), ring: _ring.slice(-20) });
    if (_consecErrors >= _MAX_CONSEC_ERRORS) {
      _fatal('TickFrame-persistent@' + diag.frame, e);   // sustained failure — stop cleanly
      return;
    }
    // otherwise fall through: skip this frame, keep the loop alive
  }
  diag.frame++; diag.lastTickTs = performance.now();
  if ((diag.frame & 7) === 0) _wdPing();                  // heartbeat the freeze watchdog (~every 8 frames)
  if (diag.frame === 1) { console.log('[boot] first frame ticked'); _wdPing(); }
  if (alive) requestAnimationFrame(_pump);
  else { console.log('[boot] game exited; rAF pump stopped after ' + diag.frame + ' frames'); beacon('exit', { frames: diag.frame }); }
}
requestAnimationFrame(_pump);

// Expose for console poking + the diag-sidecar / BugPin hooks.
window.UO_diag = diag;
