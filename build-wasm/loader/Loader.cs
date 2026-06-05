using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Loader;
using System.Runtime.Versioning;

[assembly: SupportedOSPlatform("browser")]

// WASM loader entry for ClassicUO-web (single-threaded).
// Library mode: JS calls Init() then StartClassicUO() via JSExport — we never
// call dotnet.run(), so the runtime does NOT exit and stays alive for FNA's
// emscripten_set_main_loop (FNA 25.09 owns the per-frame loop on browser-wasm).
public static partial class ClassicUOLoader
{
    public static void Main() { /* unused: runtime kept alive via dotnet.create(), not run() */ }

    [JSExport]
    public static void Init()
    {
        Console.WriteLine("[ClassicUOLoader] Init — wasm runtime up");
        // FNA: force the SDL3 backend; map any leftover SDL2 P/Invoke to the linked SDL3.a.
        Environment.SetEnvironmentVariable("FNA_PLATFORM_BACKEND", "SDL3");
        AssemblyLoadContext.Default.ResolvingUnmanagedDll += (assembly, name) =>
        {
            if (name == "SDL2") name = "SDL3";
            return NativeLibrary.Load(name, assembly, null);
        };
    }

    [JSExport]
    public static void StartClassicUO()
    {
        try
        {
            Console.WriteLine("[ClassicUOLoader] starting ClassicUO client...");
            ClassicUO.WebEntry.Start(new string[] { });
            Console.WriteLine("[ClassicUOLoader] ClassicUO.WebEntry.Start returned");
        }
        catch (Exception e)
        {
            Console.WriteLine("[ClassicUOLoader] ClassicUO start ERROR:\n" + e);
        }
    }
}
