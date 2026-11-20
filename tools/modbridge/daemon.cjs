#!/usr/bin/env node
'use strict';
// Owns the single TCP connection to modbridge.nro, discovers the FS objects ModLoader needs, writes a run
// directory, and serves that run's two pipes until stopped:
//   ops  - modbridge frames from the run's fake engine modules, serialized onto the console connection
//   json - ModLoader's socketPath: one newline-terminated JSON request per connection, JSON reply, close
// Ops-pipe NORMAL_READ/NORMAL_WRITE (Normal FS heap) are served by FS-side copies (native.cjs).
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {Bridge, OP, DAEMON_ERROR, frames, frame} = require('./bridge.cjs');
const {discover} = require('./discover.cjs');
const {Native, cacheRelro} = require('./native.cjs');
const {makeRun, newSession} = require('./make-run.cjs');

const check = (ok, message) => { if (!ok) throw Error(message); };
const REFUSED = 0xca01; // frame status for a CLOSE of a handle the daemon must keep
const pipePath = name => process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock');
const listen = (server, at) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(at, resolve); });

async function start({host = '192.168.50.2', port = 5501, runsDir = path.join(__dirname, 'runs'), log = console.log} = {}) {
  log('Connecting to modbridge at ' + host + ':' + port);
  const bridge = await Bridge.connect({host, port});
  let d, native;
  try {
    d = await discover(bridge, log);
    native = await Native.open(bridge, d, log);
    d.relro = await cacheRelro(native, d, log);
  } catch (error) {
    if (native) await native.close().catch(problem => { error.message += ' | ' + problem.message; });
    bridge.end(); throw error;
  }
  const session = newSession();
  const pipes = {ops: pipePath('modbridge-' + session + '-ops'), json: pipePath('modbridge-' + session + '-fs')};
  const keep = new Set([d.hello.ro, d.hello.fsProcess, d.hello.fsRoot, d.notifier.handle]);
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };

  // Normal FS heap, only ever asked for by the run's fake memory inside ModLoader's own allocations.
  const normal = async (op, payload) => {
    check(payload.length >= 16, 'Invalid Normal request');
    const address = payload.readBigUInt64LE(0), length = Number(payload.readBigUInt64LE(8));
    check(length > 0 && length <= 0x10000 && payload.length === (op === OP.NORMAL_READ ? 16 : 16 + 2 * length), 'Invalid Normal request');
    const q = await bridge.fsQuery(address);
    check(q.type === 5 && q.permissions === 3 && !q.attributes && address + BigInt(length) <= q.address + q.size,
      'Not Normal RW FS memory: 0x' + address.toString(16));
    if (op === OP.NORMAL_READ) return native.read(address, length);
    await native.write(address, payload.subarray(16, 16 + length), payload.subarray(16 + length));
    return Buffer.alloc(0);
  };
  const ops = net.createServer(socket => {
    track(socket);
    let order = Promise.resolve(); // replies leave in request order
    frames(socket, (op, payload) => {
      const refused = op === OP.CLOSE && payload.length >= 4 && keep.has(payload.readUInt32LE(0));
      const reply = refused ? Promise.resolve({status: REFUSED, data: Buffer.alloc(0)}) :
        [OP.NORMAL_READ, OP.NORMAL_WRITE].includes(op) ? normal(op, payload).then(data => ({status: 0, data}),
          error => ({status: DAEMON_ERROR, data: Buffer.from(error.message)})) :
        native.exclusive(() => bridge.request(op, payload));
      reply.catch(() => {}); // handled in order below
      order = order.then(() => reply).then(({status, data}) => { if (!socket.destroyed) socket.write(frame(status, data)); },
        error => socket.destroy(error));
    });
  });
  const answer = command => {
    if (command?.command === 'root-native-info')
      return {session, worker: {joined: true}, notifiers: [d.notifier.handle], services: [], events: [], calls: []};
    if (command?.command === 'info') return {ready: true, session, platform: 2, provider: 'modbridge'};
    return {error: 'Unsupported modbridge command: ' + command?.command};
  };
  const json = net.createServer(socket => {
    track(socket);
    let input = '', answered = false;
    socket.setEncoding('utf8');
    socket.on('data', part => {
      if (answered) return;
      input += part;
      const end = input.indexOf('\n');
      if (end < 0) { if (input.length > 65536) socket.destroy(); return; }
      answered = true;
      let reply;
      try { reply = answer(JSON.parse(input.slice(0, end))); } catch (error) { reply = {error: error.message}; }
      socket.end(JSON.stringify(reply) + '\n');
    });
  });

  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([ops, json].map(server => new Promise(resolve => server.close(() => resolve()))));
    try { await native.close(); } catch (error) { log('WARNING: the FS staging block was not freed: ' + error.message); }
    bridge.end();
  };
  let run;
  try {
    await listen(ops, pipes.ops);
    await listen(json, pipes.json);
    run = makeRun(runsDir, session, d, pipes);
  } catch (error) { await stop(); throw error; }
  let stopped = false;
  bridge.socket.on('close', () => { if (!stopped) { log('Console connection closed; stopping.'); process.exitCode = 1; stop(); } });
  return {run, session, discovery: d, pipes, stop: () => { stopped = true; return stop(); }};
}

function options(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--host') { o.host = v; i++; } else if (a === '--port') { o.port = Number(v); i++; }
    else if (a === '--runs') { o.runsDir = path.resolve(v); i++; }
    else throw Error('Usage: node daemon.cjs [--host 192.168.50.2] [--port 5501] [--runs DIR]\nUnknown option: ' + a);
  }
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port > 0 && o.port < 65536)) throw Error('Invalid --port');
  return o;
}

if (require.main === module) {
  (async () => {
    const daemon = await start(options(process.argv.slice(2)));
    console.log('\nRUN=' + daemon.run);
    console.log('From the ModLoader folder run:\n  node load.cjs --run-dir "' + daemon.run + '" --keep-rpc');
    console.log('Keep this window open until ModLoader finishes. Ctrl+C stops the daemon.');
    process.once('SIGINT', async () => {
      console.log('Stopping. modbridge keeps the notifier and any handles ModLoader left open until you exit it on the console.');
      await daemon.stop();
    });
  })().catch(error => { console.error('MODBRIDGE STOPPED: ' + error.message); process.exitCode = 1; });
}

module.exports = {start, options, pipePath};
