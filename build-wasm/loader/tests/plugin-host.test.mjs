// L4 (D3) plugin host tests.  run: node build-wasm/loader/tests/plugin-host.test.mjs
import { PluginHost } from '../wwwroot/plugin-host.js';
import { ReferenceAssistant } from '../wwwroot/reference-assistant.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const u8 = (...a) => new Uint8Array(a);

// ── register / list / unregister ─────────────────────────────────────────────
PluginHost._reset();
const off = PluginHost.register({ name: 'p1' });
ok(PluginHost.count() === 1 && PluginHost.list()[0] === 'p1', 'register + list');
off();
ok(PluginHost.count() === 0, 'unregister removes it');
PluginHost.register(null); ok(PluginHost.count() === 0, 'register(null) is a safe no-op');

// ── packetIn/Out chain: pass-through, rewrite, drop, order ───────────────────
PluginHost._reset();
const log = [];
PluginHost.register({ name: 'a', onPacketIn: (p) => { log.push('a' + p[0]); return p; } });
PluginHost.register({ name: 'b', onPacketIn: (p) => { const q = u8(p[0] + 1); return q; } });   // rewrite
let out = PluginHost.packetIn(u8(10));
ok(out instanceof Uint8Array && out[0] === 11, 'packetIn chain rewrites (10→11)');
ok(log[0] === 'a10', 'hooks run in registration order, first sees original');

PluginHost._reset();
PluginHost.register({ name: 'drop', onPacketOut: () => null });          // drop
PluginHost.register({ name: 'after', onPacketOut: () => { throw 'should not run'; } });
ok(PluginHost.packetOut(u8(1, 2, 3)) === null, 'a DROP short-circuits the chain');

PluginHost._reset();
ok(PluginHost.packetIn(u8(5)).length === 1, 'no plugins → bytes pass through unchanged');

// ── a throwing plugin is isolated (chain continues) ──────────────────────────
PluginHost._reset();
PluginHost.register({ name: 'boom', onPacketIn: () => { throw new Error('x'); } });
PluginHost.register({ name: 'good', onPacketIn: (p) => u8(p[0] + 100) });
ok(PluginHost.packetIn(u8(1))[0] === 101, 'a throwing hook is skipped, the chain continues');

// ── lifecycle + connected state + late registration ──────────────────────────
PluginHost._reset();
let ev = [];
PluginHost.register({ name: 'lc', onConnect: () => ev.push('c'), onDisconnect: () => ev.push('d') });
ok(PluginHost.connected === false, 'starts disconnected');
PluginHost.fire('connect');
ok(PluginHost.connected === true && ev.join('') === 'c', 'connect fires + sets state');
// a plugin registered WHILE connected gets an immediate onConnect
let lateGotConnect = false;
PluginHost.register({ name: 'late', onConnect: () => { lateGotConnect = true; } });
ok(lateGotConnect, 'late registration during a live connection gets onConnect');
PluginHost.fire('disconnect');
ok(PluginHost.connected === false && ev.join('') === 'cd', 'disconnect fires + clears state');

// ── api.send injects via the loader-bound sender (bypasses the out-chain) ─────
PluginHost._reset();
const wire = [];
PluginHost.bindSend((b) => wire.push(b));
let outChainRan = false;
PluginHost.register({ name: 'inj', onRegister(api) { this.api = api; }, onPacketOut() { outChainRan = true; return null; } });
PluginHost.list();
PluginHost.api.send(u8(0x12, 0x34));
ok(wire.length === 1 && wire[0][0] === 0x12, 'api.send puts bytes on the bound wire');
ok(outChainRan === false, 'injected packets bypass the out-chain (no self-loop)');

// ── the reference assistant tallies the stream ───────────────────────────────
PluginHost._reset();
PluginHost.register(ReferenceAssistant);
PluginHost.fire('connect');
PluginHost.packetIn(u8(0xA0, 1, 2)); PluginHost.packetIn(u8(0xA0, 9)); PluginHost.packetIn(u8(0xB1));
PluginHost.packetOut(u8(0x02, 7, 7, 7));
const s = ReferenceAssistant.stats;
ok(s.in === 3 && s.out === 1, 'assistant counts in/out');
ok(s.byId[0xA0] === 2 && s.byId[0xB1] === 1, 'assistant tallies per packet id');
ok(s.bytesIn === 3 + 2 + 1 && s.bytesOut === 4, 'assistant tallies bytes');
ok(typeof ReferenceAssistant.summary() === 'string' && ReferenceAssistant.summary().includes('distinct-ids=2'), 'assistant summary');
ok(PluginHost.packetIn(u8(0xC2, 1))[0] === 0xC2, 'assistant passes packets through unchanged (observation-only)');

console.log(`\nplugin-host: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
