// D6 net-transport tests.  run: node build-wasm/loader/tests/net-transport.test.mjs
import { chooseTransport, resolveTransport, openTransport, base64ToBytes, parseCertHashes, deriveCertUrl } from '../wwwroot/net-transport.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, m + ' (got ' + JSON.stringify(a) + ')');

// A cert fetch that returns nothing → the existing WS/plain-WT expectations hold
// without touching the network.
const noCertFetch = async () => ({ ok: false });

// ── chooseTransport (pure policy) ────────────────────────────────────────────
eq(chooseTransport({}, true), 'websocket', 'default → websocket');
eq(chooseTransport({ transport: 'webtransport', wtUrl: 'https://h' }, true), 'webtransport', 'enabled + supported + url → webtransport');
eq(chooseTransport({ transport: 'webtransport', wtUrl: 'https://h' }, false), 'websocket', 'unsupported → websocket');
eq(chooseTransport({ transport: 'webtransport' }, true), 'websocket', 'no wtUrl → websocket');
eq(chooseTransport({ transport: 'websocket', wtUrl: 'https://h' }, true), 'websocket', 'explicit websocket honoured');

// ── resolveTransport (config + query, query wins) ────────────────────────────
{
  let r = resolveTransport({ transport: 'webtransport', wt_url: 'https://c' }, '');
  eq(r.transport, 'webtransport', 'config transport'); eq(r.wtUrl, 'https://c', 'config wt_url');
  r = resolveTransport({ transport: 'websocket' }, '?transport=webtransport&wt=https://q');
  eq(r.transport, 'webtransport', 'query transport wins'); eq(r.wtUrl, 'https://q', 'query wt wins');
  r = resolveTransport(null, '');
  eq(r.transport, null, 'no config → null transport'); eq(r.wtUrl, null, 'no config → null wtUrl');
  // cert URL: config wt_cert_url, then ?wtcert= wins
  r = resolveTransport({ wt_cert_url: 'https://c/wt-cert/cert-hash' }, '');
  eq(r.wtCertUrl, 'https://c/wt-cert/cert-hash', 'config wt_cert_url');
  r = resolveTransport({ wt_cert_url: 'https://c/x' }, '?wtcert=https://q/y');
  eq(r.wtCertUrl, 'https://q/y', 'query wtcert wins');
  r = resolveTransport(null, '');
  eq(r.wtCertUrl, null, 'no config → null wtCertUrl');
}

// ── base64ToBytes (round-trip) ───────────────────────────────────────────────
{
  const bytes = base64ToBytes('AQID');                 // [1,2,3]
  ok(bytes.length === 3 && bytes[0] === 1 && bytes[1] === 2 && bytes[2] === 3, 'base64ToBytes decodes AQID → [1,2,3]');
  // full 32-byte SHA-256-sized round-trip
  const digest = new Uint8Array(32); for (let i = 0; i < 32; i++) digest[i] = (i * 7) & 0xff;
  const b64 = btoa(String.fromCharCode(...digest));
  const back = base64ToBytes(b64);
  let same = back.length === 32; for (let i = 0; i < 32; i++) if (back[i] !== digest[i]) same = false;
  ok(same, '32-byte digest survives base64 round-trip');
}

// ── parseCertHashes ──────────────────────────────────────────────────────────
{
  const digest = new Uint8Array(32); for (let i = 0; i < 32; i++) digest[i] = i;
  const b64 = btoa(String.fromCharCode(...digest));
  const h = parseCertHashes({ algorithm: 'SHA-256', value: b64 });
  ok(Array.isArray(h) && h.length === 1, 'parseCertHashes → one entry');
  eq(h[0].algorithm, 'sha-256', 'algorithm lower-cased');
  ok(h[0].value instanceof Uint8Array && h[0].value.length === 32, 'value is the 32-byte digest');
  ok(parseCertHashes(null) === null, 'null json → null');
  ok(parseCertHashes({}) === null, 'no value → null');
  ok(parseCertHashes({ value: '' }) === null, 'empty value → null');
}

// ── deriveCertUrl ────────────────────────────────────────────────────────────
{
  eq(deriveCertUrl('https://play.utumno-uo-t2a.epikos-kyklos.com:4433/wt'), 'https://play.utumno-uo-t2a.epikos-kyklos.com/wt-cert/cert-hash', 'derive drops port, adds /wt-cert/cert-hash');
  eq(deriveCertUrl('https://wt', 'https://explicit/x'), 'https://explicit/x', 'explicit override wins');
  eq(deriveCertUrl('not a url'), null, 'unparseable wtUrl → null');
}

