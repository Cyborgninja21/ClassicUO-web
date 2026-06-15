// L4 (D3) — reference assistant plugin.
//
// A safe, observation-only demonstration of the plugin host: it tallies the
// packet stream (counts in/out + per-packet-id) and exposes the live tally on
// globalThis.UOAssistant so it's inspectable from the console / a test, and logs
// the first sighting of each new packet id. It NEVER rewrites or drops a packet
// (every hook returns the bytes unchanged), so bundling it on by default cannot
// affect gameplay — it exists to prove the host works end-to-end and to document
// the API shape that D5 mods build on.
export const ReferenceAssistant = {
  name: 'reference-assistant',
  stats: { in: 0, out: 0, bytesIn: 0, bytesOut: 0, byId: {}, connected: false },
  _api: null,
  onRegister(api) {
    this._api = api;
    try { globalThis.UOAssistant = this; } catch {}
  },
  onConnect() {
    this.stats = { in: 0, out: 0, bytesIn: 0, bytesOut: 0, byId: {}, connected: true };
  },
  onDisconnect() { this.stats.connected = false; },
  onPacketIn(p) {
    this.stats.in++; this.stats.bytesIn += p.length;
    const id = p.length ? p[0] : -1;
    if (this.stats.byId[id] == null) { this.stats.byId[id] = 0; }
    this.stats.byId[id]++;
    return p;   // pass through unchanged
  },
  onPacketOut(p) {
    this.stats.out++; this.stats.bytesOut += p.length;
    return p;   // pass through unchanged
  },
  // a tiny convenience the console / a mod can call
  summary() {
    const ids = Object.keys(this.stats.byId).length;
    return `in=${this.stats.in} (${this.stats.bytesIn}B) out=${this.stats.out} (${this.stats.bytesOut}B) distinct-ids=${ids} connected=${this.stats.connected}`;
  },
};
