'use strict';
// Isolated native-window acceptance fixture; no real network, signature or broadcast.
const fs = require('node:fs'), path = require('node:path');
const { createApp, openWindow } = require('../src/server');
const { config, FakeChain } = require('./fixtures');
const { atomicJson } = require('../src/config');
(async () => {
  const dataDir = path.resolve(__dirname, '../test-output/background-' + Date.now());
  fs.mkdirSync(dataDir, { recursive: true }); atomicJson(path.join(dataDir, 'config.json'), config({ maxPerRun: 0 }));
  const chain = new FakeChain(config({ maxPerRun: 0 })); let height = 10;
  chain.head = async () => height++;
  chain.buildAndSign = chain.broadcast = async () => { throw new Error('Fixture forbids signing and broadcasting'); };
  const app = await createApp({ dataDir, idleExit: true, chainFactory: () => chain, automaticUpdates: false });
  await app.engine.start('simulate');
  await openWindow(app.url, dataDir);
  atomicJson(path.resolve(__dirname, '../test-output/background-instance.json'), { url: app.url, port: app.port, dataDir });
  console.log('Native isolated background fixture ready.');
})();
