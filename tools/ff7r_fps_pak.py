#!/usr/bin/env python3
"""Build FF7 Remake Intergrade (Switch 2) frame-rate mods.

The cap lives in End/Config/Switch2/Switch2DeviceProfiles.ini inside pakchunk0-Switch2.pak:
    ; 1:120FPS, 2:60FPS, 3:40FPS, 4:30FPS
    +Cvars=rhi.SyncInterval=4
The engine's dynamic resolution budget stays at 33.33 ms (30 fps) unless lowered too.

Copies the original pak, appends a replacement ini record after the data, points that one
index entry at it, rehashes the index and rewrites the footer. Every other byte is unchanged.

Usage: python -P ff7r_fps_pak.py <original pakchunk0-Switch2.pak> <out dir>
"""
import hashlib
import os
import struct
import sys

INI = b"End/Config/Switch2/Switch2DeviceProfiles.ini\0"
STOCK = (b"[Switch2 DeviceProfile]\r\n"
         b"+Cvars=r.Streaming.PoolSize=2500\r\n"
         b"+Cvars=r.Streaming.MaxTempMemoryAllowed=200\r\n"
         b"; 1:120FPS, 2:60FPS, 3:40FPS, 4:30FPS\r\n"
         b"+Cvars=rhi.SyncInterval=4\r\n")
TITLE = "040093D0233B0000"
PAK = "pakchunk0-Switch2.pak"
# name: (rhi.SyncInterval, r.DynamicRes.FrameTimeBudget ms)
VARIANTS = {"40fps": (3, "25.00"), "60fps": (2, "16.67"), "120fps": (1, "8.333"), "uncapped-experimental": (0, "16.67")}


def ini_for(interval, budget):
    out = STOCK.replace(b"rhi.SyncInterval=4", b"rhi.SyncInterval=%d" % interval)
    return out + b"+Cvars=r.DynamicRes.FrameTimeBudget=" + budget.encode() + b"\r\n"


def entry_bytes(offset, data):
    # FPakEntry v4, uncompressed: Offset, Size, UncompressedSize, CompressionMethod, SHA1, bEncrypted, BlockSize
    return struct.pack("<qqqi", offset, len(data), len(data), 0) + hashlib.sha1(data).digest() + b"\0" + struct.pack("<I", 0)


def build(pak, data):
    magic_at = pak.rfind(struct.pack("<I", 0x5A6F12E1))
    ver, ioff, isz = struct.unpack_from("<Iqq", pak, magic_at + 4)
    assert ver == 4 and ioff + isz == magic_at - 1 and pak[magic_at - 1] == 0, "unexpected pak layout"
    index = bytearray(pak[ioff:ioff + isz])
    assert hashlib.sha1(index).digest() == pak[magic_at + 24:magic_at + 44], "original index hash mismatch"
    p = index.find(INI)
    assert p > 0 and index.find(INI, p + 1) < 0, "ini entry not found exactly once"
    e = p + len(INI)
    old = struct.unpack_from("<qqqi", index, e)
    assert old[1:] == (len(STOCK), len(STOCK), 0) and pak[old[0] + 53:old[0] + 53 + len(STOCK)] == STOCK, "not the stock ini"
    record = entry_bytes(0, data) + data           # in-data header carries offset 0, like the original
    index[e:e + 53] = entry_bytes(ioff, data)      # new record sits where the old index started
    new_ioff = ioff + len(record)
    footer = b"\0" + struct.pack("<IIqq", 0x5A6F12E1, ver, new_ioff, len(index)) + hashlib.sha1(index).digest()
    return pak[:ioff] + record + bytes(index) + footer


def check(out, data):
    """Re-read the built pak the way the game does: footer -> index hash -> entry -> data."""
    m = out.rfind(struct.pack("<I", 0x5A6F12E1))
    _, ioff, isz = struct.unpack_from("<Iqq", out, m + 4)
    index = out[ioff:ioff + isz]
    assert hashlib.sha1(index).digest() == out[m + 24:m + 44]
    e = index.find(INI) + len(INI)
    off, size, usize, cm = struct.unpack_from("<qqqi", index, e)
    assert (size, usize, cm) == (len(data), len(data), 0)
    assert out[off + 53:off + 53 + size] == data
    assert hashlib.sha1(data).digest() == index[e + 28:e + 48]


def main(src, outdir):
    pak = open(src, "rb").read()
    for name, (interval, budget) in VARIANTS.items():
        data = ini_for(interval, budget)
        out = build(pak, data)
        check(out, data)
        dst = os.path.join(outdir, name, TITLE, "romfs", "End", "Content", "Paks", PAK)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, "wb").write(out)
        print(f"{name:22} SyncInterval={interval} FrameTimeBudget={budget}  {len(out)} bytes  sha256 {hashlib.sha256(out).hexdigest()[:16]}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
