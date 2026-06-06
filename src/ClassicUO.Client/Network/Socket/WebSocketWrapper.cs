using System;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using ClassicUO.Utility.Logging;
using TcpSocket = System.Net.Sockets.Socket;
using static System.Buffers.ArrayPool<byte>;

namespace ClassicUO.Network.Socket;

/// <summary>
/// Handles websocket connections to shards that support it. `ws(s)://[hostname]` as the ip in settings.json.
/// For testing see `tools/ws/README.md` 
/// </summary>
sealed class WebSocketWrapper : SocketWrapper
{
    private const int MAX_RECEIVE_BUFFER_SIZE = 1024 * 1024; // 1MB
    private const int WS_KEEP_ALIVE_INTERVAL = 5;            // seconds

    private ClientWebSocket _webSocket;
    private TcpSocket _rawSocket;
    private bool _browserConnected;
    private bool _browserConnecting;

    public override bool IsConnected => OperatingSystem.IsBrowser()
        ? (_browserConnected || _browserConnecting)
        : (_webSocket?.State is WebSocketState.Connecting or WebSocketState.Open);
    public override EndPoint LocalEndPoint => _rawSocket?.LocalEndPoint;
    public bool IsCanceled => _tokenSource.IsCancellationRequested;

    private CancellationTokenSource _tokenSource = new();
    private CircularBuffer _receiveStream;

    public override void Connect(Uri uri)
    {
        // Browser: drive a plain JS WebSocket through WasmWebSocketBridge. ClientWebSocket's
        // async would queue continuations on the .NET-WASM threadpool, whose background-job
        // reverse-pinvoke trampoline mismatches under AOT and kills the runtime on connect.
        // The bridge is fully synchronous + event-driven — no .NET async, no threadpool.
        if (OperatingSystem.IsBrowser())
        {
            ConnectBrowser(uri);
            return;
        }

        ConnectAsync(uri, _tokenSource).Wait();
    }

    private void ConnectBrowser(Uri uri)
    {
        _receiveStream = new CircularBuffer();
        _browserConnected = false;
        _browserConnecting = true;

        if (WasmWebSocketBridge.Open == null)
        {
            Log.Error("WasmWebSocketBridge not wired by the loader — cannot open a WebSocket in wasm");
            _browserConnecting = false;
            InvokeOnError(SocketError.SocketError);
            return;
        }

        WasmWebSocketBridge.OnOpen = () =>
        {
            _browserConnected = true;
            _browserConnecting = false;
            Log.Trace($"Connected WebSocket (browser): {uri}");
            InvokeOnConnected();
        };
        WasmWebSocketBridge.OnMessage = data =>
        {
            if (data == null || data.Length == 0)
                return;
            lock (_receiveStream)
            {
                _receiveStream.Enqueue(data, 0, data.Length);
            }
        };
        WasmWebSocketBridge.OnClose = () =>
        {
            bool wasUp = _browserConnected || _browserConnecting;
            _browserConnected = false;
            _browserConnecting = false;
            if (wasUp && !IsCanceled)
                InvokeOnError(SocketError.ConnectionReset);
        };
        WasmWebSocketBridge.OnError = () =>
        {
            _browserConnected = false;
            _browserConnecting = false;
            InvokeOnError(SocketError.SocketError);
        };

        Log.Trace($"Connecting to {uri} (browser JS WebSocket)");
        WasmWebSocketBridge.Open(uri.ToString());
    }

    public override void Send(byte[] buffer, int offset, int count)
    {
        if (OperatingSystem.IsBrowser())
        {
            // Synchronous hand-off to the JS WebSocket (no .NET async / threadpool).
            if (!_browserConnected || WasmWebSocketBridge.Send == null)
                return;
            byte[] frame;
            if (offset == 0 && count == buffer.Length)
            {
                frame = buffer;
            }
            else
            {
                frame = new byte[count];
                Buffer.BlockCopy(buffer, offset, frame, 0, count);
            }
            WasmWebSocketBridge.Send(frame, count);
            return;
        }

        var copy = Shared.Rent(count);
        Buffer.BlockCopy(buffer, offset, copy, 0, count);
        SendCopyAsync(copy, count);
    }

    private async void SendCopyAsync(byte[] copy, int count)
    {
        try
        {
            await _webSocket.SendAsync(copy.AsMemory().Slice(0, count), WebSocketMessageType.Binary, true, _tokenSource.Token);
        }
        finally
        {
            Shared.Return(copy);
        }
    }

    public override int Read(byte[] buffer)
    {
        lock (_receiveStream)
        {
            return _receiveStream.Dequeue(buffer, 0, buffer.Length);
        }
    }

    public async Task ConnectAsync(Uri uri, CancellationTokenSource tokenSource = null)
    {
        if (IsConnected)
            return;

        _tokenSource = tokenSource ?? new CancellationTokenSource();
        _receiveStream = new CircularBuffer();

        try
        {
            await ConnectWebSocketAsyncCore(uri);

            if (IsConnected)
                InvokeOnConnected();
            else
                InvokeOnError(SocketError.NotConnected);
        }
        catch (WebSocketException ex)
        {
            SocketError error = ex.InnerException?.InnerException switch
            {
                SocketException socketException => socketException.SocketErrorCode,
                _ => SocketError.SocketError
            };

            Log.Error($"Error {ex.GetType().Name} {error} while connecting to {uri} {ex}");
            InvokeOnError(error);
        }
        catch (Exception ex)
        {
            Log.Error($"Unknown Error {ex.GetType().Name} while connecting to {uri} {ex}");
            InvokeOnError(SocketError.SocketError);
        }
    }


