// Shared art contract — single source for the file lists + manifest/integrity
// helpers, imported by BOTH the classic main-thread path (main.js) and the
// worker engine (engine-worker.js, sprint 9). Keep in sync with the server's
// load-art harness (Utumno-iac configure-utumno-uo-t2a-web-art.yml).
export const UO_FILES = [
  "AnimationSequence.uop", "Body.def", "Bodyconv.def", "Cliloc.enu", "MainMisc.uop",
  "MultiCollection.uop", "Prof.txt", "Professn.enu", "Skills.idx", "Sound.def", "art.def",
  "artLegacyMUL.uop", "fonts.mul", "gump.def", "gumpartLegacyMUL.uop", "hues.mul", "light.mul",
  "lightidx.mul", "map0LegacyMUL.uop", "mobtypes.txt", "radarcol.mul", "skills.mul", "speech.mul",
  "staidx0.mul", "statics0.mul", "string_dictionary.uop", "texidx.mul", "texmaps.mul", "tileart.uop",
  "tiledata.mul", "unifont.mul", "unifont1.mul", "unifont2.mul", "unifont3.mul",
];
// Base body animations are REQUIRED (a missing anim.mul = silent bodyless world).
export const UO_FILES_REQUIRED = UO_FILES.concat(["anim.mul", "anim.idx"]);
// Recommended (background tier): more bodies/multis; the client runs without them.
export const UO_FILES_RECOMMENDED = [
  "AnimationFrame1.uop", "AnimationFrame2.uop", "AnimationFrame3.uop", "AnimationFrame4.uop",
  "anim2.mul", "anim2.idx", "anim3.mul", "anim3.idx", "multi.mul", "multi.idx", "Multimap.rle",
];

export async function sha256Hex(buf) {
  if (!(typeof crypto !== 'undefined' && crypto.subtle)) return null;
  const d = await crypto.subtle.digest('SHA-256', buf);
  let s = ''; for (const b of new Uint8Array(d)) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function checkIntegrity(entry, buf, hash) {
  if (entry && entry.size != null && buf.length !== entry.size) return 'size ' + buf.length + '≠' + entry.size;
  if (hash && entry && entry.sha256) { const h = await sha256Hex(buf); if (h && h !== entry.sha256) return 'sha256 mismatch'; }
  return null;
}

// Accept legacy ["name", ...] or integrity [{name,size,sha256}, ...]; -> Map name->entry.
export function parseManifest(json) {
  const m = new Map();
  for (const e of json || []) {
    const entry = typeof e === 'string' ? { name: e } : e;
    if (entry && entry.name && entry.name !== 'manifest.json') m.set(entry.name, entry);
  }
  return m;
}

export async function fetchManifest() {
  try {
    const r = await fetch('/uo-data/manifest.json', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
    return parseManifest(await r.json());
  } catch { return null; }
}

// ── L2: content-addressed delta sync (D1) ────────────────────────────────────
// The cache holds files BY NAME. Before this, the client only re-fetched files
// that were *missing* by name — so a shard that UPDATES an art file (same name,
// changed bytes: custom art, a corrected tiledata.mul, …) never reached a client
// that already had the old copy. The server manifest carries per-file
// {size, sha256}; this turns that into the content address: a cached file is
// stale iff its content no longer matches the manifest entry.
//
// To avoid re-hashing every (multi-hundred-MB) cached file on every boot, each
// file that the loader writes is recorded in a small persisted "validated"
// sidecar — the {size, sha256} the bytes were last verified against. The delta
// then compares the NEW manifest's sha256 to that recorded sha256 (cheap, no
// re-hash). When there's no sidecar record (e.g. a pre-existing cache from
// before this feature), it falls back to a size comparison, which catches
// essentially every real art change (UO art edits change the file length). The
// reserved sidecar file/key is never itself treated as art.
export const ART_STATE_NAME = '_art-validated.json';

// Serialize the validated map (name -> {size, sha256}) for the sidecar.
export function serializeArtState(validated) {
  const o = {};
  for (const [name, v] of (validated || new Map())) {
    if (name === ART_STATE_NAME || !v) continue;
    o[name] = { size: v.size ?? null, sha256: v.sha256 ?? null };
  }
  return JSON.stringify({ v: 1, files: o });
}

// Parse the sidecar back to a Map. Tolerant of absent/corrupt input (-> empty).
export function parseArtState(json) {
  const m = new Map();
  try {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    const files = o && o.files;
    if (files && typeof files === 'object') {
      for (const name of Object.keys(files)) {
        const e = files[name];
        if (e && name !== ART_STATE_NAME) m.set(name, { size: e.size ?? null, sha256: e.sha256 ?? null });
      }
    }
  } catch { /* corrupt sidecar -> behave as if empty (falls back to size diff) */ }
  return m;
}

// Compute the content-addressed delta between the server `manifest` (Map
// name->entry) and what the cache currently holds.
//   present   — Set of cached file names (or array)
//   validated — Map name->{size, sha256} last verified (the sidecar); may be empty
//   sizeOf    — async (name) => cached byte length | null  (the size fallback)
// Returns { refetch: [manifestEntry...], prune: [name...] }.
//   refetch = manifest files that are missing OR whose content changed
//   prune   = cached files the manifest no longer lists (the implicit `del`)
export async function computeArtDelta(manifest, present, validated, sizeOf) {
  const have = present instanceof Set ? present : new Set(present || []);
  const val = validated || new Map();
  const refetch = [];
  for (const [name, entry] of manifest) {
    if (!have.has(name)) { refetch.push(entry); continue; }   // missing
    const rec = val.get(name);
    if (rec && rec.sha256 && entry.sha256) {
      // Content address known cheaply from the sidecar — re-fetch iff it moved.
      if (rec.sha256 !== entry.sha256) refetch.push(entry);
      continue;
    }
    // No recorded hash (pre-sidecar cache) — fall back to a size comparison.
    if (entry.size != null && typeof sizeOf === 'function') {
      let sz = null;
      try { sz = await sizeOf(name); } catch { sz = null; }
      if (sz != null && sz !== entry.size) refetch.push(entry);
    }
  }
  const prune = [];
  for (const name of have) {
    if (name !== ART_STATE_NAME && !manifest.has(name)) prune.push(name);
  }
  return { refetch, prune };
}
