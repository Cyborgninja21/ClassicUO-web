#!/usr/bin/env python3
"""Capture a screenshot of a long-running (rAF loop) headless Chrome page via CDP.
--screenshot can't capture an infinite main loop; Page.captureScreenshot grabs the
live composited frame. Usage: cdp-screenshot.py <debug-port> <out.png> <wait-seconds>"""
import asyncio, base64, json, sys, urllib.request
import websockets

PORT = sys.argv[1]; OUT = sys.argv[2]; WAIT = float(sys.argv[3])

async def main():
    # find the page target's ws debugger url
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
    page = next(t for t in targets if t["type"] == "page")
    ws_url = page["webSocketDebuggerUrl"]
    print(f"[cdp] connecting {ws_url}")
    async with websockets.connect(ws_url, max_size=None) as ws:
        mid = 0
        async def cmd(method, params=None):
            nonlocal mid; mid += 1
            await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == mid:
                    return msg.get("result", {})
        await cmd("Page.enable")
        print(f"[cdp] waiting {WAIT}s for boot+render...")
        await asyncio.sleep(WAIT)
        res = await cmd("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        data = base64.b64decode(res["data"])
        with open(OUT, "wb") as f:
            f.write(data)
        print(f"[cdp] wrote {OUT} ({len(data)} bytes)")

asyncio.run(main())
