'use strict';
// FS-side memory access for memory no console op can reach: FS relro (CodeMutable, perm 1, attr 16 is
// permission-locked) and the Normal heap (RO cannot alias Normal pages on this kernel). FS copies the bytes
// itself, by the technique of ModLoader's lib/native/bridge.cjs and call-source.cjs: a cave in unused .text
// padding at FS+0x24d500 (ModLoader's caves are +0x24d100 and +0x24d800), a branch at the notifier's
// command-0 handler FS+0x1201b0, then command 0 on the daemon's notifier; the cave acts only when x0 == E.
// Copies go through one 0x1000-byte staging block from FS+0x694c0 (CodeMutable, so FS_READ/FS_WRITE reach
// it), kept for the daemon session. Every op first checks that ModLoader is idle (hook site original,
// E+8 == B), unhooks after each call, and leaves hook site, cave, E+8 and the cave page permission as found.
const {packet, response} = require('./make-run.cjs').requireEngine('shared/ipc.cjs');

const check = (ok, message) => { if (!ok) throw Error(message); };
const hex = value => '0x' + value.toString(16);
const canonical = value => value >= 0x100000000n && value < 0x8000000000n;
const HOOK = 0x1201b0n, CAVE = 0x24d500n, CAVE_BYTES = 256, MALLOC = 0x694c0n, FREE = 0x69580n, STAGE = 0x1000;
const ORIGINAL = Buffer.from('7f2303d5ff8300d1fd7b01a9fd430091', 'hex'); // pacibsp; sub sp,#32; stp x29,x30; add x29
const NOP = 0xd503201f, NONCE = 0x6dfe, MAX_RELRO = 0x100000;
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const floor8 = value => value & ~7n, ceil8 = value => (value + 7n) & ~7n;

/// A cave in ModLoader's call-source.cjs shape (owner check, frame, body, result store, 0x6dfe, and a
/// pass-through replaying the four hooked instructions). The call body is byte-identical to its call3
/// template. The copy body moves args[2] bytes (multiple of 8) from args[1] to args[0]; with result null it
/// stores no result, so E+8 is never touched.
function cave(at, hook, owner, {operation = 0n, result = null, args, copy = false}) {
  const w = [], literals = [];
  const ldr = (rt, slot) => { literals.push([w.length, slot]); w.push(rt); }; // slots: owner, operation, result, arg0..2
  ldr(9, 0); w.push(0xeb09001f); // cmp x0, x9
  const branch = w.length; w.push(0);
  w.push(0xd503237f, 0xa9be7bfd, 0xa90153f3, 0xaa0003f3); // pacibsp; stp x29,x30,[sp,#-32]!; stp x19,x20,[sp,#16]; mov x19,x0
  if (copy) {
    ldr(9, 3); ldr(10, 4); ldr(11, 5);
    // ldr x12,[x10],#8; str x12,[x9],#8; subs x11,x11,#8; b.ne -3; mov x0,#0
    w.push(0xf840854c, 0xf800852c, 0xf100216b, 0x54ffffa1, 0xd2800000);
  } else { ldr(0, 3); ldr(1, 4); ldr(2, 5); ldr(16, 1); w.push(0xd63f0200); } // blr x16
  if (result !== null) { ldr(9, 2); w.push(0xf9000120); } // str x0, [x9]
  w.push(0x528dbfc0, 0xa94153f3, 0xa8c27bfd, 0xd65f0fff); // mov w0,#0x6dfe; ldp; ldp; retab
  const passthrough = w.length;
  w.push(...Array.from({length: 4}, (_, i) => ORIGINAL.readUInt32LE(4 * i)));
  const tail = w.length; w.push(0);
  if (w.length % 2) w.push(NOP);
  const pool = 4 * w.length;
  w[branch] = (0x54000001 | ((passthrough - branch) & 0x7ffff) << 5) >>> 0; // b.ne passthrough
  w[tail] = (0x14000000 | (Number((hook + 16n - at - BigInt(4 * tail)) / 4n) & 0x3ffffff)) >>> 0; // b original_tail
  for (const [i, slot] of literals) w[i] = (0x58000000 | (((pool + 8 * slot - 4 * i) / 4) & 0x7ffff) << 5 | w[i]) >>> 0;
  const code = Buffer.alloc(pool + 48);
  w.forEach((value, i) => code.writeUInt32LE(value, 4 * i));
  [owner, operation, result ?? 0n, ...args].forEach((value, i) => code.writeBigUInt64LE(BigInt(value), pool + 8 * i));
  return code;
}

