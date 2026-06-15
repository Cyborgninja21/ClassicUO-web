// art-delta-codec.js — self-contained binary-delta codec for the art-patching
// pipeline (workstream D2). Pure ES module, NO native/system/npm dependency,
// runs UNCHANGED in both node (server-side gen tool) and the browser (client
// decode). Operates on Uint8Array only — never Node Buffer, never node-only
// globals — so it is byte-identical on both ends.
//
// Correctness (exact round-trip) is paramount: applyDelta(base, encodeDelta(
// base, target)) === target, byte-for-byte, for ALL inputs. The encoder is a
// simple greedy hash-matcher; it is NOT size-optimal, but it is correct and
// produces a delta meaningfully smaller than the target when base ≈ target.
//
// ── WIRE FORMAT (this codec only — interop with xdelta3/RFC3284 is NOT a goal)
//
// Header (fixed):
//   magic    4 bytes  = DELTA_MAGIC ("UODL")
//   version  1 byte   = DELTA_VERSION (currently 1)
//   mode     1 byte   = 0 (instruction stream) | 1 (store: literal target only)
//   targetLen u32 LE  = length of the reconstructed target (sanity/preallocation)
//
// mode 1 (store): header is immediately followed by exactly `targetLen` raw
// target bytes. Used as the bounded-size fallback when an instruction-stream
// delta would be larger than the target itself; guarantees the encoded size is
// never worse than header + target.
//
// mode 0 (instruction stream): header is followed by a sequence of instructions
// until `targetLen` output bytes have been produced. Each instruction begins
// with one opcode byte:
//   ADD  (0x01): varint len, then `len` literal bytes -> appended to output.
//   COPY (0x02): varint len, varint srcOffset -> copies `len` bytes starting at
//                absolute offset `srcOffset` of a virtual source buffer that is
//                the concatenation (base ++ output-so-far). srcOffset < base.len
//                copies from base; srcOffset >= base.len copies from already-
//                produced target (self-reference, enabling run/repeat encoding).
//                A COPY may read bytes that are produced *by itself* (srcOffset
//                in the output region within `len` of the write head): this is
//                the classic overlapping-copy = run-fill, decoded byte-by-byte.
//
// All multi-byte integers are unsigned LEB128 varints (7 bits/byte, low byte
// first, high bit = continuation) EXCEPT the two header u32s, which are fixed
// little-endian u32 for a stable, greppable header. Varints keep small offsets/
// lengths compact (the common near-identical case) while still addressing files
// far larger than 4 GB if ever needed.
//
// applyDelta guards EVERY read against overrun and validates magic/version/mode/
// final-length; on any violation it throws (never reads OOB, never returns
// garbage). A malformed or foreign delta is rejected, not silently mis-applied.

export const DELTA_MAGIC = new Uint8Array([0x55, 0x4f, 0x44, 0x4c]); // "UODL"
export const DELTA_VERSION = 1;

const MODE_STREAM = 0;
const MODE_STORE = 1;

const OP_ADD = 0x01;
const OP_COPY = 0x02;

// Header size: 4 magic + 1 version + 1 mode + 4 (u32 targetLen) = 10 bytes.
const HEADER_LEN = 10;

// Encoder tuning. MIN_MATCH must be >= the COPY instruction overhead to ever
// pay off (opcode + 2 varints); 8 keeps the k-gram hash selective and the win
// real. WINDOW caps work on pathological inputs without affecting correctness.
const MIN_MATCH = 8;
const HASH_BITS = 21; // 2^21 buckets — modest memory, low collision on UO art

// ─────────────────────────────────────────────────────────────────────────────
// varint helpers (unsigned LEB128) over a small growable byte sink / cursor.
// ─────────────────────────────────────────────────────────────────────────────

class ByteSink {
  constructor(cap = 1024) {
    this.buf = new Uint8Array(cap);
    this.len = 0;
  }

