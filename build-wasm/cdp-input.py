#!/usr/bin/env python3
"""Trusted input via CDP. Usage: cdp-input.py <port> <x> <y> <button> <holdMs>"""
import asyncio, json, sys, urllib.request
import websockets

PORT, X, Y, BTN, HOLD = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5])

async def main():
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
    page = next(t for t in targets if t.get("type") == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
        mid = 0
        async def cmd(method, params):
            nonlocal mid
            mid += 1
            await ws.send(json.dumps({"id": mid, "method": method, "params": params}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == mid:
                    return m
        await cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": X, "y": Y})
        await cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": X, "y": Y,
                  "button": BTN, "buttons": 2 if BTN == "right" else 1, "clickCount": 1})
        await asyncio.sleep(HOLD / 1000)
        await cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": X, "y": Y,
                  "button": BTN, "buttons": 0, "clickCount": 1})
        print("dispatched", BTN, "hold", HOLD, "ms at", X, Y)

asyncio.run(main())
