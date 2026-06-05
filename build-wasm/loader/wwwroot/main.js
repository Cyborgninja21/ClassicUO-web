// Boot the ClassicUO-web WASM client (single-threaded), library mode.
// UO art is fetched in JS and written to MEMFS via a synchronous JSExport (AOT-safe).
import { dotnet } from './_framework/dotnet.js'

// --- debug capture: keep a ring of recent log lines; on ANY uncaught error/rejection
// dump the stack + recent context. Hard wasm traps ("memory access out of bounds")
// otherwise print with no stack — this is how you get one. See DEBUGGING.md.
const _ring = [];
const _log = console.log.bind(console);
console.log = (...a) => { try { _ring.push(a.join(' ')); if (_ring.length > 60) _ring.shift(); } catch {} _log(...a); };
function _fatal(tag, e) {
  const stack = (e && (e.stack || e.message)) || String(e);
  _log(`[fatal] ${tag}: ${stack}\n--- last ${Math.min(_ring.length,20)} log lines ---\n${_ring.slice(-20).join('\n')}\n--- end ---`);
}
addEventListener('error', e => _fatal('window.onerror', e.error || e));
addEventListener('unhandledrejection', e => _fatal('unhandledrejection', e.reason));

const { getAssemblyExports, getConfig } = await dotnet.create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName);
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
let settings = {
  ip: "172.16.2.154", port: 2593,
  ultimaonlinedirectory: "/uo", clientversion: "7.0.95.0",
  lang: "ENU", encryption: 0, use_verdata: false
};
try { settings = Object.assign(settings, await (await fetch('./uo-config.json')).json()); } catch {}
console.log('[boot] UO files written; starting ClassicUO (ip=' + settings.ip + ')');
try {
  exports.ClassicUOLoader.StartClassicUO(JSON.stringify(settings));
} catch (e) {
  // emscripten simulate_infinite_loop throws "unwind" to hand the stack to rAF — expected.
  if (!('' + e).includes('unwind')) _fatal('StartClassicUO', e);
}
