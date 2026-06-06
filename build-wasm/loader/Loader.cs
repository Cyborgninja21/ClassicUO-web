using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Loader;
using System.Runtime.Versioning;

[assembly: SupportedOSPlatform("browser")]

// WASM loader entry for ClassicUO-web (single-threaded).
// Library mode: JS calls Init() -> MountUO() -> StartClassicUO() via JSExport.
// We never call dotnet.run() (Main-return exits the runtime); the runtime stays
// alive for FNA's emscripten_set_main_loop (FNA 25.09 owns the per-frame loop).
public static partial class ClassicUOLoader
{
    public static void Main() { /* unused: runtime kept alive via dotnet.create(), not run() */ }

    [JSExport]
    public static void Init()
    {
        Console.WriteLine("[ClassicUOLoader] Init — wasm runtime up");
        Environment.SetEnvironmentVariable("FNA_PLATFORM_BACKEND", "SDL3");
        AssemblyLoadContext.Default.ResolvingUnmanagedDll += (assembly, name) =>
        {
            if (name == "SDL2") name = "SDL3";
            return NativeLibrary.Load(name, assembly, null);
        };

        // Wire ClassicUO's WebSocket seam to the JS WebSocket (see WasmWebSocketBridge):
        // ClientWebSocket's async dies on the threadpool reverse-pinvoke under AOT.
        ClassicUO.Network.Socket.WasmWebSocketBridge.Open = WsOpen;
        ClassicUO.Network.Socket.WasmWebSocketBridge.Send = (data, _) => WsSend(data);
        ClassicUO.Network.Socket.WasmWebSocketBridge.Close = WsClose;
    }

    // --- JS-interop WebSocket. The "uo-ws" module (main.js, setModuleImports) owns a
    // plain JS WebSocket; bytes cross synchronously, no .NET async, no threadpool. ---
    [JSImport("wsOpen", "uo-ws")]
    internal static partial void WsOpen(string url);
    [JSImport("wsSend", "uo-ws")]
    internal static partial void WsSend(byte[] data);
    [JSImport("wsClose", "uo-ws")]
    internal static partial void WsClose();

    [JSExport]
    public static void WsOnOpen() => ClassicUO.Network.Socket.WasmWebSocketBridge.OnOpen?.Invoke();
    [JSExport]
    public static void WsOnMessage(byte[] data) => ClassicUO.Network.Socket.WasmWebSocketBridge.OnMessage?.Invoke(data);
    [JSExport]
    public static void WsOnClose() => ClassicUO.Network.Socket.WasmWebSocketBridge.OnClose?.Invoke();
    [JSExport]
    public static void WsOnError() => ClassicUO.Network.Socket.WasmWebSocketBridge.OnError?.Invoke();

    // UO art preload: JS does the fetch (async, JS-native) and hands each file's
    // bytes to this SYNCHRONOUS writer. No .NET Task/async in the managed path, so
    // there's no interp<->AOT boundary to break when AOT is enabled (the async
    // HttpClient version broke under AOT'd corlib). MEMFS is synchronous to read,
    // so ClassicUO's later file reads work single-threaded. Only the files JS
    // writes exist, so File.Exists probes for absent variants return false.
    [JSExport]
    public static void MkUODir() => Directory.CreateDirectory("/uo");

    [JSExport]
    public static void WriteUOFile(string path, byte[] data) => File.WriteAllBytes(path, data);

    // settingsJson is ClassicUO's settings.json verbatim (ip may be a ws://… URL to
    // dial the WSS proxy; add username/password/autologin to skip the login UI).
    [JSExport]
    public static void StartClassicUO(string settingsJson)
    {
        try
        {
            // settings.json at ExecutablePath (= Environment.CurrentDirectory = "/").
            File.WriteAllText("/settings.json", settingsJson);
            Console.WriteLine("[loader] wrote /settings.json; starting ClassicUO");

            // When the config requests autologin, skip the login screen so the connect
            // fires on a fresh start (ClassicUO's in-Load autologin is gated on
            // SkipLoginScreen, set only by the -skiploginscreen arg).
            var args = new System.Collections.Generic.List<string>();
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(settingsJson);
                if (doc.RootElement.TryGetProperty("autologin", out var al) &&
                    al.ValueKind == System.Text.Json.JsonValueKind.True)
                {
                    args.Add("-skiploginscreen");
                }
            }
            catch { /* settings without autologin: just show the login screen */ }

            // Returns (via unwind) after init now — the WASM main loop is JS-driven via
            // TickFrame(), not emscripten_set_main_loop. main.js starts the rAF pump.
            ClassicUO.WebEntry.Start(args.ToArray());
            Console.WriteLine("[loader] ClassicUO init done — JS now drives frames via TickFrame()");
        }
        catch (Exception e) when (e.Message == null || !e.Message.Contains("unwind"))
        {
            Console.WriteLine("[ClassicUOLoader] ClassicUO start ERROR:\n" + e);
        }
        // An "unwind" exception is FNA handing the stack to the JS event loop after init
        // (see SDL3_FNAPlatform.RunPlatformMainLoop) — let it propagate so main.js starts
        // the rAF frame pump. The game stays alive; JS drives it via TickFrame().
    }

    // One FNA frame (Update + Draw). JS calls this from requestAnimationFrame because
    // single-threaded WASM AOT can't wire emscripten_set_main_loop's reverse-pinvoke
    // callback. Returns false once the game exits so JS can stop the rAF pump.
    [JSExport]
    public static bool TickFrame() => Microsoft.Xna.Framework.WasmMainLoop.Tick();
}
