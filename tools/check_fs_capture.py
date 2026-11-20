#!/usr/bin/env python3
"""Check an FS code capture against ns2jb-modloader's FS ABI (lib/native/fs-abi.json, fs-contract.json).

Usage: python -P check_fs_capture.py <fs text capture .bin> <ModLoader dir>
Exact: each fs-abi range's sha256 at its offset. Relocated: fs-contract prefix found elsewhere.
"""
import hashlib
import json
import os
import sys


def main(capture_path, modloader):
    cap = open(capture_path, "rb").read()
    abi = json.load(open(os.path.join(modloader, "lib", "native", "fs-abi.json")))
    contract = json.load(open(os.path.join(modloader, "lib", "native", "fs-contract.json")))
    print(f"capture {len(cap)} bytes, fs-abi captureSize {abi['captureSize']}")
    exact = 0
    for r in abi["ranges"]:
        got = hashlib.sha256(cap[r["offset"]:r["offset"] + r["size"]]).hexdigest()
        ok = got == r["sha256"]
        exact += ok
        if not ok:
            print(f"  MISMATCH at 0x{r['offset']:x} (+{r['size']}): {r['purpose']}")
    print(f"exact fs-abi ranges: {exact}/{len(abi['ranges'])}")
    moved = 0
    for r in contract["ranges"]:
        prefix = bytes.fromhex(r["prefix"])
        hits = []
        at = cap.find(prefix)
        while at >= 0 and len(hits) < 4:
            if hashlib.sha256(cap[at:at + r["size"]]).hexdigest() == r["sha256"]:
                hits.append(at)
            at = cap.find(prefix, at + 1)
        if hits and hits[0] != r["offset"]:
            moved += 1
            print(f"  relocated: {r['purpose']} 0x{r['offset']:x} -> {[hex(h) for h in hits]}")
        elif not hits:
            print(f"  contract range not found: {r['purpose']}")
    print(f"contract ranges relocated: {moved}")
    return 0 if exact == len(abi["ranges"]) else 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
