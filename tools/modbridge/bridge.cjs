'use strict';
// Frame client for modbridge.nro (TCP) and for the daemon's ops pipe, which forwards the same frames.
// Request: u32 op, u32 len, payload. Response: u32 status (0 ok, else a Result), u32 len, payload.
// All little-endian. Requests are serialized: one frame in flight at a time.
const net = require('node:net');

const OP = {HELLO: 1, ALLOC: 2, FREE: 3, MEM_READ: 4, MEM_WRITE: 5, SEND: 6, CLOSE: 7, FS_READ: 8, FS_WRITE: 9, FS_QUERY: 10,
  // Daemon only (ops pipe): Normal FS heap through FS-side copies, see native.cjs. Same payloads as FS_READ/FS_WRITE.
  NORMAL_READ: 0x101, NORMAL_WRITE: 0x102};
const DAEMON_ERROR = 0xca02; // daemon failure; the payload is the message
const NAMES = Object.fromEntries(Object.entries(OP).map(([name, op]) => [op, name]));
const MAX_PAYLOAD = 0x500000; // modbridge.nro MAX_PAYLOAD
const FS_WRITE_CHUNK = 0x10000; // the console splits writes into 64 KiB RO calls anyway

const u64s = (...values) => {
  const bytes = Buffer.alloc(8 * values.length);
  values.forEach((value, i) => bytes.writeBigUInt64LE(BigInt(value), 8 * i));
  return bytes;
};

/// Calls onFrame(first, payload) for every complete u32,u32,payload frame on a stream.
function frames(socket, onFrame) {
  let chunks = [], size = 0, need = 8, first = null;
  socket.on('data', chunk => {
    chunks.push(chunk); size += chunk.length;
    while (size >= need) {
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      chunks = [all];
      if (first === null) {
        const length = all.readUInt32LE(4);
        if (length > MAX_PAYLOAD + 16) { socket.destroy(Error('Oversized modbridge frame')); return; }
        first = all.readUInt32LE(0); need = 8 + length;
        continue;
      }
      const payload = all.subarray(8, need), rest = all.subarray(need);
      chunks = rest.length ? [rest] : []; size = rest.length; need = 8;
      const value = first; first = null;
      onFrame(value, payload);
    }
  });
}

