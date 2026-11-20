#!/usr/bin/env python3
"""Decompress a Switch NSO into a flat memory image (text|ro|data at their memory offsets).

Usage: python -I nso2raw.py <in.nso> <out.raw>
Prints segment layout and build ID. Segment SHA-256s are checked against the NSO header.
"""
import hashlib
import struct
import sys

import lz4.block


def main(src, dst):
    d = open(src, "rb").read()
    assert d[:4] == b"NSO0", "not an NSO"
    flags = struct.unpack_from("<I", d, 0xC)[0]
    csizes = struct.unpack_from("<III", d, 0x60)
    image = bytearray()
    for i, name in enumerate(("text", "ro", "data")):
        foff, moff, size = struct.unpack_from("<III", d, 0x10 + i * 0x10)
        raw = d[foff:foff + csizes[i]]
        seg = lz4.block.decompress(raw, uncompressed_size=size) if flags & (1 << i) else raw
        assert len(seg) == size, f"{name}: size {len(seg)} != {size}"
        if flags & (1 << (i + 3)):
            want = d[0xA0 + i * 0x20:0xC0 + i * 0x20]
            assert hashlib.sha256(seg).digest() == want, f"{name}: hash mismatch"
        image.extend(b"\0" * (moff - len(image)))
        image[moff:moff + size] = seg
        print(f"{name:4} mem 0x{moff:08x} size 0x{size:08x}")
    bss = struct.unpack_from("<I", d, 0x3C)[0]
    print(f"bss  size 0x{bss:08x}")
    print("build id", d[0x40:0x60].hex().upper())
    open(dst, "wb").write(image)
    print("wrote", dst, len(image), "bytes")


if __name__ == "__main__":
    main(*sys.argv[1:3])
