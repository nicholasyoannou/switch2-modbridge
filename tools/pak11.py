#!/usr/bin/env python3
"""Read a UE 4.26 pak (version 11: encoded entries + path-hash / full-directory indexes).

Usage: python -P pak11.py <pak> [outdir regex]   (OODLE_DLL=<oo2core_*_win64.dll> for Oodle entries)
"""
import hashlib
import os
import re
import struct
import sys

MAGIC = struct.pack("<I", 0x5A6F12E1)


class R:
    def __init__(self, b, o=0):
        self.b, self.o = b, o

    def u(self, fmt):
        v = struct.unpack_from("<" + fmt, self.b, self.o)
        self.o += struct.calcsize("<" + fmt)
        return v[0] if len(v) == 1 else v

    def raw(self, n):
        v = self.b[self.o:self.o + n]; self.o += n; return v

    def fstr(self):
        n = self.u("i")
        if n < 0:
            return self.raw(-2 * n).decode("utf-16-le").rstrip("\0")
        return self.raw(n).decode("latin-1").rstrip("\0")


def footer(d):
    m = d.rfind(MAGIC)
    ver, ioff, isz = struct.unpack_from("<Iqq", d, m + 4)
    ihash = d[m + 24:m + 44]
    names = [d[m + 44 + 32 * i:m + 76 + 32 * i].rstrip(b"\0").decode() for i in range(5)]
    return dict(magic_at=m, ver=ver, ioff=ioff, isz=isz, ihash=ihash, encrypted=d[m - 1], methods=names)


def legacy_entry(r):
    """FPakEntry as serialized in the Files array and before each file's data (v8+)."""
    off, size, usize, cm = r.u("qqqI")
    r.raw(20)
    blocks = []
    if cm:
        for _ in range(r.u("i")):
            blocks.append(r.u("qq"))
    enc, bsz = r.u("BI")
    return dict(off=off, size=size, usize=usize, cm=cm, blocks=blocks, enc=enc, bsz=bsz)


def header_size(e):
    return 53 + (4 + 16 * len(e["blocks"]) if e["cm"] else 0)


def decode_entry(b, o):
    r = R(b, o)
    v = r.u("I")
    bsz = r.u("I") if (v & 0x3F) == 0x3F else (v & 0x3F) << 11
    cm = (v >> 23) & 0x3F
    off = r.u("I") if v & (1 << 31) else r.u("Q")
    usize = r.u("I") if v & (1 << 30) else r.u("Q")
    size = (r.u("I") if v & (1 << 29) else r.u("Q")) if cm else usize
    enc = (v >> 22) & 1
    n = (v >> 6) & 0xFFFF
    e = dict(off=off, size=size, usize=usize, cm=cm, enc=enc, bsz=bsz, blocks=[None] * n)
    base = header_size(e)  # block offsets are relative to the entry's offset
    if n == 1 and not enc:
        e["blocks"] = [(base, base + size)]
    elif n:
        cur = base
        for i in range(n):
            s = r.u("I")
            e["blocks"][i] = (cur, cur + s)
            cur += (s + 15) & ~15 if enc else s
    if n == 1:
        e["bsz"] = usize  # one block holds the whole file
    return e


def parse(d):
    f = footer(d)
    assert not f["encrypted"], "encrypted index"
    idx = d[f["ioff"]:f["ioff"] + f["isz"]]
    assert hashlib.sha1(idx).digest() == f["ihash"], "primary index hash mismatch"
    r = R(idx)
    p = dict(footer=f, mount=r.fstr(), count=r.u("i"), seed=r.u("Q"))
    if r.u("I"):
        p["phi"] = r.u("qq") + (r.raw(20),)
    if r.u("I"):
        p["fdi"] = r.u("qq") + (r.raw(20),)
    n = r.u("i"); p["encoded"] = r.raw(n)
    nfiles = r.u("i"); p["files_at"] = r.o
    p["files"] = [legacy_entry(r) for _ in range(nfiles)]
    assert r.o == len(idx), "trailing primary index bytes"
    off, size, h = p["fdi"]
    blob = d[off:off + size]
    assert hashlib.sha1(blob).digest() == h, "directory index hash mismatch"
    r = R(blob); names = {}
    for _ in range(r.u("i")):
        dname = r.fstr()
        for _ in range(r.u("i")):
            fname = r.fstr(); names[(dname + fname).lstrip("/")] = r.u("i")
    p["names"] = names
    return p


def entry_for(p, loc):
    return decode_entry(p["encoded"], loc) if loc >= 0 else p["files"][-loc - 1]


_oodle = None


def read_file(d, p, e):
    if e["enc"]:
        raise ValueError("encrypted entry")
    start = e["off"]
    if not e["cm"]:
        return d[start + 53:start + 53 + e["size"]]
    method = p["footer"]["methods"][e["cm"] - 1]
    out, left = [], e["usize"]
    for s, t in e["blocks"]:
        n = min(left, e["bsz"]); src = d[start + s:start + t]
        if method.lower() == "zlib":
            import zlib; out.append(zlib.decompress(src))
        elif method.lower() == "oodle":
            out.append(oodle(src, n))
        else:
            raise ValueError("compression " + method)
        left -= n
    return b"".join(out)


