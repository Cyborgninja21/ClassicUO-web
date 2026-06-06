#!/usr/bin/env python3
"""Standalone WS<->TCP bridge for the W3 end-to-end test (browser client -> shard).
ws://127.0.0.1:8770/ <-> tcp 172.16.2.154:2593. Single fixed target (not an open relay).

Logs each connection lifecycle + the first byte/length of every frame in each direction
(the dev version of the W4 wsproxy structured logs, plan §3.5 Layer 3). UO packet opcodes
are the first byte, so this shows the handshake: 0x80 account login, 0xA8 server list,
0xA0 select, 0x8C relay, 0x91 game login, 0xA9 char list."""
import asyncio, sys, websockets
GAME = ("172.16.2.154", 2593)
_conn = 0

def log(*a):
    print("[bridge]", *a, flush=True)  # flush: visible mid-run, not buffered to exit

async def handler(ws):
    global _conn
    _conn += 1
    cid = _conn
    peer = getattr(ws, "remote_address", None)
    log(f"#{cid} WS accept from {peer}; dialing {GAME[0]}:{GAME[1]}")
    try:
        reader, writer = await asyncio.open_connection(*GAME)
    except OSError as e:
        log(f"#{cid} shard dial FAILED: {e}")
        await ws.close(code=1011, reason=str(e)); return
    log(f"#{cid} shard connected")
    up = down = 0

    async def w2t():
        nonlocal up
        try:
            async for m in ws:
                b = m if isinstance(m, (bytes, bytearray)) else m.encode()
                up += len(b)
                log(f"#{cid} c->s op=0x{b[0]:02X} len={len(b)} (total {up})")
                writer.write(b); await writer.drain()
        finally:
            try: writer.write_eof()
            except OSError: pass

    async def t2w():
        nonlocal down
        try:
            while True:
                d = await reader.read(65536)
                if not d: break
                down += len(d)
                log(f"#{cid} s->c op=0x{d[0]:02X} len={len(d)} (total {down})")
                await ws.send(d)
        finally:
            await ws.close()

    await asyncio.gather(w2t(), t2w(), return_exceptions=True)
    writer.close()
    log(f"#{cid} closed (c->s {up}B, s->c {down}B)")

async def main():
    async with websockets.serve(handler, "127.0.0.1", 8770, max_size=None):
        log(f"ws://127.0.0.1:8770/ -> tcp {GAME[0]}:{GAME[1]}"); await asyncio.Future()

asyncio.run(main())
