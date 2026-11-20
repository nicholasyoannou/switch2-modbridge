#!/usr/bin/env python3
"""Build an IPSwitch patch (.pchtxt) with code tweaks for FF7 Remake Intergrade (Switch 2) main.

Two independent sections; set either to @disabled in the output to turn it off.

1. FPS counter, toggled in game by clicking both sticks (L3+R3). On at boot.
   DrawStatsHUD (main+0x3345b0) has UEngine::RenderEngineStats inlined: for every engine stat with a
   RenderFunc it asks Viewport->GetClient()->IsStatEnabled(name), never true in this shipping build.
   - main+0x3346f0: only the stat whose RenderFunc == UEngine::RenderStatFPS goes on to the
     IsStatEnabled call site (0x3347bc); every other stat is skipped.
   - main+0x3347c0/0x3347c8: that call becomes bl TOGGLE(x0 = &record.RenderFunc). The original
     code after it is kept: w0 bit 0 set -> render, clear -> skip.
   - TOGGLE (text tail padding, main+0x4123f40): ORs the buttons of nn::hid::GetNpadState for
     Handheld (id 0x20), FullKey and JoyDual (id 0 = player 1), detects the L3+R3 press edge and
     keeps its state in padding bytes 0x5a-0x5b of the STAT_FPS FEngineStatFuncs record (0x60-byte
     record, last member bIsRHS at 0x58). High byte 0xA5 marks the state valid; anything else
     (uninitialised heap) is treated as "visible, not held".
   The overlay shows "NN.NN FPS" / "NN.NN ms" (GAverageFPS/GAverageMS from CalculateFPSTimings at
   main+0x1a08640), green/yellow/red per t.TargetFrameTimeThreshold.

2. 120 Hz display. The present-interval hook (main+0x64d4e0) calls
   SetLayerExtendedSwapInterval(layer, rhi.SyncInterval, 120), then
   SetDisplay120HzRefreshRateCapability(display, bUseFixedFrameRate || bSmoothFrameRate), both read
   from DefaultEngine.ini and both unset, so the panel/TV stays at 60 Hz and SyncInterval=1 cannot
   show 120 fps. Handheld VRR is enabled when SyncInterval < 4, docked VRR is always off. The patch
   passes true on the normal path and leaves the VRR logic unchanged.

Usage: python -P ff7r_exefs_tweaks.py <raw main image (nso2raw)> <exefs/main NSO> <out .pchtxt>
"""
import struct
import sys

import capstone

BUILD_ID = "F9E3A6396ECB7F38D5E9C578DFE038F0"
TEXT_END, RODATA = 0x4123F40, 0x4124000
SITE = 0x3346F0            # ldr x8,[x22,#0x50] : Viewport->ViewportClient, start of the IsStatEnabled test
ENABLED_CALL = 0x3347BC    # IsStatEnabled virtual-call path (only reached from SITE's block)
NEXT = 0x334718            # loop increment
RENDER_STAT_FPS = 0x3C7E7EC
FPS_REGISTRATION = 0x3C7CFC8  # adr x3, RenderStatFPS (next to the u"STAT_FPS" name)
TOGGLE = TEXT_END
GET_NPAD = {"Handheld": 0x4123630, "JoyDual": 0x4123640, "FullKey": 0x4123650}
HZ_SITE = 0x64D518         # mov w1, wzr ; bl SetDisplay120HzRefreshRateCapability
SET_120HZ_STUB = 0x4122100

# -- tiny A64 encoders (each use is checked against capstone below) --
def adrp(at, rd, target):
    imm = ((target & ~0xFFF) - (at & ~0xFFF)) >> 12
    return 0x90000000 | (imm & 3) << 29 | ((imm >> 2) & 0x7FFFF) << 5 | rd
