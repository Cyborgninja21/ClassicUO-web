// A3 (L1) launcher tests — shard preset resolution + picker→endpoint wiring.
//   run: node build-wasm/loader/tests/shard-presets.test.mjs
import {
  SHARD_PRESETS, buildPresets, findPreset, resolveShard, shardStorageValue, SHARD_STORAGE_KEY,
} from '../wwwroot/shard-presets.js';
import { shouldShowPicker } from '../wwwroot/server-picker.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, m + ' (got ' + JSON.stringify(a) + ')');

// ── built-in presets ─────────────────────────────────────────────────────────
ok(SHARD_PRESETS.length >= 2, 'at least two built-in shards');
{
  const t2a = findPreset(SHARD_PRESETS, 't2a'), ej = findPreset(SHARD_PRESETS, 'ej');
  ok(t2a && /utumno-uo-t2a/.test(t2a.ws), 't2a preset points at the t2a relay host');
  ok(ej && /utumno-uo-ej/.test(ej.ws), 'ej preset points at the ej relay host');
  ok(t2a.ws.startsWith('wss://') && ej.ws.startsWith('wss://'), 'preset relays are wss://');
}

// ── findPreset (case-insensitive, miss → null) ───────────────────────────────
eq(findPreset(SHARD_PRESETS, 'T2A').id, 't2a', 'findPreset case-insensitive');
ok(findPreset(SHARD_PRESETS, 'nope') === null, 'findPreset miss → null');
ok(findPreset(SHARD_PRESETS, null) === null, 'findPreset null id → null');

// ── buildPresets (config merge + override) ───────────────────────────────────
{
  const merged = buildPresets({ shards: [{ id: 't2a', ws: 'wss://override/uo-ws' }, { id: 'new', name: 'New', ws: 'wss://new/uo-ws' }] });
  eq(findPreset(merged, 't2a').ws, 'wss://override/uo-ws', 'config overrides a built-in preset endpoint');
  ok(findPreset(merged, 'ej'), 'un-overridden built-in survives the merge');
  ok(findPreset(merged, 'new'), 'config-only shard is appended');
  eq(buildPresets(null).length, SHARD_PRESETS.length, 'no config → built-ins unchanged');
}

// ── resolveShard precedence ──────────────────────────────────────────────────
{
  // 7 — default (no query / store / config) → t2a
  let r = resolveShard(SHARD_PRESETS, null, '', null);
  eq(r.id, 't2a', 'default shard is t2a');
  eq(r.ip, findPreset(SHARD_PRESETS, 't2a').ws, 'default ip is the t2a relay');
  ok(r.custom === false, 'default is not custom');

  // 2 — ?shard= picks a preset
  r = resolveShard(SHARD_PRESETS, null, '?shard=ej', null);
  eq(r.id, 'ej', '?shard=ej resolves the ej preset');
  eq(r.ip, findPreset(SHARD_PRESETS, 'ej').ws, 'ej ip is the ej relay');

  // 1 — ?server= (custom) beats ?shard=
  r = resolveShard(SHARD_PRESETS, null, '?shard=ej&server=wss://custom.example/uo-ws', null);
  ok(r.custom === true, '?server= yields a custom endpoint');
  eq(r.ip, 'wss://custom.example/uo-ws', 'custom endpoint ip is the raw URL');

  // non-ws ?server= is ignored → falls through to ?shard=
  r = resolveShard(SHARD_PRESETS, null, '?shard=ej&server=http://nope', null);
  eq(r.id, 'ej', 'non-ws ?server= ignored, ?shard= wins');

  // 3 — persisted preset id
  r = resolveShard(SHARD_PRESETS, null, '', 'ej');
  eq(r.id, 'ej', 'persisted preset id resolves');
  // 3 — persisted custom
  r = resolveShard(SHARD_PRESETS, null, '', 'custom:wss://saved.example/uo-ws');
  ok(r.custom === true && r.ip === 'wss://saved.example/uo-ws', 'persisted custom: endpoint resolves');

  // query beats store
  r = resolveShard(SHARD_PRESETS, null, '?shard=t2a', 'ej');
  eq(r.id, 't2a', 'query shard beats persisted store');

  // 4 — config.shard
  r = resolveShard(SHARD_PRESETS, { shard: 'ej' }, '', null);
  eq(r.id, 'ej', 'config.shard selects a preset');
  // 5 — config.shard_url custom
  r = resolveShard(SHARD_PRESETS, { shard_url: 'wss://cfg.example/uo-ws' }, '', null);
  ok(r.custom === true && r.ip === 'wss://cfg.example/uo-ws', 'config.shard_url → custom endpoint');
  // 6 — legacy config.ip ws URL (back-compat)
  r = resolveShard(SHARD_PRESETS, { ip: 'wss://legacy.example/uo-ws' }, '', null);
  ok(r.custom === true && r.ip === 'wss://legacy.example/uo-ws', 'legacy ws ip → custom endpoint');
  // legacy non-ws ip is NOT treated as a relay (old raw-host default) → default shard
  r = resolveShard(SHARD_PRESETS, { ip: '172.16.2.154' }, '', null);
  eq(r.id, 't2a', 'legacy raw-host ip ignored → default shard');

  // store beats config
  r = resolveShard(SHARD_PRESETS, { shard: 't2a' }, '', 'ej');
  eq(r.id, 'ej', 'persisted store beats config.shard');
}

