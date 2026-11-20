'use strict';
// Local stand-in for modbridge.nro, for selftest.cjs only. Same TCP frames on 127.0.0.1, over a synthetic
// FS: a memory map, a notifier whose u32 at +0x10 counts its sessions, a CMIF domain-entry table, an FS
// root that clones/converts, and an RO that answers ns2jb helper commands with its kernel PID.
const net = require('node:net');
const crypto = require('node:crypto');
const {OP, MAX_PAYLOAD, frames, frame} = require('./bridge.cjs');

const BAD = 0xd401, BAD_HANDLE = 0xe401, UNKNOWN = 0xf801;
const FS_PID = 8n, RO_PID = 0x51n, PROGRAM = 0x0400000000000000n;
const H = {ro: 0x3401d7, fsProcess: 0x3281d9, fsRoot: 0x3301d8};
// FS image: .text, .rodata, relro (CodeMutable, perm 1, attr 16: permission-locked, unreadable through any
// console op, holding the vtables), then CodeMutable RW (.data/.bss pools) holding the notifier, root,
// domain manager and table, and a second relro page after it. The Normal heap sits at a low address, as on the
// console; discovery must never touch it and the fake memory only inside ModLoader's own allocations.
const TEXT = 0x74d3c00000n, RODATA = TEXT + 0x24e000n, RELRO = RODATA + 0x80000n, DATA = RELRO + 0x10000n;
const HEAP = 0x0932460000n, END = 1n << 39n;
const E = DATA + 0x12340n, B = DATA + 0x20000n, ROOT = DATA + 0x30000n, TWIN = DATA + 0x40000n, COUNTER = DATA + 0x50000n;
const RELRO2 = DATA + 0x800000n, VTABLE = RELRO + 0x1000n, MANAGER = DATA + 0x100n, TABLE = DATA + 0x100000n, DOMAINS = DATA + 0x200000n;
const DECOY_MANAGER = DATA + 0x300000n, HEAP_TWIN = HEAP + 0x8000n;
// For the simulated ModLoader native calls in selftest.cjs.
// FS+0x694c0 hands out CodeMutable memory; FS+0x215620 SDK blocks are Normal heap.
const ALLOCATION = DATA + 0x6f0000n, SDK_BLOCK = HEAP + 0x100000n, FS_OBJECT = HEAP + 0x200000n;
const CAVE = TEXT + 0x24d100n, HOOK = TEXT + 0x1201b0n, MALLOC = TEXT + 0x694c0n, FREE = TEXT + 0x69580n;
const PROLOGUE = Buffer.from('7f2303d5ff8300d1fd7b01a9fd430091', 'hex'), NONCE = 0x6dfe;

