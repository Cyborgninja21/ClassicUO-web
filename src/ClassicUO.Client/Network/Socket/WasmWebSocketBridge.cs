using System;

namespace ClassicUO.Network.Socket
{
    /// <summary>
    /// JS-interop WebSocket seam for single-threaded WASM AOT.
    ///
    /// <see cref="System.Net.WebSockets.ClientWebSocket"/>'s async runs continuations on
    /// the .NET-WASM threadpool, whose background-job reverse-pinvoke trampoline
    /// (<c>wasm_native_to_interp_…ThreadPool_BackgroundJobHandler</c>) mismatches under AOT
    /// and kills the runtime the moment the socket connects. So on browser the WASM loader
    /// (which owns JS interop) implements <see cref="Open"/>/<see cref="Send"/>/<see cref="Close"/>
    /// via JSImport against a plain JS <c>WebSocket</c>, and raises <see cref="OnOpen"/>/
    /// <see cref="OnMessage"/>/<see cref="OnClose"/>/<see cref="OnError"/> from its events —
    /// all synchronous, on the main thread, with no .NET async and no threadpool.
    ///
    /// Desktop never touches this (the delegates stay null; <see cref="WebSocketWrapper"/>
    /// keeps its <c>ClientWebSocket</c> path off-browser).
    /// </summary>
    public static class WasmWebSocketBridge
    {
        // Wired by the WASM loader at startup; null on desktop.
        public static Action<string> Open;
        public static Action<byte[], int> Send;
        public static Action Close;

        // Raised by the WASM loader from the JS WebSocket's events.
        public static Action OnOpen;
        public static Action<byte[]> OnMessage;
        public static Action OnClose;
        public static Action OnError;
    }
}
