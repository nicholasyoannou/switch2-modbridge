#!/usr/bin/env python3
"""Build the ESP32 LDN board's blob_apply.bin from CivSwitchFS's persistent installer.

The esp32-ldn-civ7 board sends the save template into window.__tpl (base64 chunks), then
sends blob_apply's JS to the console's :9026 loader. Stock blob_apply persists plain
CivSwitch; this one runs CivSwitchFS's persist-bootstrap.js (the same installer
`npm run persist:chain` sends) and feeds it that template, so one LDN run restores the
Load Game -> kaiHEN chain with no PC. blob_tpl.bin is unchanged: both use the same template.

Usage: python -P make_esp32_persist_blob.py <CivSwitchFS dist/persist dir> <out blob_apply.bin>
Run `npm run persist:build -- --chain` (or persist:chain) first so dist/persist is current.
"""
import base64
import hashlib
import json
import os
import struct
import sys

TEMPLATE_SHA256 = "32fa8a0d6dd0a480d8e541e63ea44c4619bc6f7be4282cfc3cb6a4f6d305dfae"
CHUNK = 400000  # CivSwitchFS installer: MAX_CHUNK 480000, multiple of 4
APPLY_AREA = 0x80000  # esp32-ldn-civ7 storage: apply blob at +0x180000, partition ends at +0x200000

GLUE = """
;(async function () {
try {
    const b64 = (window.__tpl || []).join("");
    window.__tpl = null;
    if (b64.length !== %(tpl_b64_len)d) { await log("E: template incomplete " + b64.length); return; }
    for (let offset = 0, index = 1; offset < b64.length; offset += %(chunk)d, index++)
        window.__cfsPersistInstaller.stageChunk("esp32-ldn", index, offset, b64.slice(offset, offset + %(chunk)d));
    await log("CivSwitchFS template staged from the board.");
    const report = await window.__cfsPersistInstaller.installFromTemplate();
    await log(report && report.message ? report.message : "Installed. Restart the game, then open Load Game menu.");
} catch (e) {
    await log("EXCEPTION: " + e.message);
    await log(String(e.stack));
}
})();
"""


def main(dist, out):
    manifest = json.load(open(os.path.join(dist, "install-image.json")))
    if not manifest["version"].endswith("+kaihen"):
        sys.exit("dist/persist is not the kaiHEN chain build (%s); run persist:build -- --chain" % manifest["version"])
    template = open(os.path.join(dist, "save-template.bin"), "rb").read()
    if hashlib.sha256(template).hexdigest() != TEMPLATE_SHA256:
        sys.exit("unexpected save template")
    bootstrap = open(os.path.join(dist, "persist-bootstrap.js"), "rb").read().decode("ascii")
    tpl_b64_len = len(base64.b64encode(template))
    js = (bootstrap + GLUE % {"tpl_b64_len": tpl_b64_len, "chunk": CHUNK}).encode("ascii")
    blob = struct.pack("<I", len(base64.b64encode(js))) + base64.b64encode(js)
    if len(blob) > APPLY_AREA:
        sys.exit("blob_apply too large: %d > %d" % (len(blob), APPLY_AREA))
    # Self-check: the blob decodes back to the installer plus glue.
    n = struct.unpack_from("<I", blob)[0]
    assert base64.b64decode(blob[4:4 + n]) == js
    open(out, "wb").write(blob)
    print("%s: installer %s, js %d bytes, blob %d bytes (limit %d), template b64 %d"
          % (out, manifest["version"], len(js), len(blob), APPLY_AREA, tpl_b64_len))


if __name__ == "__main__":
    main(*sys.argv[1:3])
