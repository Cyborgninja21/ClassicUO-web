// SPDX-License-Identifier: BSD-2-Clause

using ClassicUO.Network.Encryption;
using ClassicUO.Utility;
using ClassicUO.Utility.Logging;
using System;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using ClassicUO.Network.Socket;

namespace ClassicUO.Network
{
    internal sealed class NetClient
    {
        private const int BUFF_SIZE = 0x10000;

        private readonly byte[] _compressedBuffer = new byte[4096];
        private readonly byte[] _uncompressedBuffer = new byte[BUFF_SIZE];
        private readonly byte[] _sendingBuffer = new byte[4096];
        private readonly Huffman _huffman = new Huffman();
        private bool _isCompressionEnabled;
        private uint? _localIP;
        private readonly CircularBuffer _sendStream;
        private SocketWrapper _socket = null;
        private SocketWrapperType? _socketType;
        // §2.1 mode (a): the configured WSS endpoint to always re-dial in WebSocket mode.
        // ClassicUO-web: static so the relay URL survives any NetClient/_socketType reset
        // (a re-login or a reconnect must always be able to re-dial the wss:// relay).
        private static Uri _wsUri;


        public NetClient()
        {
            Statistics = new NetStatistics(this);
            _sendStream = new CircularBuffer();
        }

        public static NetClient Socket { get; private set; } = new();

        public EncryptionType Load(ClientVersion clientVersion, EncryptionType encryption)
        {
            PacketsTable = new PacketsTable(clientVersion);

            if (encryption != 0)
            {
                Encryption = new EncryptionHelper(clientVersion);
                Log.Trace("Calculating encryption by client version...");
                Log.Trace($"encryption: {Encryption.EncryptionType}");

                if (Encryption.EncryptionType != encryption)
                {
                    Log.Warn($"Encryption found: {Encryption.EncryptionType}");
                    encryption = Encryption.EncryptionType;
                }
            }

            return encryption;
        }


        public bool IsConnected => _socket != null && _socket.IsConnected;
        public NetStatistics Statistics { get; }
        public EncryptionHelper? Encryption { get; private set; }
        public PacketsTable PacketsTable { get; private set; }

        public uint LocalIP
        {
            get
            {
                if (!_localIP.HasValue)
                {
                    try
                    {
                        byte[] addressBytes = (_socket?.LocalEndPoint as IPEndPoint)?.Address.MapToIPv4().GetAddressBytes();

                        if (addressBytes != null && addressBytes.Length != 0)
                        {
                            _localIP = (uint)(addressBytes[0] | (addressBytes[1] << 8) | (addressBytes[2] << 16) | (addressBytes[3] << 24));
                        }

                        if (!_localIP.HasValue || _localIP == 0)
                        {
                            _localIP = 0x100007f;
                        }
                    }
                    catch (Exception ex)
                    {
                        Log.Error($"error while retriving local endpoint address: \n{ex}");

                        _localIP = 0x100007f;
                    }
                }

                return _localIP.Value;
            }
        }


        public event EventHandler Connected;
        public event EventHandler<SocketError> Disconnected;

        private void SetupSocket(SocketWrapperType wrapperType)
        {
            _socket?.Dispose();

            _socket = wrapperType switch
            {
                SocketWrapperType.TcpSocket => new TcpSocketWrapper(),
                SocketWrapperType.WebSocket => new WebSocketWrapper(),
                _ => throw new ArgumentOutOfRangeException(nameof(wrapperType), wrapperType, null)
            };

            _socket.OnConnected += (o, e) =>
            {
                Statistics.Reset();
                Connected?.Invoke(this, EventArgs.Empty);
            };

            _socket.OnDisconnected += (_, _) => Disconnected?.Invoke(this, SocketError.Success);
            _socket.OnError += (_, e) => Disconnected?.Invoke(this, e);
        }

        public void Connect(string ip, ushort port)
        {
            _sendStream.Clear();
            _huffman.Reset();
            Statistics.Reset();

            if (string.IsNullOrEmpty(ip))
                throw new ArgumentNullException(nameof(ip));

            var isWebsocketAddress = ip.ToLowerInvariant().StartsWith("ws");

            // §2.1 mode (a): once we're on WebSocket, every reconnect re-dials the one
            // configured WSS endpoint. The login->game relay (0x8C) hands us the game
            // server's RAW IP, but a browser can only re-open a WebSocket URL — so ignore
            // the relay host and reuse the original WSS URI (the proxy opens a fresh TCP
            // to the game port per WS connection, so this just works).
            // ClassicUO-web: in a browser the ONLY usable transport is the wss:// relay — a raw
            // TCP socket is impossible. So ANY non-ws address (the 0x8C relay's game IP, OR a
            // manual re-login whose Settings.IP was overwritten by that relay) must re-dial the
            // stored relay URL. Keyed on IsBrowser() (not the fragile _socketType, which a reset
            // can flip back to TcpSocket and strand the client dialing tcp:// forever).
            if (OperatingSystem.IsBrowser() && !isWebsocketAddress && _wsUri != null)
            {
                Log.Trace($"WS mode: ignoring relay {ip}:{port}; re-dialing {_wsUri}");
                SetupSocket(SocketWrapperType.WebSocket);
                _socket.Connect(_wsUri);
                return;
            }

            // For a ws/wss address use it verbatim (it carries scheme + optional port/path);
            // a bare host gets the tcp:// scheme + port.
            var addr = isWebsocketAddress ? ip : $"tcp://{ip}:{port}";

            if (!Uri.TryCreate(addr, UriKind.RelativeOrAbsolute, out var uri))
                throw new UriFormatException($"NetClient::Connect() invalid Uri {addr}");

            Log.Trace($"Connecting to {uri}");

            if (isWebsocketAddress)
                _wsUri = uri;

            // First connected socket sets the type for any future sockets.
            // This prevents the client from swapping from WS -> TCP on game server login
            SetupSocket(_socketType ??= isWebsocketAddress ? SocketWrapperType.WebSocket : SocketWrapperType.TcpSocket);
            _socket.Connect(uri);
        }

