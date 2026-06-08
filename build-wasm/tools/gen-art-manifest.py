#!/usr/bin/env python3
"""Generate an integrity manifest for a UO art directory.

Writes <art-dir>/manifest.json as a JSON array of {name, size, sha256} for every
real file in the directory. The web loader (main.js) fetches this, downloads each
listed file, and verifies size + sha256 before writing it into the game's virtual
filesystem — so a truncated or corrupt art file is caught and re-fetched instead of
silently producing a broken client (invisible bodies, per-frame NREs, the failure
this guards against).

Run this whenever the served art set changes — for the local dev set
(build-wasm/.uo-test-data) and for the deployed /uo-data set.

Usage:
    gen-art-manifest.py <art-dir>

The loader still accepts a legacy flat ["name", ...] manifest (size/hash checks are
simply skipped for entries with no metadata), so an un-regenerated server keeps
working — it just loses integrity verification until regenerated.
"""
import hashlib
import json
import os
import sys


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: gen-art-manifest.py <art-dir>", file=sys.stderr)
        return 2
    art_dir = sys.argv[1]
    if not os.path.isdir(art_dir):
        print(f"error: not a directory: {art_dir}", file=sys.stderr)
        return 1

    entries = []
    for name in sorted(os.listdir(art_dir)):
        if name == "manifest.json" or name.startswith("."):
            continue
        path = os.path.join(art_dir, name)
        if not os.path.isfile(path):
            continue
        size = os.path.getsize(path)
        digest = sha256_of(path)
        entries.append({"name": name, "size": size, "sha256": digest})
        print(f"  {name:<28} {size:>12,}  {digest[:16]}…", file=sys.stderr)

    out = os.path.join(art_dir, "manifest.json")
    with open(out, "w") as f:
        json.dump(entries, f, separators=(",", ":"))

    total = sum(e["size"] for e in entries)
    print(
        f"\nwrote {out}: {len(entries)} files, {total:,} bytes ({total / 1e6:.0f} MB)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
