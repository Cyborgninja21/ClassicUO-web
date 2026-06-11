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
  wasm-trap-lint.py --strict --baseline FILE [src-dir]
        # ratchet gate: tolerate the findings recorded in FILE (per file+category
        # counts), exit 1 only on NEW unguarded crash traps. Lets CI gate a tree
        # with known desktop-only findings without a big-bang cleanup.
  wasm-trap-lint.py --write-baseline FILE [src-dir]
        # (re)generate FILE from the current findings (run after fixing traps to
        # tighten the ratchet; never to absorb a regression).
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
    # Image DECODE traps (both proven 2026-06-11): Texture2D.FromStream rides
    # FNA3D_Image_Load's stb_image reverse-pinvoke read callbacks; ImageSharp's
    # PNG decoder raw-traps with an uncatchable "function signature mismatch".
    # Browser path: decode in JS (createImageBitmap) -> RGBA -> SetData.
    (r"\bTexture2D\.FromStream\b",                      "image-decode",          "crash"),
    (r"\bImage\.Load\b|\bImage\.LoadAsync\b",          "image-decode",          "crash"),
    (r"\bThread\.Sleep\b",                               "blocks-ui-thread",      "hang"),
    (r"\.GetAwaiter\(\)\.GetResult\(\)",                 "sync-over-async",       "hang"),
    (r"\.Wait\(\s*\)",                                   "sync-over-async",       "hang"),
]

GUARD_WINDOW = 14  # lines above a hit to look for an OperatingSystem.IsBrowser() guard


def is_guarded(lines, i):
    lo = max(0, i - GUARD_WINDOW)
    return any("IsBrowser" in lines[j] for j in range(lo, i + 1))


def read_opt(args, flag):
    if flag in args:
        i = args.index(flag)
        val = args[i + 1]
        del args[i:i + 2]
        return val
    return None


def main():
    args = [a for a in sys.argv[1:]]
    strict = "--strict" in args
    args = [a for a in args if a != "--strict"]
    baseline_path = read_opt(args, "--baseline")
    write_baseline_path = read_opt(args, "--write-baseline")
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

    # Baseline ratchet — keyed on (file, category) with a tolerated count, so line
    # drift from unrelated edits doesn't churn the file, but ANY new trap (new
    # file+category, or one more hit in a known pair) fails the gate.
    def group(items):
        counts = {}
        for f in items:
            counts[(f["file"], f["cat"])] = counts.get((f["file"], f["cat"]), 0) + 1
        return counts

    if write_baseline_path:
        with open(write_baseline_path, "w") as fh:
            fh.write("# wasm-trap-lint ratchet baseline — tolerated UNGUARDED crash findings\n")
            fh.write("# (file|category|count). Tighten after fixing traps; never absorb a regression.\n")
            for (path, cat), n in sorted(group(unguarded_crash).items()):
                fh.write(f"{path}|{cat}|{n}\n")
        print(f"baseline written: {write_baseline_path} ({len(group(unguarded_crash))} entries)")
        return 0

    if strict:
        allowed = {}
        if baseline_path:
            for ln in open(baseline_path):
                ln = ln.strip()
                if not ln or ln.startswith("#"):
                    continue
                path, cat, n = ln.rsplit("|", 2)
                allowed[(path, cat)] = int(n)
        new = {k: n for k, n in group(unguarded_crash).items() if n > allowed.get(k, 0)}
        if new:
            print("\nSTRICT: NEW unguarded crash traps (not in baseline) — failing.", file=sys.stderr)
            for (path, cat), n in sorted(new.items()):
                over = n - allowed.get((path, cat), 0)
                print(f"  {path} [{cat}]: {n} found, {allowed.get((path, cat), 0)} tolerated (+{over})",
                      file=sys.stderr)
            return 1
        fixed = {k: v for k, v in allowed.items() if group(unguarded_crash).get(k, 0) < v}
        if fixed:
            print(f"\nnote: {len(fixed)} baseline entr{'y is' if len(fixed)==1 else 'ies are'} now "
                  f"over-tolerant — re-run --write-baseline to tighten the ratchet.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
