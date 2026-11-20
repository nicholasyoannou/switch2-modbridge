#!/usr/bin/env node
'use strict';
// Offline checks for the Moader route (no console):
//  1. Moader's fork qualifies a real FS capture from this console (the 0.3.5 install's fs-4.bin).
//  2. install-moader.cjs builds its plan, report and relocated runtime/context from that capture.
//  3. stage-moader-sd.cjs output passes the checks Moader's runtime (moader.c) and library apply.
// Usage: node test-install-moader.cjs <fs-4.bin>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {planFor, reportFor, layoutCheck, ML} = require('./install-moader.cjs');
const {stage} = require('./stage-moader-sd.cjs');

const repo = path.resolve(__dirname, '../..');
// FS .text capture from your console: ModLoader/state/<session>/native-fs/fs-4.bin of any earlier install.
const capture = path.resolve(process.argv[2] || path.join(repo, 'downloads/ns2jb-modloader-0.3.5/ModLoader/state/switch2-dsEqix/native-fs/fs-4.bin'));
if (!fs.existsSync(capture)) { console.error('Usage: node test-install-moader.cjs <fs-4.bin>   (not found: ' + capture + ')'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moader-test-'));

(async () => {
  const validation = require(path.join(ML, 'lib/native.cjs')).validateCapture(fs.readFileSync(capture));
  assert.equal(validation.runtimeLoggingCompatible, true, 'fork: FS logging ABI not qualified');
  console.log('ok  fork validateCapture: ' + validation.validatedRanges + ' FS ranges, logging ABI qualified');

  const session = 'switch2-Offline1', plan = planFor(session, {verified: true, session, runtimeLoggingCompatible: true, ...validation});
  const report = reportFor(session, plan);
  assert.equal(report.sdPath, '/moader/runtime/runtime.log');
  plan.diagnostics = {...report, buffer: undefined, text: report.buffer.toString('utf8'), size: report.buffer.length};
  const built = await layoutCheck(plan, capture, tmp);
  assert(built.contextBytes > 0 && built.runtimeBytes > 0, 'empty native build');
  console.log('ok  plan.moader report + relocated runtime/context build: ' + JSON.stringify(built));

  const sd = path.join(tmp, 'sd'), {ips} = stage(sd);
  const header = fs.readFileSync(path.join(sd, 'moader/runtime/catalogue.bin'));
  // lfs_moader_reload_locked: identified, rows 0, total_size == file size, strings right after rows, epoch != 0,
  // reserved 0; parse(): payload_crc == crc32 of the (empty) payload == 0.
  assert.equal(header.length, 64); assert.equal(header.toString('latin1', 0, 8), 'MOADER01'); assert.equal(header.readUInt32LE(8), 1);
  assert.equal(header.readUInt32LE(12), 0); assert.equal(header.readUInt32LE(40), 64); assert.equal(header.readUInt32LE(44), 64);
  assert(header.readBigUInt64LE(24) | header.readBigUInt64LE(32)); assert.equal(header.readUInt32LE(48), 0);
  assert.equal(header.readUInt32LE(52), 0); assert.equal(header.readBigUInt64LE(56), 0n);
  for (const [file, size] of [['ack.bin', 64], ['log0.bin', 65616], ['log1.bin', 65616]])
    assert.equal(fs.statSync(path.join(sd, 'moader/runtime', file)).size, size, file);
  console.log('ok  runtime metadata: catalogue header accepted by moader.c rules, ack/log sizes');

  const library = path.join(sd, 'moader/library/040093d0233b0000');
  for (const id of fs.readdirSync(library)) {
    assert.match(id, /^[a-z0-9_-]{1,48}$/, 'Moader valid_mod_id');
    const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    for (const file of walk(path.join(library, id))) assert(fs.statSync(file).size <= 64 * 1024 * 1024, 'over Moader 64 MiB row limit: ' + file);
  }
  const enabled = fs.readdirSync(library).filter(id => fs.existsSync(path.join(library, id, '.enabled')));
  assert.deepEqual(enabled.sort(), ['ff7r-120fps', 'ff7r-tweaks']);
  const patch = fs.readFileSync(path.join(library, 'ff7r-tweaks/exefs_patches', 'F9E3A6396ECB7F38D5E9C578DFE038F0.ips'));
  assert.equal(patch.toString('latin1', 0, 5), 'IPS32'); assert.equal(patch.toString('latin1', patch.length - 4), 'EEOF');
  assert(patch.equals(ips.buffer));
  console.log('ok  library: ' + fs.readdirSync(library).length + ' mods, enabled ' + enabled.join(' + ') + ', tweaks IPS32 ' + ips.records + ' records');
  fs.rmSync(tmp, {recursive: true, force: true});
  console.log('MOADER OFFLINE TEST PASSED');
})().catch(error => { console.error(error); process.exitCode = 1; });
