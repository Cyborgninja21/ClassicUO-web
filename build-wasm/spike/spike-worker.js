// SPIKE 7.1: boot the ClassicUO wasm bundle inside a Web Worker against an
// OffscreenCanvas, with a minimal DOM shim for SDL3's queries. Success = the
// login screen renders. NOT production code — a feasibility probe.
const post = (m) => self.postMessage(String(m));
post('worker alive');

let offCanvas = null;
const noop = () => {};

self.onmessage = async (e) => {
  offCanvas = e.data.canvas;
  // SDL3 queries clientWidth/getBoundingClientRect on the canvas — expando-shim them.
  try {
    offCanvas.clientWidth = e.data.width;
    offCanvas.clientHeight = e.data.height;
    offCanvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: e.data.width, height: e.data.height, right: e.data.width, bottom: e.data.height, x: 0, y: 0 });
    offCanvas.addEventListener = noop;
    offCanvas.removeEventListener = noop;
    offCanvas.style = {};
    offCanvas.focus = noop;
    offCanvas.setAttribute = noop;
  } catch (ex) { post('canvas shim limits: ' + ex); }

  // Minimal DOM shim for the worker global — installed AFTER dotnet.create():
  // with window/document present at import time, dotnet.js classifies the env
  // as a browser and parks awaiting DOM readiness; as a TRUE worker it boots.
  // SDL only queries the DOM at SDL_Init (StartClassicUO) — shim present by then.
  const installDomShim = () => {
  self.document = {
    querySelector: (sel) => (sel === '#canvas' ? offCanvas : null),
    getElementById: (id) => (id === 'canvas' ? offCanvas : null),
    addEventListener: noop, removeEventListener: noop,
    createElement: (tag) => {
      if (tag === 'canvas') {
        const c = new OffscreenCanvas(1, 1);
        try { c.style = {}; c.addEventListener = noop; c.setAttribute = noop; c.toDataURL = () => 'data:,'; } catch {}
        return c;
      }
      return { style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop, getContext: () => null };
    },
    body: { appendChild: noop, removeChild: noop, addEventListener: noop, style: {} },
    documentElement: { style: {} },
    visibilityState: 'visible', hasFocus: () => true,
    readyState: 'complete',   // loader waits for DOMContentLoaded if 'loading'
    currentScript: null, baseURI: self.location.href,
    title: 'spike', fonts: { ready: Promise.resolve() },
    fullscreenEnabled: false, exitPointerLock: noop,
  };
  self.window = self;
  if (!('devicePixelRatio' in self)) self.devicePixelRatio = 1;
  if (!self.screen) self.screen = { width: e.data.width, height: e.data.height };
  };

  // Full DOM shim BEFORE import: with dotnetSidecar=true the loader no longer
  // cares about window/document for env classification, and emscripten captures
  // `document` during create() — so the real shim must already be in place.
  installDomShim();
  self.document.baseURI = self.location.href;

  // THE KEY: in worker mode (Ce) the loader parks awaiting a main-thread asset
  // hand-off (dotnet's own threading protocol). dotnetSidecar=true flips Ce off —
  // the loader self-downloads and resolves its own readiness, like on main.
  globalThis.dotnetSidecar = true;

  try {
    post('importing dotnet.js…');
    const { dotnet } = await import('./_framework/dotnet.js');
    post('creating runtime (bisect: tracing on, no canvas first)…');
    setTimeout(() => post('still creating after 10s…'), 10000);
    setTimeout(() => post('still creating after 30s…'), 30000);
    const api = await dotnet
      .withDiagnosticTracing(true)
      .withModuleConfig({ print: (t) => post('out: ' + t), printErr: (t) => post('err: ' + t),
                          onConfigLoaded: () => post('config loaded'),
                          onDotnetReady: () => post('dotnet ready cb') })
      .create();
    post('runtime UP in worker');
    const cfg = api.getConfig();
    const exports = await api.getAssemblyExports(cfg.mainAssemblyName);
    api.setModuleImports('uo-ws', { wsOpen: noop, wsSend: noop, wsClose: noop });
    api.setModuleImports('uo-audio', { audioPlay: noop, audioMusic: noop, audioMusicStop: noop, audioMusicVolume: noop, audioStopAll: noop });
    post('imports wired');
    exports.ClassicUOLoader.Init();
    exports.ClassicUOLoader.MkUODir();
    post('runtime init OK — fetching required art (the slow part)…');
    const manifest = await (await fetch('uo-data/manifest.json')).json();
    const files = (Array.isArray(manifest) ? manifest : manifest.files);
    const RECOMMENDED = new Set(['animationframe1.uop','animationframe2.uop','animationframe3.uop','animationframe4.uop','anim2.mul','anim2.idx','anim3.mul','anim3.idx','multi.mul','multi.idx','multimap.rle']);
    let n = 0;
    for (const f of files) {
      if (RECOMMENDED.has(f.name.toLowerCase())) continue;
      const buf = new Uint8Array(await (await fetch('uo-data/' + f.name)).arrayBuffer());
      exports.ClassicUOLoader.WriteUOFile('/uo/' + f.name, buf);
      if (++n % 10 === 0) post('art ' + n);
    }
    post('art loaded (' + n + ' files) — starting ClassicUO…');
    const settings = JSON.stringify({ ip: '127.0.0.1', port: 2593, ultimaonlinedirectory: '/uo',
      clientversion: '7.0.114.65', lang: 'ENU', encryption: 0, use_verdata: false, login_music: false });
    try { exports.ClassicUOLoader.StartClassicUO(settings); } catch (ex) {
      if (!String(ex).includes('unwind')) { post('StartClassicUO EX: ' + ex + ' :: ' + (ex && ex.stack || '').slice(0, 400)); return; }
    }
    post('Start returned — pumping frames…');
    let frames = 0;
    const pump = () => {
      try { exports.ClassicUOLoader.TickFrame(); frames++; }
      catch (ex) { if (!String(ex).includes('unwind')) { post('tick EX@' + frames + ': ' + ex); return; } }
      if (frames === 60) post('SUCCESS-CANDIDATE: 60 frames ticked in worker');
      if (frames < 600) requestAnimationFrame(pump);
      else post('DONE: 600 frames pumped in worker');
    };
    requestAnimationFrame(pump);
  } catch (ex) {
    post('SPIKE FAIL: ' + ex + ' :: ' + (ex && ex.stack || '').slice(0, 600));
  }
};
