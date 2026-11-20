// modbridge stand-in for civ7-fs-kaihen's switch2/app/session.cjs. Same interface; the scratch memory and
// IPC are the modbridge console app's (ALLOC/MEM_READ/MEM_WRITE/SEND/CLOSE through the daemon's ops pipe).
const {ops, config} = require('../tools/fs-memory.cjs');
const {packet, response} = require('../../shared/ipc.cjs');
const u32 = value => {const b = Buffer.alloc(4); b.writeUInt32LE(value); return b;};
const u64 = value => {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b;};
const check = (condition, message) => {if (!condition) throw Error(message);};
const live = {session: config.session, platform: 2};
// The daemon holds these for the whole session; a client session never closes them.
const persistent = new Set(Object.values(config.handles));

class Session {
  constructor(label, bytes = 0x10000) {
    this.label = label;
    this.handles = new Set();
    this.threads = new Set();
    this.base = 0;
    this.bytes = bytes;
  }
  async record() {}
  async ready() { return true; }
  async initialize() {
    check(!this.base, 'Session is already initialized');
    const base = await (await ops()).alloc(this.bytes);
    check(base > 0 && base % 4096 === 0, 'Invalid allocation');
    this.base = base;
  }
  // Only the SDK calls ModLoader and the copied engine modules make through a Session.
  async call(name, ...args) {
    const bridge = await ops();
    if (name === 'send') return bridge.send(args[2], args[0], args[1]);
    if (name === 'close') return bridge.close(args[0]);
    throw Error('modbridge has no SDK function ' + name);
  }
  async read(address, bytes) { return (await ops()).memRead(address, bytes); }
  async readOwned(address, bytes) {
    check(this.base && Number.isInteger(bytes) && bytes > 0 && bytes <= 524288 &&
      Number.isSafeInteger(address) && address >= this.base && address + bytes <= this.base + this.bytes,
      'Owned read is outside the verified allocation');
    return this.read(address, bytes);
  }
  async write(address, bytes) { await (await ops()).memWrite(address, bytes); }
  async openService(name) {
    throw Error('modbridge cannot look up services (no SM handle): ' + name);
  }
  async ipc(label, handle, command, data = Buffer.alloc(0), options = {}) {
    await this.write(this.base, packet(command, data, options));
    const transport = await this.call('send', this.base, 4096, handle);
    await this.record({operation: label, handle, command, transport});
    check(!transport, label + ': transport 0x' + transport.toString(16));
    const raw = await this.readOwned(this.base, 256);
    const reply = response(raw);
    reply.interfaceId = raw.readUInt32LE(raw.length - reply.data.length - 4);
    for (const child of [...reply.copies, ...reply.moves]) this.handles.add(child);
    await this.record({operation: label + ' reply', result: reply.result, copies: reply.copies,
      moves: reply.moves, interfaceId: reply.interfaceId,
      data: reply.data.subarray(0, 32).toString('hex')});
    return reply;
  }
  async close(handle) {
    check(this.handles.has(handle), 'Handle is not owned');
    if (!persistent.has(handle)) {
      const result = await this.call('close', handle);
      await this.record({operation: 'CloseHandle', handle, result});
      check(!result, 'Owned handle did not close');
    }
    this.handles.delete(handle);
  }
  async closeUpload() {}
  async cleanup() {
    for (const handle of [...this.handles].reverse()) await this.close(handle);
    if (this.base) {
      await (await ops()).free(this.base);
      await this.record({operation: 'Free', base: this.base});
      this.base = 0;
    }
  }
}

module.exports = {Session, live, u32, u64, check};
