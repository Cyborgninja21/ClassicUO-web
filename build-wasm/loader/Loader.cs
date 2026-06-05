using System;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
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

    // Preload UO art into the in-memory FS at /uo. We use async HttpClient
    // (browser fetch) + synchronous writes rather than WASMFS's fetch backend:
    // the fetch backend needs BLOCKING reads, which are impossible on the
    // single-threaded main thread (celeste gets away with it only because it's
    // threaded). Downloading upfront keeps ClassicUO's later reads synchronous.
    // Only the manifest files are created, so File.Exists probes for absent
    // variants (e.g. .mul when we ship .uop) correctly return false.
    [JSExport]
    public static async Task PreloadUO(string urlBase, string[] files)
    {
        Directory.CreateDirectory("/uo");
        using var http = new HttpClient();
        long total = 0;
        foreach (var f in files)
        {
            if (f == "manifest.json") continue;
            byte[] bytes = await http.GetByteArrayAsync(urlBase + f);
            File.WriteAllBytes("/uo/" + f, bytes);
            total += bytes.Length;
        }
        Console.WriteLine($"[loader] preloaded {files.Length} UO files into /uo ({total / (1024 * 1024)} MB)");
    }

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
