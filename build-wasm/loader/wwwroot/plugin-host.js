// L4 (D3) — in-browser assistant / plugin host.
//
// UO assistants (Razor / UOSteam / ClassicAssist) work by intercepting the
// packet stream in both directions, injecting their own packets, and reacting
// to connection lifecycle. This is the WASM-safe equivalent: a small pure-JS
// host that sits at the loader's WebSocket/transport boundary (the only place
// packets cross JS↔engine), so plugins never touch the wasm engine internals.
//
// A plugin is a plain object; every hook is optional:
//   { name,
//     onRegister(api),                  // once, when registered
//     onConnect(), onDisconnect(),      // transport up / down
//     onPacketIn(bytes) -> bytes|null|true|void,   // server → client
//     onPacketOut(bytes) -> bytes|null|true|void } // client → server
// A hook may: return a Uint8Array to REWRITE the packet, return null/false to
// DROP it, or return undefined/true/the same bytes to pass it through. Hooks run
// in registration order; the first DROP short-circuits.
//
// The loader wires it in (bindSend + the in/out chains at the WS seam) — see
// main.js / engine-worker.js. Both loaders import THIS single host so a plugin
// behaves identically in classic + worker mode.

const _plugins = [];
let _sendRaw = null;     // the loader's wire-send (set via bindSend)
let _connected = false;

function _u8(b) { return b instanceof Uint8Array ? b : new Uint8Array(b || 0); }
function _warn(p, hook, e) {
  try { (globalThis.console && console.warn) && console.warn('[plugin] ' + (p && p.name || 'anon') + '.' + hook + ' threw: ' + e); } catch {}
}

// The API object handed to each plugin (send + read connection state + helpers).
export const pluginApi = {
  // Inject an OUTBOUND packet. Bypasses the out-chain (so a plugin can't loop on
  // its own injection); it still goes on the wire via the loader's bound sender.
  send(bytes) { const b = _u8(bytes); if (b.length && _sendRaw) { try { _sendRaw(b); } catch (e) { _warn({ name: 'api' }, 'send', e); } } },
  get connected() { return _connected; },
  packetId(bytes) { return bytes && bytes.length ? bytes[0] : -1; },
  plugins() { return _plugins.map((p) => p.name || 'anon'); },
};

export const PluginHost = {
  api: pluginApi,
  // Register a plugin; returns an unregister function.
  register(p) {
    if (!p || typeof p !== 'object') return () => {};
    _plugins.push(p);
    try { p.onRegister && p.onRegister(pluginApi); } catch (e) { _warn(p, 'onRegister', e); }
    if (_connected) { try { p.onConnect && p.onConnect(); } catch (e) { _warn(p, 'onConnect', e); } }
    return () => { const i = _plugins.indexOf(p); if (i >= 0) _plugins.splice(i, 1); };
  },
  list() { return _plugins.map((p) => p.name || 'anon'); },
  count() { return _plugins.length; },
  // The loader calls these for every packet; returns the (possibly rewritten)
  // bytes to deliver, or null to drop. Never throws (a bad plugin is isolated).
  packetIn(bytes) { return _runChain('onPacketIn', _u8(bytes)); },
  packetOut(bytes) { return _runChain('onPacketOut', _u8(bytes)); },
  // Lifecycle fan-out (connect/disconnect). Tracks connected state for late
  // registrations + api.connected.
  fire(ev, arg) {
    if (ev === 'connect') _connected = true;
    else if (ev === 'disconnect') _connected = false;
    const hook = ev === 'connect' ? 'onConnect' : ev === 'disconnect' ? 'onDisconnect' : ev;
    for (const p of _plugins) { try { p[hook] && p[hook](arg); } catch (e) { _warn(p, hook, e); } }
  },
  // The loader binds its wire-send so plugins (api.send) can inject packets.
  bindSend(fn) { _sendRaw = typeof fn === 'function' ? fn : null; },
  get connected() { return _connected; },
  // test/reset hook
  _reset() { _plugins.length = 0; _sendRaw = null; _connected = false; },
};

function _runChain(hook, bytes) {
  let b = bytes;
  for (const p of _plugins) {
    if (!p[hook]) continue;
    let r;
    try { r = p[hook](b); } catch (e) { _warn(p, hook, e); continue; }
    if (r === null || r === false) return null;     // dropped
    if (r instanceof Uint8Array) b = r;             // rewritten
    // undefined / true / same → pass through
  }
  return b;
}
