// D6 net-transport tests.  run: node build-wasm/loader/tests/net-transport.test.mjs
import { chooseTransport, resolveTransport, openTransport } from '../wwwroot/net-transport.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, m + ' (got ' + JSON.stringify(a) + ')');

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
}

// ── openTransport: WS path + WebTransport fallback (mocked globals) ───────────
const realWS = globalThis.WebSocket, realWT = globalThis.WebTransport;
function MockWS(url) { this.url = url; this.readyState = 1; this.sent = []; MockWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
MockWS.prototype.send = function (b) { this.sent.push(b); };
MockWS.prototype.close = function () { this.closed = true; };
try {
  // no WebTransport global → WS regardless of config
  globalThis.WebSocket = MockWS; delete globalThis.WebTransport;
  let opened = false;
  let t = await openTransport('wss://relay', { transport: 'webtransport', wtUrl: 'https://wt' }, { onOpen: () => { opened = true; } });
  eq(t.kind, 'websocket', 'no WebTransport support → websocket');
  await new Promise((r) => setTimeout(r, 5));
  ok(opened, 'WS onOpen fired'); t.send(new Uint8Array([1, 2])); ok(MockWS.last.sent.length === 1, 'WS send works');

  // WebTransport present but its .ready REJECTS → fall back to WS (connection still comes up)
  globalThis.WebTransport = function () { this.ready = Promise.reject(new Error('no quic')); this.closed = new Promise(() => {}); this.close = () => {}; };
  t = await openTransport('wss://relay', { transport: 'webtransport', wtUrl: 'https://wt' }, { onOpen: () => {} });
  eq(t.kind, 'websocket', 'WebTransport open failure → WS fallback (no connectivity regression)');

  // WebTransport present + opens cleanly → webtransport
  globalThis.WebTransport = function () {
    this.ready = Promise.resolve();
    this.closed = new Promise(() => {});
    this.close = () => {};
    this.createBidirectionalStream = async () => ({
      writable: { getWriter: () => ({ write: () => {} }) },
      readable: { getReader: () => ({ read: () => new Promise(() => {}) }) },   // never resolves (stays open)
    });
  };
  let wtOpen = false;
  t = await openTransport('wss://relay', { transport: 'webtransport', wtUrl: 'https://wt' }, { onOpen: () => { wtOpen = true; } });
  eq(t.kind, 'webtransport', 'clean WebTransport open → webtransport');
  ok(wtOpen, 'WebTransport onOpen fired'); ok(typeof t.send === 'function' && typeof t.close === 'function', 'transport has send/close');
} finally {
  if (realWS) globalThis.WebSocket = realWS; else delete globalThis.WebSocket;
  if (realWT) globalThis.WebTransport = realWT; else delete globalThis.WebTransport;
}

console.log(`\nnet-transport: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
