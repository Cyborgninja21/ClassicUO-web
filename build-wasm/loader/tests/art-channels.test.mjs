// L5 (D4) update-channel + version-pin tests for the art loader.
//   run: node build-wasm/loader/tests/art-channels.test.mjs
import { manifestUrl, resolveArtSelection, fetchManifest } from '../wwwroot/art-contract.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, m + ' (got ' + JSON.stringify(a) + ')');

// ── manifestUrl ──────────────────────────────────────────────────────────────
eq(manifestUrl('stable', null), '/uo-data/manifest.json', 'stable head → base manifest');
eq(manifestUrl(null, null), '/uo-data/manifest.json', 'default → base manifest');
eq(manifestUrl('beta', null), '/uo-data/manifest.beta.json', 'beta channel → per-channel manifest');
eq(manifestUrl('stable', 'v123'), '/uo-data/manifests/v123.json', 'pin → archived version (channel ignored)');
eq(manifestUrl('beta', 'v9'), '/uo-data/manifests/v9.json', 'pin wins over channel');
eq(manifestUrl('beta', 'a b/c'), '/uo-data/manifests/a%20b%2Fc.json', 'pin is URL-encoded');

// ── resolveArtSelection (precedence: query > stored > config > defaults) ──────
eq(JSON.stringify(resolveArtSelection('', null, null)), JSON.stringify({ channel: 'stable', pin: null }), 'empty → stable/unpinned');
{
  const s = resolveArtSelection('?channel=beta&artpin=v7', { channel: 'stable', pin: null }, { art_channel: 'edge' });
  eq(s.channel, 'beta', 'query channel wins');
  eq(s.pin, 'v7', 'query pin wins');
}
{
  const s = resolveArtSelection('', { channel: 'beta', pin: 'v3' }, { art_channel: 'edge', art_pin: 'v1' });
  eq(s.channel, 'beta', 'stored channel beats config');
  eq(s.pin, 'v3', 'stored pin beats config');
}
{
  const s = resolveArtSelection('', {}, { art_channel: 'edge', art_pin: 'v1' });
  eq(s.channel, 'edge', 'config channel used when no query/stored');
  eq(s.pin, 'v1', 'config pin used when no query/stored');
}
{
  // ?artpin= (empty) is an explicit "clear the pin" — must not inherit stored/config
  const s = resolveArtSelection('?artpin=', { pin: 'v3' }, { art_pin: 'v1' });
  eq(s.pin, null, 'empty ?artpin= clears the pin');
}

// ── fetchManifest: envelope + legacy parsing (mock fetch) ────────────────────
const realFetch = globalThis.fetch;
function mockFetch(map) {
  globalThis.fetch = async (url) => {
    const body = map[url];
    if (body === undefined) return { ok: false, headers: { get: () => '' } };
    return { ok: true, headers: { get: (h) => h === 'content-type' ? 'application/json' : '' }, json: async () => body };
  };
}
try {
  // envelope
  mockFetch({ '/uo-data/manifest.json': { version: 'v42', channel: 'stable', files: [{ name: 'a.mul', size: 1, sha256: 'x' }] } });
  let m = await fetchManifest({ channel: 'stable' });
  ok(m && m.size === 1 && m.get('a.mul').sha256 === 'x', 'envelope files parsed');
  eq(m.version, 'v42', 'envelope version attached');
  eq(m.channel, 'stable', 'envelope channel attached');
  ok(m.pinned === false, 'unpinned flag');

  // legacy bare array still works (no meta companion → null version)
  mockFetch({ '/uo-data/manifest.json': ['a.mul', 'b.mul'] });
  m = await fetchManifest({});
  ok(m && m.size === 2, 'legacy array still parses');
  eq(m.version, null, 'bare array + no meta → null version');

  // bare array + companion meta → version from the sibling (non-breaking model)
  mockFetch({ '/uo-data/manifest.json': [{ name: 'a.mul', size: 1, sha256: 'x' }], '/uo-data/manifest.meta.json': { version: 'v99', channel: 'stable', generated: 'now' } });
  m = await fetchManifest({ channel: 'stable' });
  ok(m && m.size === 1, 'bare array files parsed');
  eq(m.version, 'v99', 'version read from companion manifest.meta.json');

  // channel + pin route to the right URL
  mockFetch({ '/uo-data/manifests/v7.json': { version: 'v7', channel: 'beta', files: [{ name: 'a', size: 1, sha256: 'h' }] } });
  m = await fetchManifest({ channel: 'beta', pin: 'v7' });
  ok(m && m.version === 'v7' && m.pinned === true, 'pin fetches the archived version + sets pinned');

  // missing manifest → null (graceful)
  mockFetch({});
  m = await fetchManifest({ channel: 'nope' });
  ok(m === null, 'absent manifest → null');
} finally { globalThis.fetch = realFetch; }

console.log(`\nart-channels: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
