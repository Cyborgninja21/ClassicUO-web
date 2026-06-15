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
// to the WS relay so connectivity never regresses. The Pangolin edge needs a
// WebTransport→TCP bridge for the endpoint to exist (server side, ADR-050);
// absent that, the client simply stays on WS.
//
// openTransport(wsUrl, opts, cb) → { send(bytes), close(), kind }
//   opts = { transport, wtUrl }       cb = { onOpen, onMessage(u8), onClose, onError }

// Pure: which transport to use. Keeps the policy testable without a browser.
export function chooseTransport(opts, hasWebTransport) {
  const o = opts || {};
  if (o.transport === 'webtransport' && hasWebTransport && o.wtUrl) return 'webtransport';
  return 'websocket';
}

// Pull transport options out of uo-config + the URL query (query wins).
export function resolveTransport(config, search) {
  const c = config || {};
  let transport = c.transport || null, wtUrl = c.wt_url || null;
  try {
    const q = new URLSearchParams(search || '');
    if (q.get('transport')) transport = q.get('transport');
    if (q.get('wt')) wtUrl = q.get('wt');
  } catch {}
  return { transport, wtUrl };
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

// Open a WebTransport bidi stream and adapt it. Resolves to a transport, or
// rejects so the caller can fall back to WS.
async function openWebTransport(wtUrl, cb) {
  const wt = new WebTransport(wtUrl);
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
  const hasWT = typeof WebTransport !== 'undefined';
  if (chooseTransport(opts, hasWT) === 'webtransport') {
    try { return await openWebTransport(opts.wtUrl, cb); }
    catch (e) { try { (globalThis.console && console.warn) && console.warn('[net] WebTransport failed, falling back to WS: ' + e); } catch {} }
  }
  return openWebSocket(wsUrl, cb);
}
