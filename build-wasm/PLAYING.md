# Playing Utumno Online in your browser

A self-hosted browser client for the **Utumno Online** shard (T2A / ModernUO). No
download, no install — it runs in the browser. You supply your own Ultima Online art
files once; everything else is served for you.

## Quick start

1. Go to **https://play.utumno-uo-t2a.epikos-kyklos.com** (internal/LAN this phase).
2. The first time, you'll see **"Load your Ultima Online art"**. Click **Select your UO
   folder** and pick the folder of a UO installation (see below). The files are cached in
   your browser (OPFS) — **nothing is uploaded anywhere**, and you only do this once per
   browser.
3. The client loads and shows the login screen. Sign in with your shard account and play.

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
