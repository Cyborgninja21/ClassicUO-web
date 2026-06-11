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
// Sound effects are raw 16-bit mono PCM @ 22050 Hz out of soundLegacyMUL.uop
// (SoundsLoader strips the 40-byte name header). PCM crosses the boundary ONCE
// per sound id (RegisterEffect); JS caches the decoded AudioBuffer and replays
// by id. Music crosses as just a name — JS streams /uo-data/music/<name>.mp3.
using System;
using System.Collections.Generic;

namespace ClassicUO.Game.Managers
{
    public static class WasmAudioBridge
    {
        // Wired by the loader's Init() to the uo-audio JSImports. Null on desktop.
        public static Action<int, byte[], int> RegisterEffect;   // id, pcm16 mono, frequency
        public static Action<int, float> PlayEffect;             // id, volume 0..1
        public static Action<string, float, bool> PlayMusic;     // name (no ext), volume, loop
        public static Action StopMusic;
        public static Action<float> SetMusicVolume;
        public static Action StopAllEffects;

        public static bool Available => PlayEffect != null;

        private static readonly HashSet<int> _registered = new();

        /// <summary>
        /// Plays a sound effect by UO sound id, shipping the PCM to JS on first use.
        /// Volume is the final effective value (distance attenuation already applied).
        /// </summary>
        public static void Effect(int index, float volume)
        {
            if (!Available || volume <= 0f)
            {
                return;
            }

            if (_registered.Add(index))
            {
                if (Client.Game.UO.FileManager.Sounds.TryGetSound(index, out byte[] pcm, out string _) &&
                    pcm != null && pcm.Length > 0)
                {
                    RegisterEffect?.Invoke(index, pcm, 22050);
                }
                else
                {
                    // Absent sound (trimmed art set) — remember so we don't re-probe.
                    return;
                }
            }

            PlayEffect(index, Math.Clamp(volume, 0f, 1f));
        }
    }
}
