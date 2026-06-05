// Boot the ClassicUO-web WASM client (single-threaded). Library mode: never
// call dotnet.run() (it exits on Main return) — call exports directly so the
// runtime stays alive for FNA's emscripten main loop.
import { dotnet } from './_framework/dotnet.js'
try {
  const { getAssemblyExports, getConfig } = await dotnet.create();
  const exports = await getAssemblyExports(getConfig().mainAssemblyName);
  exports.ClassicUOLoader.Init();
  console.log('[boot] starting ClassicUO');
  exports.ClassicUOLoader.StartClassicUO();
} catch (e) {
  console.log('[boot] ERROR ' + (e && e.stack ? e.stack : e));
}
