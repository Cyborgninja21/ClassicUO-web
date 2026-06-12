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
