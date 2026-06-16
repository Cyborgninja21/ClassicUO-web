// A3 (L1) — in-browser server picker (the launcher UI).
//
// A minimal pre-boot overlay: a dropdown of shard presets + a "Custom server"
// field, a "Play" button, and a "remember" checkbox. Resolves to the same
// endpoint record shard-presets.resolveShard returns, so the boot path stays
// endpoint-driven and transport-agnostic.
//
// The picker is SKIPPED (boot proceeds straight to the resolved shard) when the
// selection is already pinned non-interactively — a ?shard=/?server= query, a
// remembered localStorage choice, or a uo-config.json that names a shard — OR when
// ?picker=0 forces it off. ?picker=1 always shows it. This keeps existing e2e
// harnesses (which drive a fixed uo-config.json) unchanged while giving a human a
// chooser on a fresh visit.

import { buildPresets, resolveShard, findPreset, shardStorageValue, SHARD_STORAGE_KEY } from './shard-presets.js';

// Decide whether the picker should be shown. Pure so it's testable.
//   forced  : ?picker=1 → always show ; ?picker=0 → never show
//   pinned  : a query (?shard=/?server=), remembered choice, or config.shard/
//             shard_url/legacy-ws-ip means "already chosen" → skip.
export function shouldShowPicker(config, search, stored) {
  let q = null;
  try { q = new URLSearchParams(search || ''); } catch {}
  const forced = q && q.get('picker');
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  const c = config || {};
  const queryPin = q && (q.get('shard') || q.get('server'));
  const configPin = c.shard || c.shard_url || (c.ip && /^wss?:\/\//i.test(c.ip));
  if (queryPin || stored || configPin) return false;
  return true;
}

// Read the persisted shard choice (raw string), DOM-side. Safe on no localStorage.
export function readStoredShard() {
  try { return localStorage.getItem(SHARD_STORAGE_KEY) || null; } catch { return null; }
}

// Persist (or clear) the shard choice.
export function persistShard(value) {
  try { if (value) localStorage.setItem(SHARD_STORAGE_KEY, value); else localStorage.removeItem(SHARD_STORAGE_KEY); } catch {}
}

// Resolve the shard WITHOUT showing UI (the non-interactive boot path). Returns the
// endpoint record. Callers in main.js / shell.js use this when shouldShowPicker is
// false so the connect path always has endpoints.
export function resolveShardForBoot(config, search) {
  const presets = buildPresets(config);
  return resolveShard(presets, config, search, readStoredShard());
}

// Show the picker overlay and resolve to the chosen endpoint record. Returns a
// Promise that settles when the user clicks Play. Persists the choice when
// "remember" is checked. Browser-only (uses document); the pure logic above is
// what the tests exercise.
export function showPicker(config, search) {
  const presets = buildPresets(config);
  return new Promise((resolve) => {
    const initial = resolveShard(presets, config, search, readStoredShard());

    const overlay = document.createElement('div');
    overlay.id = 'uo-server-picker';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(8,10,14,.92);font:14px system-ui,sans-serif;color:#e8e8e8';
    const card = document.createElement('div');
    card.style.cssText = 'background:#171a21;border:1px solid #2b313d;border-radius:10px;padding:26px 30px;width:min(420px,90vw);' +
      'box-shadow:0 12px 40px rgba(0,0,0,.6)';
    const title = document.createElement('div');
    title.textContent = 'Choose a shard';
    title.style.cssText = 'font-size:19px;font-weight:600;margin-bottom:4px;color:#9adb9a';
    const sub = document.createElement('div');
    sub.textContent = 'Pick which Utumno Online world to connect to.';
    sub.style.cssText = 'opacity:.7;margin-bottom:18px';

    const select = document.createElement('select');
    select.style.cssText = 'width:100%;padding:9px 10px;border-radius:6px;background:#0e1116;color:#e8e8e8;border:1px solid #313845;font-size:14px';
    for (const p of presets) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name + ' — ' + (p.era || '');
      select.appendChild(o);
    }
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__'; customOpt.textContent = 'Custom server…';
    select.appendChild(customOpt);
    // Preselect the resolved shard (or custom).
    select.value = initial.custom ? '__custom__' : (findPreset(presets, initial.id) ? initial.id : presets[0].id);

    const customWrap = document.createElement('div');
    customWrap.style.cssText = 'margin-top:12px;display:none';
    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = 'wss://host[:port]/uo-ws';
    if (initial.custom) customInput.value = initial.ip;
    customInput.style.cssText = 'width:100%;padding:9px 10px;border-radius:6px;background:#0e1116;color:#e8e8e8;border:1px solid #313845;font-size:13px;box-sizing:border-box';
    const customHint = document.createElement('div');
    customHint.textContent = 'A ws:// or wss:// relay URL for the shard you want to reach.';
    customHint.style.cssText = 'opacity:.55;font-size:12px;margin-top:5px';
    customWrap.appendChild(customInput); customWrap.appendChild(customHint);

    const syncCustom = () => { customWrap.style.display = select.value === '__custom__' ? 'block' : 'none'; };
    select.addEventListener('change', syncCustom);
    syncCustom();

    const rememberWrap = document.createElement('label');
    rememberWrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:16px;opacity:.85;cursor:pointer';
    const remember = document.createElement('input');
    remember.type = 'checkbox'; remember.checked = true;
    const rememberTxt = document.createElement('span');
    rememberTxt.textContent = 'Remember this shard on this device';
    rememberWrap.appendChild(remember); rememberWrap.appendChild(rememberTxt);

    const err = document.createElement('div');
    err.style.cssText = 'color:#ff8e8e;font-size:13px;margin-top:12px;min-height:16px';

    const play = document.createElement('button');
    play.textContent = 'Play';
    play.style.cssText = 'margin-top:18px;width:100%;padding:11px;border:none;border-radius:6px;background:#2e7d46;color:#fff;' +
      'font-size:15px;font-weight:600;cursor:pointer';

    const finish = (resolved) => {
      persistShard(remember.checked ? shardStorageValue(resolved) : null);
      if (!remember.checked) persistShard(null);
      try { overlay.remove(); } catch {}
      resolve(resolved);
    };

    play.addEventListener('click', () => {
      err.textContent = '';
      if (select.value === '__custom__') {
        const url = (customInput.value || '').trim();
        if (!/^wss?:\/\//i.test(url)) { err.textContent = 'Enter a ws:// or wss:// URL.'; return; }
        finish(resolveShard(presets, config, '?server=' + encodeURIComponent(url), null));
      } else {
        finish(resolveShard(presets, config, '?shard=' + encodeURIComponent(select.value), null));
      }
    });

    card.appendChild(title); card.appendChild(sub); card.appendChild(select);
    card.appendChild(customWrap); card.appendChild(rememberWrap); card.appendChild(err); card.appendChild(play);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    try { select.focus(); } catch {}
  });
}
