'use strict';
// Isolated UI fixture. All displayed figures are synthetic; RPC and sending disabled.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../src/server');
const { config, address } = require('./fixtures');
const { atomicJson } = require('../src/config');
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-statistics-ui-'));
  const settings = config({ privateKey: '', apiKey: '' }); atomicJson(path.join(dataDir, 'config.json'), settings);
  const app = await createApp({ dataDir, automaticUpdates: false, chainFactory: () => ({ receipt: async () => ({}) }) });
  const day = new Date(Date.now() + 480 * 60000).toISOString().slice(0, 10);
  const today = Date.parse(day + 'T06:00:00Z'); let sequence = 0;
  function seed(offset, count, options = {}) {
    for (let i = 0; i < count; i++) {
      const n = ++sequence;
      const amount = options.token ? '0.012345678901234567' : '168';
      app.store.offer('live', { to: address(n + 100), txid: n.toString(16).padStart(64, '0'), asset: 'TRX', amount: '150' },
        { ...settings, sendAmount: amount, tokenContract: options.token || settings.tokenContract }, 10);
      const row = app.store.next('live'), txid = n.toString(16).padStart(64, 'b');
      app.store.update(row.id, options.status || 'confirmed', { txid });
      if (!options.undated) app.store.saveReceipt({ ...row, txid }, { id: txid, blockTimeStamp: today - offset * 86400000,
        receipt: { result: options.status === 'failed' ? 'REVERT' : 'SUCCESS', energy_usage_total: options.partial ? null : 64285 + n % 100 }, fee: options.partial ? null : (n % 3 ? 0 : 127000) });
    }
  }
  for (let day = 0; day < 37; day++) if (day % 5 !== 3) seed(day, 2 + day % 7);
  seed(0, 1, { status: 'failed' }); seed(1, 1, { token: address(10) });
  seed(2, 1, { partial: true }); seed(0, 2, { undated: true }); seed(0, 1, { status: 'executed', undated: true });
  clearInterval(app.engine.confirmationTimer); clearInterval(app.engine.statisticsTimer);
  console.log(JSON.stringify({ url: app.url, dataDir, port: app.port }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); });
})().catch(error => { console.error(error); process.exitCode = 1; });
