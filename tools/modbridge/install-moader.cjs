#!/usr/bin/env node
'use strict';
// Installs Moader's FS runtime (moader-src/runtime/modloader, Moader v0.2.5) through a modbridge run.
// Same steps as moader-src/tools/install-runtime.cjs, without the parts that need Moader's own hosts:
// no host profile or transport guard (a modbridge run is the plain ns2jb layout), no HEN/RO/bootstrap
// install and no FS-side SD staging. The four /moader/runtime metadata files must already be on SD
// (stage-moader-sd.cjs + FTP). The RO handoff (handoff.cjs) is never called, so kaiHEN's RO stays.
//
// Usage: node install-moader.cjs --run-dir RUN
const fs = require('node:fs');
const path = require('node:path');

// H644b/Moader checkout at v0.2.5 (next to tools/, or MOADER_SRC).
const MOADER = path.resolve(process.env.MOADER_SRC || path.join(__dirname, '../../moader-src'));
const ML = path.join(MOADER, 'runtime/modloader');
if (!fs.existsSync(path.join(ML, 'install.cjs'))) throw Error('No Moader v0.2.5 checkout at ' + MOADER + ' (clone H644b/Moader next to tools/, or set MOADER_SRC)');
const STATE = path.join(__dirname, 'moader-state');
const check = (ok, message) => { if (!ok) throw Error(message); };

// The resident plan Moader installs: no SD-scanned games; routing comes later from /moader/runtime/catalogue.bin.
function planFor(session, profile) {
  const plan = require(path.join(ML, 'lib/lazy-context.cjs')).plan({games: [], patches: []}, session);
  plan.moader = true; plan.nativeProfile = profile; plan.runtimeDiagnostics = true; plan.runtimeTrace = false;
  return plan;
}
const reportFor = (session, plan) => require(path.join(ML, 'lib/diagnostics.cjs')).report(
  {session, sdPath: '/moader/runtime/runtime.log', collection: {games: [], patches: []}, plan, status: 'prepared', trace: false});
// Offline relocation/context build at fake addresses, exactly as install-runtime.cjs checks before hooking.
async function layoutCheck(plan, capture, directory) {
  const {buildAll} = require(path.join(ML, 'lib/native.cjs')), {buildContext} = require(path.join(ML, 'lib/context.cjs'));
  const native = await buildAll(0x4000000000n, 0x6000000000n, plan, {capture, directory: path.join(directory, 'offline-build')});
  const context = buildContext(plan, {filesystem: {object: 0x6100001000n}, registry: 0x6100003000n,
    logFile: {object: 0x6100002000n, write: 0x40001050a0n, flush: 0x40001053d0n, setSize: 0x4000105410n}}, 0x4000000000n, 0x6000000000n, native);
  return {contextBytes: context.length, runtimeBytes: native.runtimeBytes, gatewayBytes: native.codeBytes};
}

async function install(run, log = console.log) {
  run = require(path.join(ML, 'install.cjs')).verifiedRun(path.resolve(run));
  const session = path.basename(run), directory = path.join(STATE, session);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const journal = path.join(directory, 'moader-runtime.json');
  const record = {session, started: new Date().toISOString(), stage: 'preflight', complete: false};
  // wx: one attempt per session; a second run of this command on the same RUN stops here.
  fs.writeFileSync(journal, JSON.stringify(record, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  const save = () => fs.writeFileSync(journal, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  const phase = async (name, action) => { record.stage = name; save(); log(name); const value = await action(); record[name] = value; save(); return value; };
  try {
    const {captureNative} = require(path.join(ML, 'lib/native-capture.cjs'));
    const capture = await phase('qualify fresh FS code and mappings', () => captureNative(run, directory));
    const profile = JSON.parse(fs.readFileSync(path.join(directory, 'native-fs/manifest.json')));
    check(profile.verified === true && profile.session === session && profile.runtimeLoggingCompatible === true,
      'Moader requires the same-session verified fresh native capture and qualified write/flush ABI');
    const plan = planFor(session, profile);
    const folder = path.join(directory, 'prepared'); fs.mkdirSync(folder, {recursive: true});
    fs.writeFileSync(path.join(folder, plan.payload.filename), Buffer.alloc(0));
    const report = reportFor(session, plan);
    record.report = await phase('create Moader runtime report', () => require(path.join(ML, 'lib/diagnostics.cjs')).writeReport(run, report));
    plan.diagnostics = {...report, buffer: undefined, text: report.buffer.toString('utf8'), size: report.buffer.length};
    fs.writeFileSync(path.join(folder, 'overlay.json'), JSON.stringify(plan, null, 2) + '\n');
    await phase('check relocation and native context layout', () => layoutCheck(plan, capture, directory));
    const resident = await phase('attach resident filesystem routing', () =>
      require(path.join(ML, 'lib/resident.cjs')).install(run, plan, directory, capture, null, name => log('  ' + name)));
    check(resident.verified && resident.active && resident.controllerHandlesClosed && resident.diagnosticsOwned === true && resident.diagnosticWriteErrors === '0',
      'Native runtime did not reach verified idle handoff with required Moader diagnostics');
    record.complete = true; record.finished = new Date().toISOString(); save();
    return {record, directory};
  } catch (error) {
    record.error = String(error.stack || error); record.inspectBeforeRetry = true; save();
    error.message += ' (journal: ' + journal + ')';
    throw error;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--run-dir') {
    console.error('Usage: node install-moader.cjs --run-dir RUN'); process.exit(2);
  }
  install(argv[1]).then(({directory}) => {
    console.log('MOADER RUNTIME INSTALLED — RPC stays open; stock RO handoff not run. State: ' + directory);
    console.log('Stop the daemon (Ctrl+C), exit modbridge with +, then open Moader from hbmenu.');
  }, error => { console.error('MOADER INSTALL STOPPED: ' + error.message); process.exitCode = 1; });
}

module.exports = {install, planFor, reportFor, layoutCheck, ML, MOADER};