function frame(first, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(first >>> 0); head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

class Bridge {
  constructor(socket, timeoutMs) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.queue = Promise.resolve(); this.waiting = null; this.error = null;
    frames(socket, (status, data) => {
      const waiting = this.waiting; this.waiting = null;
      if (waiting) waiting.resolve({status, data}); else this.fail(Error('Unexpected console frame'));
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(Error('socket closed')));
    socket.unref(); // an idle connection must not keep ModLoader (or the self-test) from exiting
  }

  /// target: {host, port} for the console, or a pipe path string for the daemon.
  static connect(target, {timeoutMs = 60000} = {}) {
    return new Promise((resolve, reject) => {
      const socket = typeof target === 'string' ? net.createConnection(target) : net.createConnection(target.port, target.host);
      const timer = setTimeout(() => socket.destroy(Error('Connection to ' + JSON.stringify(target) + ' timed out')), 10000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => { clearTimeout(timer); socket.setNoDelay?.(true); resolve(new Bridge(socket, timeoutMs)); });
    });
  }

  // After a timeout the frame stream can no longer be trusted: every later request fails too.
  // The message matches ModLoader's isUncertain(), so it keeps buffers and handles alive.
  fail(cause) {
    if (!this.error) this.error = Object.assign(Error('Console disconnected: ' + cause.message), {nativeRequestUncertain: true});
    this.socket.destroy();
    const waiting = this.waiting; this.waiting = null;
    waiting?.reject(this.error);
  }

  request(op, payload = Buffer.alloc(0)) {
    const run = () => new Promise((resolve, reject) => {
      if (this.error) { reject(this.error); return; }
      const timer = setTimeout(() => this.fail(Error('Console response timed out (' + NAMES[op] + ')')), this.timeoutMs);
      const settle = () => { clearTimeout(timer); this.socket.unref(); };
      this.waiting = {resolve: value => { settle(); resolve(value); }, reject: error => { settle(); reject(error); }};
      this.socket.ref();
      this.socket.write(frame(op, payload));
    });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async call(op, payload) {
    const {status, data} = await this.request(op, payload);
    if (status) throw Object.assign(Error('Console ' + NAMES[op] + ' failed: 0x' + status.toString(16) +
      (status === DAEMON_ERROR ? ': ' + data.toString('utf8') : '')), {status});
    return data;
  }

  async hello() {
    const d = await this.call(OP.HELLO);
    return {ro: d.readUInt32LE(0), fsProcess: d.readUInt32LE(4), fsRoot: d.readUInt32LE(8), fsPid: d.readBigUInt64LE(16)};
  }
  async alloc(size) { return Number((await this.call(OP.ALLOC, u64s(size))).readBigUInt64LE()); }
  async free(address) { await this.call(OP.FREE, u64s(address)); }
  async memRead(address, length) {
    const bytes = await this.call(OP.MEM_READ, u64s(address, length));
    if (bytes.length !== length) throw Error('Short scratch read');
    return bytes;
  }
  async memWrite(address, bytes) { await this.call(OP.MEM_WRITE, Buffer.concat([u64s(address), bytes])); }
  /// svcSendSyncRequestWithUserBuffer on scratch; returns the transport result.
  async send(handle, address, size) {
    const p = Buffer.alloc(24);
    p.writeUInt32LE(handle >>> 0); p.writeBigUInt64LE(BigInt(address), 8); p.writeBigUInt64LE(BigInt(size), 16);
    return (await this.call(OP.SEND, p)).readUInt32LE();
  }
  async close(handle) {
    const p = Buffer.alloc(4); p.writeUInt32LE(handle >>> 0);
    return (await this.call(OP.CLOSE, p)).readUInt32LE();
  }
  async fsRead(address, length) {
    const parts = [];
    for (let at = 0; at < length;) {
      const n = Math.min(MAX_PAYLOAD, length - at), from = BigInt(address) + BigInt(at);
      let part;
      try { part = await this.call(OP.FS_READ, u64s(from, n)); }
      catch (error) { error.message += ' (FS_READ 0x' + from.toString(16) + ' +0x' + n.toString(16) + ')'; throw error; }
      if (part.length !== n) throw Error('Short FS read');
      parts.push(part); at += n;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  }
  /// The console compares `expected`, writes, and verifies its readback.
  async fsWrite(address, expected, replacement) {
    if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(replacement) || expected.length !== replacement.length)
      throw Error('FS writes need equal-sized expected and replacement bytes');
    for (let at = 0; at < expected.length; at += FS_WRITE_CHUNK) {
      const n = Math.min(FS_WRITE_CHUNK, expected.length - at);
      await this.call(OP.FS_WRITE, Buffer.concat([u64s(BigInt(address) + BigInt(at), n), expected.subarray(at, at + n), replacement.subarray(at, at + n)]));
    }
  }
  async normalRead(address, length) {
    const parts = [];
    for (let at = 0; at < length; at += FS_WRITE_CHUNK) parts.push(await this.call(OP.NORMAL_READ, u64s(BigInt(address) + BigInt(at), Math.min(FS_WRITE_CHUNK, length - at))));
    const bytes = Buffer.concat(parts);
    if (bytes.length !== length) throw Error('Short Normal read');
    return bytes;
  }
  async normalWrite(address, expected, replacement) {
    for (let at = 0; at < expected.length; at += FS_WRITE_CHUNK) {
      const n = Math.min(FS_WRITE_CHUNK, expected.length - at);
      await this.call(OP.NORMAL_WRITE, Buffer.concat([u64s(BigInt(address) + BigInt(at), n), expected.subarray(at, at + n), replacement.subarray(at, at + n)]));
    }
  }
  async fsQuery(address) {
    const d = await this.call(OP.FS_QUERY, u64s(address));
    return {address: d.readBigUInt64LE(0), size: d.readBigUInt64LE(8), type: d.readUInt32LE(16), attributes: d.readUInt32LE(20), permissions: d.readUInt32LE(24)};
  }
  end() { this.socket.end(); }
}

module.exports = {Bridge, OP, DAEMON_ERROR, MAX_PAYLOAD, frames, frame, u64s};
