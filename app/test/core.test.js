'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { Chain, RequestQueue, decodeCandidates, transferEvents } = require('../src/chain');
const { decimalUnits, formatUnits, normalize, validate, publicConfig, fingerprint, redact } = require('../src/config');
const { config, key, address, trxBlock, usdtBlock, receipt, FakeChain } = require('./fixtures');
function fixture(t, extra) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-test-'));
  const store = new Store(directory), c = config(extra), chain = new FakeChain(c), engine = new Engine(store, () => c, () => chain, { executionWaitMs: 0, retryDelayMs: 0 });
  t.after(async () => { await engine.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, c, chain, engine, directory };
}
test('18-decimal amounts remain exact beyond Number safe range', () => {
  assert.equal(decimalUnits('168.000000000000000001', 18), 168000000000000000001n);
  assert.equal(formatUnits(168000000000000000001n, 18), '168.000000000000000001');
  assert.equal(decimalUnits('168', 6), 168000000n);
});
test('reject excess decimals, exponent notation, negatives and overflow', () => {
  for (const value of ['0.0000001', '1e6', '-1', 'NaN', '']) assert.throws(() => decimalUnits(value, 6));
  assert.throws(() => decimalUnits((2n ** 256n).toString(), 0));
});
test('blank secret preserves existing key; explicit clear removes it; no public leakage', () => {
  const c = config(); assert.equal(normalize({ privateKey: '' }, c).privateKey, c.privateKey);
  assert.equal(normalize({ clearSecrets: ['privateKey'] }, c).privateKey, '');
  assert.equal(publicConfig(c).privateKey, undefined); assert.equal(publicConfig(c).apiKey, undefined);
  assert.ok(!redact('error ' + c.privateKey, c).includes(c.privateKey));
});
test('validate addresses, run limits and key; simulation supports no private key', () => {
  assert.throws(() => validate(config({ watchedAddresses: ['bad'] }), 'live'));
  validate(config({ maxPerRun: 0 }), 'live');
  assert.throws(() => validate(config({ maxPerRun: -1 }), 'live'));
  assert.throws(() => validate(config({ watchTrx: false, watchUsdt: false })));
  const c = normalize({ clearSecrets: ['privateKey'] }, config()); validate(c, 'simulate'); assert.throws(() => validate(c, 'live'));
});
test('wallet-free simulation supplies a public caller for constant RPC calls without a signer', async () => {
  const c = normalize({ clearSecrets: ['privateKey'] }, config()); const chain = new Chain(c);
  assert.equal(chain.wallet, ''); assert.equal(chain.tron.defaultAddress.base58, c.tokenContract);
  assert.ok(!chain.tron.defaultPrivateKey); assert.equal(await chain.resources(), null);
});
test('TRX threshold inclusive and recipient always actual transaction recipient', () => {
  const rows = decodeCandidates(trxBlock(), config()); assert.equal(rows.length, 1); assert.equal(rows[0].to, address(3));
  assert.equal(decodeCandidates(trxBlock(), config({ minTrx: '150.000001' })).length, 0);
});
test('USDT ABI decode preserves 41 network prefix and amount precision', () => {
  const rows = decodeCandidates(usdtBlock(), config()); assert.equal(rows[0].to, address(3)); assert.equal(rows[0].amount, '50');
});
test('failed transactions, malformed ABI and wrong tokens cannot trigger', () => {
  const block = usdtBlock(); block.transactions[0].ret[0].contractRet = 'REVERT'; assert.deepEqual(decodeCandidates(block, config()), []);
  block.transactions[0].ret[0].contractRet = 'SUCCESS'; block.transactions[0].raw_data.contract[0].parameter.value.data += '00'; assert.deepEqual(decodeCandidates(block, config()), []);
  assert.deepEqual(decodeCandidates(usdtBlock(), config({ usdtContract: address(8) })), []);
});
test('unsafe JSON amounts and missing success markers cannot trigger', () => {
  const block = trxBlock(); block.transactions[0].raw_data.contract[0].parameter.value.amount = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(decodeCandidates(block, config()).length, 0);
  delete block.transactions[0].ret; assert.equal(decodeCandidates(block, config()).length, 0);
});
test('request queue recovers after failure instead of remaining rejected', async () => {
  const q = new RequestQueue(0); await assert.rejects(q.run(() => { throw new Error('offline'); })); assert.equal(await q.run(() => 42), 42);
});
test('broadcast requests are never automatically retried on 429', async () => {
  const q = new RequestQueue(0); let count = 0;
  await assert.rejects(q.run(() => { count++; throw { response: { status: 429 } }; }, false)); assert.equal(count, 1);
});
test('receipts must match token, sender, recipient and exact amount', () => {
  const r = receipt(address(9), address(1), address(3), '168000000000000000000');
  assert.ok(transferEvents(r, address(9), address(1), address(3), '168000000000000000000'));
  assert.ok(!transferEvents(r, address(8), address(1), address(3), '168000000000000000000'));
  assert.ok(!transferEvents(r, address(9), address(1), address(4), '168000000000000000000'));
  assert.ok(!transferEvents(r, address(9), address(1), address(3), '167000000000000000000'));
});
test('same address with multiple triggers is queued once, simulation separate from live', t => {
  const { store, c } = fixture(t); const candidate = decodeCandidates(trxBlock(), c)[0];
  assert.ok(store.offer('simulate', candidate, c, 11)); assert.ok(!store.offer('simulate', { ...candidate, txid: 'c'.repeat(64) }, c, 11));
  assert.ok(store.offer('live', candidate, c, 11)); assert.equal(store.records().total, 2);
});
test('legacy dedupe applies to both modes', t => {
  const { store, c } = fixture(t); store.db.prepare('INSERT INTO legacy_addresses VALUES(?)').run(address(3));
  const candidate = decodeCandidates(trxBlock(), c)[0]; assert.ok(!store.offer('live', candidate, c, 11)); assert.ok(!store.offer('simulate', candidate, c, 11));
});
test('queue and cursor roll back together on a persistence error', t => {
  const { store, c } = fixture(t);
  assert.throws(() => store.transaction(() => { store.offer('live', decodeCandidates(trxBlock(), c)[0], c, 11); store.setMeta('cursor', 11); throw new Error('disk'); }));
  assert.equal(store.records().total, 0); assert.equal(store.getMeta('cursor'), null);
});
test('full simulated run reaches cap without signing or broadcasting', async t => {
  const { engine, chain, store } = fixture(t); await engine.start('simulate'); await engine.loopPromise;
  assert.equal(engine.state, 'stopped'); assert.equal(chain.signed, 0); assert.equal(chain.broadcasts, 0); assert.equal(store.records().items[0].status, 'simulated');
});
test('full mocked live run persists txid before broadcast, confirms actual receipt', async t => {
  const { engine, chain, store } = fixture(t);
  chain.broadcast = async () => { assert.equal(store.pending()[0].txid, 'b'.repeat(64)); assert.equal(store.pending()[0].status, 'prepared'); chain.broadcasts++; return { result: true }; };
  await engine.start('live'); await engine.loopPromise;
  assert.equal(chain.broadcasts, 1); assert.equal(store.records().items[0].status, 'confirmed'); assert.equal(engine.metrics.sent, 1);
});
test('lost broadcast response is reconciled before replaying and does not stop successful delivery', async t => {
  const { engine, chain, store } = fixture(t);
  chain.broadcast = async () => { chain.broadcasts++; throw new Error('network lost'); };
  await engine.start('live'); await engine.loopPromise;
  assert.equal(engine.state, 'stopped'); assert.equal(store.records().items[0].status, 'confirmed');
  assert.equal(chain.broadcasts, 1); assert.equal(engine.metrics.sent, 1);
});
test('one final failure uses its three retries and remains a per-recipient failure', async t => {
  const { engine, chain, store, c } = fixture(t);
  engine.loop = async () => {}; await engine.start('live');
  store.offer('live', decodeCandidates(trxBlock(), c)[0], c, 11);
  chain.receipt = async id => ({ id, receipt: { result: 'OUT_OF_ENERGY' } });
  await engine.sendNext();
  assert.equal(engine.metrics.sent, 0); assert.equal(engine.running, true);
  assert.equal(chain.broadcasts, 4); assert.equal(engine.failureStreak(), 1);
  assert.equal(store.records().items[0].status, 'failed');
});
test('successful receipt without matching transfer remains uncertain', async t => {
  const { engine, chain, store } = fixture(t); chain.receipt = async id => ({ id, receipt: { result: 'SUCCESS' }, log: [] });
  await engine.start('live'); await engine.loopPromise; assert.equal(store.records().items[0].status, 'uncertain'); assert.equal(engine.metrics.sent, 0);
});
test('pause during resource lookup prevents signing and broadcasting', async t => {
  const { engine, chain } = fixture(t); const checked = await chain.preflight();
  const original = chain.resources.bind(chain); chain.resources = async () => { engine.stop(); return original(); };
  await engine.start('live', checked); await engine.loopPromise; assert.equal(chain.signed, 0); assert.equal(chain.broadcasts, 0);
});
test('pause after signing prevents broadcasting', async t => {
  const { engine, chain } = fixture(t); const original = chain.buildAndSign.bind(chain);
  chain.buildAndSign = async (...args) => { const result = await original(...args); engine.stop(); return result; };
  await engine.start('live'); await engine.loopPromise; assert.equal(chain.signed, 1); assert.equal(chain.broadcasts, 0);
});
test('failed block read does not advance the stored scan cursor', async t => {
  const { engine, store, c, chain } = fixture(t); engine.config = c; engine.chain = chain; engine.running = true; engine.mode = 'simulate'; engine.cursorKey = fingerprint(c, 'simulate');
  chain.block = async () => { throw new Error('offline'); }; await assert.rejects(engine.scanOne(11)); assert.equal(store.getMeta(engine.cursorKey), null); engine.running = false;
});
test('blacklist prevents queued recipients from being sent after configuration change', async t => {
  const { engine, store, c, chain } = fixture(t); store.offer('live', decodeCandidates(trxBlock(), c)[0], c, 11); c.blacklist = [address(3)];
  engine.config = c; engine.chain = chain; engine.running = true; engine.mode = 'live'; await engine.sendNext(); engine.running = false;
  assert.equal(store.records().items[0].status, 'skipped'); assert.equal(chain.signed, 0);
});
test('insufficient energy or token balance prevents starting a real run', async t => {
  const { engine, chain } = fixture(t); const checked = await chain.preflight(); checked.resources.energy = 0;
  await assert.rejects(engine.start('live', checked), /能量/); assert.equal(chain.broadcasts, 0);
  checked.resources.energy = 999999; checked.token.rawBalance = '0'; await assert.rejects(engine.start('live', checked), /余额/);
});
test('pending transaction survives database close and reopen', t => {
  const { store, c, directory } = fixture(t); store.offer('live', decodeCandidates(trxBlock(), c)[0], c, 11); const row = store.next('live'); store.update(row.id, 'prepared', { txid: 'b'.repeat(64) });
  const second = new Store(directory); assert.equal(second.pending()[0].txid, 'b'.repeat(64)); second.close();
});
test('buildAndSign refuses modified RPC transaction before touching private key', async () => {
  const chain = new Chain(config()); chain.request = async fn => fn(); let signed = false;
  chain.tron.transactionBuilder.triggerSmartContract = async () => ({ result: { result: true }, transaction: { raw_data: { contract: [] } } });
  chain.tron.trx.sign = async () => { signed = true; };
  await assert.rejects(chain.buildAndSign({ amount: '168', token: address(9), address: address(3) }, 18), /不一致/); assert.equal(signed, false);
});
test('scanner keeps progressing while sender awaits receipt; pause keeps settings locked until settled', async t => {
  const { engine, chain } = fixture(t); let receiptEntered, releaseReceipt, scannedNext;
  const entered = new Promise(r => { receiptEntered = r; });
  const gate = new Promise(r => { releaseReceipt = r; });
  const scanned = new Promise(r => { scannedNext = r; });
  const oldReceipt = chain.receipt.bind(chain), oldBlock = chain.block.bind(chain);
  chain.receipt = async id => { receiptEntered(); await gate; return oldReceipt(id); };
  chain.block = async h => { if (h === 12) scannedNext(); return oldBlock(h); };
  await engine.start('live'); await entered; chain.headValue = 12; engine.wakeAll(); await scanned;
  engine.stop(); assert.equal(engine.busy, true); assert.equal(engine.state, 'stopping');
  releaseReceipt(); await engine.loopPromise; assert.equal(engine.busy, false); assert.equal(engine.metrics.sent, 1);
});
