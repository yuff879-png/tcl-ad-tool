'use strict';
// Isolated UI data. No live RPC, token signing, broadcasting or software updates.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createApp } = require('../src/server');
const { atomicJson } = require('../src/config');
const { config, FakeChain, address } = require('./fixtures');
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-trc10-ui-'));
  const c = config({ assetType: 'TRC10', tokenId: '1000016', trc10SendAmount: '168', privateKey: '', maxPerRun: 0 });
  atomicJson(path.join(dataDir, 'config.json'), c);
  class IsolatedChain extends FakeChain {
    async tokenInfo() { return this.config.assetType === 'TRC10' ? { contract: '1000016', symbol: 'DEMO10', decimals: 0, assetType: 'TRC10', issuer: address(9), rawBalance: null, balance: null } : super.tokenInfo(); }
    async inspectWallet(owner) { return { wallet: owner, activated: true, standardPermission: true, balanceSun: '0', rawBalance: '16800', freeBandwidth: 600, freeLimit: 600, stakedBandwidth: 0, checkedAt: new Date().toISOString() }; }
    async buildNative() { throw new Error('隔离界面验收：真实签名已禁用'); }
    async buildAndSign() { throw new Error('隔离界面验收：真实签名已禁用'); }
    async broadcast() { throw new Error('隔离界面验收：广播已禁用'); }
    async receipt() { return {}; }
  }
  const updater = { snapshot: () => ({ currentVersion: require('../package.json').version, available: false }), stopAutomaticChecks() {}, check: async () => ({ available: false }) };
  const app = await createApp({ dataDir, chainFactory: next => new IsolatedChain(next), automaticUpdates: false, updater });
  app.pool.unlock('isolated-ui-demo-password', true); await app.pool.generate(100); await app.pool.work;
  const saved = app.store.db.prepare('SELECT * FROM pool_wallets').all();
  for (let i = 0; i < saved.length; i++) app.store.db.prepare('UPDATE pool_wallets SET active=?,enabled=?,state=?,token_id=?,raw_balance=?,free_bandwidth=?,checked_at=? WHERE id=?')
    .run(i < 90 ? 1 : 0, i < 90 ? 1 : 0, i >= 90 ? 'inactive' : i % 6 === 0 ? 'recovering' : 'ready', c.tokenId, '16800', i % 6 === 0 ? 100 : 600, new Date().toISOString(), saved[i].id);
  for (let i = 0; i < 3; i++) {
    app.store.offer('live', { to: address(500 + i), txid: String(i).padStart(64, 'a'), asset: 'TRX', amount: '150' }, { ...c, tokenContract: c.tokenId }, 11);
    const row = app.store.next('live'); const txid = String(i).padStart(64, 'b'); app.store.update(row.id, 'confirmed', { txid });
    app.store.saveReceipt({ ...row, txid }, { id: txid, nativeValidated: true, blockTimeStamp: Date.now() - i * 86400000, receipt: { result: 'SUCCESS', net_usage: 282 } });
  }
  // Completed and paused batches exercise the real table with synthetic rows.
  const now = new Date().toISOString();
  for (const [id, total, done, status] of [['demo-completed', 20, 20, 'completed'], ['demo-paused', 10, 5, 'paused']]) {
    app.store.db.prepare('INSERT INTO pool_batches(id,kind,token_id,rpc,owner,decimals,amount,total,group_size,budget_sun,status,created_at,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'activate', c.tokenId, c.rpcUrl, address(7), 0, '16800', total, 10, String(total * 1100000), status, now, status === 'paused' ? '示例批次：暂停后可继续剩余钱包' : '示例批次：本批已完成');
    for (let i = 0; i < total; i++) app.store.db.prepare('INSERT INTO pool_jobs(id,batch_id,wallet_id,address,token,amount,raw_amount,wallet,rpc,status,fee_sun,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id + '-' + i, id, saved[i].id, saved[i].address, c.tokenId, '16800', '16800', address(7), c.rpcUrl, i < done ? 'confirmed' : 'queued', i < done ? '1100000' : null, now);
  }
  const backupDir = path.join(dataDir, 'fixture-backup'); fs.mkdirSync(backupDir);
  await require('node:sqlite').backup(app.store.db, path.join(backupDir, 'records.sqlite'));
  for (const name of ['config.json', 'pool-vault.json']) fs.copyFileSync(path.join(dataDir, name), path.join(backupDir, name));
  app.pool.noteBackup(backupDir); app.pool.verifyBackup('isolated-ui-demo-password'); app.pool.progress = null;
  app.engine.log('info', '隔离界面验收数据：不连接真实节点，所有广播已禁用。');
  fs.mkdirSync(path.join(__dirname, '../test-output'), { recursive: true });
  atomicJson(path.join(__dirname, '../test-output/trc10-ui-instance.json'), { url: app.url, port: app.port, dataDir });
  console.log(JSON.stringify({ url: app.url, dataDir }));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close());
})().catch(error => { console.error(error); process.exitCode = 1; });
