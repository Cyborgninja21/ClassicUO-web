// Page shell for worker mode (sprint 9): the engine runs in engine-worker.js;
// this side owns what workers can't — DOM input capture, WebAudio + the music
// element, status/banner UI — and forwards everything over postMessage.
// boot.js picks this path on ?worker=1; the classic main-thread path (main.js)
// is untouched and remains the default.

import { resolveArtSelection } from './art-contract.js';

export async function boot() {
  const canvas = document.getElementById('canvas');
  const statusEl = document.createElement('div');
  statusEl.id = 'art-status';
  statusEl.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;color:#9adb9a;font:13px system-ui,sans-serif;text-shadow:0 1px 2px #000';
  document.body.appendChild(statusEl);
  const log = console.log.bind(console);

  // L5 (D4): resolve the art channel + version pin here (the worker can't read
  // the page query / localStorage / uo-config) and pass it into the worker URL
  // so engine-worker.js fetches the right manifest. Same precedence + URL-sticks
  // behaviour as the classic path in main.js.
  let cfg = null;
  try { cfg = await (await fetch('./uo-config.json')).json(); } catch {}
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('uo-art-sel') || '{}'); } catch {}
  try {
    const q = new URLSearchParams(location.search), upd = {};
    if (q.get('channel')) upd.channel = q.get('channel');
    if (q.has('artpin')) upd.pin = q.get('artpin') || '';
    if (Object.keys(upd).length) { stored = Object.assign(stored, upd); localStorage.setItem('uo-art-sel', JSON.stringify(stored)); }
  } catch {}
  const sel = resolveArtSelection(location.search, stored, cfg);
  const wq = new URLSearchParams();
  if (sel.channel && sel.channel !== 'stable') wq.set('channel', sel.channel);
  if (sel.pin) wq.set('artpin', sel.pin);
  // L6 (D5): bridge the page's ?mods= into the worker URL (a worker can't read
  // the page query); uo-config `mods` the worker reads itself.
  try { const pm = new URLSearchParams(location.search).get('mods'); if (pm) wq.set('mods', pm); } catch {}
  // D6: bridge ?transport=/?wt= into the worker URL.
  try { const q = new URLSearchParams(location.search); if (q.get('transport')) wq.set('transport', q.get('transport')); if (q.get('wt')) wq.set('wt', q.get('wt')); } catch {}
  const workerUrl = './engine-worker.js' + (wq.toString() ? '?' + wq.toString() : '');
  log('[art] channel=' + sel.channel + (sel.pin ? ' · pinned ' + sel.pin : ' · head'));

  canvas.style.cursor = 'none';   // the engine draws the gauntlet; hide the OS arrow
  const off = canvas.transferControlToOffscreen();
  const worker = new Worker(workerUrl, { type: 'module' });
  const send = (m, tr) => worker.postMessage(m, tr || []);
  const inj = (fn, ...a) => send({ t: 'in', fn, a });

  // ── Audio sink (same engine as classic mode, fed by worker messages) ──────
  let ac = null;
  const audioBuffers = new Map();
  const livePlays = new Set();
  const audioFetching = new Set();
  let musicEl = null;
  let playCount = 0;
  const audioCtx = () => {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    return ac;
  };
  function fetchEffect(id) {
    if (audioFetching.has(id)) return;
    audioFetching.add(id);
    (async () => {
      try {
        const resp = await fetch('uo-data/sounds/' + id + '.pcm');
        if (!resp.ok) { audioBuffers.set(id, null); return; }
        const pcm = new Uint8Array(await resp.arrayBuffer());
        const ctx = audioCtx(); if (!ctx) return;
        const n = pcm.byteLength >> 1;
        const buf = ctx.createBuffer(1, n, 22050);
        const ch = buf.getChannelData(0);
        const view = new DataView(pcm.buffer);
        for (let i = 0; i < n; i++) ch[i] = view.getInt16(i << 1, true) / 32768;
        audioBuffers.set(id, buf);
      } catch (e) { log('[audio] fetch ' + id + ' failed: ' + e); }
      finally { audioFetching.delete(id); }
    })();
  }
  const audio = {
    play(id, volume) {
      const buf = audioBuffers.get(id);
      if (buf === undefined) { fetchEffect(id); return; }
      if (buf === null) return;
      const ctx = audioCtx();
      if (!ctx || ctx.state !== 'running') return;
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      src.buffer = buf;
      src.connect(gain).connect(ctx.destination);
      livePlays.add(src);
      src.onended = () => livePlays.delete(src);
      src.start();
      playCount++;
    },
    music(name, volume, loop) {
      const src = 'uo-data/music/' + String(name).toLowerCase() + '.mp3';
      if (!musicEl) { musicEl = new Audio(); musicEl.preload = 'auto'; }
      const want = new URL(src, location.href).href;
      if (musicEl.src !== want) musicEl.src = src;
      musicEl.loop = !!loop;
      musicEl.volume = Math.max(0, Math.min(1, volume));
      musicEl.dataset.wantsPlay = '1';
      musicEl.play().catch(() => {});
    },
    musicStop() { try { if (musicEl) { musicEl.dataset.wantsPlay = '0'; musicEl.pause(); musicEl.removeAttribute('src'); musicEl.load(); } } catch {} },
    musicVolume(v) { try { if (musicEl) musicEl.volume = Math.max(0, Math.min(1, v)); } catch {} },
    stopAll() { for (const s of livePlays) { try { s.stop(); } catch {} } livePlays.clear(); },
  };
  for (const evName of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(evName, () => {
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
      if (musicEl && musicEl.paused && musicEl.dataset.wantsPlay === '1') musicEl.play().catch(() => {});
    }, { passive: true });
  }

  // ── Diagnostics proxies (parity with classic mode) ────────────────────────
  let lastStats = { n: 0 };
  window.__cuoTickStats = () => lastStats;
  window.__cuoAudioStats = () => ({ buffers: audioBuffers.size, plays: playCount,
    ctx: ac ? ac.state : 'none', music: musicEl ? (musicEl.paused ? 'paused' : 'playing') : 'none',
    musicSrc: musicEl ? musicEl.src : null, musicErr: musicEl && musicEl.error ? musicEl.error.code : null });
  window.__cuoWorkerMode = true;

  // ── Worker messages ────────────────────────────────────────────────────────
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'status') statusEl.textContent = m.msg;
    else if (m.t === 'log') log(m.msg);
    else if (m.t === 'phase') log('[phase] ' + m.phase);
    else if (m.t === 'stats') lastStats = m.stats;
    else if (m.t === 'audio') audio[m.op] && audio[m.op](m.id ?? m.name, m.volume, m.loop);
    else if (m.t === 'banner' && m.kind === 'refresh') showRefreshBanner();
    else if (m.t === 'fallback') {
      // no server art: worker mode v1 doesn't carry the folder picker — reload classic
      const u = new URL(location.href); u.searchParams.delete('worker'); location.href = u.href;
    }
    else if (m.t === 'ready') resize();   // initial resize raced the boot — exports exist now
    else if (m.t === 'fatal') {
      log('[fatal] ' + m.msg); statusEl.textContent = '⚠ ' + m.msg;
      // Worker mode is the default now — give a one-click escape hatch.
      const u = new URL(location.href); u.searchParams.set('classic', '1');
      const a = document.createElement('a');
      a.href = u.href; a.textContent = ' → reload in classic mode';
      a.style.color = '#ffd966';
      statusEl.appendChild(a);
    }
  };
  worker.onerror = (e) => { log('[worker error] ' + e.message); statusEl.textContent = '⚠ worker: ' + e.message; };

  function showRefreshBanner() {
    let el = document.getElementById('art-refresh-banner');
    if (!el) {
      el = document.createElement('div'); el.id = 'art-refresh-banner';
      el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99998;background:#1f4d2e;color:#fff;' +
        'font:13px/1.4 system-ui,sans-serif;padding:8px 14px;text-align:center;box-shadow:0 -1px 6px rgba(0,0,0,.5)';
      document.body.appendChild(el);
    }
    el.innerHTML = '✓ Extra animations downloaded — <span style="text-decoration:underline;cursor:pointer" ' +
      'onclick="location.reload()">refresh to enable them</span>' +
      ' &nbsp;<span style="text-decoration:underline;cursor:pointer;opacity:.7" onclick="this.parentElement.remove()">later</span>';
  }

  // ── Input capture → forward (mirrors main.js's mappings) ─────────────────
  const sdlBtn = (b) => (b === 1 ? 2 : b === 2 ? 3 : b === 3 ? 4 : b === 4 ? 5 : 1);
  // In worker mode the engine CANNOT poll a cursor (SDL's DOM listeners don't
  // exist in the worker) — the injected position is the ONLY position source and
  // must stay active permanently. Never call SetTouchPointerActive(false) here
  // (that flips the engine back to the SDL poll, which reads 0,0 — clicks land
  // in the top-left corner; user-reported on first validation).
  const sendPos = (e) => {
    const r = canvas.getBoundingClientRect();
    inj('InjectMousePosition', Math.round(e.clientX - r.left), Math.round(e.clientY - r.top));
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;   // touch handled below
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    sendPos(e);
    inj('InjectMouseButton', sdlBtn(e.button), true);
  });
  canvas.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') { sendPos(e); inj('InjectMouseButton', sdlBtn(e.button), false); } });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    sendPos(e);
    inj('InjectMouseMotion');
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { inj('InjectMouseWheel', e.deltaY < 0 ? 1 : -1); e.preventDefault(); }, { passive: false });

  const SDLK = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Delete: 127, ' ': 32,
    ArrowRight: 0x4000004F, ArrowLeft: 0x40000050, ArrowDown: 0x40000051, ArrowUp: 0x40000052,
    Home: 0x4000004A, End: 0x4000004D, PageUp: 0x4000004B, PageDown: 0x4000004E,
    Shift: 0x400000E1, Control: 0x400000E0, Alt: 0x400000E2 };
  const sdlKeycode = (e) => SDLK[e.key] !== undefined ? SDLK[e.key] : (e.key && e.key.length === 1 ? e.key.toLowerCase().charCodeAt(0) : 0);
  const sdlMod = (e) => (e.shiftKey ? 0x0003 : 0) | (e.ctrlKey ? 0x00C0 : 0) | (e.altKey ? 0x0300 : 0) | (e.metaKey ? 0x0C00 : 0);
  const gameKey = (e) => !e.ctrlKey && !e.metaKey && (e.key.length === 1 || ['Tab', 'Backspace', 'Delete', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key));
  const heldKeys = new Map();
  canvas.addEventListener('keydown', (e) => {
    inj('InjectKey', sdlKeycode(e), sdlMod(e), true);
    heldKeys.set(e.key, sdlKeycode(e));
    if (e.key.length === 1) inj('InjectText', e.key);
    if (gameKey(e)) e.preventDefault();
  });
  canvas.addEventListener('keyup', (e) => { inj('InjectKey', sdlKeycode(e), sdlMod(e), false); heldKeys.delete(e.key); });
  window.addEventListener('blur', () => { for (const [, code] of heldKeys) inj('InjectKey', code, 0, false); heldKeys.clear(); });

  // Touch (mirrors main.js's state machine)
  {
    const WALK_MOVE_PX = 14, DRAG_HOLD_MS = 550, TAP_MAX_MS = 300;
    let t = null;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]; };
    const setPos = (e) => { const [x, y] = pos(e); inj('InjectMousePosition', x, y); inj('InjectMouseMotion'); };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault();
      if (t) {
        if (t.mode === 'walk') inj('InjectMouseButton', 3, false);
        if (t.mode === 'drag') inj('InjectMouseButton', 1, false);
        t.mode = 'cancelled';
        inj('InjectMouseButton', 3, true); inj('InjectMouseButton', 3, false);
        return;
      }
      setPos(e);
      t = { id: e.pointerId, t0: performance.now(), mode: 'pending', x0: e.clientX, y0: e.clientY,
            holdTimer: setTimeout(() => { if (t && t.mode === 'pending') { t.mode = 'drag'; inj('InjectMouseButton', 1, true); } }, DRAG_HOLD_MS) };
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    }, { passive: false });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !t || e.pointerId !== t.id || t.mode === 'cancelled') return;
      e.preventDefault();
      setPos(e);
      if (t.mode === 'pending' && Math.hypot(e.clientX - t.x0, e.clientY - t.y0) > WALK_MOVE_PX) {
        clearTimeout(t.holdTimer);
        t.mode = 'walk';
        inj('InjectMouseButton', 3, true);
      }
    }, { passive: false });
    const endTouch = (e) => {
      if (e.pointerType !== 'touch' || !t || e.pointerId !== t.id) return;
      e.preventDefault();
      clearTimeout(t.holdTimer);
      setPos(e);
      if (t.mode === 'walk') inj('InjectMouseButton', 3, false);
      else if (t.mode === 'drag') inj('InjectMouseButton', 1, false);
      else if (t.mode === 'pending' && performance.now() - t.t0 <= TAP_MAX_MS + DRAG_HOLD_MS) {
        inj('InjectMouseButton', 1, true); inj('InjectMouseButton', 1, false);
      }
      t = null;
      // injection stays active — it's the only position source in worker mode
    };
    canvas.addEventListener('pointerup', endTouch, { passive: false });
    canvas.addEventListener('pointercancel', endTouch, { passive: false });
    if (matchMedia('(pointer: coarse)').matches) {
      const kb = document.createElement('button');
      kb.textContent = '⌨';
      kb.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99997;width:46px;height:46px;border-radius:50%;border:none;background:#3b6ea5;color:#fff;font-size:22px;opacity:.75';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.autocapitalize = 'off'; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.style.cssText = 'position:fixed;bottom:-100px;left:0;width:10px;height:10px;opacity:0';
      kb.addEventListener('click', (e) => { e.preventDefault(); inp.focus(); });
      inp.addEventListener('input', () => { if (inp.value) { inj('InjectText', inp.value); inp.value = ''; } });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Backspace') {
          const code = e.key === 'Enter' ? 13 : 8;
          inj('InjectKey', code, 0, true); inj('InjectKey', code, 0, false);
          e.preventDefault();
        }
      });
      document.body.appendChild(kb);
      document.body.appendChild(inp);
    }
  }

  // Keyboard focus: keep the canvas focused so keys land.
  canvas.tabIndex = 0;
  const focus = () => { try { canvas.focus(); } catch {} };
  focus();
  addEventListener('pointerdown', focus, true);

  // Resize: page drives the worker's backbuffer.
  const resize = () => send({ t: 'resize', w: window.innerWidth, h: window.innerHeight });
  addEventListener('resize', resize);

  // Boot.
  const chunkmesh = new URLSearchParams(location.search).get('chunkmesh') === '1';
  send({ t: 'boot', canvas: off, width: window.innerWidth, height: window.innerHeight, chunkmesh }, [off]);
  resize();
  console.log('[shell] worker mode boot (sprint 9)');
}
