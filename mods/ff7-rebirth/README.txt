FINAL FANTASY VII REBIRTH (Switch 2) - frame-rate mods
Program ID 04008BE0262BC000, main build ID 12CCA0469530607AFE3C01584F405118 (2026-07-27 build).

Where the 30 fps cap lives
  romfs/End/Content/Paks/pakchunk0-Switch2.pak (pak v11) -> End/Platforms/Switch2/Config/Switch2DeviceProfiles.ini
      +Cvars=rhi.SyncInterval=2
      +CVars=r.DynamicRes.FrameTimeBudget=33.3333
  Game code (main): nn::vi::SetLayerExtendedSwapInterval(layer, 1, Switch2.MaxRefreshRate), default 60,
  and nn::vi::SetDisplayVrrCapability(display, Switch2.EnableVrr), default 1. The RHI turns VRR on only below interval 2.
  So at 60 Hz: 1 = 60 fps, 2 = 30 fps. At MaxRefreshRate=120: 1 = 120, 2 = 60, 3 = 40, 4 = 30.

Variants (each replaces only that ini; all other entries untouched)
  60fps                      SyncInterval=1                     Budget 16.67 ms   safest: refresh rate unchanged
  40fps-120hz                SyncInterval=3, MaxRefreshRate=120 Budget 25 ms      handheld screen or a 120 Hz TV; on a 60 Hz TV expect worse, possibly 20 fps
  vrr-uncapped-experimental  SyncInterval=1, MaxRefreshRate=120 Budget 16.67 ms   120 Hz layer with VRR; frame rate floats, best on the handheld screen
  120fps                     SyncInterval=1, MaxRefreshRate=120 Budget 8.33 ms    120 Hz target; resolution will drop hard

Layout: <variant>/04008BE0262BC000/romfs/End/Content/Paks/pakchunk0-Switch2.pak (191 MB).
Load it with ns2jb-modloader through modbridge (tools/modbridge):
SD:/ns2jb-modloader/contents/04008be0262bc000/romfs/End/Content/Paks/pakchunk0-Switch2.pak
Not yet tested on a console.
Rebuild after a game update: python -P tools\ff7rebirth_fps_pak.py <new pak> mods\ff7-rebirth

Built from your own dump. Do not share the pak: it is the game's data.
