# switch2-modbridge

> [!IMPORTANT]
> Built on [**kaiHEN**](https://github.com/ouncebrew/kaihen) by ouncebrew, [**CivSwitchFS-kaiHEN**](https://github.com/s8n/CivSwitchFS-kaiHEN) by s8n,
> [**ns2jb-modloader**](https://github.com/SebaaMG/ns2jb-modloader) by SebaaMG and the ns2jb RO helper from
> [**civ7-fs-kaihen**](https://github.com/s8n/civ7-fs-kaihen) / [**ns2jb**](https://gitlab.com/kurumuz/ns2jb). All the hard work is theirs.

switch2-modbridge lets **ns2jb-modloader** install mods (RomFS and ExeFS) on a Switch 2 that boots **kaiHEN through
CivSwitchFS**. No held FS exploit session is needed: a small hbmenu app, **Mod Bridge**, gives the PC tools access
to FS through a patched kaiHEN.

It also includes frame-rate mods for FINAL FANTASY VII REMAKE INTERGRADE (see [FF7 mods](#ff7-mods)).

This repository is very much AI assisted with Claude, and is temperimental / experimental. Have tested with own Switch 2 and eShop FF7 games.

## Repo state

Early code. A failed install can crash FS, which restarts the console. Mods stay installed until the next
restart, so you install again after every reboot.

### Tested configuration

- Nintendo Switch 2, firmware **23.0.1**
- **CivSwitchFS-kaiHEN 20261117.1** with the persisted chain (Civ 7 → Load Game boots kaiHEN)
- **ns2jb-modloader 0.3.5**, unmodified

### Requirements

- A console that already reaches hbmenu through [CivSwitchFS-kaiHEN](https://github.com/s8n/CivSwitchFS-kaiHEN)
- A PC on the same network with Node.js **22 or later**
- The console's IP address (System Settings → Internet)

## Usage

### Install (once)

1. Download `switch2-modbridge-<version>-sd.zip` from [Releases](../../releases) and extract it onto your SD card,
   overwriting `kaihen/bin/ro/main` and `kaihen/bin/hen/main`. Keep your CivSwitchFS-kaiHEN zip to undo this.
2. Download [ns2jb-modloader 0.3.5](https://github.com/SebaaMG/ns2jb-modloader/releases/tag/v0.3.5). Copy its
   `sd-card-root` contents to the SD card, then put your mods in `/ns2jb-modloader/contents/<title id>/` as its
   README describes.
3. On your PC, download **switch2-modbridge** and open a terminal in its folder. Clone s8n's civ7-fs-kaihen
   into it at the pinned commit. The bridge loads five files from it:

   ```sh
   git clone https://github.com/s8n/civ7-fs-kaihen.git
   git -C civ7-fs-kaihen checkout 51a804cbce09216e1a42e65929644fd436b4c8bf
   ```

### Load mods (every boot)

1. Boot kaiHEN as usual: Civ 7 → Load Game, close Civ 7, then hold R while opening a Switch 2 game to get hbmenu.
2. Open **Mod Bridge** in hbmenu. Wait for `listening on port 5501`.
3. From the `switch2-modbridge` folder, start the bridge with your console's IP address:

   ```sh
   node tools/modbridge/daemon.cjs --host <console-ip>
   ```

   Wait about a minute until it prints `RUN=...` and a `load.cjs` command. Leave it running.
4. In a second terminal, from ns2jb-modloader's `ModLoader` folder, run the command it printed:

   ```sh
   node load.cjs --run-dir "<RUN>" --keep-rpc
   ```

   Wait for `INSTALLED`.
5. Press Ctrl+C in the first terminal, then press **+** to close Mod Bridge.
6. Start your game normally. Mods stay active until the console restarts.

Mod Bridge only matters during the install. It does not load mods itself. To change mods, edit the SD card,
restart, and repeat these steps. Only install once per boot. If an install fails, restart before trying again.

**Undo:** copy `kaihen/bin/ro/main` and `kaihen/bin/hen/main` back from the CivSwitchFS-kaiHEN zip and delete
`kaihen/civswitchfs-skipcheck`.

### Moader (untested)

`moader-untested-<version>-sd.zip` loads [Moader](https://github.com/H644b/Moader)'s FS runtime instead of
ns2jb-modloader, so you can switch mods on and off from the Moader app without reinstalling. **This has not been
tested on a console yet.** Steps are in [tools/modbridge/README.md](tools/modbridge/README.md#moader-route-instead-of-ns2jb-modloader--untested-on-a-console).

## FF7 mods

- `ff7r-intergrade-tweaks-<version>.zip` (Releases): FF7 Remake Intergrade FPS counter (L3+R3 toggles it) and
  120 Hz unlock. Extract onto the SD card.
- Frame-rate cap: built from your own game dump with `tools/ff7r_fps_pak.py` (see
  [mods/ff7r-intergrade/README.txt](mods/ff7r-intergrade/README.txt)). Rebirth:
  [mods/ff7-rebirth/README.txt](mods/ff7-rebirth/README.txt) (untested). The paks are game data, so don't share them.

As for the performance of these mods, on the 120 FPS variant (since the Switch display is 120 Hz haven't tested above that) the game in handheld mode during combat (tested in Chapter 1 and early Chapter 2) maintains 40 FPS. Docked it can waver from 40 to 60 FPS (my capture card caps at 60FPS so max it's capable of needs further testing). I've attached footage recorded footage below via (a cheap) USB-HDMI for docked.

<table>
  <tr>
    <th>Docked (<a href="https://otgsytpue8.ufs.sh/f/9ac2dkswyWNhj8VvcBO1q97hVzMGdt3uYH5wWr24TUCkSlos">uncompressed 1GB copy</a>)</th>
  </tr>
  <tr>
    <td><a href="https://otgsytpue8.ufs.sh/f/9ac2dkswyWNhd2rJjQzeNKOVcp7jsDAxfR8rYFL9mXPZ3QgS"><img width="540" height="304" alt="ff7r-demo-play" src="https://github.com/user-attachments/assets/2949e453-2bcb-4c76-a98f-a65f0ab2c5a5" /></a></td>
  </tr>
</table>

## How it works

- **kaiHEN patches** (`kaihen/patches`, against [ouncebrew/kaihen](https://github.com/ouncebrew/kaihen) tag
  `20261117.1`): RO's `ro:dmnt` service gains the helper commands ns2jb-modloader's client sends
  (`0x524f0010` query, `0x11` read, `0x12`/`0x13` map/unmap code, `0x14` write, `0x15` text-read toggle,
  `0x26` bulk read). Every command that writes or maps refuses any process except FS. HEN gains homebrew
  command 64, a copy of the FS process handle.
- **`apps/modbridge`** ("Mod Bridge" in hbmenu): the console end of the install. It opens FS through the
  patched kaiHEN and serves it to the PC over TCP port 5501. It is open only while you install, and mods stay
  active after you close it.
- **`tools/modbridge`**: PC daemon. It finds the FS objects ModLoader needs, writes a run directory shaped
  like a civ7-fs-kaihen run, and passes ModLoader's requests to the console through modbridge. ModLoader
  itself runs unmodified with `--keep-rpc`, so kaiHEN's RO is never replaced. Details and safety notes are in
  [tools/modbridge/README.md](tools/modbridge/README.md).
- **`apps/fsprobe`**: read/write probe used to check the patched RO against FS (development aid).
- **Moader route — untested on a console**: install the FS runtime of
  [Moader](https://github.com/H644b/Moader) v0.2.5 through modbridge instead of ns2jb-modloader, then manage
  mods from the Moader app in hbmenu with no reinstall. Needs a patched Moader.nro (patch included). See the
  Moader section of [tools/modbridge/README.md](tools/modbridge/README.md).

## Building from source

The release zips already contain these builds, and they rebuild byte-for-byte from the sources in switch2-modbridge.

1. **kaiHEN.** Clone ouncebrew/kaihen, check out `20261117.1`, apply the patches with
   `git am /path/to/kaihen/patches/*.patch`, then build with `docker build --output out .` (see kaiHEN's
   README). Back up `SD:/kaihen/bin/ro/main` and `SD:/kaihen/bin/hen/main`, then replace them with
   `out/ro/main` and `out/hen/main`. Create an empty file `SD:/kaihen/civswitchfs-skipcheck`, which makes the
   CivSwitchFS chain check that the binaries are present instead of checking their hashes.
2. **Apps.** Build them in the [ounce-devkit](https://github.com/ouncebrew/ounce-devkit) image:
   `docker run --rm -v "$PWD:/src" -w /src/apps/modbridge ounce-devkit make`. Copy `modbridge.nro` to
   `SD:/switch/`.
3. **PC.** Install Node.js 22 or newer (tested with 24) and extract ns2jb-modloader 0.3.5. Clone
   [s8n/civ7-fs-kaihen](https://github.com/s8n/civ7-fs-kaihen) at commit `51a804c` next to `tools/`, or set
   `CIV7_FS_KAIHEN` to point at it. The daemon copies five engine files from that checkout and checks their
   SHA-256 hashes. Run the self-test against a local mock console:
   `MODLOADER=/path/to/ModLoader node tools/modbridge/selftest.cjs`.
4. **Each boot.** Boot kaiHEN through CivSwitchFS and open modbridge from hbmenu. On the PC, run
   `node tools/modbridge/daemon.cjs --host <switch IP>`. Then, from the ModLoader folder, run
   `node load.cjs --run-dir "<RUN printed by the daemon>" --keep-rpc`.

You can install only once per boot. A failed install can crash FS, which reboots the console.

### ESP32 LDN board: persist the kaiHEN chain without a PC

For developers. This uses [SeanHeuc's esp32-ldn-civ7](https://github.com/SeanHeuc/CivSwitch/tree/main/esp32-ldn-civ7)
firmware unchanged (layout checked at SeanHeuc/CivSwitch `5bba4b6`), and replaces only its `blob_apply.bin` with
one that runs CivSwitchFS-kaiHEN's persist installer. One LDN lobby run then sets up the Load Game → kaiHEN
chain, the same as `npm run persist:chain`, with no PC. Tested on firmware 23.0.1.

1. Build esp32-ldn-civ7 with your own `prod.keys`, following its README. The firmware it builds contains keys
   derived from your `prod.keys`, so never share it.
2. In CivSwitchFS-kaiHEN, run `npm run persist:build -- --chain`.
3. Build the replacement blob:
   `python -P tools/make_esp32_persist_blob.py <CivSwitchFS-kaiHEN>/dist/persist blob_apply.bin`.
   It checks the save template's hash and that the blob fits the board's apply area.
4. Put the ESP32-S3 in flash mode, then write only the apply blob over the existing firmware:
   `python -m esptool --chip esp32s3 -p <port> write-flash 0x290000 blob_apply.bin`.
5. Reset the board. In Civ 7, go to Multiplayer → Wireless → Create Game (R3) → Host Lobby (+), then power the
   board. Close Civ 7 afterwards. From then on, Load Game boots kaiHEN.

## Not included

Game data, console or FS dumps, keys and logs.

## Credits

- [ouncebrew/kaihen](https://github.com/ouncebrew/kaihen) (GPL-2.0): RO and HEN, patched here.
- [s8n/CivSwitchFS-kaiHEN](https://github.com/s8n/CivSwitchFS-kaiHEN) (GPL-2.0): the boot chain.
- [SebaaMG/ns2jb-modloader](https://github.com/SebaaMG/ns2jb-modloader) (GPL-2.0): the mod loader.
- [H644b/Moader](https://github.com/H644b/Moader) (GPL-2.0): mod manager app and FS runtime (Moader route).
- [SeanHeuc/CivSwitch](https://github.com/SeanHeuc/CivSwitch) esp32-ldn-civ7: the LDN board firmware (ESP32 section).
- [s8n/civ7-fs-kaihen](https://github.com/s8n/civ7-fs-kaihen) and [kurumuz/ns2jb](https://gitlab.com/kurumuz/ns2jb):
  - the RO helper protocol; `ro/source/helper_ops.cpp` in the kaiHEN patches is a port of civ7-fs-kaihen's
    `engine/switch2/ro/payload/process.c`
  - the engine files the daemon loads from a local checkout

  Neither project includes a license file.

## License

GPL-2.0-only, see [LICENSE](LICENSE).
