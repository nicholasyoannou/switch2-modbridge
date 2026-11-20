'use strict';
// Writes a civ7-fs-kaihen-style run directory that ns2jb-modloader 0.3.5 accepts unchanged:
// the proofs it validates plus the engine modules it require()s, backed by the modbridge daemon.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TEMPLATE = path.join(__dirname, 'run');
// Unchanged engine modules ModLoader require()s, copied from a local s8n/civ7-fs-kaihen checkout (commit
// 51a804cbce09216e1a42e65929644fd436b4c8bf) rather than shipped here. CIV7_FS_KAIHEN overrides its location.
const CIV7 = path.resolve(process.env.CIV7_FS_KAIHEN || path.join(__dirname, '../../civ7-fs-kaihen'));
const ENGINE_FILES = {
  'shared/ipc.cjs': ['engine/shared/ipc.cjs', '059d0ef672ad578734a258052b6a89a263ec76d3123b53a623d43adca4ce20da'],
  'shared/domain.cjs': ['engine/shared/domain.cjs', '106108ea1044cb41e5f16b14477170922690ceb794a0f786e7b8780bfe7b60a6'],
  'switch2/app/domain.cjs': ['engine/switch2/app/domain.cjs', 'bdde0f204755f91506747a4cfec3d9b1a4194469c6346afb69fad8b1f4898aa1'],
  'switch2/app/filesystem.cjs': ['engine/switch2/app/filesystem.cjs', '4db643c45b10708ec051918fcf296485b73b8f2ef333ba4e20446de6a430d114'],
  'switch2/app/hash-code.json': ['targets/civ7/app/hash-code.json', '59f04db61ea92b29e3e1f22fc59770fab7bd5d6ef3f6fbef8e3f31ff28357daf'],
};
function engineFiles() {
  return Object.entries(ENGINE_FILES).map(([target, [source, sha256]]) => {
    const file = path.join(CIV7, source);
    if (!fs.existsSync(file)) throw Error('Missing ' + file + ' (clone s8n/civ7-fs-kaihen at 51a804c next to tools/, or set CIV7_FS_KAIHEN)');
    const bytes = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error(file + ' differs from civ7-fs-kaihen 51a804c');
    return {target, bytes};
  });
}
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// ModLoader matches sessions with /^switch2-[A-Za-z0-9]+$/.
const newSession = () => 'switch2-' + Array.from(crypto.randomBytes(6), x => ALPHABET[x % ALPHABET.length]).join('');

// FS addresses are below 2^39, so ModLoader's Number arithmetic on them is exact.
const n = value => Number(value);

function makeRun(runsDir, session, d, pipes) {
  const run = path.join(path.resolve(runsDir), session);
  const engine = engineFiles(); // checked before anything is written
  fs.mkdirSync(path.dirname(run), {recursive: true});
  fs.mkdirSync(run); // fails if this session already exists
  fs.cpSync(TEMPLATE, run, {recursive: true});
  for (const {target, bytes} of engine) {
    fs.mkdirSync(path.dirname(path.join(run, target)), {recursive: true});
    fs.writeFileSync(path.join(run, target), bytes);
  }
  fs.copyFileSync(path.join(__dirname, 'bridge.cjs'), path.join(run, 'switch2/tools/bridge.cjs'));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(run, file)), {recursive: true});
    fs.writeFileSync(path.join(run, file), JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  };
  const started = new Date().toISOString(), {E, B, handle} = d.notifier;
  // FS relro is permission-locked (RO cannot map it); the fake memory serves it from this FS-made copy.
  let offset = 0;
  const relro = (d.relro || []).map(r => { const row = {address: String(r.address), size: String(r.size), offset}; offset += r.bytes.length; return row; });
  fs.writeFileSync(path.join(run, 'modbridge-relro.bin'), Buffer.concat((d.relro || []).map(r => r.bytes)), {mode: 0o600});
  write('modbridge.json', {session, opsPipe: pipes.ops, socketPath: pipes.json,
    handles: {ro: d.hello.ro, fsProcess: d.hello.fsProcess, fsRoot: d.hello.fsRoot, notifier: handle},
    roPid: String(d.roPid), fsPid: String(d.hello.fsPid), textBase: String(d.text.address), textSize: String(d.text.size),
    notifierE: String(E), relro, started});
  write('result.json', {platform: 2, session, verified: true, rpc: {state: 'listening'}, provider: 'modbridge', started});
  const proofFile = 'switch2/' + session + '-fs-execution.json';
  write('switch2/fs-execution-current.json', {session, verified: true, file: proofFile});
  write(proofFile, {session, verified: true, identity: {pid: String(d.hello.fsPid), programId: '0400000000000000'},
    mapping: {memory: {address: String(d.text.address), size: String(d.text.size), type: d.text.type, permissions: d.text.permissions}},
    notifier: {object: n(E), backend: n(B), handle}, roPid: String(d.roPid), discovery: 'modbridge'});
  write('switch2/ro/' + session + '-notifier-proof.json', {session, identityVerified: true, E: n(E), B: n(B), handle,
    vptr: n(d.notifier.vptr), vtableSlot4IsNotifierHook: d.notifier.hookSlotMatches,
    discovery: 'session refcount at E+0x10 went 1 -> 8 -> 1', challenge: d.challenge});
  write('switch2/ro/' + session + '-layout.json', {session, table: n(d.layout.table), count: d.layout.count,
    manager: n(d.layout.manager), domain: n(d.layout.domain), entry: n(d.layout.entry), objectId: d.layout.objectId,
    discovery: 'converted notifier clone located in the CMIF domain-entry table', regions: d.regions});
  write('switch2/current-acquisition.json', {session, socketPath: pipes.json});
  write('switch2/ro/root/current-root.json', {session, rootHandle: d.hello.fsRoot});
  return run;
}

// The daemon's own use of the engine's IPC/domain encoders, from the same pinned checkout files.
function requireEngine(target) {
  engineFiles();
  return require(path.join(CIV7, ENGINE_FILES[target][0]));
}

module.exports = {makeRun, newSession, engineFiles, requireEngine, ENGINE_FILES};