  _ensure(extra) {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  pushByte(b) {
    this._ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  pushBytes(arr, start = 0, end = arr.length) {
    const n = end - start;
    this._ensure(n);
    this.buf.set(arr.subarray(start, end), this.len);
    this.len += n;
  }

  pushU32LE(v) {
    this._ensure(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }

  // Unsigned LEB128. Uses arithmetic (not >>>) so values > 2^32 still encode.
  pushVarint(value) {
    let v = value;
    if (v < 0 || !Number.isFinite(v)) throw new RangeError('varint: negative/non-finite');
    do {
      let byte = v % 128; // low 7 bits
      v = Math.floor(v / 128);
      if (v > 0) byte |= 0x80;
      this.pushByte(byte);
    } while (v > 0);
  }

  toUint8Array() {
    return this.buf.subarray(0, this.len);
  }
}

class Cursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  remaining() {
    return this.bytes.length - this.pos;
  }

  readByte() {
    if (this.pos >= this.bytes.length) throw new RangeError('delta overrun: byte');
    return this.bytes[this.pos++];
  }

  readU32LE() {
    if (this.pos + 4 > this.bytes.length) throw new RangeError('delta overrun: u32');
    const b = this.bytes;
    const v = b[this.pos] | (b[this.pos + 1] << 8) | (b[this.pos + 2] << 16) | (b[this.pos + 3] << 24);
    this.pos += 4;
    return v >>> 0;
  }

  readVarint() {
    let result = 0;
    let shift = 1; // multiplier = 128^k, kept as a float for > 2^32 safety
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.bytes.length) throw new RangeError('delta overrun: varint');
      const byte = this.bytes[this.pos++];
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new RangeError('delta corrupt: varint too long');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// encodeDelta
// ─────────────────────────────────────────────────────────────────────────────

function rollingHashOf(bytes, i) {
  // FNV-1a-ish over MIN_MATCH bytes, folded into HASH_BITS. Deterministic.
  let h = 0x811c9dc5;
  for (let k = 0; k < MIN_MATCH; k++) {
    h ^= bytes[i + k];
    h = (h * 0x01000193) >>> 0;
  }
  return (h ^ (h >>> (32 - HASH_BITS))) & ((1 << HASH_BITS) - 1);
}

function matchLength(src, srcOff, tgt, tgtOff, maxLen) {
  let n = 0;
  while (n < maxLen && src[srcOff + n] === tgt[tgtOff + n]) n++;
  return n;
}

/**
 * Produce a compact binary delta transforming base -> target.
 * @param {Uint8Array} baseBytes
 * @param {Uint8Array} targetBytes
 * @returns {Uint8Array}
 */
export function encodeDelta(baseBytes, targetBytes) {
  const base = baseBytes instanceof Uint8Array ? baseBytes : new Uint8Array(baseBytes);
  const target = targetBytes instanceof Uint8Array ? targetBytes : new Uint8Array(targetBytes);

  const stream = encodeStream(base, target);
  // Fallback: if the instruction stream isn't smaller than a plain store of the
  // target, emit a store so the encoded size is bounded by header + target.
  if (stream.len > HEADER_LEN + target.length) {
    return encodeStore(target);
  }
  return stream.toUint8Array();
}

function writeHeader(sink, mode, targetLen) {
  sink.pushBytes(DELTA_MAGIC);
  sink.pushByte(DELTA_VERSION);
  sink.pushByte(mode);
  sink.pushU32LE(targetLen >>> 0);
}

function encodeStore(target) {
  const sink = new ByteSink(HEADER_LEN + target.length);
  writeHeader(sink, MODE_STORE, target.length);
  sink.pushBytes(target);
  return sink.toUint8Array();
}

function encodeStream(base, target) {
  const sink = new ByteSink(Math.max(64, target.length >> 2));
  writeHeader(sink, MODE_STREAM, target.length);

  // Hash table of base k-grams: bucket -> last starting offset in base.
  // (Single-slot per bucket; greedy, not exhaustive — correct, not optimal.)
  const buckets = 1 << HASH_BITS;
  const table = new Int32Array(buckets).fill(-1);
  if (base.length >= MIN_MATCH) {
    // Index a sparse-ish set: every position is fine for these file sizes, but
    // stepping by 1 maximises match recall on near-identical inputs.
    for (let i = 0; i + MIN_MATCH <= base.length; i++) {
      table[rollingHashOf(base, i)] = i;
    }
  }

  const tlen = target.length;
  let pos = 0;
  let pendingAddStart = 0; // start of the not-yet-flushed literal run

  const flushAdd = (end) => {
    if (end > pendingAddStart) {
      sink.pushByte(OP_ADD);
      sink.pushVarint(end - pendingAddStart);
      sink.pushBytes(target, pendingAddStart, end);
    }
  };

  while (pos < tlen) {
    let bestLen = 0;
    let bestSrc = -1;

    if (pos + MIN_MATCH <= tlen && base.length >= MIN_MATCH) {
      const cand = table[rollingHashOf(target, pos)];
      if (cand >= 0 && cand + MIN_MATCH <= base.length) {
        // verify (hash collisions) and extend within base
        const max = Math.min(base.length - cand, tlen - pos);
        const len = matchLength(base, cand, target, pos, max);
        if (len >= MIN_MATCH) {
          bestLen = len;
          bestSrc = cand; // absolute offset in virtual source (base region)
        }
      }
    }

    // Self-reference: try to extend a copy from already-produced target so runs
    // and earlier-repeated regions encode as one COPY into the output region.
    if (pos + MIN_MATCH <= tlen && pos >= MIN_MATCH) {
      // probe a handful of recent positions for a cheap self-match; the decoder
      // supports overlapping copies, so a 1-byte back-reference fills a run.
      const back = findSelfMatch(target, pos);
      if (back.len > bestLen) {
        bestLen = back.len;
        bestSrc = base.length + back.off; // output region of virtual source
      }
    }

    if (bestLen >= MIN_MATCH) {
      flushAdd(pos);
      sink.pushByte(OP_COPY);
      sink.pushVarint(bestLen);
      sink.pushVarint(bestSrc);
      pos += bestLen;
      pendingAddStart = pos;
    } else {
      pos += 1; // accumulate into the pending ADD run
    }
  }
  flushAdd(tlen);
  return sink;
}

// Cheap self-match probe: detect an immediately-preceding run/repeat so highly
// repetitive output collapses to an overlapping COPY. Returns the best {off,len}
// where off is an absolute offset within the produced target (< pos).
function findSelfMatch(target, pos) {
  let best = { off: 0, len: 0 };
  // period-1 run: target[pos] == target[pos-1] ...
  // Try a few stride candidates (1,2,3,4) — covers solid fills and small tiles.
  for (const stride of [1, 2, 3, 4]) {
    if (pos - stride < 0) continue;
    const src = pos - stride;
    let n = 0;
    const max = target.length - pos;
    while (n < max && target[src + (n % stride)] === target[pos + n]) n++;
    if (n >= MIN_MATCH && n > best.len) best = { off: src, len: n };
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyDelta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconstruct target from base + delta. Throws on bad magic/version/mode or any
 * overrun — never returns a partial/garbage buffer.
 * @param {Uint8Array} baseBytes
 * @param {Uint8Array} deltaBytes
 * @returns {Uint8Array}
 */
export function applyDelta(baseBytes, deltaBytes) {
  const base = baseBytes instanceof Uint8Array ? baseBytes : new Uint8Array(baseBytes);
  const delta = deltaBytes instanceof Uint8Array ? deltaBytes : new Uint8Array(deltaBytes);

  const cur = new Cursor(delta);

  // magic
  for (let i = 0; i < DELTA_MAGIC.length; i++) {
    if (cur.readByte() !== DELTA_MAGIC[i]) throw new Error('art-delta: bad magic (not a UODL delta)');
  }
  const version = cur.readByte();
  if (version !== DELTA_VERSION) throw new Error(`art-delta: unsupported version ${version}`);
  const mode = cur.readByte();
  const targetLen = cur.readU32LE();

  const out = new Uint8Array(targetLen);

  if (mode === MODE_STORE) {
    if (cur.remaining() !== targetLen) throw new Error('art-delta: store length mismatch');
    for (let i = 0; i < targetLen; i++) out[i] = cur.readByte();
    return out;
  }
  if (mode !== MODE_STREAM) throw new Error(`art-delta: unknown mode ${mode}`);

  let outPos = 0;
  const baseLen = base.length;

  while (outPos < targetLen) {
    const op = cur.readByte();
    if (op === OP_ADD) {
      const len = cur.readVarint();
      if (outPos + len > targetLen) throw new Error('art-delta: ADD overruns target');
      if (cur.pos + len > delta.length) throw new Error('art-delta: ADD overruns delta');
      out.set(delta.subarray(cur.pos, cur.pos + len), outPos);
      cur.pos += len;
      outPos += len;
    } else if (op === OP_COPY) {
      const len = cur.readVarint();
      const srcOff = cur.readVarint();
      if (outPos + len > targetLen) throw new Error('art-delta: COPY overruns target');
      // virtual source = base ++ out[0..outPos). Copy byte-by-byte so an
      // overlapping self-copy (run fill) is well-defined.
      for (let i = 0; i < len; i++) {
        const s = srcOff + i;
        let v;
        if (s < baseLen) {
          v = base[s];
        } else {
          const o = s - baseLen;
          if (o >= outPos) throw new Error('art-delta: COPY reads beyond produced output');
          v = out[o];
        }
        out[outPos++] = v;
      }
    } else {
      throw new Error(`art-delta: unknown opcode 0x${op.toString(16)}`);
    }
  }

  if (outPos !== targetLen) throw new Error('art-delta: produced length mismatch');
  if (cur.remaining() !== 0) throw new Error('art-delta: trailing bytes after target complete');
  return out;
}
