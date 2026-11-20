// modbridge stand-in for civ7-fs-kaihen's switch2/tools/fs-memory.cjs: the same Memory class, backed by
// the modbridge daemon (FS_READ/FS_WRITE over its ops pipe, JSON commands over its socketPath pipe).
//
// Normal (type 5) FS heap pages cannot be mapped into RO on this kernel, so no console op reaches them; the
// daemon has FS copy them instead (NORMAL_READ/NORMAL_WRITE, see tools/modbridge/native.cjs). Normal memory
// is only touched inside blocks ModLoader allocated for itself in this session (seen through its native
// calls, see Allocations); every Normal access is logged to RUN/modbridge-normal-access.jsonl.
// FS relro (permission-locked) is served from the daemon's FS-made copy and never written.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {Bridge} = require('./bridge.cjs');

const check = (ok, message) => { if (!ok) throw Error(message); };
const hex = value => '0x' + value.toString(16);
const canonical = value => value >= 0x100000000n && value < 0x8000000000n;
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../modbridge.json'), 'utf8'));
const LOG = path.join(__dirname, '../../modbridge-normal-access.jsonl');
const RELRO = fs.readFileSync(path.join(__dirname, '../../modbridge-relro.bin'));

/// FS relro (CodeMutable, perm 1, attr 16) is permission-locked, so no console op can read it; the daemon
/// had FS copy it once. Returns the cached bytes, or null when [at, at+length) is outside relro.
function relro(at, length) {
  at = BigInt(at);
  const end = at + BigInt(length);
  for (const r of config.relro || []) {
    const start = BigInt(r.address), stop = start + BigInt(r.size);
    if (at >= start && end <= stop) return Buffer.from(RELRO.subarray(r.offset + Number(at - start), r.offset + Number(end - start)));
    check(end <= start || at >= stop, 'Access straddles FS relro at ' + hex(at));
  }
  return null;
}

function address(value, length = 1) {
  check(Number.isSafeInteger(value) && value >= 2 ** 32 &&
    Number.isSafeInteger(length) && length > 0 && value + length <= 2 ** 39,
  'Expected a canonical FS address and a positive length');
  return value;
}

