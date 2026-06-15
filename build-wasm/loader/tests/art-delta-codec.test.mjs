// art-delta-codec.test.mjs — the round-trip GATE for the binary-delta codec
// (workstream D2). Pure node, 0-dependency, in the existing harness style.
//   run: node build-wasm/loader/tests/art-delta-codec.test.mjs
//
// Determinism: Math.random / Date.now are unavailable here, so all "random"
// data comes from a seeded xorshift32 PRNG below — the suite is reproducible.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { encodeDelta, applyDelta, DELTA_MAGIC, DELTA_VERSION } from '../wwwroot/art-delta-codec.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// byte-for-byte equality of two Uint8Arrays
const eq = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ── seeded PRNG (xorshift32) — deterministic, no Math.random ─────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x1a2b3c4d;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}
const randBytes = (rng, n) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = rng() & 0xff;
  return a;
};

// round-trip assertion helper: returns the delta so callers can measure size
function roundtrip(base, target, label) {
  const delta = encodeDelta(base, target);
  const out = applyDelta(base, delta);
  ok(eq(out, target), `${label}: exact reconstruction (len ${target.length}, delta ${delta.length})`);
  return delta;
}

// ── 1. Random buffers, varied sizes (incl. 0,1,tiny,large ~5MB) ──────────────
{
  const rng = makeRng(0xC0FFEE);
  const sizes = [0, 1, 2, 7, 8, 9, 16, 100, 1000, 4096, 65537, 1 << 20];
  for (const sz of sizes) {
    const base = randBytes(rng, sz);
    const target = randBytes(rng, sz);
    roundtrip(base, target, `random equal-size ${sz}`);
  }
  // mismatched sizes
  for (let i = 0; i < 20; i++) {
    const bl = rng() % 5000;
    const tl = rng() % 5000;
    roundtrip(randBytes(rng, bl), randBytes(rng, tl), `random mixed-size b=${bl} t=${tl}`);
  }
  // one genuinely large ~5MB pair
  const big = randBytes(rng, 5 * 1024 * 1024);
  roundtrip(big, randBytes(rng, 5 * 1024 * 1024), 'random ~5MB pair');
}

// ── 2. Near-identical (the real shard-customization case) ────────────────────
{
  const rng = makeRng(0x5EED);
  const N = 512 * 1024;
  const base = randBytes(rng, N);

  // (a) a few byte flips
  {
    const target = base.slice();
    for (let i = 0; i < 200; i++) {
      const at = rng() % N;
      target[at] = (target[at] + 1 + (rng() & 0x7f)) & 0xff;
    }
    const delta = roundtrip(base, target, 'near-identical: 200 byte flips');
    ok(delta.length < target.length / 4, `byte-flips: delta << target (${delta.length} << ${target.length})`);
  }

  // (b) a spliced region (overwrite a contiguous block)
  {
    const target = base.slice();
    const at = 100000;
    const patch = randBytes(rng, 4096);
    target.set(patch, at);
    const delta = roundtrip(base, target, 'near-identical: spliced 4KB region');
    ok(delta.length < target.length / 4, `splice: delta << target (${delta.length} << ${target.length})`);
  }

  // (c) inserted + deleted block (shifts the tail — classic delta stress)
  {
    const insAt = 50000;
    const ins = randBytes(rng, 8192);
    const delAt = 300000;
    const delLen = 8192;
    // target = base[0..insAt) ++ ins ++ base[insAt..delAt) ++ base[delAt+delLen..]
    const head = base.subarray(0, insAt);
    const mid = base.subarray(insAt, delAt);
    const tail = base.subarray(delAt + delLen);
    const target = new Uint8Array(head.length + ins.length + mid.length + tail.length);
    let o = 0;
    target.set(head, o); o += head.length;
    target.set(ins, o); o += ins.length;
    target.set(mid, o); o += mid.length;
    target.set(tail, o);
    const delta = roundtrip(base, target, 'near-identical: insert+delete block');
    ok(delta.length < target.length / 4, `ins+del: delta << target (${delta.length} << ${target.length})`);
  }
}

// ── 3. Pathological ──────────────────────────────────────────────────────────
{
  const rng = makeRng(0xBADBEEF);

  // base empty + target non-empty
  roundtrip(new Uint8Array(0), randBytes(rng, 1000), 'pathological: empty base');

  // target empty + base non-empty
  {
    const d = roundtrip(randBytes(rng, 1000), new Uint8Array(0), 'pathological: empty target');
    ok(d.length <= 10, 'empty target -> tiny delta (header only)');
  }

  // base === target -> tiny delta
  {
    const b = randBytes(rng, 200000);
    const d = roundtrip(b, b.slice(), 'pathological: base === target');
    ok(d.length < b.length / 50, `identical: delta tiny (${d.length} for ${b.length})`);
  }

  // target = base repeated (self-reference / overlap)
  {
    const b = randBytes(rng, 50000);
    const target = new Uint8Array(b.length * 3);
    target.set(b, 0); target.set(b, b.length); target.set(b, b.length * 2);
    const d = roundtrip(b, target, 'pathological: base repeated x3');
    ok(d.length < target.length / 3, `repeat: delta < target (${d.length} < ${target.length})`);
  }

  // highly repetitive data (run fill via overlapping copy)
  {
    const base = new Uint8Array(0);
    const target = new Uint8Array(100000).fill(0xAB);
    const d = roundtrip(base, target, 'pathological: solid-fill target');
    ok(d.length < 100, `solid fill collapses to tiny delta (${d.length})`);
  }

  // repetitive small pattern
  {
    const base = new Uint8Array(0);
    const target = new Uint8Array(60000);
    for (let i = 0; i < target.length; i++) target[i] = (i % 4) + 1;
    const d = roundtrip(base, target, 'pathological: period-4 pattern');
    ok(d.length < target.length / 10, `period-4 collapses (${d.length} for ${target.length})`);
  }

  // both empty
  roundtrip(new Uint8Array(0), new Uint8Array(0), 'pathological: both empty');
}

