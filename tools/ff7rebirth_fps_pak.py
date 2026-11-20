#!/usr/bin/env python3
"""Build FF7 Rebirth (Switch 2) frame-rate mods.

Cap: End/Platforms/Switch2/Config/Switch2DeviceProfiles.ini in pakchunk0-Switch2.pak sets
rhi.SyncInterval=2 and r.DynamicRes.FrameTimeBudget=33.3333. The layer runs at Switch2.MaxRefreshRate
(code default 60) via nn::vi::SetLayerExtendedSwapInterval(layer, 1, rate), so 2 = 30 fps.
At MaxRefreshRate=120 the intervals become 1=120, 2=60, 3=40, 4=30. The RHI enables VRR only below interval 2.

Usage: python -P ff7rebirth_fps_pak.py <original pakchunk0-Switch2.pak> <out dir>   (OODLE_DLL needed for the check)
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pak11  # noqa: E402

INI = "End/Platforms/Switch2/Config/Switch2DeviceProfiles.ini"
TITLE = "04008BE0262BC000"
SYNC = b"+Cvars=rhi.SyncInterval=2\r\n"
BUDGET = b"+CVars=r.DynamicRes.FrameTimeBudget=33.3333\r\n"
# name: (rhi.SyncInterval, Switch2.MaxRefreshRate or None, FrameTimeBudget)
VARIANTS = {
    "60fps": (1, None, b"16.6667"),
    "40fps-120hz": (3, 120, b"25.0000"),
    "vrr-uncapped-experimental": (1, 120, b"16.6667"),
    "120fps": (1, 120, b"8.3333"),
}


def ini_for(stock, interval, rate, budget):
    assert stock.count(SYNC) == 1 and stock.count(BUDGET) == 1, "not the stock profile"
    sync = b"+Cvars=rhi.SyncInterval=%d\r\n" % interval
    if rate:
        sync += b"+Cvars=Switch2.MaxRefreshRate=%d\r\n" % rate
    return stock.replace(SYNC, sync).replace(BUDGET, b"+CVars=r.DynamicRes.FrameTimeBudget=" + budget + b"\r\n")


def check(orig, out, data):
    a, b = pak11.parse(orig), pak11.parse(out)  # parse() verifies all three index hashes
    assert a["names"].keys() == b["names"].keys()
    assert pak11.read_file(out, b, pak11.entry_for(b, b["names"][INI])) == data
    for name in ("End/Platforms/Switch2/Config/Switch2Engine.ini", "End/Config/DefaultEngine.ini", "Engine/Config/BaseEngine.ini"):
        x = pak11.read_file(orig, a, pak11.entry_for(a, a["names"][name]))
        y = pak11.read_file(out, b, pak11.entry_for(b, b["names"][name]))
        assert x == y, name
    changed = [n for n in a["names"] if n != INI and a["names"][n] != b["names"][n]]
    assert not changed, changed


def main(src, outdir):
    orig = open(src, "rb").read()
    p = pak11.parse(orig)
    stock = pak11.read_file(orig, p, pak11.entry_for(p, p["names"][INI]))
    for name, (interval, rate, budget) in VARIANTS.items():
        data = ini_for(stock, interval, rate, budget)
        out = pak11.replace_file(orig, INI, data)
        check(orig, out, data)
        dst = os.path.join(outdir, name, TITLE, "romfs", "End", "Content", "Paks", "pakchunk0-Switch2.pak")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, "wb").write(out)
        print(f"{name:26} SyncInterval={interval} MaxRefreshRate={rate or 'default(60)'} Budget={budget.decode()}  sha256 {hashlib.sha256(out).hexdigest()[:16]}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
