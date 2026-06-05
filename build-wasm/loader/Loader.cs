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
    }

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

    [JSExport]
    public static void StartClassicUO(string uoDir, string clientVersion, string ip, int port)
    {
        try
        {
            // settings.json at ExecutablePath (= Environment.CurrentDirectory = "/").
            string json =
                "{\"ip\":\"" + ip + "\",\"port\":" + port +
                ",\"ultimaonlinedirectory\":\"" + uoDir + "\"" +
                ",\"clientversion\":\"" + clientVersion + "\"" +
                ",\"lang\":\"ENU\",\"encryption\":0,\"use_verdata\":false}";
            File.WriteAllText("/settings.json", json);
            Console.WriteLine("[loader] wrote /settings.json; starting ClassicUO (uoDir=" + uoDir + " ver=" + clientVersion + ")");
            ClassicUO.WebEntry.Start(new string[] { });
            Console.WriteLine("[loader] ClassicUO.WebEntry.Start returned");
        }
        catch (Exception e)
        {
            Console.WriteLine("[ClassicUOLoader] ClassicUO start ERROR:\n" + e);
        }
    }
}
