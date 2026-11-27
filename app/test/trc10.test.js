'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { TronWeb, utils } = require('tronweb');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { WalletPool } = require('../src/pool');
const { PoolVault } = require('../src/pool-vault');
const { Trc10Chain, rawUnits, validateNative, bandwidthSize } = require('../src/trc10');
const { normalize, effectiveConfig, publicConfig } = require('../src/config');
const { receiptMetrics, queryStatistics } = require('../src/statistics');
const { address, key, config, trxBlock } = require('./fixtures');
const PASSWORD = 'isolated-test-password';
function nativeTx(to, amount, token, sender) {
  const tx = { visible: false, raw_data: { ref_block_bytes: '1234', ref_block_hash: '0123456789abcdef', timestamp: Date.now(), expiration: Date.now() + 60000,
    contract: [{ type: 'TransferAssetContract', parameter: { type_url: 'type.googleapis.com/protocol.TransferAssetContract', value: {
      owner_address: TronWeb.address.toHex(sender), to_address: TronWeb.address.toHex(to), asset_name: Buffer.from(token).toString('hex'), amount } } }] } };
  const pb = utils.transaction.txJsonToPb(tx); tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).toLowerCase(); tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '').toLowerCase(); return tx;
}
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-trc10-')), store = new Store(directory);
  const c = config({ assetType: 'TRC10', tokenId: '1000016', trc10SendAmount: '168', poolFundingKey: key(7), maxPerRun: 0 });
  const chain = new Trc10Chain(effectiveConfig(c));
  const transfers = new Map(), balances = new Map(); let broadcasts = 0;
  chain.request = fn => fn();
  chain.tokenInfo = async token => ({ assetType: 'TRC10', contract: token || c.tokenId, symbol: 'DEMO10', decimals: 0, rawBalance: null, balance: null });
  chain.head = async () => 10; chain.block = async h => trxBlock(h); chain.verifyTrigger = async () => true;
  chain.preflight = async () => ({ height: 10, token: await chain.tokenInfo(), amount: '168', resources: null, warnings: [] });
  chain.account = async owner => ({ address: TronWeb.address.toHex(owner) });
  chain.inspectWallet = async owner => ({ wallet: owner, activated: true, standardPermission: true, rawBalance: '1000000000', balanceSun: owner === address(7) ? '1000000000' : '0', freeBandwidth: 600, freeLimit: 600, stakedBandwidth: 0, checkedAt: new Date().toISOString(), ...balances.get(owner) });
  chain.tron.transactionBuilder.sendToken = async (to, amount, token, sender) => nativeTx(to, amount, token, sender);
  chain.broadcast = async signed => { broadcasts++; transfers.set(signed.txID, signed); return { result: true }; };
  chain.receipt = async id => transfers.has(id) ? { id, blockTimeStamp: Date.now(), receipt: { net_usage: 282 } } : {};
  chain.executionReceipt = chain.receipt;
  for (const node of ['fullNode', 'solidityNode']) chain.tron[node].request = async (endpoint, input) => ({ ...transfers.get(input.value), ret: [{ contractRet: 'SUCCESS' }] });
  const engine = new Engine(store, () => c, () => chain, { executionWaitMs: 0, retryDelayMs: 0 });
  const pool = new WalletPool(store, directory, () => c, () => chain); engine.pool = pool;
  pool.costs = async () => ({ create: 1000000n, createBandwidth: 100000n, perByte: 1000n });
  t.after(async () => { await pool.close(); await engine.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, c, chain, pool, engine, balances, transfers, get broadcasts() { return broadcasts; } };
}
async function wallets(f, n = 3) {
  f.pool.unlock(PASSWORD, true); await f.pool.generate(n); await f.pool.work;
  const folder = path.join(f.directory, 'backup-test'); fs.mkdirSync(folder); fs.copyFileSync(f.pool.vault.file, path.join(folder, 'pool-vault.json'));
  f.pool.noteBackup(folder); f.pool.verifyBackup(PASSWORD);
  f.store.db.prepare("UPDATE pool_wallets SET active=1,enabled=1,state='checking'").run();
  return f.store.db.prepare('SELECT * FROM pool_wallets ORDER BY id').all();
}
function queue(f, recipient = address(3), source = 'a'.repeat(64)) {
  f.store.offer('live', { to: recipient, txid: source, asset: 'TRX', amount: '150' }, effectiveConfig(f.c), 10); return f.store.next('live');
}
test('TRC10 amount conversion is exact and rejects unsafe SDK integers', () => {
  assert.equal(rawUnits('168.123456', 6), '168123456');
  assert.throws(() => rawUnits('9007199254740992', 0)); assert.throws(() => rawUnits('0', 0));
  const c = config({ assetType: 'TRC10', tokenId: '1000016', poolFundingKey: key(7) });
  assert.equal(publicConfig(c).poolFundingKey, undefined); assert.equal(publicConfig(c).hasPoolFundingKey, true);
  assert.equal(effectiveConfig(c).tokenContract, '1000016'); assert.equal(c.tokenContract, address(9));
});
test('native signed transaction validates exact transfer and measures serialized bandwidth', async t => {
  const f = setup(t), row = { address: address(3), amount: '168', token: '1000016' };
  const p = await f.chain.buildNative(row, 0, key(1));
  assert.equal(p.wallet, address(1)); assert.equal(p.rawAmount, '168'); assert.ok(p.bandwidth >= 250 && p.bandwidth <= 400);
  assert.equal(p.bandwidth, bandwidthSize(p.signed));
  assert.throws(() => validateNative({ ...row, address: address(4) }, p.signed, '168', address(1)));
  assert.throws(() => validateNative(row, p.signed, '169', address(1)));
  assert.throws(() => validateNative({ ...row, token: '1000017' }, p.signed, '168', address(1)));
  const bad = structuredClone(p.signed); bad.raw_data.data = 'aa'; assert.throws(() => validateNative(row, bad, '168', address(1)));
});
test('vault encrypts keys, rejects wrong password, and recovers after reopening', async t => {
  const f = setup(t), items = await wallets(f);
  const bytes = fs.readFileSync(f.pool.vault.file, 'utf8');
  for (const w of items) assert.ok(!bytes.includes(f.pool.vault.get(w.id).key));
  const v = new PoolVault(f.directory); assert.throws(() => v.unlock('wrong-password'));
  v.unlock(PASSWORD); assert.equal(v.require().data.wallets.length, 3); v.lock();
  await f.pool.generate(2); await f.pool.work;
  assert.equal(f.pool.snapshot().total, 5); assert.equal(f.pool.backedUp(), false);
  assert.throws(() => f.pool.verifyBackup(PASSWORD), /不一致/);
});
test('free-only admission rejects TRX, staked bandwidth, low tokens and nonstandard permissions', async t => {
  const f = setup(t);
  for (const change of [{ balanceSun: '1' }, { stakedBandwidth: 1 }, { standardPermission: false }, { rawBalance: '1' }, { freeBandwidth: 281 }]) {
    f.balances.set(address(1), change); await assert.rejects(f.chain.checkFree(address(1), '168', 282), e => e.resourceWait === true);
  }
  f.balances.set(address(1), { freeBandwidth: 302 }); await f.chain.checkFree(address(1), '168', 282);
});
test('native execution succeeds without a Transfer event or energy receipt; statistics keep bandwidth', async t => {
  const f = setup(t); await wallets(f); f.engine.loop = async () => {};
  await f.engine.start('live'); const row = queue(f);
  await f.engine.sendNext(); assert.equal(f.store.get(row.id).status, 'executed'); assert.equal(f.broadcasts, 1);
  await f.engine.confirmExecuted(); const confirmed = f.store.get(row.id); assert.equal(confirmed.status, 'confirmed');
  const metrics = receiptMetrics(confirmed, await f.chain.deliveryReceipt(confirmed, true));
  assert.equal(metrics.energy, '0'); assert.equal(metrics.bandwidth, '282'); assert.equal(metrics.feeSun, '0');
  const stats = queryStatistics(f.store.db, { period: 'all', token: f.c.tokenId }); assert.equal(stats.totals.count, 1); assert.equal(stats.totals.bandwidth, '282');
});
test('insufficient free bandwidth waits without signing, attempts or failure streak', async t => {
  const f = setup(t), items = await wallets(f); items.forEach(w => f.balances.set(w.address, { freeBandwidth: 0 }));
  f.engine.loop = async () => {}; await f.engine.start('live'); const row = queue(f);
  assert.equal(await f.engine.sendNext(), false); assert.equal(f.broadcasts, 0); assert.equal(f.store.get(row.id).status, 'queued');
  assert.equal(f.store.retryInfo(row).attempts, 0); assert.equal(f.engine.failureStreak(), 0); assert.match(f.engine.resourceWait, /免费带宽/);
});