function encodeU64(value) {
  check(typeof value === 'bigint' || Number.isSafeInteger(value), 'Use BigInt for large integers');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

/// FS blocks ModLoader allocated through its notifier-hook native calls (ModLoader lib/native/bridge.cjs):
/// the cave literal pool (owner E, operation, result, args) is rebuilt from the 16-byte code patches, and
/// the call's result is the next u64 ModLoader reads at `result`. Allocators: 1 size arg returning a
/// pointer (FS+0x694c0); [manager, output, size] returning 0 with the block at *output (FS+0x215620).
/// Frees ([block, size] and [manager, block, size] of a tracked block) forget the block again.
class Allocations {
  constructor(text, textSize, owner) {
    Object.assign(this, {text, textSize, owner, code: new Map(), blocks: new Map(), pending: null, watch: null});
  }
  patched(at, replacement) {
    at = BigInt(at);
    this.code.set(at, Buffer.from(replacement));
    const word = replacement.readUInt32LE(0);
    if (word >>> 26 !== 5) return; // only an unconditional branch can be the notifier hook
    const cave = at + BigInt(((word & 0x3ffffff) << 6) >> 6) * 4n;
    const bytes = Buffer.concat(Array.from({length: 64}, (_, i) => this.code.get(cave + BigInt(16 * i)) || Buffer.alloc(16)));
    for (let o = 0; o + 24 <= bytes.length; o += 8) {
      if (bytes.readBigUInt64LE(o) !== this.owner) continue;
      const args = [];
      for (let p = o + 24; p + 8 <= bytes.length && args.length < 6 && bytes.readBigUInt64LE(p); p += 8) args.push(bytes.readBigUInt64LE(p));
      this.pending = {operation: bytes.readBigUInt64LE(o + 8), result: bytes.readBigUInt64LE(o + 16), args};
      return;
    }
  }
  observed(at, value) {
    at = BigInt(at);
    if (this.watch && at === this.watch.output) {
      if (canonical(value)) this.blocks.set(value, this.watch.size);
      this.watch = null;
    }
    const call = this.pending;
    if (!call || at !== call.result) return;
    this.pending = null;
    if (call.operation < this.text || call.operation >= this.text + this.textSize) return; // runtime or publish
    const [a, b, c] = call.args, owns = (start, size) => this.blocks.get(start) === size;
    if (call.args.length === 1 && canonical(value) && a > 0n && a <= 0x10000000n) this.blocks.set(value, a);
    else if (call.args.length === 2 && owns(a, b)) this.blocks.delete(a);
    else if (call.args.length === 3 && owns(b, c)) this.blocks.delete(b);
    else if (call.args.length === 3 && value === 0n && c > 0n) this.watch = {output: b, size: c};
  }
  covers(at, length) {
    for (const [start, size] of this.blocks) if (at >= start && at + length <= start + size) return true;
    return false;
  }
}

class Memory {
  constructor(read, write) {
    this.readBytes = read;
    this.writeBytes = write;
  }

  async read(at, length) {
    address(at, length);
    const bytes = await this.readBytes(at, length);
    check(Buffer.isBuffer(bytes) && bytes.length === length, 'Memory read was truncated');
    return bytes;
  }

  async u32(at) { return (await this.read(at, 4)).readUInt32LE(); }
  async u64(at) {
    const value = (await this.read(at, 8)).readBigUInt64LE();
    this.allocations?.observed(at, value);
    return value;
  }

  async pointer(at) {
    const value = await this.u64(at);
    if (value === 0n) return 0;
    check(value >= 0x100000000n && value < 0x8000000000n,
      'Noncanonical pointer at ' + hex(at) + ': ' + hex(value));
    return Number(value);
  }

  async write(at, expected, replacement) {
    check(this.writeBytes && Buffer.isBuffer(expected) && Buffer.isBuffer(replacement) &&
      expected.length === replacement.length, 'Writes require equal-sized expected and replacement bytes');
    check((await this.read(at, expected.length)).equals(expected), 'Expected memory bytes differ at ' + hex(at));
    const result = await this.writeBytes(at, expected, replacement);
    check((await this.read(at, replacement.length)).equals(replacement), 'Write readback differs at ' + hex(at));
    return result;
  }

  async writeU64(at, expected, replacement) {
    return this.write(at, encodeU64(expected), encodeU64(replacement));
  }
}

// One serialized ops connection per process. After a timeout or disconnect it stays failed (uncertain),
// so a caller never replays a request that may still be running on the console.
let shared;
function ops() {
  if (!shared) { shared = Bridge.connect(config.opsPipe); shared.catch(() => { shared = null; }); }
  return shared;
}

const allocations = new Allocations(BigInt(config.textBase), BigInt(config.textSize), BigInt(config.notifierE));

/// Splits [at, at+length) by FS block. Normal (type 5) parts must lie inside a block ModLoader allocated.
async function parts(bridge, at, length, operation) {
  const out = [];
  for (let a = BigInt(at), end = a + BigInt(length); a < end;) {
    const q = await bridge.fsQuery(a), stop = q.address + q.size < end ? q.address + q.size : end, normal = q.type === 5;
    if (normal) {
      const allowed = allocations.covers(a, stop - a);
      fs.appendFileSync(LOG, JSON.stringify({at: new Date().toISOString(), operation, address: hex(a), length: Number(stop - a), allowed}) + '\n');
      check(allowed, 'modbridge refused to ' + operation + ' Normal FS memory at ' + hex(a) + ' (' + Number(stop - a) +
        ' bytes): ModLoader did not allocate it in this session');
    }
    out.push({at: a, length: Number(stop - a), offset: Number(a - BigInt(at)), normal});
    a = stop;
  }
  return out;
}

async function readFs(at, length) {
  const cached = relro(at, length);
  if (cached) return cached;
  const bridge = await ops(), out = [];
  for (const p of await parts(bridge, at, length, 'read'))
    out.push(await (p.normal ? bridge.normalRead(p.at, p.length) : bridge.fsRead(p.at, p.length)));
  return out.length === 1 ? out[0] : Buffer.concat(out, length);
}

async function writeFs(at, expected, replacement) {
  check(!relro(at, expected.length), 'FS relro is read-only: ' + hex(at));
  const bridge = await ops();
  for (const p of await parts(bridge, at, expected.length, 'write')) {
    const before = expected.subarray(p.offset, p.offset + p.length), after = replacement.subarray(p.offset, p.offset + p.length);
    await (p.normal ? bridge.normalWrite(p.at, before, after) : bridge.fsWrite(p.at, before, after));
  }
}

/// Newline-terminated JSON request, JSON reply, then close (the contract ModLoader uses too).
function request(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(60000, () => socket.destroy(Error('Memory request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => { input += part; });
    socket.on('end', () => {
      try { const result = JSON.parse(input); if (result.error) throw Error(result.error); resolve(result); }
      catch (error) { reject(error); }
    });
  });
}

async function connect() {
  await ops();
  const memory = new Memory(readFs, writeFs);
  return Object.assign(memory, {config, allocations, info: {ready: true, session: config.session}, request, captures: []});
}

module.exports = {Memory, Allocations, connect, ops, readFs, writeFs, relro, request, config, encodeU64};
