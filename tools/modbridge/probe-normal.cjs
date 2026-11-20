// Diagnostic: probe one FS heap (Normal) address through a running daemon's ops pipe.
// Usage: node probe-normal.cjs RUN-DIR ADDRESS-HEX
const fs = require('node:fs'), path = require('node:path');
const {Bridge} = require('./bridge.cjs');
(async () => {
  const run = process.argv[2], at = BigInt(process.argv[3]);
  const {opsPipe} = JSON.parse(fs.readFileSync(path.join(run, 'modbridge.json'), 'utf8'));
  const b = await Bridge.connect(opsPipe);
  console.log('block', await b.fsQuery(at));
  for (const len of [0x1000, 0x10000]) {
    try { const d = await b.fsRead(at, len); console.log('read 0x' + len.toString(16), 'ok, nonzero bytes', d.filter(x => x).length); }
    catch (error) { console.log('read 0x' + len.toString(16), 'FAILED', error.message); }
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