// ── shardStorageValue (round-trips back through resolveShard) ─────────────────
{
  const preset = resolveShard(SHARD_PRESETS, null, '?shard=ej', null);
  eq(shardStorageValue(preset), 'ej', 'preset stores as its id');
  ok(resolveShard(SHARD_PRESETS, null, '', shardStorageValue(preset)).id === 'ej', 'stored preset id round-trips');

  const custom = resolveShard(SHARD_PRESETS, null, '?server=wss://c.example/uo-ws', null);
  eq(shardStorageValue(custom), 'custom:wss://c.example/uo-ws', 'custom stores as custom:<url>');
  const back = resolveShard(SHARD_PRESETS, null, '', shardStorageValue(custom));
  ok(back.custom && back.ip === 'wss://c.example/uo-ws', 'stored custom round-trips');
}

// ── endpoint record feeds the transport path (wtUrl/wtCertUrl) ───────────────
{
  const presets = buildPresets({ shards: [{ id: 'wt', name: 'WT', ws: 'wss://wt.example/uo-ws', wt: 'https://wt.example:4433/wt', wtCert: 'https://wt.example/wt-cert/cert-hash' }] });
  const r = resolveShard(presets, null, '?shard=wt', null);
  eq(r.ip, 'wss://wt.example/uo-ws', 'shard ip drives settings.ip');
  eq(r.wtUrl, 'https://wt.example:4433/wt', 'shard wt drives _transportOpts.wtUrl');
  eq(r.wtCertUrl, 'https://wt.example/wt-cert/cert-hash', 'shard wtCert drives _transportOpts.wtCertUrl');
  // a custom endpoint carries no WebTransport pin
  const c = resolveShard(presets, null, '?server=wss://x/uo-ws', null);
  ok(c.wtUrl === null && c.wtCertUrl === null, 'custom endpoint has no WebTransport endpoints');
}

// ── shouldShowPicker (picker visibility policy) ──────────────────────────────
eq(SHARD_STORAGE_KEY, 'uo-shard', 'storage key is uo-shard');
ok(shouldShowPicker(null, '', null) === true, 'fresh visit (no pin) → show picker');
ok(shouldShowPicker(null, '?shard=ej', null) === false, '?shard= pin → skip picker');
ok(shouldShowPicker(null, '?server=wss://x/uo-ws', null) === false, '?server= pin → skip picker');
ok(shouldShowPicker(null, '', 'ej') === false, 'remembered choice → skip picker');
ok(shouldShowPicker({ shard: 'ej' }, '', null) === false, 'config.shard → skip picker');
ok(shouldShowPicker({ ip: 'wss://x/uo-ws' }, '', null) === false, 'legacy ws config.ip → skip picker');
ok(shouldShowPicker({ ip: '172.16.2.154' }, '', null) === true, 'legacy raw-host config.ip does NOT pin → show picker');
ok(shouldShowPicker(null, '?picker=1', 'ej') === true, '?picker=1 forces the picker even with a remembered choice');
ok(shouldShowPicker(null, '?picker=0', null) === false, '?picker=0 forces skip even with no pin');

console.log(`\nshard-presets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