// ── openTransport: WS path + WebTransport fallback (mocked globals) ───────────
const realWS = globalThis.WebSocket, realWT = globalThis.WebTransport;
function MockWS(url) { this.url = url; this.readyState = 1; this.sent = []; MockWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
MockWS.prototype.send = function (b) { this.sent.push(b); };
MockWS.prototype.close = function () { this.closed = true; };
// Capturing WebTransport mock that records the constructor (url, opts).
function makeMockWT() {
  function MockWT(url, opts) {
    MockWT.lastUrl = url; MockWT.lastOpts = opts;
    this.ready = Promise.resolve();
    this.closed = new Promise(() => {});
    this.close = () => {};
    this.createBidirectionalStream = async () => ({
      writable: { getWriter: () => ({ write: () => {} }) },
      readable: { getReader: () => ({ read: () => new Promise(() => {}) }) },
    });
  }
  return MockWT;
}
try {
  // no WebTransport global → WS regardless of config
  globalThis.WebSocket = MockWS; delete globalThis.WebTransport;
  let opened = false;
  let t = await openTransport('wss://relay', { transport: 'webtransport', wtUrl: 'https://wt', fetchImpl: noCertFetch }, { onOpen: () => { opened = true; } });
  eq(t.kind, 'websocket', 'no WebTransport support → websocket');
  await new Promise((r) => setTimeout(r, 5));
  ok(opened, 'WS onOpen fired'); t.send(new Uint8Array([1, 2])); ok(MockWS.last.sent.length === 1, 'WS send works');

  // WebTransport present but its .ready REJECTS → fall back to WS (connection still comes up)
  globalThis.WebTransport = function () { this.ready = Promise.reject(new Error('no quic')); this.closed = new Promise(() => {}); this.close = () => {}; };
  t = await openTransport('wss://relay', { transport: 'webtransport', wtUrl: 'https://wt', fetchImpl: noCertFetch }, { onOpen: () => {} });
  eq(t.kind, 'websocket', 'WebTransport open failure → WS fallback (no connectivity regression)');

  // WebTransport present + opens cleanly, NO cert hash available → plain open (no opts)
  globalThis.WebTransport = makeMockWT();
  let wtOpen = false;
  t = await openTransport('wss://relay', { transport: 'webtransport', wtUrl: 'https://wt', fetchImpl: noCertFetch }, { onOpen: () => { wtOpen = true; } });
  eq(t.kind, 'webtransport', 'clean WebTransport open → webtransport');
  ok(wtOpen, 'WebTransport onOpen fired'); ok(typeof t.send === 'function' && typeof t.close === 'function', 'transport has send/close');
  ok(globalThis.WebTransport.lastOpts === undefined, 'no cert hash → plain WebTransport(url) (no serverCertificateHashes)');

  // WebTransport opens cleanly AND the bridge serves a cert hash → it is pinned.
  const digest = new Uint8Array(32); for (let i = 0; i < 32; i++) digest[i] = (i * 3 + 1) & 0xff;
  const b64 = btoa(String.fromCharCode(...digest));
  const certFetch = async (url) => { certFetch.url = url; return { ok: true, json: async () => ({ algorithm: 'sha-256', value: b64 }) }; };
  globalThis.WebTransport = makeMockWT();
  t = await openTransport('wss://relay', { transport: 'webtransport', wtUrl: 'https://play.x.com:4433/wt', fetchImpl: certFetch }, { onOpen: () => {} });
  eq(t.kind, 'webtransport', 'pinned WebTransport open → webtransport');
  eq(certFetch.url, 'https://play.x.com/wt-cert/cert-hash', 'cert fetched from derived /wt-cert/cert-hash');
  const opts = globalThis.WebTransport.lastOpts;
  ok(opts && Array.isArray(opts.serverCertificateHashes) && opts.serverCertificateHashes.length === 1, 'serverCertificateHashes passed to WebTransport ctor');
  ok(opts.serverCertificateHashes[0].algorithm === 'sha-256', 'pinned hash algorithm sha-256');
  {
    const v = opts.serverCertificateHashes[0].value; let same = v && v.length === 32;
    for (let i = 0; i < 32; i++) if (v[i] !== digest[i]) same = false;
    ok(same, 'pinned hash bytes match the fetched digest');
  }
} finally {
  if (realWS) globalThis.WebSocket = realWS; else delete globalThis.WebSocket;
  if (realWT) globalThis.WebTransport = realWT; else delete globalThis.WebTransport;
}

console.log(`\nnet-transport: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
