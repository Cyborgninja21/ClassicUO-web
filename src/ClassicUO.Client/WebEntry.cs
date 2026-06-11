// SPDX-License-Identifier: BSD-2-Clause
//
// Public entry point for the WASM/browser loader. `Bootstrap` is internal, so
// the out-of-assembly loader can't call Boot() directly; this thin public shim
// (same assembly, so it can reach internal Bootstrap) is the seam. Desktop
// builds are unaffected — nothing references this.
using System;
using static SDL3.SDL;

namespace ClassicUO
{
    public static class WebEntry
    {
        public static void Start(string[] args)
        {
            // Browser input wiring — MUST run before Bootstrap.Boot creates the SDL window.
            // SDL3's emscripten backend defaults its keyboard listener target to the selector
            // "#window", which document.querySelector('#window') resolves to null, so SDL bails
            // and NO keydown/keyup listener is ever attached (keys fall through to <body>).
            // Point the keyboard element AND canvas selector at our real #canvas so keyboard
            // attaches and pointer events bind to the right element.
            if (OperatingSystem.IsBrowser())
            {
                SDL_SetHint(SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT, "#canvas");
                SDL_SetHint(SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR, "#canvas");
            }

            Bootstrap.Boot(null, args);
        }

        // Public seam for the out-of-assembly loader's SetCanvasSize JSExport — it can't
        // reach internal Client.Game directly. Drives ClassicUO's normal window-resize path
        // so the canvas/backbuffer track the browser viewport (clicks land on #canvas, 1:1).
        public static void SetCanvasSize(int width, int height)
        {
            if (OperatingSystem.IsBrowser())
            {
                Client.Game?.SetWindowSize(width, height);
                Client.Game?.MaximizeGameWindow();   // refill the world viewport to the new size
            }
        }

        // Public seams for the loader's input-injection JSExports (Client.Game is internal).
        // JS feeds canvas mouse input here because SDL's emscripten event callbacks don't
        // enqueue discrete events under WASM AOT.
        public static void InjectMouseButton(int sdlButton, bool down) => Client.Game?.InjectMouseButton(sdlButton, down);
        public static void InjectMouseWheel(int dy) => Client.Game?.InjectMouseWheel(dy);
        public static void InjectMouseMotion() => Client.Game?.InjectMouseMotion();
        public static void InjectKey(int keycode, int mod, bool down) => Client.Game?.InjectKey(keycode, mod, down);
        public static void InjectText(string text) => Client.Game?.InjectText(text);

        // A/B lever for the GPU chunk-mesh renderer (off by default in-browser — see
        // ChunkMesh.DisableChunkMesh). The loader calls this from main.js when the page
        // URL carries ?chunkmesh=1, so dense-scene perf comparisons need no rebuild.
        public static void SetChunkMeshEnabled(bool enabled)
        {
            Game.Map.ChunkMesh.DisableChunkMesh = !enabled;
        }
    }
}
