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

console.log = (...a) => { _captureLine(_join(a)); _log(...a); };
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
const _NATIVE_INFO = /^(FNA3D Driver:|OpenGL (Renderer|Driver|Vendor):)/;
function _printErr(line) {
  const s = typeof line === 'string' ? line : String(line);
  _captureLine(s);
  if (_NATIVE_INFO.test(s)) { _info(s); return; }
  _err(s);
}

const { getAssemblyExports, getConfig, setModuleImports } =
  await dotnet.withModuleConfig({ printErr: _printErr }).create();
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
exports.ClassicUOLoader.Init();
exports.ClassicUOLoader.MkUODir();

// ===========================================================================
// UO art onboarding (plan §W5). UO art is EA-owned and NOT shipped — the player
// supplies it once from a UO install (T2A / 7.0.x). It's cached in OPFS (persists
// across sessions), so the folder picker only shows the first time. Dev keeps the
// /uo-data/ server fallback so the harness e2e needs no picker. Nothing is uploaded.
// ===========================================================================
const UO_FILES = [
  "AnimationSequence.uop", "Body.def", "Bodyconv.def", "Cliloc.enu", "MainMisc.uop",
  "MultiCollection.uop", "Prof.txt", "Professn.enu", "Skills.idx", "Sound.def", "art.def",
  "artLegacyMUL.uop", "fonts.mul", "gump.def", "gumpartLegacyMUL.uop", "hues.mul", "light.mul",
  "lightidx.mul", "map0LegacyMUL.uop", "mobtypes.txt", "radarcol.mul", "skills.mul", "speech.mul",
  "staidx0.mul", "statics0.mul", "string_dictionary.uop", "texidx.mul", "texmaps.mul", "tileart.uop",
  "tiledata.mul", "unifont.mul", "unifont1.mul", "unifont2.mul", "unifont3.mul",
];
// Optional — loaded if the player's folder/cache has them (mobiles/items render with
// these; the world still loads without them, just no animations). Not required by the
// picker so partial installs work; the render loop skips anything it can't draw.
const UO_FILES_OPTIONAL = [
  "AnimationFrame1.uop", "AnimationFrame2.uop", "AnimationFrame3.uop", "AnimationFrame4.uop",
  "anim.mul", "anim.idx", "anim2.mul", "anim2.idx", "anim3.mul", "anim3.idx",
  "multi.mul", "multi.idx", "Multimap.rle", "verdata.mul",
];

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

async function loadFromOpfs() {
  artStatus('loading cached art…');
  const dir = await opfsArtDir(false);
  // Load everything cached (required + any optional the player provided).
  const names = [];
  for await (const [name, handle] of dir.entries()) if (handle.kind === 'file') names.push(name);
  let i = 0;
  for (const f of names) {
    const buf = new Uint8Array(await (await (await dir.getFileHandle(f)).getFile()).arrayBuffer());
    exports.ClassicUOLoader.WriteUOFile('/uo/' + f, buf);
    artStatus('loading cached art… ' + (++i) + '/' + names.length);
  }
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
      load: loadFromOpfs,
      write: async (f, buf) => { const d = await opfsArtDir(true); await opfsWrite(d, f, buf); },
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
async function loadFromDevServer(cache) {
  try {
    const r = await fetch('/uo-data/manifest.json');
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return false;
    const list = (await r.json()).filter(f => f && f !== 'manifest.json');
    if (!list.length) return false;
    const baseUrl = new URL('/uo-data/', location.href).href;
    // "(one time)" only when there's a persistent cache to write into; without one we
    // don't over-promise — the fetch would repeat each load.
    const once = cache ? ' (one time)' : '';
    artStatus('downloading art' + once + '…');
    let i = 0;
    for (const f of list) {
      const resp = await fetch(baseUrl + f);
      if (!resp.ok) throw new Error('art fetch ' + f + ' -> ' + resp.status);
      const buf = new Uint8Array(await resp.arrayBuffer());
      exports.ClassicUOLoader.WriteUOFile('/uo/' + f, buf);
      if (cache) { try { await cache.write(f, buf); } catch {} }  // cache for next visit
      artStatus('downloading art' + once + '… ' + (++i) + '/' + list.length + ' (' + f + ')');
    }
    return true;
  } catch { return false; }
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
        const missing = UO_FILES.filter(f => !byName.has(f.toLowerCase()));
        if (missing.length) {
          artStatus('that folder is missing ' + missing.length + ' file(s) (e.g. ' + missing.slice(0, 3).join(', ') + ') — pick your UO root folder.');
          return;
        }
        // Required + any optional files the folder actually has (mobiles/items art).
        const toImport = UO_FILES.concat(UO_FILES_OPTIONAL.filter(f => byName.has(f.toLowerCase())));
        let i = 0;
        for (const f of toImport) {
          const buf = new Uint8Array(await byName.get(f.toLowerCase()).arrayBuffer());
          if (cache) { try { await cache.write(f, buf); } catch {} }  // persist for next visit
          exports.ClassicUOLoader.WriteUOFile('/uo/' + f, buf);
          artStatus('importing ' + (++i) + '/' + toImport.length + ' (' + f + ')…');
        }
        artStatus('done — starting the client…');
        ov.remove();
        resolve();
      } catch (e) { artStatus('import failed: ' + ((e && e.message) || e)); reject(e); }
    });
  });
}

