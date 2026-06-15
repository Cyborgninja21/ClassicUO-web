// L6 (D5) mod loader/SDK tests.  run: node build-wasm/loader/tests/mod-loader.test.mjs
import { resolveModSpecs, loadMods, makeModContext } from '../wwwroot/mod-loader.js';
import { PluginHost } from '../wwwroot/plugin-host.js';
import { mod as sampleMod } from '../wwwroot/mods/sample-stats.mod.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const u8 = (...a) => new Uint8Array(a);

// ── resolveModSpecs: config + ?mods=, order + de-dupe ────────────────────────
ok(JSON.stringify(resolveModSpecs(null, '')) === '[]', 'no config/query → no mods');
ok(JSON.stringify(resolveModSpecs({ mods: ['a', 'b'] }, '')) === '["a","b"]', 'config.mods');
ok(JSON.stringify(resolveModSpecs({ mods: ['a'] }, '?mods=b,c')) === '["a","b","c"]', 'config + query append');
ok(JSON.stringify(resolveModSpecs({ mods: ['a'] }, '?mods=a,b')) === '["a","b"]', 'de-dupe across sources');

// ── loadMods: registers plugin + runs onLoad(ctx), with a mock importer ──────
PluginHost._reset();
const ctx = makeModContext({ k: 1 }, null);
const seen = [];
const importer = async (spec) => {
  if (spec === './good.js') return { mod: { name: 'good', version: '2.0', plugin: { name: 'gp', onPacketIn: (p) => p }, async onLoad(c) { seen.push(c.config.k); } } };
  if (spec === './nodesc.js') return { something: 1 };               // no mod/default export
  if (spec === './boom.js') throw new Error('import failed');         // import fails
  return undefined;
};
let loaded = await loadMods(['./good.js', './nodesc.js'], ctx, importer);
ok(loaded.length === 1 && loaded[0].name === 'good' && loaded[0].version === '2.0', 'loads the valid mod, skips the no-export one');
ok(PluginHost.count() === 1 && PluginHost.list()[0] === 'gp', "mod's plugin auto-registered");
ok(seen[0] === 1, 'onLoad got the mod context (config)');

// a mod whose import throws is isolated (others still load)
PluginHost._reset();
loaded = await loadMods(['./boom.js', './good.js'], ctx, importer);
ok(loaded.length === 1 && loaded[0].name === 'good', 'a throwing import is skipped; later mods still load');

// default-export mods work too
PluginHost._reset();
loaded = await loadMods(['./def.js'], ctx, async () => ({ default: { name: 'd', plugin: { name: 'dp' } } }));
ok(loaded.length === 1 && PluginHost.list()[0] === 'dp', 'default export mod loads');

// ── makeModContext.writeArt routes to the engine ─────────────────────────────
let wrote = null;
const fakeExports = { ClassicUOLoader: { WriteUOFile: (path, bytes) => { wrote = { path, len: bytes.length }; } } };
const ctx2 = makeModContext({}, fakeExports);
ok(ctx2.writeArt('gump.def', u8(1, 2, 3)) === true && wrote.path === '/uo/gump.def' && wrote.len === 3, 'ctx.writeArt overrides a file in the engine');
ok(makeModContext({}, null).writeArt('x', u8(1)) === false, 'writeArt safe-fails with no engine');

// ── the REAL sample mod loads + works end-to-end ─────────────────────────────
PluginHost._reset();
loaded = await loadMods(['./mods/sample-stats.mod.js'], makeModContext({ sampleStats: { foo: 1 } }, null), async () => ({ mod: sampleMod }));
ok(loaded.length === 1 && loaded[0].name === 'sample-stats', 'sample mod loads');
ok(PluginHost.count() === 1, 'sample mod registered its plugin');
PluginHost.fire('connect');
for (let i = 0; i < 3; i++) PluginHost.packetIn(u8(0x11, i));
ok(PluginHost.packetIn(u8(0x22))[0] === 0x22, 'sample mod passes packets through (observation-only)');
ok(sampleMod.plugin._n === 4, 'sample mod plugin counted the inbound packets');

console.log(`\nmod-loader: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
