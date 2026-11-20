// modbridge stand-in for civ7-fs-kaihen's switch2/process/client.cjs. ModLoader's openClient replaces
// request/readBulk with its own raw exchange (Session.call('send') to ro:dmnt), so info/read/map/unmap/
// patch below keep the engine's semantics and reach the console RO through that exchange. Two additions:
// read() serves FS relro from the daemon's cache and Normal (type 5) FS pages, which RO cannot map, through
// the daemon's FS-side copies inside ModLoader's own allocations only; patch() feeds the allocation tracker
// in ../tools/fs-memory.cjs.
const fs = require('node:fs/promises');
const path = require('node:path');
const {connect, ops, readFs, relro} = require('../tools/fs-memory.cjs');
const check = (ok, message) => { if (!ok) throw Error(message); };
const read = file => fs.readFile(file, 'utf8').then(JSON.parse);

class Client {
  async save() {
    await fs.writeFile(this.file, JSON.stringify(this.record, null, 2) + '\n', {mode: 0o600});
  }
  async open() {
    this.memory = await connect();
    const {config} = this.memory;
    const state = await this.memory.request({command: 'root-native-info'});
    check(state.session === config.session && (!state.worker || state.worker.joined),
      'The modbridge daemon serves another session or is busy');
    // RO's kernel PID, read by the daemon from a helper reply's special header.
    this.pid = config.roPid;
    this.handle = config.handles.ro;
    this.record = {session: config.session, roPid: this.pid, provider: 'modbridge',
      started: new Date().toISOString(), calls: []};
    this.file = path.join(__dirname, config.session + '-process-probe-' + Date.now() + '.json');
    await this.save();
    return this;
  }
  async fsProcess() {
    this.record.fsCopy = {handle: this.memory.config.handles.fsProcess};
    await this.save();
    return this.record.fsCopy.handle;
  }
  async request() {
    throw Error('modbridge: process requests are sent by ModLoader openClient');
  }
  async info(handle, address = 0n, pid = 0n) {
    const reply = await this.request(0x524f0010, handle, [pid, address, 0, 0]), v = reply.values;
    if (reply.result) return {result: reply.result, pid: null, programId: null,
      identityResults: {pid: Number(v[2] & 0xffffffffn), program: Number(v[2] >> 32n)}};
    return {result: reply.result, pid: v[0].toString(), programId: v[1].toString(16).padStart(16, '0'),
      queryResult: Number(v[3]), memory: {address: v[4].toString(), size: v[5].toString(),
        type: Number(v[6] & 0xffffffffn), attributes: Number(v[6] >> 32n),
        permissions: Number(v[7] & 0xffffffffn), ipcReferences: Number(v[7] >> 32n), deviceReferences: Number(v[8])},
      addressSpace: v[9].toString(), addressSpaceSize: v[10].toString(),
      freeAddress: v[11].toString(), roFreeAddress: v[12].toString()};
  }
  async read(handle, pid, address, length = 128) {
    const cached = relro(address, length);
    if (cached) return {result: 0, local: '0', mapResult: 0, unmapResult: 0, length, hex: cached.toString('hex')};
    if ((await (await ops()).fsQuery(address)).type === 5) {
      const bytes = await readFs(address, length);
      return {result: 0, local: '0', mapResult: 0, unmapResult: 0, length, hex: bytes.toString('hex')};
    }
    const reply = await this.request(0x524f0011, handle, [pid, address, length, 0]), v = reply.values;
    return {result: reply.result, local: v[3].toString(), mapResult: Number(v[4]),
      unmapResult: Number(v[5]), length: Number(v[6]), hex: reply.result ? null : reply.data.subarray(56, 56 + length).toString('hex')};
  }
  async map(handle, pid, source, destination) {
    const reply = await this.request(0x524f0012, handle, [pid, source, destination, 0x1000]);
    return {result: reply.result, mapResult: Number(reply.values[3]),
      permissionResult: Number(reply.values[4]), rollbackResult: Number(reply.values[5])};
  }
  async unmap(handle, pid, source, destination) {
    const reply = await this.request(0x524f0013, handle, [pid, source, destination, 0x1000]);
    return {result: reply.result};
  }
  async patch(handle, pid, address, expected, replacement) {
    check(expected.length === 16 && replacement.length === 16, 'An instruction patch must contain exactly 16 bytes');
    const words = bytes => Array.from({length: Math.floor(bytes.length / 8)}, (_, i) => bytes.readBigUInt64LE(i * 8));
    const reply = await this.request(0x524f0014, handle, [pid, address, 16, 0, ...words(expected), ...words(replacement)]);
    const v = reply.values;
    if (!reply.result && v[6] === 1n && v[7] === 1n) this.memory.allocations.patched(address, replacement);
    return {result: reply.result, mapResult: Number(v[4]), permissions: Number(v[5] & 0xffffffffn),
      attributes: Number(v[5] >> 32n), expectedMatched: v[6] === 1n,
      readbackMatched: v[7] === 1n, unmapResult: Number(v[8]), local: v[9].toString()};
  }
  // The ro:dmnt and FS process handles belong to the daemon for the whole session: nothing to close.
  async close() {
    if (this.pending) { this.record.pending = true; await this.save(); return; }
    this.record.closed = new Date().toISOString(); await this.save();
  }
}

module.exports = {Client, check, read};