// Persistent cache (OPFS on https, IndexedDB on plain-HTTP dev) -> /uo-data/ server
// -> first-run picker. Never crashes on absent art.
async function loadArt() {
  const cache = await artCache();
  if (cache && await cache.hasAll()) { await cache.load(); return; }
  if (await loadFromDevServer(cache)) return;
  await showArtPicker(cache);
}
await loadArt();
// Default settings render the login screen. An optional (gitignored) ./uo-config.json
// overrides them — e.g. a ws:// proxy URL + autologin creds for an end-to-end test.
// `diag_endpoint` (optional) points the beacons at the diag-sidecar /ingest URL.
let settings = {
  ip: "172.16.2.154", port: 2593,
  ultimaonlinedirectory: "/uo", clientversion: "7.0.95.0",
  lang: "ENU", encryption: 0, use_verdata: false
};
try { settings = Object.assign(settings, await (await fetch('./uo-config.json')).json()); } catch {}
if (settings.diag_endpoint) { diag.endpoint = settings.diag_endpoint; delete settings.diag_endpoint; }
console.log('[boot] UO files written; starting ClassicUO (ip=' + settings.ip + ')');
setPhase('starting');
try {
  // Returns after init now — the main loop is JS-driven (single-threaded WASM AOT can't
  // wire emscripten_set_main_loop's reverse-pinvoke callback). We pump frames below.
  exports.ClassicUOLoader.StartClassicUO(JSON.stringify(settings));
} catch (e) {
  // emscripten simulate_infinite_loop throws "unwind" to hand the stack to rAF — expected.
  if (!('' + e).includes('unwind')) _fatal('StartClassicUO', e);
}

// Drive FNA's frame loop from requestAnimationFrame. TickFrame() runs one Update+Draw
// and returns false once the game exits, at which point we stop the pump.
console.log('[boot] starting rAF frame pump');
function _pump() {
  let alive = true;
  try {
    alive = exports.ClassicUOLoader.TickFrame();
  } catch (e) {
    if (('' + e).includes('unwind')) { requestAnimationFrame(_pump); return; }
    _fatal('TickFrame@' + diag.frame, e);
    return;
  }
  diag.frame++; diag.lastTickTs = performance.now();
  if (diag.frame === 1) console.log('[boot] first frame ticked');
  if (alive) requestAnimationFrame(_pump);
  else { console.log('[boot] game exited; rAF pump stopped after ' + diag.frame + ' frames'); beacon('exit', { frames: diag.frame }); }
}
requestAnimationFrame(_pump);

// Expose for console poking + the diag-sidecar / BugPin hooks.
window.UO_diag = diag;