        public void Disconnect()
        {
            _isCompressionEnabled = false;
            Statistics.Reset();
            _socket.Disconnect();
        }

        public void EnableCompression()
        {
            _isCompressionEnabled = true;
            _huffman.Reset();
            _sendStream.Clear();
        }


        public ArraySegment<byte> CollectAvailableData()
        {
            if (_socket == null)
            {
                return ArraySegment<byte>.Empty;
            }

            try
            {
                var size = _socket.Read(_compressedBuffer);

                if (size <= 0)
                {
                    return ArraySegment<byte>.Empty;
                }

                Statistics.TotalBytesReceived += (uint)size;

                var segment = new ArraySegment<byte>(_compressedBuffer, 0, size);
                var span = _compressedBuffer.AsSpan(0, size);

                ProcessEncryption(span);

                return DecompressBuffer(segment);
            }
            catch (SocketException ex)
            {
                Log.Error("socket error when receving:\n" + ex);

                Disconnect();
                Disconnected?.Invoke(this, ex.SocketErrorCode);
            }
            catch (Exception ex)
            {
                if (ex.InnerException is SocketException socketEx)
                {
                    Log.Error("main exception:\n" + ex);
                    Log.Error("socket error when receving:\n" + socketEx);

                    Disconnect();
                    Disconnected?.Invoke(this, socketEx.SocketErrorCode);
                }
                else
                {
                    Log.Error("fatal error when receving:\n" + ex);

                    Disconnect();
                    Disconnected?.Invoke(this, SocketError.SocketError);

                    throw;
                }
            }

            return ArraySegment<byte>.Empty;
        }

        public void Flush()
        {
            ProcessSend();
            Statistics.Update();
        }

        public void Send(Span<byte> message, bool ignorePlugin = false, bool skipEncryption = false)
        {
            if (!IsConnected || message.IsEmpty)
            {
                return;
            }

            if (!ignorePlugin && !Plugin.ProcessSendPacket(ref message))
            {
                return;
            }

            if (message.IsEmpty)
                return;

            PacketLogger.Default?.Log(message, true);

            if (!skipEncryption)
            {
                Encryption?.Encrypt(!_isCompressionEnabled, message, message, message.Length);
            }

            lock (_sendStream)
            {
                //_socket.Send(data, 0, length);
                _sendStream.Enqueue(message);
            }

            Statistics.TotalBytesSent += (uint)message.Length;
            Statistics.TotalPacketsSent++;
        }

        private void ProcessEncryption(Span<byte> buffer)
        {
            if (!_isCompressionEnabled)
                return;

            Encryption?.Decrypt(buffer, buffer, buffer.Length);
        }

        private void ProcessSend()
        {
            if (!IsConnected)
                return;

            try
            {
                lock (_sendStream)
                {
                    while (_sendStream.Length > 0)
                    {
                        var read = _sendStream.Dequeue(_sendingBuffer, 0, _sendingBuffer.Length);

                        if (read <= 0)
                        {
                            break;
                        }

                        _socket.Send(_sendingBuffer, 0, read);
                    }
                }
            }
            catch (SocketException ex)
            {
                Log.Error("socket error when sending:\n" + ex);

                Disconnect();
                Disconnected?.Invoke(this, ex.SocketErrorCode);
            }
            catch (Exception ex)
            {
                if (ex.InnerException is SocketException socketEx)
                {
                    Log.Error("main exception:\n" + ex);
                    Log.Error("socket error when sending:\n" + socketEx);

                    Disconnect();
                    Disconnected?.Invoke(this, socketEx.SocketErrorCode);
                }
                else
                {
                    Log.Error("fatal error when sending:\n" + ex);

                    Disconnect();
                    Disconnected?.Invoke(this, SocketError.SocketError);

                    throw;
                }
            }
        }

        private ArraySegment<byte> DecompressBuffer(ArraySegment<byte> buffer)
        {
            if (!_isCompressionEnabled)
                return buffer;

            var size = 65536;

            if (!_huffman.Decompress(buffer, _uncompressedBuffer, ref size))
            {
                Disconnect();
                Disconnected?.Invoke(this, SocketError.SocketError);

                return ArraySegment<byte>.Empty;
            }

            return new ArraySegment<byte>(_uncompressedBuffer, 0, size);
        }
    }
}