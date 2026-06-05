// Boot the ClassicUO-web WASM client (single-threaded), library mode.
import { dotnet } from './_framework/dotnet.js'
try {
  const { getAssemblyExports, getConfig } = await dotnet.create();
  const exports = await getAssemblyExports(getConfig().mainAssemblyName);
  exports.ClassicUOLoader.Init();
  const files = await (await fetch('/uo-data/manifest.json')).json();
  const base = new URL('/uo-data/', location.href).href;   // absolute (wasm HttpClient needs it)
  console.log('[boot] preloading ' + files.length + ' UO files from ' + base);
  await exports.ClassicUOLoader.PreloadUO(base, files);
  console.log('[boot] starting ClassicUO');
  exports.ClassicUOLoader.StartClassicUO('/uo', '7.0.95.0', '172.16.2.154', 2593);
} catch (e) {
  console.log('[boot] ERROR ' + (e && e.stack ? e.stack : e));
}
