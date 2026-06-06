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
const _log = console.log.bind(console);
console.log = (...a) => {
  let line = '';
  try {
    line = a.join(' ');
    _ring.push(line); if (_ring.length > 80) _ring.shift();
    if (!line.startsWith('[phase] ')) {            // avoid recursion on our own emit
      const m = line.match(/\[phase\]\s+(\S+)/);
      if (m) { diag.phase = m[1]; diag.phaseTs = performance.now(); }
      else for (const [sig, ph] of PHASE_SIGNALS) if (line.includes(sig)) { setPhase(ph); break; }
    }
  } catch {}
  _log(...a);
};

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
_log('[boot] build ' + diag.build_sha + ' session ' + diag.session);

const { getAssemblyExports, getConfig, setModuleImports } = await dotnet.create();
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
const base = new URL('/uo-data/', location.href).href;
const files = await (await fetch('/uo-data/manifest.json')).json();
for (const f of files) {
  if (f === 'manifest.json') continue;
  const buf = new Uint8Array(await (await fetch(base + f)).arrayBuffer());
  exports.ClassicUOLoader.WriteUOFile('/uo/' + f, buf);
}
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
