# modbridge PC shim

Lets ns2jb-modloader 0.3.5 (its `ModLoader` folder, unmodified) install mods through
the `modbridge.nro` console app (`apps/modbridge`) instead of a civ7-fs-kaihen run.

- `daemon.cjs` holds the single TCP connection to modbridge (default `192.168.50.2:5501`), discovers the FS
  objects ModLoader needs, writes a run directory `RUN = tools/modbridge/runs/switch2-XXXXXX`, and serves two
  named pipes for that run: an ops pipe (modbridge frames from the run's fake engine modules) and the JSON
  `socketPath` ModLoader queries (`root-native-info`, `info`).
- `discover.cjs`: RO PID (from a `0x524f0010` helper reply's special header), FS `.text` (first CodeStatic
  block, must be perm 4 / size `0x24e000`), an owned `ISystemDataUpdateEventNotifier` (fsp-srv 510 on the
  FS root), its object E by the session refcount at `E+0x10` going 1 -> 8 -> 1 under 7 clones, `B = *(E+8)`,
  and the CMIF domain-entry table via a converted clone. It reads only CodeMutable (type 4, perm 3) blocks
  and stops if E or the table is not there; it never reads the Normal heap.
- `native.cjs`: FS-side copies for memory no console op can reach. FS relro (CodeMutable, perm 1,
  attr 16) is permission-locked, and on this kernel RO cannot alias Normal (type 5) heap pages either.
  FS copies the bytes itself with ModLoader's notifier-hook technique:
  - A cave in unused .text padding at FS+0x24d500 (ModLoader uses +0x24d100 and +0x24d800), written with
    RO 0x14.
  - A branch from FS+0x1201b0 to the cave, and command 0 on the daemon's notifier.
  - The cave page is made R-X with RO 0x15 if it is still X-only. It is put back afterwards; if ModLoader has
    already made it R-X, it is left as is.
  - At start the daemon allocates one 0x1000-byte staging block with FS+0x694c0 (CodeMutable, so
    FS_READ/FS_WRITE reach it) and keeps it for the session. Stopping the daemon frees it with FS+0x69580.
  - Read: FS copies target -> stage, then FS_READ of the stage.
  - Write: the preimage is checked the same way, then FS_WRITE stage, FS copies stage -> target, and the
    readback (target -> stage, FS_READ) is compared.
  - Each op first checks that ModLoader is idle: the hook site holds the original prologue and E+8 == B.
    Otherwise it refuses and changes nothing.
  - It unhooks after every call (RO verifies both patches), zeroes the cave, and verifies hook site, cave and
    E+8 by readback. On failure it undoes the hook first.
  - Before RUN is written, the relro blocks are copied once into `RUN/modbridge-relro.bin`. The fake memory
    serves reads there from that file and refuses writes.
  - Cost per 0x1000 bytes: about 13 round trips to read Normal memory, about 40 to write it.
- `make-run.cjs`: the run directory (proofs plus `switch2/app/session.cjs`, `switch2/process/client.cjs`,
  `switch2/tools/fs-memory.cjs` from `run/`, and `shared/ipc.cjs`, `shared/domain.cjs`, `switch2/app/domain.cjs`,
  `switch2/app/filesystem.cjs`, `switch2/app/hash-code.json` copied unchanged from a local
  [s8n/civ7-fs-kaihen](https://github.com/s8n/civ7-fs-kaihen) checkout at commit `51a804c`, checked by SHA-256.
  Default location `../../civ7-fs-kaihen` (next to `tools/`); set `CIV7_FS_KAIHEN` to use another).
- `bridge.cjs`: frame client (TCP or pipe), one request in flight at a time.
- `mock-bridge.cjs`, `selftest.cjs`: local mock of the console app and the self-test (127.0.0.1 and named
  pipes only).

## Self-test

```
node tools/modbridge/selftest.cjs
```

## Real run

1. On the console, start `modbridge` from hbmenu and wait for `listening on port 5501`.
2. On the PC, from this folder:
   ```
   node daemon.cjs --host 192.168.50.2
   ```
   (`--port` and `--runs DIR` are optional.) Discovery reads FS's CodeMutable RW blocks two or three times; leave it
   alone until it prints `RUN=...` and keep this window open.
3. In a second window, from the ns2jb-modloader 0.3.5 `ModLoader` folder:
   ```
   node load.cjs --run-dir "RUN" --keep-rpc
   ```
   Always pass both `--run-dir` and `--keep-rpc` (see below). `--runtime-trace` / `--no-runtime-logs` work
   as usual.

## Stopping safely

- Wait until ModLoader prints `INSTALLED` or `LOAD STOPPED`. Do not stop the daemon while it runs.
- Normal case: Ctrl+C the daemon, then press `+` in modbridge on the console. Exiting modbridge closes the
  notifier and any scratch memory or handles left in it. Installed mods stay resident until reboot.
- If ModLoader reports a pending, timed-out or uncertain native request, or
  `ModLoader/state/<session>/resident-install.json` has `requiresInspectionOrReboot`, a notifier hook may
  still be attached in FS. Do not exit modbridge or retry. Reboot the console.
- Every attempt needs a new daemon run (a new session). Restart modbridge between attempts. It has 8
  scratch slots. The daemon keeps one, and an aborted ModLoader can leave slots allocated.

## ModLoader behaviour this shim does not provide (without changing ModLoader)

- Automatic session discovery (`load.cjs` without `--run-dir`) needs `connection.json` and the ns2jb HTTP
  status port. Not provided.
- The handoff that runs without `--keep-rpc` needs `switch2/ro/current-execution.json`, `runtime.cjs`, the
  ns2jb native worker and `pm` services. Not provided. That handoff would also replace kaiHEN's RO.
- Service lookup: modbridge has no SM handle, so `Session.openService` throws and `root-native-info` reports
  `services: []`. ModLoader 0.3.5's lazy (native-on-mount) install does not use services. Its non-lazy
  verification, game RomFS/CodeFS capture and program-registry paths
  (`switch2/ro/<session>-loader-root-copy.json`) would fail.
- Normal (type 5) FS memory is only touched inside blocks ModLoader allocated in this session, through the
  daemon's FS-side copies (`NORMAL_READ`/`NORMAL_WRITE` on the ops pipe). The blocks are tracked from its
  notifier-hook calls: `FS+0x694c0` results and `*output` of `FS+0x215620`. They are forgotten again on
  `FS+0x69580` / `FS+0x215800`. Any other Normal access fails with `modbridge refused to ... Normal FS
  memory`. Every Normal access is logged to `RUN/modbridge-normal-access.jsonl`. If FS puts an object that
  ModLoader inspects in the Normal heap (for example the SD filesystem or file objects in
  `lib/native/source.cjs`, or buffers its resident runtime allocates), that step is refused. ModLoader's
  own RO requests on Normal pages are not routed through the daemon: `c.map` (0x12, mapping the resident
  code from an `FS+0x215620` block) depends on what RO can do on this kernel.

## Moader route (instead of ns2jb-modloader) — UNTESTED ON A CONSOLE

**Status:** builds and passes the offline tests below; not yet run on a Switch. Expect problems; a failed
install can crash FS, which reboots the console.

Installs the FS runtime from [H644b/Moader](https://github.com/H644b/Moader) v0.2.5 (commit `c7819aa`;
`runtime/modloader`, a fork of ns2jb-modloader 0.3.4) instead of ModLoader 0.3.5. Mods are then managed
from the Moader app in hbmenu: the app writes `/moader/runtime/catalogue.bin`, the runtime re-reads it on FS
opens and swaps routing live, so enabling or disabling a mod needs no reinstall (ExeFS changes need a game
relaunch). Only one FS runtime per boot: use this or `load.cjs`, on a boot where neither has run yet.

Not used: Moader's resident service (`moader.nso`, needs Moader's own HEN), its HEN/RO/bootstrap and its
setup scripts. Do not copy `moader.nso` to the SD.

Setup:
1. Clone H644b/Moader at tag `v0.2.5` as `moader-src` next to `tools/` (or set `MOADER_SRC`), then
   `git -C moader-src apply ../tools/modbridge/moader-app-hen-fallback.patch`. Official kaiHEN 20261117.1 also
   reports protocol 7 but answers Moader's reload command 26 with BadInput (its 23 is GetLoaderRoot), so stock
   Moader.nro stops there instead of opening its foreground mode; the patch makes it fall back to plugin
   enumeration, which finds no resident and starts the foreground mode.
2. Build the app in the ounce-devkit image:
   ```
   docker run --rm -v "$PWD/moader-src:/src" -w /src ounce-devkit make dist/Moader.nro SOURCE_PREFIX_FLAGS=-Wno-error=maybe-uninitialized
   ```
   (GCC 15 in ounce-devkit warns in picojson; Moader pins GCC 16.)
3. `node stage-moader-sd.cjs <out>` builds an SD tree: `switch/Moader.nro`, the four `/moader/runtime`
   metadata files Moader's installer stages before hooking (64-byte catalogue header with a random epoch, ack,
   log0/log1), and FF7R Intergrade mods in `/moader/library/040093d0233b0000/` (120fps + tweaks enabled;
   60/40/uncapped off; the tweaks pchtxt compiled to IPS32 with the modloader's own `pchtxt.cjs`). Needs the
   paks built by `tools/ff7r_fps_pak.py` in `mods/ff7r-intergrade`. Copy it to the SD (FTP works). Copy the
   runtime files only once: after that the app owns them.
4. Each boot: as in "Real run" above, but step 3 is `node install-moader.cjs --run-dir "RUN"` from this
   folder. Then stop the daemon, exit modbridge with `+`, open Moader from hbmenu (Settings -> Advanced should
   show the runtime connected) and start the game.

Files:
- `install-moader.cjs --run-dir RUN`: Moader's `tools/install-runtime.cjs` without host profiles, transport
  guards, HEN install or FS-side SD staging. Never runs the RO handoff. Journal and state in
  `moader-state/<session>/`; one attempt per session.
- `test-install-moader.cjs <fs-4.bin>`: offline, with an FS capture from your console (`ModLoader/state/<session>/native-fs/fs-4.bin`
  of an earlier install): the fork qualifies it, the plan/report/relocated runtime build, and a staged SD tree
  passes Moader's catalogue and library rules. `MODLOADER=<moader-src>/runtime/modloader node selftest.cjs`
  runs the daemon self-test against the fork's own client and session code.

Limits: Moader routes files up to 64 MiB, so FF7 Rebirth's 191 MB pak cannot go through it.
