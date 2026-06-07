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
    }
}