def oodle(src, n):
    global _oodle
    import ctypes
    if _oodle is None:
        _oodle = ctypes.WinDLL(os.environ["OODLE_DLL"]).OodleLZ_Decompress
        _oodle.restype = ctypes.c_ssize_t
        _oodle.argtypes = [ctypes.c_void_p, ctypes.c_ssize_t, ctypes.c_void_p, ctypes.c_ssize_t] + [ctypes.c_int] * 3 + [ctypes.c_void_p, ctypes.c_ssize_t, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t, ctypes.c_int]
    buf = ctypes.create_string_buffer(n)
    got = _oodle(src, len(src), buf, n, 1, 0, 0, None, 0, None, None, None, 0, 3)
    assert got == n, f"oodle returned {got}, want {n}"
    return buf.raw


def dir_index_locs(b, o=0):
    """Offsets of each file's int32 location inside a serialized FDirectoryIndex. Returns (map, end)."""
    r = R(b, o); locs = {}
    for _ in range(r.u("i")):
        dname = r.fstr()
        for _ in range(r.u("i")):
            fname = r.fstr(); locs[(dname + fname).lstrip("/")] = r.o; r.u("i")
    return locs, r.o


def legacy_entry_bytes(offset, data):
    return struct.pack("<qqqI", offset, len(data), len(data), 0) + hashlib.sha1(data).digest() + b"\0" + struct.pack("<I", 0)


def replace_file(d, name, data):
    """New pak bytes with `name` replaced by uncompressed `data`. Existing data bytes are not moved."""
    p = parse(d); f = p["footer"]
    phi_off, phi_size, _ = p["phi"]; fdi_off, fdi_size, _ = p["fdi"]
    assert phi_off == f["ioff"] + f["isz"] and fdi_off == phi_off + phi_size and fdi_off + fdi_size == f["magic_at"] - 17, "unexpected index layout"
    old_loc = p["names"][name]
    new_loc = -(len(p["files"]) + 1)

    phi = bytearray(d[phi_off:phi_off + phi_size])
    r = R(phi); hits = []
    for _ in range(r.u("i")):
        r.u("Q"); at = r.o
        if r.u("i") == old_loc:
            hits.append(at)
    pruned, end = dir_index_locs(phi, r.o)
    assert end == len(phi) and len(hits) == 1, "path hash index: expected one entry for the file"
    for at in hits + ([pruned[name]] if name in pruned else []):
        assert struct.unpack_from("<i", phi, at)[0] == old_loc
        struct.pack_into("<i", phi, at, new_loc)

    fdi = bytearray(d[fdi_off:fdi_off + fdi_size])
    locs, end = dir_index_locs(fdi)
    assert end == len(fdi) and struct.unpack_from("<i", fdi, locs[name])[0] == old_loc
    struct.pack_into("<i", fdi, locs[name], new_loc)

    data_end = f["ioff"]
    record = legacy_entry_bytes(0, data) + data  # in-data header carries offset 0
    ioff = data_end + len(record)

    def primary(isz):
        phi_at = ioff + isz; fdi_at = phi_at + len(phi)
        def s(x):
            b = x.encode() + b"\0"; return struct.pack("<i", len(b)) + b
        return (s(p["mount"]) + struct.pack("<iQ", p["count"], p["seed"])
                + struct.pack("<Iqq", 1, phi_at, len(phi)) + hashlib.sha1(phi).digest()
                + struct.pack("<Iqq", 1, fdi_at, len(fdi)) + hashlib.sha1(fdi).digest()
                + struct.pack("<i", len(p["encoded"])) + p["encoded"]
                + struct.pack("<i", len(p["files"]) + 1)
                + d[f["ioff"] + p["files_at"]:f["ioff"] + f["isz"]]   # existing unencoded entries, verbatim
                + legacy_entry_bytes(data_end, data))
    idx = primary(0); idx = primary(len(idx))
    m = f["magic_at"]
    foot = bytearray(d[m - 17:])
    struct.pack_into("<qq", foot, 17 + 8, ioff, len(idx))
    foot[17 + 24:17 + 44] = hashlib.sha1(idx).digest()
    return d[:data_end] + record + idx + bytes(phi) + bytes(fdi) + bytes(foot)


def main():
    d = open(sys.argv[1], "rb").read()
    p = parse(d)
    f = p["footer"]
    print("version", f["ver"], "mount", p["mount"], "entries", p["count"], "methods", [m for m in f["methods"] if m])
    want = re.compile(sys.argv[3], re.I) if len(sys.argv) > 3 else None
    for name, loc in sorted(p["names"].items()):
        e = entry_for(p, loc)
        print(f"{e['usize']:>10} cm={e['cm']} enc={e['enc']} loc={loc} {name}")
        if want and want.search(name):
            data = read_file(d, p, e)
            assert len(data) == e["usize"]
            dst = os.path.join(sys.argv[2], *name.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            open(dst, "wb").write(data)


if __name__ == "__main__":
    main()
