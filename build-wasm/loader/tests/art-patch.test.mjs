// L3 (D2) client patch-apply integration tests: selectPatch decision +
// end-to-end reconstruct via the real codec.  run: node art-patch.test.mjs
import { selectPatch, deltaUrl } from '../wwwroot/art-contract.js';
import { encodeDelta, applyDelta } from '../wwwroot/art-delta-codec.js';
import { createHash } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const sha = (b) => createHash('sha256').update(b).digest('hex');
// tiny seeded PRNG (Math.random is unavailable here)
let _s = 0x1234abcd; const rnd = () => (_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296;
const randBytes = (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (rnd() * 256) | 0; return a; };

// ── selectPatch decision (pure) ──────────────────────────────────────────────
const man = new Map([['a.mul', { name: 'a.mul', base_sha256: 'B', result_sha256: 'R', result_size: 10 }]]);
ok(selectPatch(man, 'a.mul', 'B', 'R') !== null, 'patch chosen when cached base + target both match');
ok(selectPatch(man, 'a.mul', 'X', 'R') === null, 'no patch when cached base ≠ patch base');
ok(selectPatch(man, 'a.mul', 'B', 'OTHER') === null, 'no patch when target ≠ patch result');
ok(selectPatch(man, 'a.mul', 'B', null) !== null, 'target check skipped when manifest entry has no sha');
ok(selectPatch(man, 'missing', 'B', 'R') === null, 'no patch for an unlisted file');
ok(selectPatch(null, 'a.mul', 'B', 'R') === null, 'no patch manifest → null');
ok(selectPatch(man, 'a.mul', null, 'R') === null, 'no cached sha → null (can\'t know the base)');

// ── deltaUrl ─────────────────────────────────────────────────────────────────
ok(deltaUrl('https://h/uo-data/', 'art.mul') === 'https://h/uo-data/deltas/art.mul.uodelta', 'deltaUrl');

// ── end-to-end: cached base + server delta → reconstructed target ────────────
// mirrors tryApplyPatch's core: applyDelta(cachedBase, delta) must equal target
// and match the patch result_sha256 the client checks before writing.
{
  const base = randBytes(50000);
  const target = base.slice();                       // near-identical (the real case)
  for (let i = 0; i < 300; i++) target[(rnd() * target.length) | 0] = (rnd() * 256) | 0;
  const delta = encodeDelta(base, target);
  const patch = { name: 'x', base_sha256: sha(base), result_sha256: sha(target), result_size: target.length, delta_size: delta.length };

  // the client only applies when its cached sha == patch.base_sha256
  ok(selectPatch(new Map([['x', patch]]), 'x', sha(base), sha(target)) === patch, 'real patch selected');

  const result = applyDelta(base, delta);
  ok(result.length === patch.result_size, 'reconstructed length matches patch.result_size');
  ok(sha(result) === patch.result_sha256, 'reconstructed sha256 matches patch.result_sha256 (client write gate)');
  ok(Buffer.compare(Buffer.from(result), Buffer.from(target)) === 0, 'reconstructed bytes == target exactly');
  ok(delta.length < target.length / 2, 'delta is much smaller than a full fetch (' + delta.length + ' vs ' + target.length + ')');

  // a corrupted/foreign delta must NOT reconstruct to the expected sha (client falls back)
  const bad = delta.slice(); bad[bad.length - 1] ^= 0xff;
  let badSha = null;
  try { badSha = sha(applyDelta(base, bad)); } catch { badSha = 'threw'; }
  ok(badSha !== patch.result_sha256, 'a tampered delta does not pass the result_sha256 gate (→ full fetch)');

  // wrong cached base (client doesn't hold the patch's base) → selectPatch rejects up front
  ok(selectPatch(new Map([['x', patch]]), 'x', sha(randBytes(10)), sha(target)) === null, 'wrong cached base → no patch (full fetch)');
}

console.log(`\nart-patch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
