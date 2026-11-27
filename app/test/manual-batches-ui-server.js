'use strict';
// Isolated UI fixture. Every chain method uses in-memory synthetic data; no RPC.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../src/server');
const { atomicJson } = require('../src/config');
const { config, FakeChain, address } = require('./fixtures');
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-manual-ui-'));
  const c = config({ maxPerRun: process.argv.includes('--resume-demo') ? 1 : 0, blacklist: [address(6)], sendIntervalSeconds: 2 });
  atomicJson(path.join(dataDir, 'config.json'), c);
  const chain = new FakeChain(c), version = require('../package.json').version;
  const updater = { snapshot: () => ({ currentVersion: version, latestVersion: version, available: false }), stopAutomaticChecks() {} };
  const app = await createApp({ dataDir, automaticUpdates: false, automaticRuntime: false, chainFactory: () => chain, updater });
  app.engine.preflightResult = await chain.preflight(); app.engine.wallet = app.engine.preflightResult.resources;
  if (process.argv.includes('--repeat-demo')) {
    for (const [n, status] of [[4, 'confirmed'], [10, 'archived_unconfirmed']]) {
      app.store.offer('live', { to: address(n), txid: 'demo-history-' + n, asset: 'TRX', amount: '150' }, c, 1);
      const row = app.store.db.prepare('SELECT id FROM deliveries WHERE address=?').get(address(n));
      app.store.update(row.id, status, { txid: String(n).padStart(64, 'a'), detail: '隔离界面测试历史记录' });
    }
  }
  if (process.argv.includes('--resume-demo')) {
    chain.headValue = 10;
    const p = await app.engine.manualBatches.prepare({ text: [address(4), address(5), address(7)].join('\n'), mode: 'live', historyPolicy: 'repeat' });
    await app.engine.manualBatches.submit({ confirmationToken: p.confirmationToken, confirmed: true, confirmRepeat: true });
    await app.engine.loopPromise;
  }
  const instance = { url: app.url, port: app.port, dataDir,
    sample: [address(4), address(5), address(4), address(6), 'invalid-address', address(10)].join('\n') };
  atomicJson(path.join(__dirname, '../test-output/manual-batches-ui-instance.json'), instance);
  console.log(JSON.stringify(instance));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); });
})().catch(error => { console.error(error); process.exitCode = 1; });