test('manual TRC10 batches use the same free-bandwidth pool, stay ahead of scans and do not age out as triggers', async t => {
  const f = setup(t); await wallets(f); f.engine.loop = async () => {};
  await f.engine.start('live'); const scanned = queue(f);
  const p = await f.engine.manualBatches.prepare({ text: [address(4), address(5)].join('\n'), mode: 'live' });
  const result = await f.engine.manualBatches.submit({ confirmationToken: p.confirmationToken, confirmed: true });
  f.store.db.prepare('UPDATE deliveries SET created_at=? WHERE manual_batch_id=?').run('2020-01-01T00:00:00Z', result.id);
  await f.engine.sendNext(); await f.engine.confirmExecuted();
  await f.engine.sendNext(); await f.engine.confirmExecuted();
  const manual = f.store.records({ search: result.id }).items;
  assert.equal(f.broadcasts, 2); assert.ok(manual.every(row => row.status === 'confirmed' && row.asset_type === 'TRC10' && row.token === '1000016'));
  assert.equal(f.store.get(scanned.id).status, 'queued'); assert.equal(f.store.next('live', effectiveConfig(f.c)).id, scanned.id);
  assert.ok(manual.every(row => f.store.db.prepare('SELECT 1 FROM pool_wallets WHERE address=?').get(row.wallet)));
});
test('linked seamless policy keeps TRC10 local broadcasts and permits the next free pool wallet', async t => {
  const f = setup(t); await wallets(f); f.engine.loop = async () => {};
  f.engine.energyPolicy = { linked: () => true, refreshForSend: async () => 'seamless', requireMode: () => 'seamless' };
  await f.engine.start('live');
  f.chain.receipt = async () => ({}); f.chain.executionReceipt = async () => ({});
  const first = queue(f); await f.engine.sendNext(); assert.equal(f.broadcasts, 1); assert.equal(f.store.get(first.id).status, 'pending');
  queue(f, address(4), 'c'.repeat(64)); await f.engine.sendNext(); assert.equal(f.broadcasts, 2);
});

