// L2 (D1) content-addressed delta-sync tests for the art loader.
// Pure-logic coverage of art-contract.js — no browser/WASM needed.
//   run: node build-wasm/loader/tests/art-delta.test.mjs
import {
  computeArtDelta, serializeArtState, parseArtState, ART_STATE_NAME, parseManifest,
} from '../wwwroot/art-contract.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const man = (arr) => new Map(arr.map((e) => [e.name, e]));

// ── computeArtDelta ──────────────────────────────────────────────────────────
{
  const m = man([
    { name: 'a.mul', size: 100, sha256: 'aaa' },
    { name: 'b.mul', size: 200, sha256: 'bbb' },
    { name: 'c.mul', size: 300, sha256: 'ccc' },
  ]);
  const sizeOf = async (n) => ({ 'a.mul': 100, 'b.mul': 999, 'c.mul': 300 }[n] ?? null);

  // sidecar-known: only the hash-changed file re-fetches
  let val = new Map([['a.mul', { size: 100, sha256: 'aaa' }], ['b.mul', { size: 200, sha256: 'OLD' }], ['c.mul', { size: 300, sha256: 'ccc' }]]);
  let d = await computeArtDelta(m, new Set(['a.mul', 'b.mul', 'c.mul']), val, sizeOf);
  ok(d.refetch.length === 1 && d.refetch[0].name === 'b.mul', 'hash-change re-fetches only the changed file');
  ok(d.prune.length === 0, 'unchanged set prunes nothing');

  // no sidecar: missing re-fetches, present size-matches stay; extra prunes
  d = await computeArtDelta(m, new Set(['a.mul', 'c.mul', 'old.mul']), new Map(), sizeOf);
  ok(d.refetch.length === 1 && d.refetch[0].name === 'b.mul', 'missing file re-fetched, size-matching kept');
  ok(d.prune.length === 1 && d.prune[0] === 'old.mul', 'manifest-dropped file pruned');

  // no sidecar + size mismatch -> size fallback re-fetches
  d = await computeArtDelta(m, new Set(['a.mul', 'b.mul', 'c.mul']), new Map(), sizeOf);
  ok(d.refetch.length === 1 && d.refetch[0].name === 'b.mul', 'size-fallback re-fetches the wrong-size file');

  // sidecar hash-match trumps a differing size accessor (no needless re-fetch)
  d = await computeArtDelta(man([{ name: 'b.mul', size: 200, sha256: 'bbb' }]), new Set(['b.mul']), new Map([['b.mul', { size: 200, sha256: 'bbb' }]]), async () => 999);
  ok(d.refetch.length === 0, 'sidecar hash-match avoids a re-hash/re-fetch');

  // the sidecar file itself is never art (never loaded, never pruned)
  d = await computeArtDelta(m, new Set(['a.mul', 'b.mul', 'c.mul', ART_STATE_NAME]), val, sizeOf);
  ok(!d.prune.includes(ART_STATE_NAME), 'the sidecar file is not treated as prunable art');
}

// ── sidecar round-trip ───────────────────────────────────────────────────────
{
  const s = serializeArtState(new Map([['a.mul', { size: 100, sha256: 'aaa' }], [ART_STATE_NAME, { size: 1, sha256: 'x' }]]));
  const back = parseArtState(s);
  ok(back.size === 1 && back.get('a.mul').sha256 === 'aaa' && !back.has(ART_STATE_NAME), 'round-trip drops the sidecar self-entry');
  ok(parseArtState('not json {').size === 0, 'corrupt sidecar parses to empty (falls back to size diff)');
  ok(parseArtState(null).size === 0, 'absent sidecar parses to empty');
}

// ── end-to-end scenario: first load → persist → server updates a file → delta ─
{
  // simulate a mock OPFS cache as plain in-memory state
  const cache = {
    files: new Map(),                    // name -> {size, sha256-of-bytes}
    sidecar: null,
    keys: async () => [...cache.files.keys()],
    sizeOf: async (n) => cache.files.get(n)?.size ?? null,
    readState: async () => parseArtState(cache.sidecar),
    writeState: async (map) => { cache.sidecar = serializeArtState(map); },
  };
  // a tiny stand-in for the loader's record+persist cycle
  const validated = new Map();
  const writeFile = (entry) => { cache.files.set(entry.name, { size: entry.size, sha256: entry.sha256 }); validated.set(entry.name, { size: entry.size, sha256: entry.sha256 }); };

  // first visit: download all, persist sidecar
  const v1 = man([{ name: 'a.mul', size: 10, sha256: 'h_a1' }, { name: 'b.mul', size: 20, sha256: 'h_b1' }]);
  for (const e of v1.values()) writeFile(e);
  await cache.writeState(validated);

  // second visit: server changed b (new bytes, even same size) + added c
  const v2 = man([{ name: 'a.mul', size: 10, sha256: 'h_a1' }, { name: 'b.mul', size: 20, sha256: 'h_b2' }, { name: 'c.mul', size: 5, sha256: 'h_c1' }]);
  const sidecar = await cache.readState();
  const present = new Set(await cache.keys());
  const { refetch, prune } = await computeArtDelta(v2, present, sidecar, cache.sizeOf);
  const names = refetch.map((e) => e.name).sort();
  ok(names.length === 2 && names[0] === 'b.mul' && names[1] === 'c.mul', 'delta re-fetches the content-changed (b) + new (c) files, skips unchanged a');
  ok(prune.length === 0, 'nothing pruned this round');

  // third visit: server removed c
  const v3 = man([{ name: 'a.mul', size: 10, sha256: 'h_a1' }, { name: 'b.mul', size: 20, sha256: 'h_b2' }]);
  for (const e of refetch) writeFile(e);            // apply round-2 fetches
  await cache.writeState(validated);
  const { refetch: r3, prune: p3 } = await computeArtDelta(v3, new Set(await cache.keys()), await cache.readState(), cache.sizeOf);
  ok(r3.length === 0, 'steady state: nothing to re-fetch');
  ok(p3.length === 1 && p3[0] === 'c.mul', 'manifest-dropped c is pruned');
}

// ── legacy manifest shapes still parse ───────────────────────────────────────
{
  ok(parseManifest(['a.mul', 'b.mul']).size === 2, 'legacy string-array manifest parses');
  ok(parseManifest([{ name: 'a.mul', size: 1, sha256: 'x' }]).get('a.mul').sha256 === 'x', 'integrity manifest parses');
}

console.log(`\nart-delta: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
