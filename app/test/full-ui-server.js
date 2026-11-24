'use strict';
// Manual UI regression fixture: isolated synthetic data, no RPC/signing/broadcast.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../src/server');
const { atomicJson } = require('../src/config');
const { config, FakeChain, address } = require('./fixtures');
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-full-ui-'));
  const c = config({ maxPerRun: 0, watchedAddresses: [address(2), address(5)], blacklist: [address(6)], restartScanMode: 'latest', unfinishedPolicy: 'skip' });
  atomicJson(path.join(dataDir, 'config.json'), c);
  class IsolatedChain extends FakeChain {
    async buildAndSign() { throw new Error('UI fixture: signing disabled'); }
    async broadcast() { throw new Error('UI fixture: broadcasting disabled'); }
    async receipt() { return {}; }
  }
  const version = require('../package.json').version;
  let checked = false;
  const updater = { snapshot: () => ({ currentVersion: version, latestVersion: '1.0.9', available: checked, notes: checked ? '界面验收用更新提示，不会下载或安装。' : '', checkedAt: checked ? new Date().toISOString() : null }),
    async check() { checked = true; return this.snapshot(); }, stopAutomaticChecks() {}, async prepare() { throw new Error('UI fixture: updates disabled'); } };
  const app = await createApp({ dataDir, automaticUpdates: false, chainFactory: next => new IsolatedChain(next), updater });
  const today = Date.parse(new Date(Date.now() + 480 * 60000).toISOString().slice(0, 10) + 'T06:00:00Z');
  let seq = 0;
  function seed(day, token = c.tokenContract, amount = '168', status = 'confirmed', partial = false) {
    const n = ++seq, txid = n.toString(16).padStart(64, 'b');
    app.store.offer('live', { to: address(100 + n), txid: n.toString(16).padStart(64, '0'), asset: 'TRX', amount: '150' }, { ...c, tokenContract: token, sendAmount: amount }, 10);
    const row = app.store.next('live'); app.store.update(row.id, status, { txid, detail: '隔离界面验收数据，未实际发送' });
    app.store.saveReceipt({ ...row, txid }, { id: txid, blockTimeStamp: today - day * 86400000, receipt: { result: status === 'failed' ? 'REVERT' : 'SUCCESS', energy_usage_total: partial ? null : 64285 + n }, fee: partial ? null : n % 3 ? 0 : 127000 });
  }
  for (let day = 0; day < 37; day++) if (day % 5 !== 3) for (let i = 0; i < 2 + day % 7; i++) seed(day);
  seed(0, c.tokenContract, '168', 'failed'); seed(1, address(10), '0.012345678901234567');
  seed(2, c.tokenContract, '9007199254740993.000000000000000001', 'confirmed', true);
  if (['public', 'cooldown'].includes(process.env.TCL_UI_NODE_STATE)) {
    const client = app.engine.getChain(c);
    client.nodeStatus = () => ({ source: 'public', fallback: true, state: process.env.TCL_UI_NODE_STATE === 'cooldown' ? 'cooldown' : 'ready', retryAt: process.env.TCL_UI_NODE_STATE === 'cooldown' ? Date.now() + 60000 : 0 });
  }
  app.engine.preflightResult = await new IsolatedChain(c).preflight(); app.engine.wallet = app.engine.preflightResult.resources;
  app.engine.log('info', '隔离界面验收已准备，所有链操作均为本地测试实现。');
  clearInterval(app.engine.confirmationTimer); clearInterval(app.engine.statisticsTimer);
  const instance = { url: app.url, port: app.port, dataDir };
  fs.mkdirSync(path.join(__dirname, '../test-output'), { recursive: true });
  atomicJson(path.join(__dirname, '../test-output/full-ui-instance.json'), instance);
  console.log(JSON.stringify(instance));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); });
})().catch(error => { console.error(error); process.exitCode = 1; });
