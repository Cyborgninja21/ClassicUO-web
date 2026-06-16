// A3 (L1) — shard presets + selection resolution (the "launcher" data layer).
//
// Until now the client reached ONE shard: settings.ip was a single hardcoded host
// (172.16.2.154:2593) or a single ws:// relay URL baked into the gitignored
// uo-config.json, and the WebTransport opts (wt_url/wt_cert_url) likewise pointed
// at one bridge. There was no notion of "which shard" — the connect path assumed a
// single target.
//
// There are now TWO live shards. A shard PRESET is the per-shard launcher record:
//   { id, name, era, ws, wt?, wtCert? }
//     id      — stable slug (URL/localStorage key, e.g. "t2a")
//     name    — display name for the picker
//     era     — era/ruleset label shown beside the name
//     ws      — the wss:// (or ws://) wsproxy relay endpoint for THIS shard
//     wt      — optional WebTransport (HTTP/3) endpoint for the direct path
//     wtCert  — optional explicit cert-hash URL (else derived from `wt`'s host)
//
// resolveShard() turns "config + url query + persisted choice" into the endpoints
// the existing transport/connect path consumes:
//   { id, name, era, ip, wtUrl, wtCertUrl, custom }
// where `ip` feeds settings.ip verbatim (NetClient.Connect uses any ws/wss address
// as-is) and wtUrl/wtCertUrl feed net-transport's _transportOpts. This keeps the
// engine + transport code unchanged: the launcher just selects the endpoints.

// Built-in presets. Endpoints follow the live Traefik hostnames
// (play.<shard>.epikos-kyklos.com). The wsproxy relay is reachable at the
// shard host on the /uo-ws path; the WebTransport bridge on :4433/wt with its
// cert hash at /wt-cert/cert-hash (see net-transport.js).
export const SHARD_PRESETS = [
  {
    id: 't2a',
    name: 'Utumno Online — T2A',
    era: 'The Second Age (classic)',
    ws: 'wss://play.utumno-uo-t2a.epikos-kyklos.com/uo-ws',
    wt: null,
    wtCert: null,
  },
  {
    id: 'ej',
    name: 'Utumno Online — Endless Journey',
    era: 'Endless Journey (modern)',
    ws: 'wss://play.utumno-uo-ej.epikos-kyklos.com/uo-ws',
    wt: null,
    wtCert: null,
  },
];

export const SHARD_STORAGE_KEY = 'uo-shard';
const DEFAULT_SHARD_ID = 't2a';

// Merge config-provided presets over the built-ins (by id), and apply per-preset
// endpoint overrides from uo-config.json. Lets a deployment add/retune shards
// without editing this file: { "shards": [{ id, name, era, ws, wt, wtCert }],
// "shard": "ej" }. Unknown-keyed config shards are appended.
export function buildPresets(config) {
  const c = config || {};
  const out = SHARD_PRESETS.map((p) => Object.assign({}, p));
  const extra = Array.isArray(c.shards) ? c.shards : [];
  for (const s of extra) {
    if (!s || !s.id) continue;
    const i = out.findIndex((p) => p.id === s.id);
    const merged = Object.assign({}, i >= 0 ? out[i] : { id: s.id }, s);
    if (i >= 0) out[i] = merged; else out.push(merged);
  }
  return out;
}

// Find a preset by id (case-insensitive). null if absent.
export function findPreset(presets, id) {
  if (!id) return null;
  const want = String(id).toLowerCase();
  return (presets || []).find((p) => String(p.id).toLowerCase() === want) || null;
}

// Map a resolved preset (or a custom ws endpoint) to the transport endpoints the
// connect path consumes. Custom servers carry no WebTransport pin.
function toEndpoints(preset, custom) {
  if (custom) {
    return { id: 'custom', name: 'Custom server', era: custom, ip: custom, wtUrl: null, wtCertUrl: null, custom: true };
  }
  return {
    id: preset.id,
    name: preset.name || preset.id,
    era: preset.era || '',
    ip: preset.ws || null,
    wtUrl: preset.wt || null,
    wtCertUrl: preset.wtCert || null,
    custom: false,
  };
}

// Resolve the active shard. Precedence (highest first):
//   1. URL query  ?server=<ws-url>   → a CUSTOM endpoint (raw relay URL)
//   2. URL query  ?shard=<id>        → a built-in/config preset by id
//   3. persisted choice (localStorage uo-shard): "custom:<url>" or "<id>"
//   4. config.shard (uo-config.json) preset id
//   5. config.shard_url (uo-config.json) custom endpoint
//   6. legacy config.ip when it is a ws/wss URL (back-compat with the old
//      single-relay uo-config.json — treated as a custom endpoint)
//   7. DEFAULT_SHARD_ID
// `stored` is the raw localStorage string (caller passes it so this stays pure /
// testable without a DOM). `search` is location.search.
export function resolveShard(presets, config, search, stored) {
  const list = presets && presets.length ? presets : SHARD_PRESETS;
  const c = config || {};
  let q = null;
  try { q = new URLSearchParams(search || ''); } catch {}

  // 1 — explicit custom server URL in the query.
  const qServer = q && q.get('server');
  if (qServer && /^wss?:\/\//i.test(qServer)) return toEndpoints(null, qServer);

  // 2 — preset id in the query.
  const qShard = q && q.get('shard');
  if (qShard) {
    const p = findPreset(list, qShard);
    if (p) return toEndpoints(p, null);
  }

  // 3 — persisted choice.
  if (stored) {
    if (stored.indexOf('custom:') === 0) {
      const url = stored.slice('custom:'.length);
      if (/^wss?:\/\//i.test(url)) return toEndpoints(null, url);
    } else {
      const p = findPreset(list, stored);
      if (p) return toEndpoints(p, null);
    }
  }

  // 4 — config preset id.
  if (c.shard) { const p = findPreset(list, c.shard); if (p) return toEndpoints(p, null); }
  // 5 — config custom endpoint.
  if (c.shard_url && /^wss?:\/\//i.test(c.shard_url)) return toEndpoints(null, c.shard_url);
  // 6 — legacy single-relay uo-config.json `ip` as a ws URL.
  if (c.ip && /^wss?:\/\//i.test(c.ip)) return toEndpoints(null, c.ip);

  // 7 — default.
  const def = findPreset(list, DEFAULT_SHARD_ID) || list[0];
  return toEndpoints(def, null);
}

// The localStorage value for a resolved selection (so a picked shard sticks across
// reloads). Custom endpoints store as "custom:<url>", presets store the id.
export function shardStorageValue(resolved) {
  if (!resolved) return null;
  return resolved.custom ? 'custom:' + resolved.ip : resolved.id;
}
