// L6 (D5) — in-browser content-mod SDK + loader.
//
// A "mod" is an ES module the client dynamic-imports at boot. It is the
// content-mod layer on top of the D3 plugin host (behaviour) + the D1/D2 art
// pipeline (assets). The module's default (or named `mod`) export is:
//   {
//     name, version,
//     plugin,                 // optional: a D3 plugin object (auto-registered)
//     async onLoad(ctx),      // optional: arbitrary setup; gets the mod context
//   }
// The context handed to onLoad:
//   ctx = {
//     plugins,                // the PluginHost (register more plugins, send, …)
//     config,                 // the merged uo-config.json (mod settings live here)
//     writeArt(name, bytes),  // override an art file in the live engine (gump/art/…)
//     log(msg),
//   }
// Mods are listed in uo-config.json `mods: ["./mods/foo.mod.js", …]` or via the
// URL `?mods=<url>,<url>`. A mod that fails to import/load is isolated + skipped
// (it never blocks boot or the other mods). Everything a mod can do goes through
// the host/art seams — it never touches the wasm engine directly.

import { PluginHost } from './plugin-host.js';

// Resolve the mod list from config + the URL query (query appends to config).
export function resolveModSpecs(config, search) {
  const out = [];
  const fromCfg = config && Array.isArray(config.mods) ? config.mods : [];
  for (const s of fromCfg) if (s) out.push(String(s));
  try {
    const q = new URLSearchParams(search || '');
    const m = q.get('mods');
    if (m) for (const s of m.split(',')) if (s.trim()) out.push(s.trim());
  } catch {}
  // de-dupe, preserve order
  return [...new Set(out)];
}

// Load every mod spec. `importer` is injectable for tests (defaults to dynamic
// import). `ctx` is the mod context (without `log`, which is added per-mod).
// Returns the list of successfully-loaded mod descriptors.
export async function loadMods(specs, ctx, importer) {
  const imp = importer || ((u) => import(/* @vite-ignore */ u));
  const loaded = [];
  for (const spec of specs || []) {
    try {
      const mod = await imp(spec);
      const desc = (mod && (mod.mod || mod.default)) || null;
      if (!desc || typeof desc !== 'object') { _warn(spec, 'no mod/default export'); continue; }
      const name = desc.name || spec;
      const modCtx = Object.assign({}, ctx, { log: (m) => _log(name, m) });
      if (desc.plugin) PluginHost.register(desc.plugin);
      if (typeof desc.onLoad === 'function') await desc.onLoad(modCtx);
      _log(name, 'loaded' + (desc.version ? ' v' + desc.version : ''));
      loaded.push({ name, version: desc.version || null, spec, plugin: !!desc.plugin });
    } catch (e) { _warn(spec, e); }
  }
  return loaded;
}

// Build the mod context the loader passes in. `writeArt` overrides a file in the
// running engine (the same WriteUOFile path the art loader uses), so a content
// mod can replace gump/art/cliloc bytes at load. `exportsRef` is the engine
// exports object ({ ClassicUOLoader }).
export function makeModContext(config, exportsRef) {
  return {
    plugins: PluginHost,
    config: config || {},
    writeArt(name, bytes) {
      try {
        if (!exportsRef || !exportsRef.ClassicUOLoader || !exportsRef.ClassicUOLoader.WriteUOFile) return false;
        exportsRef.ClassicUOLoader.WriteUOFile('/uo/' + name, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        return true;
      } catch { return false; }
    },
  };
}

function _log(name, m) { try { (globalThis.console && console.log) && console.log('[mod:' + name + '] ' + m); } catch {} }
function _warn(spec, e) { try { (globalThis.console && console.warn) && console.warn('[mod] ' + spec + ' failed: ' + e); } catch {} }