class Native {
  constructor(b, d, log) {
    const text = d.text.address;
    Object.assign(this, {b, d, log, text, hookAt: text + HOOK, caveAt: text + CAVE, page: (text + CAVE) & ~0xfffn,
      E: d.notifier.E, B: d.notifier.B, lock: Promise.resolve(), shadow: null, scratch: null, stage: null, touchedB: false});
    this.hook = Buffer.alloc(16);
    this.hook.writeUInt32LE((0x14000000 | Number((this.caveAt - this.hookAt) / 4n)) >>> 0);
    for (let i = 4; i < 16; i += 4) this.hook.writeUInt32LE(NOP, i);
  }

  /// Allocates the session's staging block with FS+0x694c0.
  static async open(b, d, log = () => {}) {
    const native = new Native(b, d, log);
    native.scratch = await b.alloc(0x1000);
    try {
      const stage = await native.exclusive(() => native.op(() => native.call(MALLOC, [STAGE, 0, 0])));
      check(canonical(stage), 'FS+0x694c0 did not allocate a staging block: ' + hex(stage));
      const q = await b.fsQuery(stage);
      check(q.type === 4 && q.permissions === 3 && !q.attributes && stage + BigInt(STAGE) <= q.address + q.size,
        'Staging block ' + hex(stage) + ' is not CodeMutable RW (type ' + q.type + ')');
      native.stage = stage;
      log('FS staging block ' + hex(stage));
      return native;
    } catch (error) { if (!b.error) await b.free(native.scratch); throw error; }
  }

  /// Runs fn with no other daemon traffic on the console in between.
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  async ipc(handle, bytes) {
    await this.b.memWrite(this.scratch, bytes);
    const transport = await this.b.send(handle, this.scratch, 0x1000);
    check(!transport, 'IPC transport failed: ' + hex(transport));
    return this.b.memRead(this.scratch, 256);
  }
  async helper(id, values) {
    const raw = await this.ipc(this.d.hello.ro, packet(id, Buffer.concat(values.map(u64)), {pid: true, copies: [this.d.hello.fsProcess]}));
    check(raw.readUInt32LE(4) >>> 31 && raw.readUInt32LE(8) & 1 && raw.readBigUInt64LE(12) === this.d.roPid, 'Reply did not come from RO');
    const reply = response(raw);
    return {result: reply.result, values: Array.from({length: Math.floor(reply.data.length / 8)}, (_, i) => reply.data.readBigUInt64LE(8 * i))};
  }
  async patch(at, expected, replacement) {
    const words = bytes => [bytes.readBigUInt64LE(0), bytes.readBigUInt64LE(8)];
    const r = await this.helper(0x524f0014, [this.d.hello.fsPid, at, 16, 0, ...words(expected), ...words(replacement)]);
    check(!r.result && r.values[6] === 1n && r.values[7] === 1n, 'Text patch at ' + hex(at) + ' failed: ' + hex(r.result));
  }
  async stageCave(code) {
    const next = Buffer.alloc(CAVE_BYTES);
    code.copy(next);
    for (let i = 0; i < CAVE_BYTES; i += 16) {
      const before = this.shadow.subarray(i, i + 16), after = next.subarray(i, i + 16);
      if (!before.equals(after)) { await this.patch(this.caveAt + BigInt(i), before, after); after.copy(before); }
    }
  }
  /// One native call: stage, hook (RO compares the original prologue), command 0, unhook (RO verifies).
  async run(code) {
    await this.stageCave(code);
    await this.patch(this.hookAt, ORIGINAL, this.hook);
    const reply = response(await this.ipc(this.d.notifier.handle, packet(0)));
    await this.patch(this.hookAt, this.hook, ORIGINAL);
    for (const handle of [...reply.copies, ...reply.moves]) await this.b.close(handle); // only if the real handler ran
    check(reply.canonicalResult === NONCE && !reply.copies.length && !reply.moves.length, 'FS did not run the modbridge cave (result ' + hex(reply.result) + ')');
  }
  /// FS function call with the result in E+8, as ModLoader does; B is written back and verified.
  async call(offset, args) {
    this.touchedB = true;
    await this.run(cave(this.caveAt, this.hookAt, this.E, {operation: this.text + offset, result: this.E + 8n, args}));
    const value = (await this.b.fsRead(this.E + 8n, 8)).readBigUInt64LE();
    if (value !== this.B) await this.b.fsWrite(this.E + 8n, u64(value), u64(this.B));
    this.touchedB = false;
    return value;
  }
  async copy(destination, source, length) {
    check(length > 0 && length <= STAGE && !(length % 8) && !(destination % 8n) && !(source % 8n), 'Invalid FS copy');
    await this.run(cave(this.caveAt, this.hookAt, this.E, {copy: true, args: [destination, source, length]}));
  }

