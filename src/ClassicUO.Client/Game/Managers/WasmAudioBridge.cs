// SPDX-License-Identifier: BSD-2-Clause
//
// Browser (WASM) audio bridge — the WebSocket-bridge pattern applied to sound.
//
// FNA's DynamicSoundEffectInstance streams through a BufferNeeded reverse-pinvoke
// from FAudio that hangs the single-threaded WASM runtime, so AudioManager keeps
// _canReproduceAudio=false in-browser and routes through these delegates instead.
// The loader assembly wires them to [JSImport]s of the "uo-audio" JS module
// (main.js), where a WebAudio AudioContext plays sound-effect PCM and an
// HTMLAudioElement streams the mp3 music — the browser does the audio work, the
// same inversion as the WS bridge, the PNG decode, and the login background.
//
// Sound effects cross as just (id, volume): JS lazy-fetches the raw PCM from
// /uo-data/sounds/<id>.pcm (extracted server-side from the sound UOP by the
// load-art harness) and caches decoded AudioBuffers. The UOP itself must NEVER
// enter MEMFS — every MEMFS byte is wasm-heap, and the 161 MB file pushed the
// heap past Firefox's growth ceiling (2026-06-11 live crash). Music crosses as
// just a name — JS streams /uo-data/music/<name>.mp3.
using System;

namespace ClassicUO.Game.Managers
{
    public static class WasmAudioBridge
    {
        // Wired by the loader's Init() to the uo-audio JSImports. Null on desktop.
        public static Action<int, float> PlayEffect;             // id, volume 0..1
        public static Action<string, float, bool> PlayMusic;     // name (no ext), volume, loop
        public static Action StopMusic;
        public static Action<float> SetMusicVolume;
        public static Action StopAllEffects;

        public static bool Available => PlayEffect != null;

        /// <summary>
        /// Plays a sound effect by UO sound id. Volume is the final effective value
        /// (distance attenuation already applied). JS owns fetch/decode/caching.
        /// </summary>
        public static void Effect(int index, float volume)
        {
            if (!Available || volume <= 0f)
            {
                return;
            }

            PlayEffect(index, Math.Clamp(volume, 0f, 1f));
        }
    }
}