    private async Task ConnectWebSocketAsyncCore(Uri uri)
    {
        _webSocket = new ClientWebSocket();

        if (OperatingSystem.IsBrowser())
        {
            // Browser: the JS WebSocket owns the connection. The desktop path below
            // (custom raw TcpSocket + SocketsHttpHandler for NoDelay/Available peeking)
            // is unsupported in wasm, and ClientWebSocket.Options are mostly no-ops here.
            await _webSocket.ConnectAsync(uri, _tokenSource.Token);
            Log.Trace($"Connected WebSocket (browser): {uri}");
            StartReceiveAsync().ConfigureAwait(false);
            return;
        }

        // Take control of creating the raw socket, turn off Nagle, also lets us peek at `Available` bytes.
        _rawSocket = new TcpSocket(SocketType.Stream, ProtocolType.Tcp)
        {
            NoDelay = true
        };

        _webSocket.Options.KeepAliveInterval = TimeSpan.FromSeconds(WS_KEEP_ALIVE_INTERVAL); // ping/pong

        using var httpClient = new HttpClient
        (
            new SocketsHttpHandler
            {
                ConnectCallback = async (context, token) =>
                {
                    try
                    {
                        await _rawSocket.ConnectAsync(context.DnsEndPoint, token);

                        return new NetworkStream(_rawSocket, ownsSocket: true);
                    }
                    catch
                    {
                        _rawSocket?.Dispose();
                        _rawSocket = null;
                        _webSocket?.Dispose();
                        _webSocket = null;

                        throw;
                    }
                }
            }
        );


        await _webSocket.ConnectAsync(uri, httpClient, _tokenSource.Token);

        Log.Trace($"Connected WebSocket: {uri}");

        // Kicks off the async receiving loop 
        StartReceiveAsync().ConfigureAwait(false);
    }

    private async Task StartReceiveAsync()
    {
        var buffer = Shared.Rent(4096);
        var memory = buffer.AsMemory();
        var position = 0;

        try
        {
            while (IsConnected)
            {
                GrowReceiveBufferIfNeeded(ref buffer, ref memory, position);

                var receiveResult = await _webSocket.ReceiveAsync(memory.Slice(position), _tokenSource.Token);

                // Ignoring message types:
                // 1. WebSocketMessageType.Text: shouldn't be sent by the server, though might be useful for multiplexing commands
                // 2. WebSocketMessageType.Close: will be handled by IsConnected
                if (receiveResult.MessageType == WebSocketMessageType.Binary)
                    position += receiveResult.Count;

                if (!receiveResult.EndOfMessage)
                    continue;

                lock (_receiveStream)
                {
                    _receiveStream.Enqueue(buffer, 0, position);
                }

                position = 0;
            }
        }
        catch (OperationCanceledException)
        {
            Log.Trace("WebSocket OperationCanceledException on websocket " + (IsCanceled ? "(was requested)" : "(remote cancelled)"));
        }
        catch (Exception e)
        {
            Log.Trace($"WebSocket error in StartReceiveAsync {e}");
            InvokeOnError(SocketError.SocketError);
        }
        finally
        {
            Shared.Return(buffer);
        }

        if (!IsCanceled)
            InvokeOnError(SocketError.ConnectionReset);
    }

    // This is probably unnecessary, but WebSocket frames can be up to 2^63 bytes so we put some cap on it, yet to see packets larger than 4KB come through.
    // We peek the raw tcp socket available bytes, grow if the frame is bigger, we're naively assuming no compression.
    private void GrowReceiveBufferIfNeeded(ref byte[] buffer, ref Memory<byte> memory, int position)
    {
        if (OperatingSystem.IsBrowser())
        {
            // No raw socket to peek in the browser; grow when within one chunk of the
            // end, preserving the already-received bytes [0..position).
            const int MIN_FREE = 4096;
            if (buffer.Length - position >= MIN_FREE)
                return;
            int newSize = Math.Min(Math.Max(buffer.Length * 2, position + MIN_FREE), MAX_RECEIVE_BUFFER_SIZE);
            if (newSize <= buffer.Length)
                throw new SocketException((int)SocketError.MessageSize, $"WebSocket message frame too large: > {MAX_RECEIVE_BUFFER_SIZE}");
            var grown = Shared.Rent(newSize);
            Buffer.BlockCopy(buffer, 0, grown, 0, position);
            Shared.Return(buffer);
            buffer = grown;
            memory = buffer.AsMemory();
            return;
        }

        if (_rawSocket.Available <= buffer.Length)
            return;

        if (_rawSocket.Available > MAX_RECEIVE_BUFFER_SIZE)
            throw new SocketException((int)SocketError.MessageSize, $"WebSocket message frame too large: {_rawSocket.Available} > {MAX_RECEIVE_BUFFER_SIZE}");

        Log.Trace($"WebSocket growing receive buffer {buffer.Length} bytes to {_rawSocket.Available} bytes");

        Shared.Return(buffer);
        buffer = Shared.Rent(_rawSocket.Available);
        memory = buffer.AsMemory();
    }

    public override void Disconnect()
    {
        if (OperatingSystem.IsBrowser())
        {
            _browserConnected = false;
            _browserConnecting = false;
            try { WasmWebSocketBridge.Close?.Invoke(); } catch { }
            _tokenSource?.Cancel();
            return;
        }

        if (!IsConnected)
            return;

        try
        {
            _webSocket?.CloseAsync(WebSocketCloseStatus.NormalClosure, "Disconnect", CancellationToken.None)
                .ContinueWith(_ => _tokenSource?.Cancel());
        }
        catch
        {
            _tokenSource?.Cancel();
        }
    }

    public override void Dispose()
    {
    }
}