  /// Checks ModLoader is idle, makes the cave page R-X if needed (its literals are loaded PC-relative, as in
  /// ModLoader's Bridge.open), runs fn, then restores everything; on failure undoes the hook first.
  async op(fn) {
    let permission = null, failure = null, entered = false;
    try {
      const site = await this.b.fsRead(this.hookAt, 16);
      check(site.equals(ORIGINAL), 'The notifier hook site FS+0x1201b0 is not the original prologue (ModLoader has hooked it' +
        (site.equals(this.hook) ? ' to the modbridge cave' : '') + '); refusing an FS-side copy');
      check((await this.b.fsRead(this.E + 8n, 8)).readBigUInt64LE() === this.B, 'E+8 is not B: ModLoader is mid-call; refusing an FS-side copy');
      this.shadow = await this.b.fsRead(this.caveAt, CAVE_BYTES);
      check(this.shadow.every(x => !x), 'Cave padding FS+0x24d500 is not empty');
      entered = true; // from here on, everything below is ours to undo
      const mapping = await this.b.fsQuery(this.page);
      check(mapping.type === 3 && [4, 5].includes(mapping.permissions) && !mapping.attributes, 'Cave page is not FS code');
      if (mapping.permissions === 4) {
        check(!(await this.helper(0x524f0015, [this.d.hello.fsPid, this.page, 0x1000, 5])).result, 'Cannot make the cave page readable');
        permission = 4;
      }
      return await fn();
    } catch (error) { failure = error; throw error; } finally {
      const problems = [];
      if (!entered) { /* refused before touching anything */ }
      else if (this.b.error) problems.push('console connection lost; reboot before retrying');
      else for (const step of [
        async () => { const site = await this.b.fsRead(this.hookAt, 16); if (!site.equals(ORIGINAL) && site.equals(this.hook)) await this.patch(this.hookAt, this.hook, ORIGINAL); },
        async () => {
          const value = (await this.b.fsRead(this.E + 8n, 8)).readBigUInt64LE();
          if (value !== this.B && this.touchedB) await this.b.fsWrite(this.E + 8n, u64(value), u64(this.B));
          this.touchedB = false;
        },
        async () => {
          const current = await this.b.fsRead(this.caveAt, CAVE_BYTES);
          for (let i = 0; i < CAVE_BYTES; i += 16)
            if (current.subarray(i, i + 16).some(x => x)) await this.patch(this.caveAt + BigInt(i), current.subarray(i, i + 16), Buffer.alloc(16));
          check((await this.b.fsRead(this.caveAt, CAVE_BYTES)).every(x => !x), 'cave readback is not zero');
        },
        async () => check((await this.b.fsRead(this.hookAt, 16)).equals(ORIGINAL), 'hook site readback is not the original prologue'),
        async () => check((await this.b.fsRead(this.E + 8n, 8)).readBigUInt64LE() === this.B, 'E+8 readback is not B'),
        async () => { if (permission !== null) check(!(await this.helper(0x524f0015, [this.d.hello.fsPid, this.page, 0x1000, permission])).result, 'page permission did not restore'); },
      ]) try { await step(); } catch (error) { problems.push(error.message); }
      if (problems.length) {
        const message = 'FS-side copy cleanup: ' + problems.join('; ');
        if (failure) failure.message += ' | ' + message; else throw Error(message);
      }
    }
  }

