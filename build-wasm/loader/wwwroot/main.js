// Boot the ClassicUO-web WASM client (single-threaded), library mode.
// UO art is fetched in JS and written to MEMFS via a synchronous JSExport (AOT-safe).
import { dotnet } from './_framework/dotnet.js'
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
console.log('[boot] UO files written; starting ClassicUO');
try {
  exports.ClassicUOLoader.StartClassicUO('/uo', '7.0.95.0', '172.16.2.154', 2593);
} catch (e) {
  // emscripten_set_main_loop(simulate_infinite_loop=1) throws "unwind" to hand the
  // stack to the rAF loop — expected, not an error. Anything else is real.
  if (!('' + e).includes('unwind')) console.error('[boot] ERROR', e);
}
