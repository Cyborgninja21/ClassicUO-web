// L? (D6) — pluggable network transport: WebSocket (default) or WebTransport.
//
// Today the client reaches the shard over a WSS relay (WebSocket-over-TCP). On
// the public edge that adds the TCP head-of-line + handshake cost of another TCP
// hop. WebTransport (HTTP/3 over QUIC) gives a lower-latency path; for UO — a
// stream-oriented, self-framing protocol — we use a single reliable, ordered
// BIDIRECTIONAL STREAM (not unreliable datagrams), i.e. the same byte semantics
// as the WS path, just over QUIC. The engine's packet parser already accumulates
// a byte stream, so chunk boundaries don't matter.
//
// Selection is config-driven and SAFE: WebTransport is used only when explicitly
// enabled (uo-config `transport: "webtransport"` + `wt_url`, or ?transport=
// webtransport&wt=<url>) AND the browser supports it; any open failure FALLS BACK
// to the WS relay so connectivity never regresses. The server side is the
// utumno-uo-t2a-wtproxy bridge (ADR-050).
//
// SELF-SIGNED CERT (serverCertificateHashes). The bridge mints a short-lived
// (~13-day) self-signed ECDSA cert each start and publishes its SHA-256 over the
// normal HTTPS host at /wt-cert/cert-hash. A self-signed WebTransport server is
// only accepted by the browser if we pass serverCertificateHashes, so before
// opening we fetch that hash and hand it to `new WebTransport(url, {...})`. If the
// fetch fails we still try a plain open (works when the bridge serves a CA-issued
// cert via WTPROXY_CERT_FILE), then fall back to WS. The client re-fetches each
// session, so a bridge restart (new cert) is transparent.
//
// openTransport(wsUrl, opts, cb) → { send(bytes), close(), kind }
//   opts = { transport, wtUrl, wtCertUrl, fetchImpl }
//   cb   = { onOpen, onMessage(u8), onClose, onError }

// Pure: which transport to use. Keeps the policy testable without a browser.
export function chooseTransport(opts, hasWebTransport) {
  const o = opts || {};
  if (o.transport === 'webtransport' && hasWebTransport && o.wtUrl) return 'webtransport';
  return 'websocket';
}

// Pull transport options out of uo-config + the URL query (query wins).
export function resolveTransport(config, search) {
  const c = config || {};
  let transport = c.transport || null, wtUrl = c.wt_url || null, wtCertUrl = c.wt_cert_url || null;
  try {
    const q = new URLSearchParams(search || '');
    if (q.get('transport')) transport = q.get('transport');
    if (q.get('wt')) wtUrl = q.get('wt');
    if (q.get('wtcert')) wtCertUrl = q.get('wtcert');
  } catch {}
  return { transport, wtUrl, wtCertUrl };
}

// Decode standard base64 → bytes. The bridge serves the 32-byte SHA-256 digest
// base64-encoded; serverCertificateHashes wants the raw bytes.
export function base64ToBytes(b64) {
  const bin = (typeof atob === 'function')
    ? atob(b64)
    : Buffer.from(String(b64), 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Parse the bridge's /cert-hash JSON into WebTransport serverCertificateHashes
// entries: { algorithm:"sha-256", value:"<base64>" } → [{ algorithm, value:Uint8Array }].
// Returns null on anything malformed so the caller opens without pinning.
export function parseCertHashes(json) {
  if (!json || !json.value) return null;
  let bytes;
  try { bytes = base64ToBytes(json.value); } catch { return null; }
  if (!bytes || bytes.length === 0) return null;
  return [{ algorithm: String(json.algorithm || 'sha-256').toLowerCase(), value: bytes }];
}

// Where to fetch the cert hash. Explicit override (wt_cert_url / ?wtcert=) wins;
// otherwise derive from the WT URL's host on the default HTTPS port — the bridge
// routes /wt-cert/* via Traefik on the same hostname the client dials for QUIC.
export function deriveCertUrl(wtUrl, explicit) {
  if (explicit) return explicit;
  try { const u = new URL(wtUrl); return u.protocol + '//' + u.hostname + '/wt-cert/cert-hash'; }
  catch { return null; }
}

// Fetch + parse the cert hashes; null on any failure (→ open without pinning).
async function fetchCertHashes(certUrl, fetchImpl) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f || !certUrl) return null;
  try {
    const resp = await f(certUrl, { cache: 'no-store' });
    if (!resp || !resp.ok) return null;
    return parseCertHashes(await resp.json());
  } catch { return null; }
}

// Open a WebSocket and adapt it to the transport interface.
function openWebSocket(wsUrl, cb) {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => cb.onOpen && cb.onOpen();
  ws.onmessage = (ev) => cb.onMessage && cb.onMessage(new Uint8Array(ev.data));
  ws.onclose = () => cb.onClose && cb.onClose();
  ws.onerror = () => cb.onError && cb.onError();
  return {
    kind: 'websocket',
    send: (b) => { try { if (ws.readyState === 1) ws.send(b); } catch {} },
    close: () => { try { ws.close(); } catch {} },
  };
}

// Open a WebTransport bidi stream and adapt it. With certHashes the self-signed
// bridge cert is pinned; without, a plain open is attempted. Rejects so the caller
// can fall back to WS.
async function openWebTransport(wtUrl, cb, certHashes) {
  const wt = (certHashes && certHashes.length)
    ? new WebTransport(wtUrl, { serverCertificateHashes: certHashes })
    : new WebTransport(wtUrl);
  await wt.ready;                                   // throws → caller falls back
  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let closed = false;
  const done = () => { if (!closed) { closed = true; cb.onClose && cb.onClose(); } };
  wt.closed.then(done).catch(() => { cb.onError && cb.onError(); done(); });
  (async () => {
    try { for (;;) { const { done: d, value } = await reader.read(); if (d) break; if (value && value.length) cb.onMessage && cb.onMessage(value instanceof Uint8Array ? value : new Uint8Array(value)); } }
    catch { cb.onError && cb.onError(); }
    done();
  })();
  cb.onOpen && cb.onOpen();
  return {
    kind: 'webtransport',
    send: (b) => { try { writer.write(b instanceof Uint8Array ? b : new Uint8Array(b)); } catch {} },
    close: () => { try { wt.close(); } catch {} },
  };
}

// The public entry. Returns a Promise<transport>. WebTransport failure (or
// unsupported) → WebSocket, so the connection always comes up if WS would.
export async function openTransport(wsUrl, opts, cb) {
  const o = opts || {};
  const hasWT = typeof WebTransport !== 'undefined';
  if (chooseTransport(o, hasWT) === 'webtransport') {
    try {
      const certUrl = deriveCertUrl(o.wtUrl, o.wtCertUrl);
      const hashes = certUrl ? await fetchCertHashes(certUrl, o.fetchImpl) : null;
      return await openWebTransport(o.wtUrl, cb, hashes);
    } catch (e) { try { (globalThis.console && console.warn) && console.warn('[net] WebTransport failed, falling back to WS: ' + e); } catch {} }
  }
  return openWebSocket(wsUrl, cb);
}
