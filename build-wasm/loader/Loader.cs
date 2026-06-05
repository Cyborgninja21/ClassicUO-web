using System;
using System.Runtime.InteropServices.JavaScript;

// First-cut WASM loader entry. Smoke-test target: prove the matched custom
// .NET 10 runtime + frozen emsdk + FNA native libs link and the runtime boots
// in-browser. Next steps (see ../BUILD-WASM.md): mount OPFS (Emscripten.c
// DllImports), then init FNA + call ClassicUO's Bootstrap.Boot.
public static partial class ClassicUOLoader
{
    public static void Main()
    {
        Console.WriteLine("[ClassicUOLoader] managed Main reached — wasm runtime booted");
    }

    [JSExport]
    public static string Ping() => "pong from ClassicUO-web wasm loader";
}