  /// Pieces of [at, at+length) whose 8-aligned window fits the staging block.
  static pieces(at, length) {
    const out = [];
    for (let a = at, end = at + BigInt(length); a < end;) {
      const window = floor8(a), stop = end < window + BigInt(STAGE) ? end : window + BigInt(STAGE);
      out.push({at: a, length: Number(stop - a), window, size: Number(ceil8(stop) - window), skip: Number(a - window)});
      a = stop;
    }
    return out;
  }
  // FS copies the window into the staging block, which FS_READ can read.
  async readPiece(p) {
    await this.copy(this.stage, p.window, p.size);
    return this.b.fsRead(this.stage, p.size);
  }

  read(at, length) {
    at = BigInt(at);
    return this.exclusive(() => this.op(async () => {
      const parts = [];
      for (const p of Native.pieces(at, length)) parts.push((await this.readPiece(p)).subarray(p.skip, p.skip + p.length));
      return Buffer.concat(parts, length);
    }));
  }

  /// Compares the preimage, writes through the staging block, and verifies by copying back.
  write(at, expected, replacement) {
    at = BigInt(at);
    check(Buffer.isBuffer(expected) && Buffer.isBuffer(replacement) && expected.length === replacement.length && expected.length > 0, 'Invalid FS-side write');
    return this.exclusive(() => this.op(async () => {
      let offset = 0;
      for (const p of Native.pieces(at, expected.length)) {
        const current = await this.readPiece(p), want = Buffer.from(current);
        check(current.subarray(p.skip, p.skip + p.length).equals(expected.subarray(offset, offset + p.length)), 'Expected bytes differ at ' + hex(p.at));
        replacement.copy(want, p.skip, offset, offset + p.length);
        await this.b.fsWrite(this.stage, current, want);
        await this.copy(p.window, this.stage, p.size);
        check((await this.readPiece(p)).equals(want), 'Write readback differs at ' + hex(p.at));
        offset += p.length;
      }
    }));
  }

  /// Frees the staging block and the IPC scratch.
  async close() {
    if (this.b.error) return;
    if (this.stage !== null) { await this.exclusive(() => this.op(() => this.call(FREE, [this.stage, STAGE, 0]))); this.stage = null; }
    await this.b.free(this.scratch);
  }
}

/// Returns [{address, size, bytes}] for every CodeMutable perm-1 (relro) block, copied by FS.
async function cacheRelro(native, d, log = () => {}) {
  const relro = d.blocks.filter(q => q.type === 4 && q.permissions === 1);
  const total = relro.reduce((n, q) => n + Number(q.size), 0);
  check(total <= MAX_RELRO, 'Unexpected relro size ' + hex(total));
  const out = [];
  for (const q of relro) out.push({address: q.address, size: q.size, bytes: await native.read(q.address, Number(q.size))});
  const {vptr} = d.notifier, slot = out.find(r => vptr + 0x20n >= r.address && vptr + 0x28n <= r.address + r.size);
  if (slot) d.notifier.hookSlotMatches = slot.bytes.readBigUInt64LE(Number(vptr + 0x20n - slot.address)) === native.hookAt;
  log('relro cached: ' + (out.map(r => hex(r.address) + ' +' + hex(r.size)).join(', ') || 'none') +
    (d.notifier.hookSlotMatches === false ? ' (WARNING: vtable slot 4 is not FS+0x1201b0)' : ''));
  return out;
}

module.exports = {Native, cacheRelro, cave, ORIGINAL, CAVE, HOOK, STAGE};
