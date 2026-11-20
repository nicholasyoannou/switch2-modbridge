#!/usr/bin/env node
'use strict';
// Builds an SD tree for the Moader route on the CivSwitchFS boot (upload it with FTP):
//   switch/Moader.nro                      patched app (moader-src/dist, falls back to plugin enumeration on
//                                          official kaiHEN, which has no Moader reload commands)
//   moader/runtime/{catalogue,ack,log0,log1}.bin   the metadata set Moader's installer stages before hooking
//   moader/library/040093d0233b0000/...    FF7R Intergrade fps paks + code tweaks (IPS32), as Moader mods
// Usage: node stage-moader-sd.cjs <out dir>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '../..');
const {ML, MOADER} = require('./install-moader.cjs');
const TITLE = '040093d0233b0000';
const LOG_SNAPSHOT_CAPACITY = 65616; // moader-src/tools/install-inputs.cjs
const FF7R = path.join(repo, 'mods/ff7r-intergrade');
const PAK = 'romfs/End/Content/Paks/pakchunk0-Switch2.pak';
// id: [name, source dir, enabled]
const PAKS = {'ff7r-120fps': ['FF7R 120 fps (SyncInterval 1)', '120fps', true], 'ff7r-60fps': ['FF7R 60 fps (SyncInterval 2)', '60fps', false],
  'ff7r-40fps': ['FF7R 40 fps (SyncInterval 3)', '40fps', false], 'ff7r-uncapped': ['FF7R uncapped, experimental', 'uncapped-experimental', false]};

// Same bytes as initialRuntimeMetadata(header) in moader-src/tools/install-inputs.cjs + install-moader.cjs prepare().
function initialCatalogue() {
  const header = Buffer.alloc(64);
  header.write('MOADER01'); header.writeUInt32LE(1, 8); crypto.randomFillSync(header, 24, 16);
  if (!header.readBigUInt64LE(24) && !header.readBigUInt64LE(32)) header[24] = 1;
  header.writeUInt32LE(64, 40); header.writeUInt32LE(64, 44);
  return header;
}

function stage(out) {
  check(!fs.existsSync(out), out + ' already exists; use a new folder');
  const put = (relative, data) => { const file = path.join(out, relative); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, data); };
  put('switch/Moader.nro', fs.readFileSync(path.join(MOADER, 'dist/Moader.nro')));
  put('moader/runtime/catalogue.bin', initialCatalogue());
  put('moader/runtime/ack.bin', Buffer.alloc(64));
  for (const log of ['log0', 'log1']) put('moader/runtime/' + log + '.bin', Buffer.alloc(LOG_SNAPSHOT_CAPACITY));
  const library = 'moader/library/' + TITLE + '/';
  for (const [id, [name, source, enabled]] of Object.entries(PAKS)) {
    put(library + id + '/mod.meta', name);
    put(library + id + '/' + PAK, fs.readFileSync(path.join(FF7R, source, TITLE.toUpperCase(), PAK)));
    if (enabled) put(library + id + '/.enabled', '1');
  }
  const pchtxt = path.join(FF7R, 'exefs-tweaks', TITLE.toUpperCase(), 'exefs/ff7r-tweaks.pchtxt');
  const ips = require(path.join(ML, 'lib/pchtxt.cjs')).compilePchtxt(fs.readFileSync(pchtxt), 'ff7r-tweaks.pchtxt');
  put(library + 'ff7r-tweaks/mod.meta', 'FF7R FPS counter (L3+R3) + 120 Hz');
  put(library + 'ff7r-tweaks/exefs_patches/' + ips.buildId.slice(0, 32).toUpperCase() + '.ips', ips.buffer); // NSO build id, zero tail dropped
  put(library + 'ff7r-tweaks/.enabled', '1');
  return {ips};
}
function check(ok, message) { if (!ok) throw Error(message); }

if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: node stage-moader-sd.cjs <out dir>'); process.exit(2); }
  const {ips} = stage(path.resolve(process.argv[2]));
  console.log('Staged ' + process.argv[2] + ' (tweaks: ' + ips.records + ' IPS32 records for build ' + ips.buildId + ')');
}
module.exports = {stage, initialCatalogue};
