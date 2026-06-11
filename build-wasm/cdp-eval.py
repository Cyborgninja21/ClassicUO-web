#!/usr/bin/env python3
"""Evaluate a JS expression in the first CDP page. Usage: cdp-eval.py <port> '<expr>'"""
import asyncio, json, sys, urllib.request
import websockets

PORT, EXPR = sys.argv[1], sys.argv[2]

async def main():
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
    page = next(t for t in targets if t.get("type") == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                  "params": {"expression": EXPR, "returnByValue": True}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 1:
                print(json.dumps(msg["result"].get("result", {}).get("value")))
                return

asyncio.run(main())
