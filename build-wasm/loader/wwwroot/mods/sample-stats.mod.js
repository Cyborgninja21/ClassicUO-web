// L6 (D5) — sample content mod: "packet stats".
//
// A minimal, safe demonstration of the mod SDK. It registers a D3 plugin that
// counts inbound packets and, every N packets, logs a one-line rate via the mod
// context. It rewrites/drops nothing (observation only). Load it with
// uo-config.json `{ "mods": ["./mods/sample-stats.mod.js"] }` or `?mods=./mods/
// sample-stats.mod.js`. Use it as the template for real mods (a mod's `plugin`
// can rewrite packets; `onLoad(ctx)` can ctx.writeArt(name, bytes) to override
// art, register more plugins, read ctx.config for settings, etc.).
export const mod = {
  name: 'sample-stats',
  version: '1.0.0',
  plugin: {
    name: 'sample-stats',
    _n: 0,
    _log: null,
    onConnect() { this._n = 0; },
    onPacketIn(p) {
      this._n++;
      if (this._log && this._n % 500 === 0) this._log(this._n + ' packets in this session');
      return p;   // pass through unchanged
    },
  },
  async onLoad(ctx) {
    // wire the mod's logger into its plugin + expose a handle for the console
    this.plugin._log = ctx.log;
    try { globalThis.UOMods = Object.assign(globalThis.UOMods || {}, { sampleStats: this.plugin }); } catch {}
    ctx.log('registered the packet-stats plugin (settings: ' + JSON.stringify(ctx.config.sampleStats || {}) + ')');
  },
};
export default mod;