// ── 4. Real UO art fixtures ──────────────────────────────────────────────────
{
  const dataDir = '/home/cwallace/git/ClassicUO-web/build-wasm/.uo-test-data';
  const candidates = ['MainMisc.uop', 'string_dictionary.uop', 'tileart.uop'];
  let measuredSaving = null;

  for (const fname of candidates) {
    const path = join(dataDir, fname);
    if (!existsSync(path)) {
      console.log(`  (skip real fixture ${fname}: not present)`);
      continue;
    }
    const base = new Uint8Array(readFileSync(path));
    if (base.length === 0) { console.log(`  (skip ${fname}: zero bytes)`); continue; }

    // Build a "custom" variant: flip a few hundred bytes at known offsets +
    // splice a region — the shard-customization shape.
    const rng = makeRng(0xA27 ^ base.length);
    const target = base.slice();
    const flips = Math.min(400, Math.floor(base.length / 50));
    for (let i = 0; i < flips; i++) {
      const at = rng() % base.length;
      target[at] = (target[at] ^ (1 + (rng() & 0x7f))) & 0xff;
    }
    // splice a 2KB region near the middle (clamped)
    const region = Math.min(2048, base.length);
    const at = Math.floor(base.length / 2) - Math.floor(region / 2);
    if (at >= 0 && at + region <= base.length) {
      target.set(randBytes(rng, region), at);
    }

    const delta = encodeDelta(base, target);
    const out = applyDelta(base, delta);
    ok(eq(out, target), `real fixture ${fname}: exact round-trip`);
    ok(delta.length < base.length, `real fixture ${fname}: real size saving (delta ${delta.length} < target ${base.length})`);

    const savingPct = (100 * (1 - delta.length / target.length)).toFixed(2);
    console.log(`  [real] ${fname}: target ${target.length} B, delta ${delta.length} B -> ${savingPct}% saved`);
    if (measuredSaving === null) measuredSaving = { fname, savingPct, target: target.length, delta: delta.length };
  }

  if (measuredSaving === null) {
    console.log('  WARNING: no real fixtures available — real-art assertions skipped');
  } else {
    globalThis.__REAL_SAVING__ = measuredSaving;
  }
}

// ── 5. Corruption rejection ──────────────────────────────────────────────────
{
  const rng = makeRng(0xDEAD);
  const base = randBytes(rng, 5000);
  const target = randBytes(rng, 5000);
  const good = encodeDelta(base, target);

  const throws = (fn, label) => {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    ok(threw, label);
  };

  // bad magic
  {
    const bad = good.slice();
    bad[0] ^= 0xff;
    throws(() => applyDelta(base, bad), 'corruption: bad magic throws');
  }
  // bad version
  {
    const bad = good.slice();
    bad[4] = DELTA_VERSION + 99;
    throws(() => applyDelta(base, bad), 'corruption: bad version throws');
  }
  // truncated mid-stream
  {
    const bad = good.slice(0, Math.max(7, good.length - 100));
    throws(() => applyDelta(base, bad), 'corruption: truncated delta throws');
  }
  // header-only garbage
  throws(() => applyDelta(base, new Uint8Array([0, 1, 2])), 'corruption: too-short buffer throws');
  // empty buffer
  throws(() => applyDelta(base, new Uint8Array(0)), 'corruption: empty delta throws');
  // unknown opcode injected (corrupt body of a stream delta)
  {
    const bad = good.slice();
    if (bad[5] === 0) { // only meaningful for stream mode
      bad[10] = 0x7e; // clobber a byte in the instruction region with a junk opcode
      throws(() => applyDelta(base, bad), 'corruption: junk opcode/overrun throws');
    } else {
      ok(true, 'corruption: (store-mode delta — opcode test n/a)');
    }
  }
  // sanity: a foreign random buffer is rejected
  throws(() => applyDelta(base, randBytes(rng, 200)), 'corruption: random foreign buffer throws');
}

console.log(`\nart-delta-codec: ${pass} passed, ${fail} failed`);
if (globalThis.__REAL_SAVING__) {
  const r = globalThis.__REAL_SAVING__;
  console.log(`real-art near-identical saving (${r.fname}): ${r.savingPct}% (${r.delta} B delta for ${r.target} B target)`);
}
process.exit(fail ? 1 : 0);
