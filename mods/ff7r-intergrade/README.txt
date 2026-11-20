FINAL FANTASY VII REMAKE INTERGRADE (Switch 2) - frame-rate mods
Program ID 040093D0233B0000, main build ID F9E3A6396ECB7F38D5E9C578DFE038F0 (pak from the 2025-12-04 build).

Where the 30 fps cap lives
  romfs/End/Content/Paks/pakchunk0-Switch2.pak -> End/Config/Switch2/Switch2DeviceProfiles.ini
      ; 1:120FPS, 2:60FPS, 3:40FPS, 4:30FPS      (Square Enix's own comment)
      +Cvars=rhi.SyncInterval=4
  Dynamic resolution budget (engine base profile): r.DynamicRes.FrameTimeBudget=33.33 ms.

Variants (each replaces only that ini; every other pak entry is byte-identical)
  40fps                  rhi.SyncInterval=3  FrameTimeBudget=25.00   best bet; needs 120 Hz output (handheld screen / 120 Hz TV)
  60fps                  rhi.SyncInterval=2  FrameTimeBudget=16.67   resolution will drop hard (DRS floor 50%)
  120fps                 rhi.SyncInterval=1  FrameTimeBudget=8.333   needs the 120 Hz code tweak below to go past 60
  uncapped-experimental  rhi.SyncInterval=0  FrameTimeBudget=16.67   no vsync wait; may tear or be rejected by the system

Layout is Atmosphere-style: <variant>/040093D0233B0000/romfs/End/Content/Paks/pakchunk0-Switch2.pak
Load it with ns2jb-modloader through modbridge (tools/modbridge): copy the variant's 040093D0233B0000 folder
contents to SD:/ns2jb-modloader/contents/040093d0233b0000/.
Remove the mod to get stock 30 fps back. A game update replaces this pak: rebuild with
  python -P tools\ff7r_fps_pak.py <new pakchunk0-Switch2.pak> mods\ff7r-intergrade

Built from your own dump. Do not share the pak: it is the game's data.

Code tweaks (exefs-tweaks/): one IPSwitch file for main (build F9E3A6396ECB7F38D5E9C578DFE038F0),
two sections, each can be switched off by changing its @enabled to @disabled:
  FPS counter  turns on UE4's own "stat fps" overlay (NN.NN FPS / NN.NN ms, top right, green/yellow/red).
               On at boot; click both sticks (L3+R3) to hide/show. Reads handheld, Pro Controller and
               Joy-Con pair (player 1). Test: python -P tools\test_ff7r_toggle.py <main.raw> <pchtxt>
  120 Hz       stock code always calls SetDisplay120HzRefreshRateCapability(false), so the screen/TV stays
               at 60 Hz and the 120fps pak cannot show more than 60. This passes true. Handheld VRR is
               unchanged (on when SyncInterval < 4); docked VRR stays off. On a 120 Hz TV it also makes
               the 40fps pak judder-free docked.
Copy exefs-tweaks/040093D0233B0000/exefs/ff7r-tweaks.pchtxt to
  SD:/ns2jb-modloader/contents/040093d0233b0000/exefs/ff7r-tweaks.pchtxt
ExeFS changes are read when the modloader installs: fresh boot + modloader install, then launch the game.
Delete the file (and reinstall) to remove it. Rebuild after a game update:
  python -P tools\ff7r_exefs_tweaks.py dumps\ff7r-intergrade\raw\main.raw dumps\ff7r-intergrade\exefs\main <out .pchtxt>

Resolution (checked in code, 2026-11-20): output is a fixed 1920x1080 in handheld and docked
(main+0x2b2ae90; only -ResX=/-ResY= on a command line changes it). Rendering uses dynamic resolution
50-100% of that (r.DynamicRes.Min/MaxScreenPercentage) with DLSS on by default (r.DLSS.Enabled=1),
upscaled to 1080p. Docked, the console scales that 1080p image to the TV.
