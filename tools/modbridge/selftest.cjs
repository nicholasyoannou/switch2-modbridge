#!/usr/bin/env node
'use strict';
// node tools/modbridge/selftest.cjs: runs the daemon against mock-bridge.cjs on 127.0.0.1 only, then drives
// the generated run directory with ns2jb-modloader 0.3.5's own (unmodified) validation and client code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startMock, FS_PID, RO_PID, H, TEXT, E, B, ROOT, TABLE, MANAGER, ALLOCATION, SDK_BLOCK, FS_OBJECT, CAVE, HOOK, RELRO, RELRO2, VTABLE, PROLOGUE} = require('./mock-bridge.cjs');
const native = require('./native.cjs');
const {Bridge, OP} = require('./bridge.cjs');
const {discover} = require('./discover.cjs');
const {start} = require('./daemon.cjs');

const repo = path.resolve(__dirname, '../..');
// MODLOADER=<dir> runs the same checks against another ModLoader tree (e.g. moader-src/runtime/modloader).
const ML = path.resolve(repo, process.env.MODLOADER || 'downloads/ns2jb-modloader-0.3.5/ModLoader');
const EN = path.join(path.resolve(process.env.CIV7_FS_KAIHEN || path.join(repo, 'civ7-fs-kaihen')), 'engine');
const log = () => {};

async function refuses(options, pattern) {
  const mock = await startMock(options), b = await Bridge.connect({host: '127.0.0.1', port: mock.port});
  try {
    await assert.rejects(discover(b, log), pattern);
    assert.deepEqual([...mock.fs.handles.keys()].sort(), Object.values(H).sort(), 'failed discovery left handles open');
    assert.equal(mock.scratch.size, 0, 'failed discovery left scratch allocated');
  } finally { b.end(); await mock.close(); }
}

/// The hook site, cave padding, backend pointer, cave page permission and handles are as before the cave ran.
function assertRestored(mock, notifier, scratch = 0) {
  assert(mock.fs.view(HOOK, 16).equals(PROLOGUE), 'hook site not restored');
  assert(mock.fs.view(TEXT + native.CAVE, 0x100).every(x => !x), 'modbridge cave not zero');
  assert.equal(mock.fs.get64(E + 8n), B, 'B not restored at E+8');
  assert.equal(mock.fs.pagePermissions.get(TEXT + 0x24d000n), 4, 'cave page permission not restored');
  assert.equal(mock.fs.get32(E + 0x10n), 1);
  assert.deepEqual([...mock.fs.handles.keys()].sort(), [...Object.values(H), notifier].sort());
  assert.equal(mock.scratch.size, scratch);
}

