#!/usr/bin/env python3
"""Drive the W5 art picker headlessly: set the #uo-folder input to a UO folder's
files, trigger the import, and screenshot the result. Validates the real player flow
(pick -> import -> OPFS -> MEMFS -> render) that a manual file dialog can't automate.

Usage: cdp-pick-folder.py <debug-port> <uo-folder> <out.png> [wait-secs]
"""
import asyncio, base64, json, os, sys, urllib.request
import websockets

PORT = sys.argv[1]
FOLDER = sys.argv[2]
OUT = sys.argv[3]
WAIT = int(sys.argv[4]) if len(sys.argv) > 4 else 25


async def main():
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
    page = next(t for t in targets if t.get("type") == "page")
    # ping_interval=None: the multi-hundred-MB import blocks the event loop long enough
    # to trip keepalive otherwise.
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None, ping_interval=None) as ws:
        _id = 0
        async def cmd(method, **params):
            nonlocal _id; _id += 1
            await ws.send(json.dumps({"id": _id, "method": method, "params": params}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == _id:
                    if "error" in m:
                        raise RuntimeError(f"{method}: {m['error']}")
                    return m.get("result", {})

        await cmd("DOM.enable"); await cmd("Runtime.enable")

        # Wait for the picker input to exist.
        obj = None
        for _ in range(60):
            r = await cmd("Runtime.evaluate", expression="document.querySelector('#uo-folder')")
            obj = r.get("result", {}).get("objectId")
            if obj:
                break
            await asyncio.sleep(0.5)
        if not obj:
            print("picker input #uo-folder never appeared"); sys.exit(1)
        print("picker found; setting folder files")

        files = [os.path.join(FOLDER, f) for f in sorted(os.listdir(FOLDER))
                 if os.path.isfile(os.path.join(FOLDER, f))]
        # webkitdirectory + CDP setFileInputFiles don't populate cleanly; drop the attr
        # for the test (the change handler reads input.files identically either way).
        await cmd("Runtime.evaluate",
                  expression="document.querySelector('#uo-folder').removeAttribute('webkitdirectory')")
        await cmd("DOM.setFileInputFiles", files=files, objectId=obj)
        n = await cmd("Runtime.evaluate", expression="document.querySelector('#uo-folder').files.length")
        print("input.files.length =", n.get("result", {}).get("value"))
        await cmd("Runtime.evaluate",
                  expression="document.querySelector('#uo-folder').dispatchEvent(new Event('change'))")
        print(f"dispatched change with {len(files)} files; waiting {WAIT}s for import + render")
        await asyncio.sleep(WAIT)

        shot = await cmd("Page.captureScreenshot", format="png")
        open(OUT, "wb").write(base64.b64decode(shot["data"]))
        print("screenshot ->", OUT)


asyncio.run(main())
