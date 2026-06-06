# Playing Utumno Online in your browser

A self-hosted browser client for the **Utumno Online** shard (T2A / ModernUO). No
download, no install — it runs in the browser. You supply your own Ultima Online art
files once; everything else is served for you.

## Quick start

1. Go to **https://play.utumno-uo-t2a.epikos-kyklos.com** (internal/LAN this phase).
2. **On the homelab instance the art is already provided for you** — the page downloads it
   once (a progress line shows "downloading art (one time)…"), caches it in your browser
   (OPFS), and goes straight to the login screen. No folder picking. The download only
   happens the first time per browser; later visits load instantly from the cache.
3. Sign in with your shard account and play.

> **If you self-host (or the server art isn't available)** you'll instead see **"Load your
> Ultima Online art"** — click **Select your UO folder** and pick a UO installation (see
> below). Same OPFS caching, **nothing is uploaded anywhere**, one time per browser.

## What art do I need?

The client needs the data files from a **UO Classic Client, T2A-era (client 7.0.x)**
installation — the same files the desktop ClassicUO uses. Get the official client from
Broadsword/EA's *Ultima Online: Classic Client* installer, or point at an existing UO
install you already have. You don't need to run it — just point the picker at its folder.

**Required** (the client won't start without these): the map/art/gump/font/hue/cliloc/
tiledata set — `map0LegacyMUL.uop`, `artLegacyMUL.uop`, `gumpartLegacyMUL.uop`,
`statics0.mul`, `staidx0.mul`, `texmaps.mul`, `tiledata.mul`, `hues.mul`, `radarcol.mul`,
`Cliloc.enu`, the `unifont*.mul` / `fonts.mul` fonts, and a few `.def`/`.uop` indexes (34
files total). If your folder is missing some, the picker tells you which.

**Optional** (loaded if present — needed to *see* mobiles/items animate): the animation
frames — `AnimationFrame1.uop`…`AnimationFrame4.uop` (modern) or `anim*.mul` (legacy), and
`multi*`. Without them the world still renders (terrain, statics) — characters/creatures
just won't draw.

## Notes

- **It's one-time.** The art is cached in your browser's private storage (OPFS). Clearing
  site data makes the picker appear again.
- **Nothing is uploaded.** The art never leaves your machine; the page reads it locally.
- **Firefox + Chromium both work.** The picker uses a folder `<input>`, not the
  Chrome-only directory API.
- **A black game world** after login usually means your folder is missing the animation
  frames (mobiles can't draw) — re-pick a complete UO install.
- The client force-talks to the shard over a WebSocket proxy; you don't configure a server
  address.

## For operators

Build/deploy lives in `build-wasm/` (see `BUILD-WASM.md`) + the homelab stacks
`utumno-uo-t2a-web` / `-wsproxy` / `-diag`. Plan: `Utumno-iac/plans/utumno-uo-t2a-web-client.md`.

**Operator-hosted art (zero-setup, Plan W7).** The page serves a curated UO-art set from
`/uo-data/` so LAN players skip the picker. Populate it from a UO Classic client install
on the serving host with the Utumno-iac harness:

```
task utumno-uo:web:load-art CONFIRM_PROD=yes            # default source: /opt/utumno-uo-t2a-data
task utumno-uo:web:load-art SRC=/path/to/uo CONFIRM_PROD=yes
```

It copies only the art files (34 required + animations — never `client.exe` or server
internals) into the read-only `/uo-data/` bind-mount and writes `manifest.json`. Idempotent.
If `/uo-data/` is empty/absent the page cleanly falls back to the player folder picker.
