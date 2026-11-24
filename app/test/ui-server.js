'use strict';
// Isolated UI fixture: this server can never sign or broadcast to a real chain.
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server');
const { config, FakeChain, address, trxBlock } = require('./fixtures');
const { atomicJson } = require('../src/config');
const { decodeCandidates } = require('../src/chain');
(async () => {
  const dir = path.join(__dirname, '..', 'test-output', 'ui-' + Date.now()); fs.mkdirSync(dir, { recursive: true });
  const c = config({ maxPerRun: 0 }); atomicJson(path.join(dir, 'config.json'), c);
  const app = await createApp({ dataDir: dir, chainFactory: next => new FakeChain(next), automaticUpdates: false });
  for (let i = 4; i < 71; i++) {
    const item = decodeCandidates(trxBlock(11, address(i), i.toString(16).padStart(64, '0')), c)[0];
    app.store.offer(i % 3 === 0 ? 'simulate' : 'live', item, c, 11);
    const row = app.store.db.prepare('SELECT id FROM deliveries WHERE address=?').get(item.to);
    app.store.update(row.id, i % 3 === 0 ? 'simulated' : (i % 7 === 0 ? 'cancelled' : 'confirmed'), { detail: '界面验收样例；并非真实投放', txid: i.toString(16).padStart(64, 'b') });
  }
  atomicJson(path.join(__dirname, '..', 'test-output', 'ui-instance.json'), { url: app.url, port: app.port, dataDir: dir });
  console.log('UI fixture ready on port ' + app.port);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close());
})();
