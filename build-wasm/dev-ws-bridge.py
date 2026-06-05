#!/usr/bin/env python3
"""Standalone WS<->TCP bridge for the W3 end-to-end test (browser client -> shard).
ws://127.0.0.1:8770/ <-> tcp 172.16.2.154:2593. Single fixed target (not an open relay)."""
import asyncio, websockets
GAME=("172.16.2.154",2593)
async def handler(ws):
    try: reader,writer=await asyncio.open_connection(*GAME)
    except OSError as e: await ws.close(code=1011,reason=str(e)); return
    async def w2t():
        try:
            async for m in ws:
                writer.write(m if isinstance(m,(bytes,bytearray)) else m.encode()); await writer.drain()
        finally:
            try: writer.write_eof()
            except OSError: pass
    async def t2w():
        try:
            while True:
                d=await reader.read(65536)
                if not d: break
                await ws.send(d)
        finally: await ws.close()
    await asyncio.gather(w2t(),t2w(),return_exceptions=True); writer.close()
async def main():
    async with websockets.serve(handler,"127.0.0.1",8770,max_size=None):
        print("[bridge] ws://127.0.0.1:8770/ -> tcp 172.16.2.154:2593"); await asyncio.Future()
asyncio.run(main())
