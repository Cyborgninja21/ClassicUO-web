#!/usr/bin/env python3
"""Lint ClassicUO source for patterns that HARD-CRASH or hang the single-threaded
WASM/AOT build at runtime — the class of bug that "exits the .NET runtime with 1".

Why these are traps (browser, single-threaded, AOT):
  * threadpool work (Task.Run, ThreadPool, Parallel, ContinueWith, threading Timer,
    new Thread) needs the threadpool reverse-pinvoke, which DIES under AOT -> the
    runtime hard-exits. This is what opening the World Map triggered.
  * raw TCP / ClientWebSocket: browsers can't open raw sockets; the managed async
    path also rides the threadpool reverse-pinvoke (SystemNetSockets_PlatformNotSupported).
  * Process.Start: no subprocesses in a browser.
  * sync-over-async / Thread.Sleep: block the single UI thread -> deadlock/freeze
    (the async continuation can never run while the one thread is blocked).

It is a HEURISTIC (regex + a cheap "is there an OperatingSystem.IsBrowser() guard
nearby" check), not a compiler — it surfaces candidates to review, and pairs with
the .NET trim/AOT analyzer (IL2xxx) which covers the *reflection / dynamic-code*
trap class this script does not.

Usage:
  wasm-trap-lint.py [src-dir]            # default: ../../src (the ClassicUO tree)
  wasm-trap-lint.py --strict [src-dir]   # exit 1 if any UNGUARDED crash trap found (CI gate)
"""
import os
import re
import sys

# (regex, category, severity) — severity: "crash" (runtime exit) or "hang" (UI freeze)
TRAPS = [
    (r"\bTask\.Run\b",                                  "threadpool",            "crash"),
    (r"\bTask\.Factory\.StartNew\b",                    "threadpool",            "crash"),
    (r"\.ContinueWith\s*\(",                            "threadpool-continue",   "crash"),
    (r"\bThreadPool\.",                                 "threadpool",            "crash"),
    (r"\bParallel\.(For|ForEach|Invoke)\b",             "parallel",              "crash"),
    (r"\bnew\s+Thread\s*\(",                             "raw-thread",            "crash"),
    (r"\bnew\s+(System\.Threading\.)?Timer\s*\(",       "threadpool-timer",      "crash"),
    (r"\bnew\s+Socket\s*\(",                             "raw-socket",            "crash"),
    (r"System\.Net\.Sockets",                           "raw-socket",            "crash"),
    (r"\bTcpClient\b|\bTcpListener\b|\bUdpClient\b",     "raw-socket",            "crash"),
    (r"\bClientWebSocket\b",                             "clientwebsocket-async", "crash"),
    (r"\bProcess\.Start\b|System\.Diagnostics\.Process", "subprocess",           "crash"),
    (r"\bThread\.Sleep\b",                               "blocks-ui-thread",      "hang"),
    (r"\.GetAwaiter\(\)\.GetResult\(\)",                 "sync-over-async",       "hang"),
    (r"\.Wait\(\s*\)",                                   "sync-over-async",       "hang"),
]

GUARD_WINDOW = 14  # lines above a hit to look for an OperatingSystem.IsBrowser() guard


def is_guarded(lines, i):
    lo = max(0, i - GUARD_WINDOW)
    return any("IsBrowser" in lines[j] for j in range(lo, i + 1))


def main():
    args = [a for a in sys.argv[1:]]
    strict = "--strict" in args
    args = [a for a in args if a != "--strict"]
    here = os.path.dirname(os.path.abspath(__file__))
    root = args[0] if args else os.path.normpath(os.path.join(here, "..", "..", "src"))

    findings = []
    for dirpath, _dirs, files in os.walk(root):
        if any(seg in dirpath for seg in ("/obj", "/bin", "/obj_core", "/bin_core")):
            continue
        for fn in files:
            if not fn.endswith(".cs"):
                continue
            path = os.path.join(dirpath, fn)
            try:
                lines = open(path, errors="replace").read().splitlines()
            except OSError:
                continue
            for i, ln in enumerate(lines):
                stripped = ln.lstrip()
                if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
                    continue  # comment
                for pat, cat, sev in TRAPS:
                    if re.search(pat, ln):
                        findings.append({
                            "sev": sev, "cat": cat, "guarded": is_guarded(lines, i),
                            "file": os.path.relpath(path, root), "line": i + 1,
                            "code": stripped[:110],
                        })
                        break  # one category per line is enough

    unguarded_crash = [f for f in findings if f["sev"] == "crash" and not f["guarded"]]
    guarded_crash = [f for f in findings if f["sev"] == "crash" and f["guarded"]]
    hangs = [f for f in findings if f["sev"] == "hang" and not f["guarded"]]

    def dump(title, items):
        print(f"\n{title} ({len(items)})")
        for f in sorted(items, key=lambda x: (x["file"], x["line"])):
            print(f"  {f['file']}:{f['line']}  [{f['cat']}]  {f['code']}")

    print(f"WASM trap lint — scanned {root}")
    dump("✗ UNGUARDED CRASH TRAPS (no IsBrowser guard — these can hard-exit the runtime)", unguarded_crash)
    dump("· guarded crash patterns (IsBrowser nearby — desktop path, OK)", guarded_crash)
    dump("⚠ potential UI-thread hangs (sync-over-async / Thread.Sleep — review)", hangs)
    print(f"\nsummary: {len(unguarded_crash)} unguarded crash, {len(guarded_crash)} guarded, {len(hangs)} hang")

    if strict and unguarded_crash:
        print("\nSTRICT: unguarded crash traps present — failing.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