test('TRC10 repeat batches preserve history and send through the same free-bandwidth pool', async t => {
  const f = setup(t); await wallets(f); f.engine.loop = async () => {}; await f.engine.start('live');
  const old = queue(f); await f.engine.sendNext(); await f.engine.confirmExecuted();
  const original = { ...f.store.get(old.id) }; assert.equal(original.status, 'confirmed');
  assert.equal((await f.engine.manualBatches.prepare({ text: old.address, mode: 'live' })).eligible, 0);
  const p = await f.engine.manualBatches.prepare({ text: old.address, mode: 'live', historyPolicy: 'repeat' });
  assert.equal(p.counts.repeated, 1);
  await f.engine.manualBatches.submit({ confirmationToken: p.confirmationToken, confirmed: true, confirmRepeat: true });
  const next = f.store.next('live', effectiveConfig(f.c)); assert.equal(next.manual_repeat, 1);
  await f.engine.sendNext(); await f.engine.confirmExecuted();
  assert.equal(f.broadcasts, 2); assert.equal(f.store.get(next.id).status, 'confirmed');
  assert.notEqual(f.store.get(next.id).txid, original.txid); assert.deepEqual({ ...f.store.get(old.id) }, original);
});
test('pause during candidate lookup prevents native signature and broadcast', async t => {
  const f = setup(t); await wallets(f); f.engine.loop = async () => {}; await f.engine.start('live'); queue(f);
  let signed = 0; const inspect = f.chain.inspectWallet.bind(f.chain), build = f.chain.buildNative.bind(f.chain);
  f.chain.inspectWallet = async address => { f.engine.stop(); return inspect(address); };
  f.chain.buildNative = async (...args) => { signed++; return build(...args); };
  await f.engine.sendNext(); assert.equal(f.broadcasts, 0);
  assert.equal(signed, 0); assert.equal(f.store.pending().length, 0);
});
test('unactivated recipients are skipped, and own pool wallets never enter delivery queue', async t => {
  const f = setup(t), items = await wallets(f); f.engine.loop = async () => {}; await f.engine.start('live');
  f.chain.account = async () => null; const row = queue(f); await f.engine.sendNext(); assert.equal(f.store.get(row.id).status, 'skipped');
  f.chain.block = async h => trxBlock(h, items[0].address, 'c'.repeat(64)); await f.engine.scanOne(11);
  assert.equal(f.store.records().total, 1); assert.equal(f.broadcasts, 0);
});
test('native result unknown locks its sender and target, while other wallets can continue', async t => {
  const f = setup(t); await wallets(f); f.engine.loop = async () => {}; await f.engine.start('live');
  f.chain.receipt = async () => ({}); f.chain.executionReceipt = async () => ({});
  const one = queue(f); await f.engine.sendNext(); const pending = f.store.get(one.id);
  assert.equal(pending.status, 'pending'); assert.equal(f.store.retryInfo(pending).attempts, 1);
  assert.ok(f.store.retryInfo(pending).retry_after > Date.now());
  assert.equal(f.pool.locked(pending.wallet), true);
  queue(f, address(4), 'c'.repeat(64)); await f.engine.sendNext(); const two = f.store.records().items.find(r => r.address === address(4));
  assert.notEqual(two.wallet, pending.wallet); assert.equal(f.broadcasts, 2);
  assert.equal(f.store.offer('live', { to: address(3), txid: 'd'.repeat(64), asset: 'TRX', amount: '150' }, effectiveConfig(f.c), 11), false);
});
test('over twenty locked senders cannot starve a later available wallet', async t => {
  const f = setup(t), items = await wallets(f, 25); f.engine.loop = async () => {}; await f.engine.start('live');
  for (let i = 0; i < 24; i++) {
    const row = queue(f, address(100 + i), String(i).padStart(64, 'c'));
    f.store.update(row.id, 'executed', { wallet: items[i].address, txid: String(i).padStart(64, 'd') });
  }
  const row = queue(f); await f.engine.sendNext();
  assert.equal(f.store.get(row.id).wallet, items[24].address); assert.equal(f.broadcasts, 1);
  f.store.db.prepare("UPDATE pool_wallets SET state='ready',token_id=?,enabled=0").run(f.c.tokenId);
  assert.equal(f.pool.snapshot().ready, 0);
});
test('exhausted unknown native transaction releases its wallet only after verified expiry', async t => {
  const f = setup(t); await wallets(f); f.engine.loop = async () => {}; await f.engine.start('live');
  f.chain.receipt = async () => ({}); f.chain.executionReceipt = async () => ({});
  const row = queue(f); await f.engine.sendNext(); const current = f.store.get(row.id);
  f.store.exhaustRetry(current); f.store.db.prepare('UPDATE delivery_attempts SET expiration=? WHERE txid=?').run(Date.now() - 10000, current.txid);
  f.chain.replacementReady = async () => false; await f.engine.confirmExecuted(); assert.equal(f.pool.locked(current.wallet), true);
  f.chain.replacementReady = async () => true; await f.engine.confirmExecuted(); assert.equal(f.pool.locked(current.wallet), false);
  assert.equal(f.store.get(row.id).status, 'failed'); assert.equal(f.broadcasts, 1);
});
test('cost backfill retains the original sender after a retry rotates to a different wallet', async t => {
  const f = setup(t), row = queue(f);
  const first = await f.chain.buildNative(row, 0, key(1)); f.store.prepareAttempt(row, first); f.store.attemptStatus(first.txid, 'failed_final');
  const second = await f.chain.buildNative(row, 0, key(2)); f.store.prepareAttempt(f.store.get(row.id), second);
  const history = f.store.nextReceiptBackfill(); assert.equal(history.txid, first.txid); assert.equal(history.wallet, address(1));
  assert.equal(f.store.get(row.id).wallet, address(2));
});
test('native node data must match token and fee policy before accepting it', async t => {
  const f = setup(t);
  const token = { id: f.c.tokenId, precision: 0, owner_address: TronWeb.address.toHex(address(9)), name: '54455354' };
  f.chain.tron.fullNode.request = async () => ({ ...token, public_free_asset_net_limit: 1 });
  await assert.rejects(Trc10Chain.prototype.tokenInfo.call(f.chain), /发行者带宽/);
  f.chain.tron.fullNode.request = async () => ({ ...token, id: '1000017' });
  await assert.rejects(Trc10Chain.prototype.tokenInfo.call(f.chain), /Token ID/);
  f.chain.tron.fullNode.request = async () => token;
  assert.equal((await Trc10Chain.prototype.tokenInfo.call(f.chain)).decimals, 0);
  f.chain.tron.trx.getAccount = async () => ({ address: TronWeb.address.toHex(address(4)) });
  await assert.rejects(Trc10Chain.prototype.account.call(f.chain, address(3)), /地址不符/);
});
test('asset scopes retain conservative legacy protection and avoid cross-token queues', t => {
  const f = setup(t); const row = queue(f); assert.equal(row.asset_type, 'TRC10');
  const second = { ...effectiveConfig(f.c), tokenId: '1000017', tokenContract: '1000017' };
  assert.ok(f.store.offer('live', { to: address(3), txid: 'a'.repeat(64), asset: 'TRX', amount: '150' }, second, 10));
  assert.equal(f.store.next('live', second).token, '1000017');
  f.store.db.prepare("UPDATE deliveries SET asset_scope='' WHERE id=?").run(row.id);
  assert.equal(f.store.hasRecipient('live', address(3), 'b'.repeat(64), { ...second, tokenContract: '1000018' }), true);
});
test('preparation budget validates quantity and balance; confirmation is single use', async t => {
  const f = setup(t); await wallets(f, 2); f.store.db.prepare('UPDATE pool_wallets SET active=0,enabled=0').run();
  await assert.rejects(f.pool.plan({ kind: 'activate', count: 3, amount: '16800', budgetTrx: '10' }), /只有 2/);
  await assert.rejects(f.pool.plan({ kind: 'activate', count: 2, amount: '16800', budgetTrx: '1' }), /总预算/);
  const plan = await f.pool.plan({ kind: 'activate', count: 2, amount: '16800', budgetTrx: '2.2', groupSize: 1 });
  assert.equal(plan.estimatedTrx, '2.2'); assert.equal(plan.totalAmount, '33600'); assert.equal(plan.wallets, undefined); assert.equal(plan.config, undefined);
  const { id } = f.pool.startPlanned(plan.confirmation); await f.pool.work; await f.pool.reconcile();
  assert.throws(() => f.pool.startPlanned(plan.confirmation)); assert.equal(f.broadcasts, 2);
  assert.equal(f.pool.batches().find(b => b.id === id).confirmed, 2);
});
test('preparation holds pending fee reserves before broadcasting the next transfer', async t => {
  const f = setup(t); await wallets(f, 2); f.store.db.prepare('UPDATE pool_wallets SET active=0,enabled=0').run();
  const plan = await f.pool.plan({ kind: 'activate', count: 2, amount: '16800', budgetTrx: '2.2', groupSize: 2 });
  f.chain.account = async () => null;
  f.chain.deliveryReceipt = async () => ({});
  f.balances.set(address(7), { balanceSun: '1500000' });
  const { id } = f.pool.startPlanned(plan.confirmation); await f.pool.work;
  assert.equal(f.broadcasts, 1); assert.equal(f.pool.batches().find(b => b.id === id).status, 'paused');
  assert.match(f.pool.progress.error, /待确认占用/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM pool_jobs WHERE status='queued'").get().n, 1);
});