function createModel({textPermissions = 4, twin = false, tableAcrossBlocks = false, ignoreHook = false} = {}) {
  const data = Buffer.alloc(0x800000), split = TABLE + 0x10000n - DATA;
  const mapped = [
    {address: TEXT, size: 0x24e000n, type: 3, permissions: textPermissions, bytes: crypto.randomBytes(0x24e000)},
    {address: RODATA, size: 0x80000n, type: 3, permissions: 1},
    {address: RELRO, size: 0x10000n, type: 4, permissions: 1, attributes: 16, bytes: crypto.randomBytes(0x10000)},
    // tableAcrossBlocks splits the RW block inside the table, forcing discovery's full qword == E scan.
    ...(tableAcrossBlocks ? [{address: DATA, size: split, type: 4, permissions: 3, bytes: data.subarray(0, Number(split))},
      {address: DATA + split, size: 0x800000n - split, type: 4, permissions: 3, bytes: data.subarray(Number(split))}] :
      [{address: DATA, size: 0x800000n, type: 4, permissions: 3, bytes: data}]),
    {address: RELRO2, size: 0x1000n, type: 4, permissions: 1, attributes: 16, bytes: crypto.randomBytes(0x1000)},
  ];
  const heap = {address: HEAP, size: 0x400000n, type: 5, permissions: 3};
  for (const b of [heap, ...mapped]) b.bytes ||= Buffer.alloc(Number(b.size));
  mapped[0].bytes.fill(0, Number(CAVE - TEXT), 0x24e000); // zero padding: ModLoader's caves and the free space
  PROLOGUE.copy(mapped[0].bytes, Number(HOOK - TEXT));
  const map = [];
  let at = 0n;
  for (const b of [heap, ...mapped]) { if (b.address > at) map.push({address: at, size: b.address - at, type: 0, permissions: 0}); map.push(b); at = b.address + b.size; }
  map.push({address: at, size: END - at, type: 0, permissions: 0}, {address: END, size: (1n << 64n) - END, type: 0x10, permissions: 0});

  const query = address => map.find(b => address >= b.address && address < b.address + b.size);
  const view = (address, length) => {
    const b = query(address);
    return b?.bytes && address + BigInt(length) <= b.address + b.size ? b.bytes.subarray(Number(address - b.address), Number(address - b.address) + length) : null;
  };
  const get32 = at => view(at, 4).readUInt32LE(), set32 = (at, v) => view(at, 4).writeUInt32LE(v);
  const get64 = at => view(at, 8).readBigUInt64LE(), set64 = (at, v) => view(at, 8).writeBigUInt64LE(v);

  set64(VTABLE + 0x20n, HOOK);
  set32(ROOT + 0x38n, 1); // held by the FS root handle
  set32(COUNTER + 0x10n, 1); // decoy: counts clones but never releases (passes 1 -> 8, fails -> 1)
  if (twin) set32(TWIN + 0x10n, 1);
  for (let i = 1; i < 16; i++) set32(DATA + BigInt(i) * 0x1000n + 0x10n, 1); // static decoys
  set32(MANAGER + 0x10n, 0x4000); set64(MANAGER + 0x18n, TABLE);
  set32(DECOY_MANAGER + 0x10n, 0x4000); set64(DECOY_MANAGER + 0x18n, DATA + 0x400000n);
  const used = new Set();
  const placeEntry = (i, object) => {
    const entry = TABLE + BigInt(i) * 0x30n, domain = DOMAINS + BigInt(i) * 0x40n;
    set64(domain + 0x18n, MANAGER); set64(entry + 0x18n, domain); set64(entry + 0x20n, object); used.add(i);
  };
  for (let i = 0; i < 3; i++) placeEntry(i, DATA + 0x60000n + BigInt(i) * 0x100n); // domains of other clients

  const handles = new Map([[H.ro, {kind: 'ro'}], [H.fsProcess, {kind: 'process'}], [H.fsRoot, {kind: 'root', object: ROOT, refOffset: 0x38n}]]);
  let nextHandle = 0x400001, notifierOpen = false;
  const addRef = (h, delta) => {
    if (!h.object) return;
    set32(h.object + h.refOffset, get32(h.object + h.refOffset) + delta);
    if (h.kind === 'notifier') {
      set32(HEAP_TWIN + 0x10n, get32(E + 0x10n)); // only found if discovery reads Normal memory
      if (twin) set32(TWIN + 0x10n, get32(E + 0x10n));
      if (delta > 0) set32(COUNTER + 0x10n, get32(COUNTER + 0x10n) + delta);
    }
  };
  const newHandle = value => { const handle = nextHandle; nextHandle += 2; handles.set(handle, value); return handle; };
  const close = handle => {
    const h = handles.get(handle);
    if (!h) return BAD_HANDLE;
    if (h.entry !== undefined) { view(TABLE + BigInt(h.entry) * 0x30n, 0x30).fill(0); view(DOMAINS + BigInt(h.entry) * 0x40n, 0x40).fill(0); used.delete(h.entry); }
    addRef(h, -1); handles.delete(handle);
    return 0;
  };
  const pagePermissions = new Map(), mallocs = new Map(), frees = [];
  let nextMalloc = DATA + 0x700000n;
  // Plays FS running a cave that a branch at the notifier's command-0 handler leads to (as built by native.cjs
  // or ModLoader's call templates): decodes the literal pool, checks the owner and the pass-through branch.
  function runHook(object) {
    const word = view(HOOK, 4).readUInt32LE(0);
    if (ignoreHook || word >>> 26 !== 5) return null;
    const at = HOOK + BigInt(((word & 0x3ffffff) << 6) >> 6) * 4n, code = view(at, 256), first = code.readUInt32LE(0);
    if (pagePermissions.get(at & ~0xfffn) !== 5) throw Error('cave literal load from an execute-only page (FS would crash)');
    if (first >>> 24 !== 0x58 || (first & 31) !== 9) throw Error('cave does not start with ldr x9, owner');
    const pool = 4 * ((first >>> 5) & 0x7ffff), passthrough = code.indexOf(PROLOGUE);
    const tail = code.readUInt32LE(passthrough + 16), target = at + BigInt(passthrough + 16) + BigInt(((tail & 0x3ffffff) << 6) >> 6) * 4n;
    if (passthrough % 4 || tail >>> 26 !== 5 || target !== HOOK + 16n) throw Error('cave pass-through does not return to the hooked function');
    if (code.readBigUInt64LE(pool) !== object) return null;
    const [operation, result, a, b, c] = [8, 16, 24, 32, 40].map(o => code.readBigUInt64LE(pool + o));
    let value;
    if (code.subarray(0, pool).includes(Buffer.from('4c8540f8', 'hex'))) { view(b, Number(c)).copy(view(a, Number(c))); value = 0n; }
    else if (operation === MALLOC) { value = nextMalloc; nextMalloc += 0x1000n; mallocs.set(value, a); }
    else if (operation === FREE) { if (mallocs.get(a) === b) { mallocs.delete(a); frees.push(a); } value = 0n; }
    else throw Error('mock cannot run FS function ' + operation.toString(16));
    if (result) set64(result, value); // copy caves store no result
    return NONCE;
  }
  return {map, query, view, get32, get64, set64, handles, close, addRef, newHandle, used, placeEntry, normal: [], faults: [], pagePermissions, mallocs, frees, runHook,
    openNotifier() {
      if (notifierOpen) return null;
      notifierOpen = true;
      set64(E, VTABLE); set64(E + 0x8n, B); set32(E + 0x10n, 1); set64(B + 0x10n, B + 0x10n);
      set32(HEAP_TWIN + 0x10n, 1);
      if (twin) set32(TWIN + 0x10n, 1);
      return newHandle({kind: 'notifier', object: E, refOffset: 0x10n});
    }};
}

