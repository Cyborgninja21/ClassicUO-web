// Minimal boot for the ClassicUO-web WASM loader (single-threaded).
// Smoke stage: just run managed Main. Next stages add OPFS mount + FNA/ClassicUO start.
import { dotnet } from './_framework/dotnet.js'
try {
  await dotnet.create();
  await dotnet.run();
  console.log('[boot] dotnet.run() returned');
} catch (e) {
  console.log('[boot] ERROR ' + e);
}
