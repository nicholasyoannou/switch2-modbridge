#!/usr/bin/env python3
"""Run the patched FF7R DrawStatsHUD stat check + L3+R3 toggle in unicorn with fake controller input.

Usage: python -P test_ff7r_toggle.py <raw main image> <ff7r-tweaks.pchtxt>
"""
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm64_const import (UC_ARM64_REG_PC, UC_ARM64_REG_SP, UC_ARM64_REG_LR, UC_ARM64_REG_X0,
                                 UC_ARM64_REG_X1, UC_ARM64_REG_X19, UC_ARM64_REG_X20, UC_ARM64_REG_X28,
                                 UC_ARM64_REG_X26, UC_ARM64_REG_X29)

STUBS = {0x4123630: "Handheld", 0x4123640: "JoyDual", 0x4123650: "FullKey"}
SITE, SHOW, HIDE, NEXT = 0x3346F0, 0x334750, 0x334834, 0x334718
RENDER_STAT_FPS, RODATA = 0x3C7E7EC, 0x4124000
HEAP, STACK = 0x10000000, 0x20000000
L3, R3 = 1 << 4, 1 << 5


def patched_text(raw, pchtxt):
    img = bytearray(raw[:RODATA])
    shift, on = 0, False
    for line in open(pchtxt):
        line = line.split("#")[0].strip()
        if line.startswith("@flag offset_shift"):
            shift = int(line.split()[-1], 16)
        elif line in ("@enabled", "@disabled"):
            on = line == "@enabled"
        elif line == "@stop":
            break
        elif line and not line.startswith("@") and on:
            off, data = line.split()
            at = int(off, 16) + shift - 0x100  # IPS offset = row + shift; image address = IPS offset - NSO header
            img[at:at + len(data) // 2] = bytes.fromhex(data)
    return bytes(img)


class Rig:
    def __init__(self, text):
        self.uc = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        self.uc.mem_map(0, RODATA)
        self.uc.mem_write(0, text)
        self.uc.mem_map(HEAP, 0x1000)
        self.uc.mem_map(STACK, 0x10000)
        self.pads = {}
        self.uc.hook_add(UC_HOOK_CODE, self.stub, begin=min(STUBS), end=max(STUBS))

    def stub(self, uc, address, size, _):
        style = STUBS.get(address)
        if not style:
            return
        out = uc.reg_read(UC_ARM64_REG_X0)
        npad_id = struct.unpack("<I", uc.mem_read(uc.reg_read(UC_ARM64_REG_X1), 4))[0]
        buttons = self.pads.get((style, npad_id), 0)
        uc.mem_write(out, struct.pack("<qQiiiiI4x", 1, buttons, 0, 0, 0, 0, 0))
        uc.reg_write(UC_ARM64_REG_PC, uc.reg_read(UC_ARM64_REG_LR))

    def frame(self, render_func=RENDER_STAT_FPS, **pads):
        """One pass over the patched check for one stat record; returns where it ends up."""
        self.pads = {("Handheld", 0x20): pads.get("handheld", 0), ("FullKey", 0): pads.get("fullkey", 0),
                     ("JoyDual", 0): pads.get("joydual", 0)}
        uc = self.uc
        record = HEAP + 0x100
        sp = STACK + 0x8000
        uc.reg_write(UC_ARM64_REG_SP, sp)
        uc.reg_write(UC_ARM64_REG_X28, render_func)
        uc.reg_write(UC_ARM64_REG_X19, record + 0x38)
        uc.reg_write(UC_ARM64_REG_X20, record + 0x40)
        uc.reg_write(UC_ARM64_REG_X29, 0xDEAD)
        uc.mem_write(record + 0x38, struct.pack("<QQ", render_func, 0))
        ends = {}
        def stop(uc_, address, size, _):
            if address in (SHOW, HIDE, NEXT):
                ends["at"] = address
                uc_.emu_stop()
        h = uc.hook_add(UC_HOOK_CODE, stop)
        uc.emu_start(SITE, 0, count=500)
        uc.hook_del(h)
        assert uc.reg_read(UC_ARM64_REG_SP) == sp, "stack not balanced"
        assert uc.reg_read(UC_ARM64_REG_X19) == record + 0x38 and uc.reg_read(UC_ARM64_REG_X29) == 0xDEAD
        if ends.get("at") == SHOW:
            assert uc.reg_read(UC_ARM64_REG_X28) == render_func and uc.reg_read(UC_ARM64_REG_X26) == 0
        return {SHOW: "show", HIDE: "hide", NEXT: "skip"}[ends["at"]]

    def state(self, value=None):
        if value is not None:
            self.uc.mem_write(HEAP + 0x15A, struct.pack("<H", value))
        return struct.unpack("<H", self.uc.mem_read(HEAP + 0x15A, 2))[0]


def main(raw_path, pchtxt):
    rig = Rig(patched_text(open(raw_path, "rb").read(), pchtxt))
    rig.state(0x1234)                                   # uninitialised heap padding
    assert rig.frame() == "show" and rig.state() == 0xA500
    assert rig.frame(render_func=0x3C7EC64) == "skip"   # STAT_Unit and others never draw
    assert rig.frame(handheld=L3) == "show"             # one stick is not the combo
    assert rig.frame(handheld=L3 | R3) == "hide"        # press -> hide
    assert rig.frame(handheld=L3 | R3 | 1) == "hide"    # still held: no re-toggle
    assert rig.frame() == "hide"                        # released: stays hidden
    assert rig.frame(fullkey=L3 | R3) == "show"         # Pro Controller press -> show
    assert rig.frame(fullkey=L3, joydual=R3) == "show"  # held across pads (OR): still held, no toggle
    assert rig.frame() == "show"
    assert rig.frame(joydual=L3 | R3) == "hide"         # Joy-Con pair press -> hide
    rig.state(0xA502)
    assert rig.frame() == "hide"                        # valid stored state is kept
    print("toggle test passed")


if __name__ == "__main__":
    main(*sys.argv[1:3])