// HIPC request layout, as written by the engine's shared/ipc.cjs packet() and shared/domain.cjs control().
function parse(p) {
  const first = p.readUInt32LE(0), second = p.readUInt32LE(4);
  let at = 8, pid = false;
  const copies = [], moves = [], buffers = [];
  if (second >>> 31) {
    const special = p.readUInt32LE(at); at += 4;
    if (special & 1) { pid = true; at += 8; }
    for (let i = 0; i < (special >>> 1 & 15); i++, at += 4) copies.push(p.readUInt32LE(at));
    for (let i = 0; i < (special >>> 5 & 15); i++, at += 4) moves.push(p.readUInt32LE(at));
  }
  at += (first >>> 16 & 15) * 8;
  const sends = first >>> 20 & 15, receives = first >>> 24 & 15;
  for (let i = 0; i < sends + receives + (first >>> 28 & 15); i++, at += 12) {
    const w0 = p.readUInt32LE(at), w1 = p.readUInt32LE(at + 4), w2 = p.readUInt32LE(at + 8);
    buffers.push({size: Number(BigInt(w0) | BigInt(w2 >>> 24 & 15) << 32n),
      address: Number(BigInt(w1) | BigInt(w2 >>> 28 & 15) << 32n | BigInt(w2 >>> 2 & 7) << 36n)});
  }
  const data = p.subarray((at + 15) & ~15);
  return {type: first & 0xffff, pid, copies, moves, receive: buffers.slice(sends, sends + receives), data,
    command: data.toString('ascii', 0, 4) === 'SFCI' ? data.readUInt32LE(8) : null};
}

function reply({result = 0, data = Buffer.alloc(0), moves = []}) {
  const p = Buffer.alloc(0x100);
  let at = 8;
  if (moves.length) { p.writeUInt32LE(moves.length << 5, 8); at = 12; for (const h of moves) { p.writeUInt32LE(h, at); at += 4; } }
  at = (at + 15) & ~15;
  p.writeUInt32LE(((moves.length ? 0x80000000 : 0) | Math.ceil((at + 8 + data.length) / 4)) >>> 0, 4);
  p.write('SFCO', at); p.writeUInt32LE(result, at + 8); data.copy(p, at + 16);
  return p;
}