(async () => {
  // 1. Engine modules come from the civ7-fs-kaihen checkout at the pinned hashes, not from this folder.
  const {engineFiles} = require('./make-run.cjs'), engine = engineFiles();
  for (const {target, bytes} of engine) {
    assert(!fs.existsSync(path.join(__dirname, 'run', target)), target + ' must not be shipped in run/');
    if (target.endsWith('.cjs')) assert(bytes.equals(fs.readFileSync(path.join(EN, target))), target + ' differs from the engine');
  }
  console.log('ok  ' + engine.length + ' engine files taken unchanged from civ7-fs-kaihen at their pinned hashes');

  // 2. Discovery refuses what it cannot prove, and cleans up.
  await refuses({textPermissions: 5}, /first CodeStatic block is not FS \.text/);
  await refuses({twin: true}, /refcount is not unique/);
  console.log('ok  discovery refuses wrong .text and an ambiguous refcount, leaving no handles or scratch');
  {
    const mock = await startMock({tableAcrossBlocks: true}), b = await Bridge.connect({host: '127.0.0.1', port: mock.port});
    const lines = [];
    try {
      const found = await discover(b, line => lines.push(line));
      assert.equal(found.layout.table, TABLE); assert.equal(found.layout.manager, MANAGER); assert.equal(mock.fs.normal.length, 0);
      assert(lines.some(line => line.startsWith('snapshot 3')), 'full-scan path was not taken');
    } finally { b.end(); await mock.close(); }
    console.log('ok  domain table found by the full qword == E scan when it spans two CodeMutable blocks');
  }

  // 3. FS-side copies: the call cave matches ModLoader's call3 template; a failed cave run is undone hook
  // first; an op is refused, touching nothing, while ModLoader has hooked the site or is mid-call (E+8 != B).
  {
    const {bridge: callCode} = require(path.join(ML, 'lib/native/artifacts.cjs'));
    const at = TEXT + native.CAVE, args = [0x1000n, 0x22n, 0x33n], options = {operation: TEXT + 0x694c0n, result: E + 8n};
    assert(native.cave(at, HOOK, E, {...options, args}).equals(callCode(at, E, args, {...options, original_tail: HOOK + 16n})),
      'modbridge call cave differs from ModLoader call3');
    let mock = await startMock({ignoreHook: true}), b = await Bridge.connect({host: '127.0.0.1', port: mock.port});
    try {
      const found = await discover(b, log);
      await assert.rejects(native.Native.open(b, found, log), /FS did not run the modbridge cave/);
      assertRestored(mock, found.notifier.handle);
      assert.equal(mock.fs.mallocs.size, 0);
    } finally { b.end(); await mock.close(); }
    mock = await startMock(); b = await Bridge.connect({host: '127.0.0.1', port: mock.port});
    try {
      const found = await discover(b, log), n = await native.Native.open(b, found, log), hooked = Buffer.alloc(16, 0x11);
      hooked.copy(mock.fs.view(HOOK, 16)); // ModLoader's own hook in place
      await assert.rejects(n.read(RELRO, 16), /not the original prologue/);
      assert(mock.fs.view(HOOK, 16).equals(hooked), 'modbridge touched a hook site it did not own');
      PROLOGUE.copy(mock.fs.view(HOOK, 16));
      mock.fs.set64(E + 8n, 0x1234n); // ModLoader mid-call
      await assert.rejects(n.read(RELRO, 16), /mid-call/);
      assert.equal(mock.fs.get64(E + 8n), 0x1234n, 'modbridge overwrote E+8 during a ModLoader call');
      mock.fs.set64(E + 8n, B);
      assert((await n.read(RELRO + 3n, 13)).equals(mock.fs.view(RELRO + 3n, 13)));
      await n.close();
      assertRestored(mock, found.notifier.handle);
      assert.equal(mock.fs.mallocs.size, 0); assert.deepEqual(mock.fs.faults, []);
    } finally { b.end(); await mock.close(); }
    console.log('ok  cave = ModLoader call3 encoding; failed cave run undone; refuses while ModLoader hooks or is mid-call');
  }

  // 4. Daemon against the mock.
  const mock = await startMock(), runs = fs.mkdtempSync(path.join(os.tmpdir(), 'modbridge-selftest-'));
  const daemon = await start({host: '127.0.0.1', port: mock.port, runsDir: runs, log});
  const {run, session, discovery: d} = daemon;
  let stopped = false;
  try {
    assert.match(session, /^switch2-[A-Za-z0-9]{6}$/);
    assert.equal(d.roPid, RO_PID); assert.equal(d.text.address, TEXT);
    assert.equal(d.notifier.E, E); assert.equal(d.notifier.B, B); assert.equal(d.notifier.hookSlotMatches, true);
    assert.equal(d.layout.table, TABLE); assert.equal(d.layout.manager, MANAGER); assert.equal(d.layout.count, 0x4000);
    assert.equal(mock.fs.get32(E + 0x10n), 1);
    assert.deepEqual([...mock.fs.handles.keys()].sort(), [...Object.values(H), d.notifier.handle].sort());
    assert.equal(mock.scratch.size, 1); // the daemon keeps one IPC scratch slot
    assert.equal(mock.fs.mallocs.size, 1, 'one FS staging block for the session');
    assert.deepEqual(mock.fs.normal, [], 'something asked the console for Normal FS memory');
    assertRestored(mock, d.notifier.handle, 1); // the daemon keeps one IPC scratch slot
    assert.deepEqual(mock.fs.faults, []);
    console.log('ok  discovery: CodeMutable only; RO pid, .text, E/B by 1 -> 8 -> 1, domain table; only the notifier stays open');
    console.log('ok  relro cached by FS itself through the staging block; hook site, cave, B and page permission restored');

    // 5. ModLoader's own checks on the run directory.
    const {verifiedRun} = require(path.join(ML, 'install.cjs'));
    assert.equal(verifiedRun(run), run);
    const current = JSON.parse(fs.readFileSync(path.join(run, 'switch2/fs-execution-current.json')));
    const proof = JSON.parse(fs.readFileSync(path.resolve(run, current.file)));
    const notifierProof = JSON.parse(fs.readFileSync(path.join(run, 'switch2/ro', session + '-notifier-proof.json')));
    const layout = JSON.parse(fs.readFileSync(path.join(run, 'switch2/ro', session + '-layout.json')));
    const config = JSON.parse(fs.readFileSync(path.join(run, 'modbridge.json')));
    console.log('ok  install.cjs verifiedRun accepts ' + session);

    const {openClient} = require(path.join(ML, 'lib/native/client.cjs'));
    const {identifyFs, verifyBulk} = require(path.join(ML, 'lib/native/identity.cjs'));
    const {selectNotifier} = require(path.join(ML, 'lib/native/bridge.cjs'));
    const c = await openClient(run);
    assert.equal(String(c.pid), String(RO_PID));
    const h = await c.fsProcess(), identity = await identifyFs(c, h, proof.identity);
    assert.equal(identity.pid, FS_PID);
    const info = await c.info(h, BigInt(proof.mapping.memory.address), identity.pid);
    assert.equal(info.memory.address, String(TEXT)); assert.equal(info.memory.size, String(0x24e000));
    assert.equal(info.memory.permissions, 4); assert.equal(info.memory.type, 3);
    const bulk = verifyBulk(await c.readBulk(h, identity.pid, TEXT + 0x1000n, 0x4000), identity, 0x4000);
    assert(bulk.equals(mock.fs.view(TEXT + 0x1000n, 0x4000)));
    const small = await c.read(h, identity.pid, TEXT + 0x1201b0n, 16);
    assert.equal(small.hex, mock.fs.view(TEXT + 0x1201b0n, 16).toString('hex'));
    console.log('ok  openClient: raw RO exchange with kernel PID, identifyFs, info, verifyBulk, read');

    // Bridge.open's notifier preconditions.
    assert(notifierProof.identityVerified && await c.memory.pointer(notifierProof.E + 8) === notifierProof.B && await c.memory.u32(notifierProof.E + 16) === 1);
    const state = await c.memory.request({command: 'root-native-info'});
    assert.equal(selectNotifier(state, proof, notifierProof), d.notifier.handle);
    assert.equal((await c.probeNotifier(d.notifier.handle)).result, 0);
    const writeAt = Number(B) + 0x40, before = await c.memory.read(writeAt, 8), after = Buffer.from('0123456789abcdef', 'hex');
    await c.memory.writeBytes(writeAt, before, after); assert((await c.memory.read(writeAt, 8)).equals(after));
    await c.memory.writeU64(writeAt, after.readBigUInt64LE(), 0n);
    console.log('ok  notifier proof, root-native-info, selectNotifier, probe, FS writes');

    // Relro: direct console reads are refused; ModLoader's reads (e.g. source.cjs vtables) come from the cache.
    const direct = await Bridge.connect(config.opsPipe);
    const request = Buffer.alloc(16); request.writeBigUInt64LE(VTABLE); request.writeBigUInt64LE(80n, 8);
    assert.equal((await direct.request(OP.FS_READ, request)).status, 0xd401);
    direct.end();
    assert((await c.memory.read(Number(VTABLE), 80)).equals(mock.fs.view(VTABLE, 80)));
    assert((await c.memory.read(Number(RELRO2) + 0xff0, 16)).equals(mock.fs.view(RELRO2 + 0xff0n, 16)));
    assert.equal((await c.read(h, identity.pid, VTABLE + 0x20n, 8)).hex, mock.fs.view(VTABLE + 0x20n, 8).toString('hex'));
    await assert.rejects(c.memory.writeBytes(Number(VTABLE), Buffer.alloc(8), Buffer.alloc(8, 1)), /relro is read-only/);
    console.log('ok  relro: direct FS_READ refused (0xd401), cached reads served, writes refused');

    // Normal FS memory: refused unless ModLoader allocated it. Its native calls are replayed as its
    // lib/native/bridge.cjs makes them (real call templates from its artifacts.cjs; the mock plays FS).
    await assert.rejects(c.memory.read(Number(FS_OBJECT), 8), /did not allocate it/);
    await assert.rejects(c.read(h, identity.pid, FS_OBJECT, 8), /did not allocate it/);
    const {bridge: callCode} = require(path.join(ML, 'lib/native/artifacts.cjs'));
    let staged = Buffer.alloc(1024);
    const nativeCall = async (offset, args, result, options = {}) => {
      const code = Buffer.alloc(1024);
      callCode(CAVE, E, args, {operation: TEXT + BigInt(offset), result: E + 8n, original_tail: HOOK + 16n, ...options}).copy(code);
      for (let i = 0; i < 1024; i += 16) if (!code.subarray(i, i + 16).equals(staged.subarray(i, i + 16)))
        assert((await c.patch(h, identity.pid, CAVE + BigInt(i), staged.subarray(i, i + 16), code.subarray(i, i + 16))).readbackMatched);
      staged = code;
      const original = Buffer.from(mock.fs.view(HOOK, 16)), hook = Buffer.alloc(16);
      hook.writeUInt32LE((0x14000000 | Number(CAVE - HOOK) / 4) >>> 0);
      for (let i = 4; i < 16; i += 4) hook.writeUInt32LE(0xd503201f, i);
      await c.patch(h, identity.pid, HOOK, original, hook);
      mock.fs.set64(E + 8n, result); // FS ran the call
      const value = await c.memory.u64(Number(E + 8n));
      await c.memory.writeU64(Number(E + 8n), value, B);
      await c.patch(h, identity.pid, HOOK, hook, original);
      return value;
    };
    assert.equal(await nativeCall(0x694c0, [0x1000n], ALLOCATION, {clearAllocation: true}), ALLOCATION);
    const zeros = await c.memory.read(Number(ALLOCATION), 0x100), marked = Buffer.alloc(0x100, 0x5a); // CodeMutable: plain FS_WRITE
    await c.memory.writeBytes(Number(ALLOCATION), zeros, marked);
    assert((await c.read(h, identity.pid, ALLOCATION + 0x10n, 16)).hex === marked.subarray(0x10, 0x20).toString('hex'));
    mock.fs.set64(ALLOCATION + 0xff8n, SDK_BLOCK); // FS+0x215620 stores the new block at *output
    assert.equal(await nativeCall(0x215620, [TEXT + 0x11ee960n, ALLOCATION + 0xff8n, 0x2000n], 0n), 0n);
    assert.equal(await c.memory.u64(Number(ALLOCATION + 0xff8n)), SDK_BLOCK);
    // The SDK block is Normal heap: the console refuses it; FS copies it through the daemon's staging block.
    const sdk = Number(SDK_BLOCK), code = require('node:crypto').randomBytes(0x1800);
    assert((await c.memory.read(sdk + 0x800, 0x1000)).equals(mock.fs.view(SDK_BLOCK + 0x800n, 0x1000)));
    await c.memory.writeBytes(sdk + 0x400, await c.memory.read(sdk + 0x400, code.length), code); // as Bridge.mapRuntime
    assert(mock.fs.view(SDK_BLOCK + 0x400n, code.length).equals(code));
    assert((await c.memory.read(sdk + 0x403, 13)).equals(code.subarray(3, 16)));
    await c.memory.writeBytes(sdk + 0x1ffd, Buffer.from(mock.fs.view(SDK_BLOCK + 0x1ffdn, 3)), Buffer.from([1, 2, 3]));
    assert(mock.fs.view(SDK_BLOCK + 0x1ffdn, 3).equals(Buffer.from([1, 2, 3])));
    assert.equal((await c.read(h, identity.pid, SDK_BLOCK + 0x410n, 16)).hex, code.subarray(0x10, 0x20).toString('hex'));
    await assert.rejects(c.memory.writeBytes(sdk, Buffer.alloc(8, 0xee), Buffer.alloc(8)), /Expected bytes differ/);
    await c.memory.writeU64(sdk + 0x1000, await c.memory.u64(sdk + 0x1000), 0x42n);
    assert.equal(mock.fs.get64(SDK_BLOCK + 0x1000n), 0x42n);
    await assert.rejects(c.memory.read(sdk + 0x1000, 0x1001), /did not allocate it/);
    assertRestored(mock, d.notifier.handle, 2); // the daemon slot and the open client session
    await nativeCall(0x215800, [TEXT + 0x11ee960n, SDK_BLOCK, 0x2000n], 0n);
    await nativeCall(0x69580, [ALLOCATION, 0x1000n], 0n);
    await assert.rejects(c.memory.read(sdk, 8), /did not allocate it/);
    assert.deepEqual(mock.fs.normal, [], 'something asked the console for Normal FS memory');
    const logged = fs.readFileSync(path.join(run, 'modbridge-normal-access.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert(logged.some(row => !row.allowed) && logged.filter(row => row.allowed).every(row =>
      BigInt(row.address) >= SDK_BLOCK && BigInt(row.address) + BigInt(row.length) <= SDK_BLOCK + 0x2000n));
    console.log('ok  Normal memory: FS-side copies (read, write with preimage and readback, unaligned) only inside tracked allocations, all logged');

    // ModLoader's attachGame (JSON over the named pipe, current-root.json) and its domain-table lookup.
    const {attachGame} = require(path.join(ML, 'lib/game-files/session.cjs'));
    const a = await attachGame(run);
    const clone = a.domain.oneHandle(await a.domain.send(a.s, 'clone', a.root, a.domain.wire.control(2)));
    const converted = await a.domain.send(a.s, 'convert', clone, a.domain.wire.control(0));
    const id = converted.data.readUInt32LE();
    assert(id > 0 && id <= layout.count);
    assert.equal((await c.memory.read(layout.table + (id - 1) * 0x30, 0x30)).readBigUInt64LE(32), ROOT);
    await a.s.close(clone);
    await a.close();
    console.log('ok  attachGame over ' + JSON.parse(fs.readFileSync(path.join(run, 'switch2/current-acquisition.json'))).socketPath);
    console.log('ok  layout table + (id-1)*0x30 + 0x20 is the converted object');

    const info2 = await new Promise((resolve, reject) => {
      const socket = require('node:net').createConnection(config.socketPath);
      let input = ''; socket.setEncoding('utf8'); socket.on('error', reject);
      socket.on('connect', () => socket.write('{"command":"info"}\n')); socket.on('data', p => { input += p; }); socket.on('end', () => resolve(JSON.parse(input)));
    });
    assert(info2.ready && info2.session === session);

    const raw = await Bridge.connect(config.opsPipe);
    const closeBuf = Buffer.alloc(4); closeBuf.writeUInt32LE(d.notifier.handle);
    assert.notEqual((await raw.request(OP.CLOSE, closeBuf)).status, 0);
    raw.end();
    assert(mock.fs.handles.has(d.notifier.handle));
    console.log('ok  info command; daemon refuses to close its persistent handles');

    await c.close();
    assert.equal(mock.scratch.size, 1, 'client sessions left scratch allocated');
    assert.deepEqual([...mock.fs.handles.keys()].sort(), [...Object.values(H), d.notifier.handle].sort(), 'handles leaked');
    assert.equal(mock.fs.get32(E + 0x10n), 1); assert.equal(mock.fs.get32(ROOT + 0x38n), 1);
    console.log('ok  no scratch or handle leaks; refcounts back to 1');
    await daemon.stop(); stopped = true;
    assert.equal(mock.fs.mallocs.size, 0, 'staging block not freed'); assertRestored(mock, d.notifier.handle);
    console.log('ok  daemon stop frees the FS staging block and its scratch, leaving FS as found');
  } finally {
    if (!stopped) await daemon.stop();
    await mock.close();
    fs.rmSync(runs, {recursive: true, force: true});
  }
  console.log('SELFTEST PASSED');
})().catch(error => { console.error('SELFTEST FAILED: ' + (error.stack || error)); process.exitCode = 1; });
