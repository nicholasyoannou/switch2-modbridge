'use strict';
// Finds what ModLoader's run directory needs (RO PID, FS .text, an owned notifier object and the CMIF
// domain table) using only modbridge console ops. No vtable or heap-offset knowledge is assumed.
// Only CodeMutable (type 4) RW blocks inside FS's image are read: the console reads Normal (type 5) heap
// pages by aliasing them as code, which hides them from FS meanwhile, so discovery never touches them.
const {packet, response} = require('./make-run.cjs').requireEngine('shared/ipc.cjs');
const {control} = require('./make-run.cjs').requireEngine('shared/domain.cjs');

const check = (ok, message) => { if (!ok) throw Error(message); };
const hex = value => '0x' + value.toString(16);
const canonical = value => value >= 0x100000000n && value < 0x8000000000n;
const FS_PROGRAM = 0x0400000000000000n, TEXT_SIZE = 0x24e000n, CAPACITY = 0x4000, ENTRY = 0x30n;
const NOTIFIER_HOOK = 0x1201b0n; // ModLoader's NOTIFIER offset; recorded only as a hint
const CLONES = 7, MAX_CANDIDATES = 4096;

async function walk(b) {
  const blocks = [];
  // The last block ends exactly at 2^64.
  for (let at = 0n; at < 1n << 64n;) {
    check(blocks.length < 0x10000, 'FS memory map does not terminate');
    const q = await b.fsQuery(at);
    check(q.size > 0n && q.address <= at && q.address + q.size > at, 'Invalid FS memory block at ' + hex(at));
    blocks.push(q); at = q.address + q.size;
  }
  return blocks;
}

const codeMutable = blocks => blocks.filter(q => q.type === 4 && q.permissions === 3);
/// True when [at, at+n) lies inside one of the given blocks.
const within = (blocks, at, n) => blocks.some(q => at >= q.address && at + BigInt(n) <= q.address + q.size);