function startMock(options = {}) {
  const fs = createModel(options), scratch = new Map();
  let nextScratch = 0x4100000000;
  const inScratch = (address, length) => {
    for (const [base, bytes] of scratch)
      if (address >= base && address + length <= base + bytes.length) return bytes.subarray(address - base, address - base + length);
    return null;
  };
  const sends = [];

  // ns2jb RO helper: reply special header with send_pid; the kernel would insert RO's PID at word 3.
  function ro(req) {
    const out = Array(13).fill(0n);
    let bytes = 64, result = 0, extra = null;
    const target = fs.handles.get(req.copies[0]), input = [0, 1, 2, 3].map(i => req.data.readBigUInt64LE(16 + 8 * i));
    if (req.copies.length !== 1 || target?.kind !== 'process') result = BAD_HANDLE;
    else {
      out[0] = FS_PID; out[1] = PROGRAM;
      const q = fs.query(input[1]);
      if (input[0] && input[0] !== FS_PID) result = BAD;
      else if (req.command === 0x524f0010) {
        Object.assign(out, {4: q.address, 5: q.size, 6: BigInt(q.type) | BigInt(q.attributes || 0) << 32n, 7: BigInt(q.permissions), 9: 0x800000000n, 10: 0x7800000000n, 11: 0x10000000n, 12: 0x20000000n});
        bytes = 104;
      } else if (!input[0]) result = BAD;
      else if (req.command === 0x524f0011) {
        // RO cannot map Normal pages (the kernel refuses), as on the console.
        const n = Number(input[2]), data = q.type !== 5 && !q.attributes && n > 0 && n <= 128 && (input[1] & 0xfffn) + input[2] <= 0x1000n ? fs.view(input[1], n) : null;
        if (!data) result = BAD; else { out[6] = BigInt(n); extra = Buffer.from(data); bytes = 56 + n; }
      } else if (req.command === 0x524f0016) {
        const n = Number(input[2]), into = req.receive[0], data = into && [3, 4].includes(q.type) && !q.attributes && n > 0 && n <= 0x400000 && n <= into.size ? fs.view(input[1], n) : null;
        const destination = data && inScratch(into.address, n);
        if (!destination) result = BAD; else { data.copy(destination); out[3] = 0x30000000n; out[6] = BigInt(n); }
      } else if (req.command === 0x524f0015) {
        const [page, size, permission] = [input[1], input[2], input[3]];
        if (q.type !== 3 || page & 0xfffn || size !== 0x1000n || ![4n, 5n].includes(permission)) result = BAD;
        else { out[3] = BigInt(fs.pagePermissions.get(page) ?? q.permissions); fs.pagePermissions.set(page, Number(permission)); bytes = 88; }
      } else if (req.command === 0x524f0014) {
        const code = q.type === 3 && input[2] === 16n ? fs.view(input[1], 16) : null, words = [4, 5, 6, 7].map(i => req.data.readBigUInt64LE(16 + 8 * i));
        const expected = Buffer.alloc(16), replacement = Buffer.alloc(16);
        expected.writeBigUInt64LE(words[0]); expected.writeBigUInt64LE(words[1], 8); replacement.writeBigUInt64LE(words[2]); replacement.writeBigUInt64LE(words[3], 8);
        out[5] = BigInt(q.permissions); out[9] = 0x30000000n; bytes = 80;
        if (!code || !code.equals(expected)) result = BAD; else { replacement.copy(code); out[6] = 1n; out[7] = 1n; }
      } else result = BAD;
    }
    const p = Buffer.alloc(0x100), outBytes = Buffer.alloc(13 * 8);
    out.forEach((v, i) => outBytes.writeBigUInt64LE(v, i * 8));
    p.writeUInt32LE((0x80000000 | Math.ceil((32 + bytes) / 4)) >>> 0, 4);
    p.writeUInt32LE(1, 8); p.writeBigUInt64LE(RO_PID, 12);
    p.write('SFCO', 32); p.writeUInt32LE(result, 40);
    outBytes.subarray(0, Math.min(bytes, 104)).copy(p, 48);
    if (extra) extra.copy(p, 48 + 56);
    return p;
  }

  function service(h, req) {
    if (req.command === null) return reply({result: BAD});
    if (req.type === 5) {
      if (req.command === 2) { fs.addRef(h, 1); return reply({moves: [fs.newHandle({...h, entry: undefined})]}); }
      if (req.command === 0 && h.entry === undefined && h.object) {
        let i = 0;
        while (fs.used.has(i)) i++;
        fs.placeEntry(i, h.object); h.entry = i;
        const data = Buffer.alloc(4); data.writeUInt32LE(i + 1);
        return reply({data});
      }
      return reply({result: UNKNOWN});
    }
    if (req.type !== 4 || h.entry !== undefined) return reply({result: BAD});
    if (h.kind === 'root' && req.command === 510) {
      const handle = fs.openNotifier();
      return handle ? reply({moves: [handle]}) : reply({result: BAD});
    }
    if (h.kind === 'notifier' && req.command === 0) {
      let ran;
      try { ran = fs.runHook(h.object); } catch (error) { fs.faults.push(error.message); return reply({result: 0xdead}); }
      return ran ? reply({result: ran}) : reply({});
    }
    return reply({result: UNKNOWN});
  }

  function handle(op, p) {
    const a = p.length >= 8 ? p.readBigUInt64LE(0) : 0n, b = p.length >= 16 ? p.readBigUInt64LE(8) : 0n;
    const u64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; };
    switch (op) {
      case OP.HELLO: {
        const out = Buffer.alloc(24);
        out.writeUInt32LE(H.ro, 0); out.writeUInt32LE(H.fsProcess, 4); out.writeUInt32LE(H.fsRoot, 8); out.writeBigUInt64LE(FS_PID, 16);
        return {data: out};
      }
      case OP.ALLOC: {
        if (scratch.size >= 8) return {status: BAD};
        const base = nextScratch; nextScratch += 0x1000000;
        scratch.set(base, Buffer.alloc(Number((a + 0xfffn) & ~0xfffn)));
        return {data: u64(base)};
      }
      case OP.FREE: return scratch.delete(Number(a)) ? {} : {status: BAD};
      case OP.MEM_READ: { const bytes = inScratch(Number(a), Number(b)); return bytes ? {data: Buffer.from(bytes)} : {status: BAD}; }
      case OP.MEM_WRITE: { const bytes = inScratch(Number(a), p.length - 8); if (!bytes) return {status: BAD}; p.copy(bytes, 0, 8); return {}; }
      case OP.SEND: {
        const handle = p.readUInt32LE(0), address = Number(p.readBigUInt64LE(8)), size = Number(p.readBigUInt64LE(16));
        const message = size && !(size % 0x1000) && !(address % 0x1000) ? inScratch(address, size) : null;
        if (!message) return {status: BAD};
        const h = fs.handles.get(handle), out = Buffer.alloc(4);
        if (!h) { out.writeUInt32LE(BAD_HANDLE); return {data: out}; }
        const req = parse(message);
        sends.push({handle, command: req.command, type: req.type});
        const answer = h.kind === 'ro' ? ro(req) : service(h, req);
        message.fill(0, 0, 0x100); answer.copy(message);
        return {data: out};
      }
      case OP.CLOSE: { const out = Buffer.alloc(4); out.writeUInt32LE(fs.close(p.readUInt32LE(0))); return {data: out}; }
      case OP.FS_READ: {
        if (fs.query(a).attributes || fs.query(a + b - 1n).attributes) return {status: BAD}; // RO cannot map permission-locked pages
        // RO cannot alias Normal pages on this kernel: the console refuses them.
        if (fs.query(a).type === 5 || fs.query(a + b - 1n).type === 5) { fs.normal.push({op: 'read', address: a, length: Number(b)}); return {status: BAD}; }
        const bytes = b && b <= BigInt(MAX_PAYLOAD) ? fs.view(a, Number(b)) : null;
        return bytes ? {data: Buffer.from(bytes)} : {status: BAD};
      }
      case OP.FS_WRITE: {
        if (fs.query(a).type === 5 || fs.query(a + b - 1n).type === 5) { fs.normal.push({op: 'write', address: a, length: Number(b)}); return {status: BAD}; }
        const n = Number(b), bytes = p.length === 16 + 2 * n ? fs.view(a, n) : null;
        if (!bytes || !bytes.equals(p.subarray(16, 16 + n))) return {status: BAD};
        p.copy(bytes, 0, 16 + n);
        return {};
      }
      case OP.FS_QUERY: {
        const q = fs.query(a), out = Buffer.alloc(32);
        out.writeBigUInt64LE(q.address, 0); out.writeBigUInt64LE(q.size, 8); out.writeUInt32LE(q.type, 16); out.writeUInt32LE(q.attributes || 0, 20); out.writeUInt32LE(q.permissions, 24);
        return {data: out};
      }
      default: return {status: 0xd801};
    }
  }

  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    frames(socket, (op, payload) => { const {status = 0, data = Buffer.alloc(0)} = handle(op, payload); socket.write(frame(status, data)); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({port: server.address().port, fs, scratch, sends,
      close: () => new Promise(done => { server.close(() => done()); for (const socket of sockets) socket.destroy(); })}));
  });
}

module.exports = {startMock, FS_PID, RO_PID, H, TEXT, E, B, ROOT, TABLE, MANAGER, HEAP, ALLOCATION, SDK_BLOCK, FS_OBJECT, CAVE, HOOK, RELRO, RELRO2, VTABLE, PROLOGUE};