def add_imm(rd, rn, imm, sf=1): return (0x91000000 if sf else 0x11000000) | imm << 10 | rn << 5 | rd
def bl(at, target): return 0x94000000 | ((target - at) >> 2) & 0x3FFFFFF
def b(at, target): return 0x14000000 | ((target - at) >> 2) & 0x3FFFFFF
def b_cond(at, target, cond): return 0x54000000 | (((target - at) >> 2) & 0x7FFFF) << 5 | cond
def ldr_x(rt, rn, off): return 0xF9400000 | (off // 8) << 10 | rn << 5 | rt
def str_x(rt, rn, off): return 0xF9000000 | (off // 8) << 10 | rn << 5 | rt
def str_w(rt, rn, off): return 0xB9000000 | (off // 4) << 10 | rn << 5 | rt
def ldrh(rt, rn, off): return 0x79400000 | (off // 2) << 10 | rn << 5 | rt
def strh(rt, rn, off): return 0x79000000 | (off // 2) << 10 | rn << 5 | rt
def movz(rd, imm, sf=0): return (0xD2800000 if sf else 0x52800000) | imm << 5 | rd
def mov_x(rd, rm): return 0xAA0003E0 | rm << 16 | rd
def orr_x(rd, rn, rm): return 0xAA000000 | rm << 16 | rn << 5 | rd
def ubfm(rd, rn, immr, imms, sf): return (0xD3400000 if sf else 0x53000000) | immr << 16 | imms << 10 | rn << 5 | rd
def cmp_imm(rn, imm, sf): return (0xF100001F if sf else 0x7100001F) | imm << 10 | rn << 5
def cset_eq(rd): return 0x1A9F17E0 | rd       # csinc wd, wzr, wzr, ne
def csel_eq(rd, rn, rm): return 0x1A800000 | rm << 16 | rn << 5 | rd
def bic_w(rd, rn, rm): return 0x0A200000 | rm << 16 | rn << 5 | rd
def eor_lsl(rd, rn, rm, sh): return 0x4A000000 | rm << 16 | sh << 10 | rn << 5 | rd
EQ, NE = 0, 1
SP = 31
FRAME, ACC, ID, BUF = 0x80, 0x18, 0x20, 0x28   # BUF..FRAME = 0x58 bytes, an NpadState is 0x28
BUTTONS = BUF + 8                               # game reads NpadState buttons at +8 (main+0x5c9bc8)
STATE = 0x5A - 0x38                             # padding in the record, relative to &record.RenderFunc
COMBO_SHIFT = 4                                 # nn::hid::NpadButton StickL = bit 4, StickR = bit 5


def toggle_code():
    """(word, expected disassembly) for TOGGLE. In: x0 = &record.RenderFunc. Out: w0 = 1 show, 0 hide."""
    a = TOGGLE
    rows = []
    def emit(word, text):
        rows.append((word, text))
    emit(0xA9B87BFD, f"stp x29, x30, [sp, #-{FRAME:#x}]!")
    emit(add_imm(29, SP, 0), "mov x29, sp")
    emit(str_x(19, SP, 0x10), "str x19, [sp, #0x10]")
    emit(mov_x(19, 0), "mov x19, x0")
    for n, (style, npad_id) in enumerate((("Handheld", 0x20), ("FullKey", 0), ("JoyDual", 0))):
        if n == 0:
            emit(movz(8, npad_id), "mov w8, #0x20")
            emit(str_w(8, SP, ID), f"str w8, [sp, #{ID:#x}]")
        elif n == 1:
            emit(str_w(31, SP, ID), f"str wzr, [sp, #{ID:#x}]")
        emit(add_imm(0, SP, BUF), f"add x0, sp, #{BUF:#x}")
        emit(add_imm(1, SP, ID), f"add x1, sp, #{ID:#x}")
        at = a + 4 * len(rows)
        emit(bl(at, GET_NPAD[style]), f"bl {GET_NPAD[style]:#x}")
        emit(ldr_x(8, SP, BUTTONS), f"ldr x8, [sp, #{BUTTONS:#x}]")
        if n == 0:
            emit(str_x(8, SP, ACC), f"str x8, [sp, #{ACC:#x}]")
            continue
        emit(ldr_x(9, SP, ACC), f"ldr x9, [sp, #{ACC:#x}]")
        emit(orr_x(8, 8, 9), "orr x8, x8, x9")
        if n == 1:
            emit(str_x(8, SP, ACC), f"str x8, [sp, #{ACC:#x}]")
    emit(ubfm(8, 8, COMBO_SHIFT, COMBO_SHIFT + 1, 1), "ubfx x8, x8, #4, #2")
    emit(cmp_imm(8, 3, 1), "cmp x8, #3")
    emit(cset_eq(9), "cset w9, eq")                          # w9 = both sticks held
    emit(ldrh(10, 19, STATE), f"ldrh w10, [x19, #{STATE:#x}]")
    emit(ubfm(11, 10, 8, 31, 0), "lsr w11, w10, #8")
    emit(cmp_imm(11, 0xA5, 0), "cmp w11, #0xa5")
    emit(movz(12, 0xA500), "mov w12, #0xa500")
    emit(csel_eq(10, 10, 12), "csel w10, w10, w12, eq")    # invalid -> 0xa500 (visible, not held)
    emit(0x1200014B, "and w11, w10, #1")                     # bit 0 = held last frame
    emit(bic_w(12, 9, 11), "bic w12, w9, w11")               # press edge
    emit(eor_lsl(10, 10, 12, 1), "eor w10, w10, w12, lsl #1")  # bit 1 = hidden, flips on press
    emit(0x3300012A, "bfxil w10, w9, #0, #1")               # bit 0 = held now
    emit(strh(10, 19, STATE), f"strh w10, [x19, #{STATE:#x}]")
    emit(ubfm(0, 10, 1, 1, 0), "ubfx w0, w10, #1, #1")
    emit(0x52000000, "eor w0, w0, #1")
    emit(ldr_x(19, SP, 0x10), "ldr x19, [sp, #0x10]")
    emit(0xA8C87BFD, f"ldp x29, x30, [sp], #{FRAME:#x}")
    emit(0xD65F03C0, "ret")
    return rows


def disasm(code, at):
    md = capstone.Cs(getattr(capstone, "CS_ARCH_AARCH64", None) or capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM)
    return [f"{i.mnemonic} {i.op_str}".strip() for i in md.disasm(code, at)]


def check(img, at, words, before, after):
    """Original bytes must disassemble to `before`; the replacement to `after`."""
    old = disasm(img[at:at + 4 * len(words)], at)
    assert old == before, (hex(at), old)
    code = struct.pack(f"<{len(words)}I", *words)
    new = disasm(code, at)
    assert new == after, (hex(at), [(n, e) for n, e in zip(new, after) if n != e] or new)
    return code


def main(raw_path, nso_path, out_path):
    img = open(raw_path, "rb").read()
    nso = open(nso_path, "rb").read()
    build_id = nso[0x40:0x60].rstrip(b"\0").hex().upper()
    assert build_id == BUILD_ID, build_id
    assert struct.unpack_from("<I", nso, 0x18)[0] == TEXT_END and struct.unpack_from("<I", nso, 0x24)[0] == RODATA

    assert disasm(img[FPS_REGISTRATION:FPS_REGISTRATION + 4], FPS_REGISTRATION) == [f"adr x3, {RENDER_STAT_FPS:#x}"]
    assert img[0x4302A2E:0x4302A2E + 18] == "STAT_FPS\0".encode("utf-16le")
    assert struct.unpack_from("<I", img, RENDER_STAT_FPS)[0] == 0xD503237F  # pacibsp: function entry
    fps = check(img, SITE, [
        adrp(SITE, 8, RENDER_STAT_FPS),
        add_imm(8, 8, RENDER_STAT_FPS & 0xFFF),
        0xEB08039F,                                  # cmp x28, x8 (x28 = EngineStat.RenderFunc)
        b_cond(SITE + 12, ENABLED_CALL, EQ),
        b(SITE + 16, NEXT),
    ], ["ldr x8, [x22, #0x50]", "cbz x8, 0x334748", "madd x14, x10, x13, x25", "add x1, x14, #8", "ldr x14, [x8]"],
        ["adrp x8, 0x3c7e000", "add x8, x8, #0x7ec", "cmp x28, x8", "b.eq 0x3347bc", "b 0x334718"])
    # The enabled-check path; only 0x3347c0 and 0x3347c8 change, the rest is reused as is.
    assert disasm(img[ENABLED_CALL:ENABLED_CALL + 0x20], ENABLED_CALL) == [
        "stp w27, w0, [sp, #8]", "mov x0, x8", "stp x9, x10, [sp, #0x10]", "blr x14",
        "tbz w0, #0, 0x334834", "ldr x28, [x19]", "ldr x26, [x20]", "b 0x334750"]
    arg = check(img, ENABLED_CALL + 4, [mov_x(0, 19)], ["mov x0, x8"], ["mov x0, x19"])
    call = check(img, ENABLED_CALL + 12, [bl(ENABLED_CALL + 12, TOGGLE)], ["blr x14"], [f"bl {TOGGLE:#x}"])
    rows = toggle_code()
    assert TOGGLE + 4 * len(rows) <= RODATA, "toggle does not fit in the text tail padding"
    assert not any(img[TOGGLE:RODATA]), "text tail padding is not empty"
    tog = struct.pack(f"<{len(rows)}I", *(w for w, _ in rows))
    got = disasm(tog, TOGGLE)
    want = [t for _, t in rows]
    assert got == want, [(g, x) for g, x in zip(got, want) if g != x] or (len(got), len(want))

    assert disasm(img[HZ_SITE + 4:HZ_SITE + 8], HZ_SITE + 4) == [f"bl {SET_120HZ_STUB:#x}"]
    hz = check(img, HZ_SITE, [movz(1, 1)], ["mov w1, wzr"], ["mov w1, #1"])

    with open(out_path, "w", newline="\n") as f:
        f.write(f"@nsobid-{build_id}\n"
                "# FF7 Remake Intergrade (Switch 2) code tweaks. Change @enabled to @disabled to turn one off.\n"
                "@flag offset_shift 0x100\n\n"
                "# FPS counter (top right). On at boot; click both sticks (L3+R3) to hide/show.\n"
                "@enabled\n"
                f"{SITE:08X} {fps.hex().upper()}\n"
                f"{ENABLED_CALL + 4:08X} {arg.hex().upper()}\n"
                f"{ENABLED_CALL + 12:08X} {call.hex().upper()}\n"
                f"{TOGGLE:08X} {tog.hex().upper()}\n\n"
                "# 120 Hz: let the screen/TV run at 120 Hz so rhi.SyncInterval=1 can show 120 fps.\n"
                "@enabled\n"
                f"{HZ_SITE:08X} {hz.hex().upper()}\n"
                "@stop\n")
    print(out_path, f"toggle {len(rows)} instructions at {TOGGLE:#x}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