async function snapshot(b, regions, label, log) {
  const started = Date.now(), total = regions.reduce((n, r) => n + Number(r.size), 0);
  const out = [];
  for (const r of regions) out.push({address: r.address, bytes: await b.fsRead(r.address, Number(r.size))});
  log(label + ': ' + (total / 1048576).toFixed(1) + ' MiB in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  return out;
}

async function u32(b, at) { return (await b.fsRead(at, 4)).readUInt32LE(); }

/// The spec chain: X = entry+0x20 holds E; dom = *(entry+0x18); manager = *(dom+0x18);
/// *(manager+0x18) == entry - (k-1)*0x30 and u32 *(manager+0x10) == 0x4000.
async function domainChain(b, entry, E, k, regions) {
  const read = async (at, n) => { if (!within(regions, at, n)) throw Object.assign(Error('outside CodeMutable'), {status: -1}); return b.fsRead(at, n); };
  try {
    const e = await read(entry, 0x30);
    if (e.readBigUInt64LE(0x20) !== E) return null;
    const domain = e.readBigUInt64LE(0x18);
    if (!canonical(domain)) return null;
    const manager = (await read(domain + 0x18n, 8)).readBigUInt64LE();
    if (!canonical(manager)) return null;
    const m = await read(manager + 0x10n, 0x10), count = m.readUInt32LE(0), table = m.readBigUInt64LE(8);
    return count === CAPACITY && table === entry - BigInt(k - 1) * ENTRY ? {entry, domain, manager, table, count} : null;
  } catch (error) {
    if (error.status) return null; // a pointer outside CodeMutable memory is simply not a match
    throw error;
  }
}

/// Manager-shaped records seen in a snapshot: u32 0x4000 at +0x10 and a table at +0x18 that fits in
/// the snapshot. Saves one full heap read; the chain itself is still verified live.
function managerTables(snap) {
  const inside = (at, n) => snap.some(r => at >= r.address && at + n <= r.address + BigInt(r.bytes.length));
  const tables = new Set();
  for (const {bytes} of snap)
    for (let o = 0; o + 0x20 <= bytes.length; o += 8)
      if (bytes.readUInt32LE(o + 0x10) === CAPACITY) {
        const table = bytes.readBigUInt64LE(o + 0x18);
        if (canonical(table) && inside(table, BigInt(CAPACITY) * ENTRY)) tables.add(table);
      }
  return [...tables];
}

async function discover(b, log = () => {}) {
  const hello = await b.hello();
  log('HELLO: ro:dmnt ' + hex(hello.ro) + ', FS process ' + hex(hello.fsProcess) + ', FS root ' + hex(hello.fsRoot) + ', FS pid ' + hello.fsPid);
  const scratch = await b.alloc(0x1000), clones = [];
  let notifier = null, done = false;
  const ipc = async (handle, bytes) => {
    await b.memWrite(scratch, bytes);
    const transport = await b.send(handle, scratch, 0x1000);
    check(!transport, 'IPC transport failed: ' + hex(transport));
    return b.memRead(scratch, 256);
  };
  const clone = async handle => {
    const r = response(await ipc(handle, control(2)));
    check(!r.result && r.moves.length === 1 && !r.copies.length, 'CloneCurrentObject failed: ' + hex(r.result));
    clones.push(r.moves[0]);
    return r.moves[0];
  };
  const closeClone = async handle => {
    check(!(await b.close(handle)), 'Clone did not close');
    clones.splice(clones.indexOf(handle), 1);
  };
  const closeAll = async () => { while (clones.length) await closeClone(clones.at(-1)); };
  try {
    // RO PID: the kernel inserts the RO process PID into the helper reply's special header.
    const raw = await ipc(hello.ro, packet(0x524f0010, Buffer.alloc(32), {pid: true, copies: [hello.fsProcess]}));
    const identity = response(raw);
    check(raw.readUInt32LE(4) >>> 31 && raw.readUInt32LE(8) & 1, 'RO reply carries no kernel PID');
    check(!identity.result && identity.data.readBigUInt64LE(0) === hello.fsPid && identity.data.readBigUInt64LE(8) === FS_PROGRAM,
      'RO helper did not identify the FS process: ' + hex(identity.result));
    const roPid = raw.readBigUInt64LE(12);
    check(roPid > 0n, 'Invalid RO PID');
    log('RO pid ' + roPid);

    const blocks = await walk(b);
    const text = blocks.find(q => q.type === 3);
    check(text && text.permissions === 4 && text.size === TEXT_SIZE && !text.attributes,
      'Refusing: first CodeStatic block is not FS .text (perm 4, size 0x24e000): ' +
      (text ? hex(text.address) + ' perm ' + text.permissions + ' size ' + hex(text.size) : 'none'));
    log('FS .text ' + hex(text.address));

    const opened = response(await ipc(hello.fsRoot, packet(510)));
    check(!opened.result && opened.moves.length === 1 && !opened.copies.length,
      'OpenSystemDataUpdateEventNotifier failed: ' + hex(opened.result));
    notifier = opened.moves[0];
    log('notifier handle ' + hex(notifier));

    // Refcount challenge: the notifier's u32 at E+0x10 counts its sessions, 1 -> 8 -> 1.
    const regions = codeMutable(blocks).map(q => ({address: q.address, size: q.size}));
    check(regions.length, 'No CodeMutable RW blocks in FS');
    const s1 = await snapshot(b, regions, 'snapshot 1 (1 session)', log);
    for (let i = 0; i < CLONES; i++) await clone(notifier);
    const s2 = await snapshot(b, regions, 'snapshot 2 (8 sessions)', log);
    await closeAll();
    let survivors = [];
    for (let i = 0; i < s1.length; i++) {
      const a = s1[i].bytes, c = s2[i].bytes;
      for (let o = 0; o + 4 <= a.length; o += 8) if (a.readUInt32LE(o) === 1 && c.readUInt32LE(o) === CLONES + 1) survivors.push(s1[i].address + BigInt(o));
    }
    const afterClones = survivors.length;
    check(afterClones <= MAX_CANDIDATES, 'Too many 1 -> 8 candidates (' + afterClones + '); FS heap is too busy, retry');
    const keep = async value => {
      const next = [];
      for (const at of survivors) if (await u32(b, at) === value) next.push(at);
      survivors = next;
    };
    await keep(1);
    log('refcount candidates: ' + afterClones + ' after cloning, ' + survivors.length + ' after closing');
    // Ambiguity is narrowed with smaller challenges on the survivors only.
    const rounds = [];
    for (let round = 0; survivors.length > 1 && round < 3; round++) {
      const n = 3 + round;
      for (let i = 0; i < n; i++) await clone(notifier);
      await keep(n + 1);
      await closeAll();
      await keep(1);
      rounds.push({clones: n, survivors: survivors.length});
    }
    check(survivors.length === 1, 'Notifier refcount is not unique in CodeMutable memory (' + survivors.length + ' candidates); not scanning the Normal heap');
    const E = survivors[0] - 0x10n;
    check(within(regions, E, 0x18), 'Notifier object straddles a CodeMutable block edge');
    const head = await b.fsRead(E, 0x18);
    const vptr = head.readBigUInt64LE(0), B = head.readBigUInt64LE(8);
    check(canonical(B) && canonical(vptr), 'Notifier object at ' + hex(E) + ' has no canonical vtable/backend');
    let hookSlot = null;
    // Diagnostic only: vtables sit in FS's relro block (perm 1, attr 16), which RO cannot map.
    if (within(blocks.filter(q => [3, 4].includes(q.type)), vptr + 0x20n, 8)) {
      try { hookSlot = (await b.fsRead(vptr + 0x20n, 8)).readBigUInt64LE() === text.address + NOTIFIER_HOOK; }
      catch (error) { log('vtable slot not readable (' + error.message + '); skipping that check'); }
    }
    log('notifier object E ' + hex(E) + ', backend B ' + hex(B) + (hookSlot === false ? ' (WARNING: vtable slot 4 is not FS+0x1201b0)' : ''));

    // Domain table: a converted clone puts E in entry k of FS's single CMIF domain-entry table.
    let layout, objectId;
    const domainClone = await clone(notifier);
    try {
      const converted = response(await ipc(domainClone, control(0)));
      check(!converted.result, 'ConvertCurrentObjectToDomain failed: ' + hex(converted.result));
      objectId = converted.data.readUInt32LE();
      check(objectId > 0 && objectId <= CAPACITY, 'Invalid domain object id ' + objectId);
      let matches = [];
      for (const table of managerTables(s2)) {
        const found = await domainChain(b, table + BigInt(objectId - 1) * ENTRY, E, objectId, regions);
        if (found) matches.push(found);
      }
      if (!matches.length) {
        // Spec path: every qword == E in a fresh read of the same FS memory is a candidate X.
        const s3 = await snapshot(b, regions, 'snapshot 3 (domain open)', log);
        for (const {address, bytes} of s3)
          for (let o = 0; o + 8 <= bytes.length; o += 8)
            if (bytes.readBigUInt64LE(o) === E) {
              const found = await domainChain(b, address + BigInt(o) - 0x20n, E, objectId, regions);
              if (found) matches.push(found);
            }
      }
      matches = [...new Map(matches.map(m => [m.entry, m])).values()];
      check(matches.length === 1, 'CMIF domain table is not unique in CodeMutable memory (' + matches.length + ' matches); not scanning the Normal heap');
      layout = matches[0];
    } finally { await closeClone(domainClone); }
    check(await u32(b, E + 0x10n) === 1, 'Notifier refcount did not return to 1');
    log('domain table ' + hex(layout.table) + ' (count ' + hex(layout.count) + ', manager ' + hex(layout.manager) + ')');
    done = true;
    return {hello, roPid, text, notifier: {handle: notifier, E, B, vptr, hookSlotMatches: hookSlot},
      challenge: {clones: CLONES, candidatesAfterClone: afterClones, rounds}, layout: {...layout, objectId},
      regions: regions.map(r => ({address: hex(r.address), size: hex(r.size)})), blocks};
  } finally {
    // On failure leave nothing behind; on success only the notifier stays open.
    if (b.error) log('console connection lost; handles stay with modbridge until it exits');
    else {
      await closeAll();
      if (!done && notifier !== null) await b.close(notifier);
      await b.free(scratch);
    }
  }
}

module.exports = {discover, walk, domainChain, managerTables};
