'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { Chain, checkedTransactionExpiration } = require('../src/chain');
const { nodeReason, LEGACY_EXPIRATION_MS, FINALITY_MARGIN_MS } = require('../src/delivery-retry');
const { queryStatistics } = require('../src/statistics');
const { config, address, FakeChain, receipt } = require('./fixtures');
const { TronWeb, utils } = require('tronweb');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-retry-'));
  const c = config({ maxPerRun: 0 }), store = new Store(dir), chain = new FakeChain(c);
  const engine = new Engine(store, () => c, () => chain, { executionWaitMs: 0, retryDelayMs: 0 });
  t.after(async () => { await engine.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  engine.loop = async () => {}; await engine.start('live');
  const offer = n => { store.offer('live', { to: address(n), txid: n.toString(16).padStart(64, 'a'), asset: 'TRX', amount: '150' }, c, 11); return store.queued('live').at(-1); };
  const missing = () => { chain.receipt = chain.executionReceipt = async () => ({}); };
  return { dir, c, store, chain, engine, offer, missing };
}
test('missing receipts replay the same payload at most three times after initial send', async t => {
  const { store, chain, engine, offer, missing } = await fixture(t);
  const row = offer(3); missing(); const payloads = [];
  chain.broadcast = async signed => { payloads.push(JSON.stringify(signed)); return { result: false, code: 'SERVER_BUSY', message: Buffer.from('try later').toString('hex') }; };
  await engine.sendNext();
  assert.equal(payloads.length, 4); assert.equal(new Set(payloads).size, 1); assert.equal(chain.signed, 1);
  assert.equal(store.retryInfo(store.get(row.id)).attempts, 4); assert.equal(store.retryInfo(store.get(row.id)).exhausted, 1);
  assert.equal(engine.failureStreak(), 1); assert.equal(engine.running, true);
  assert.match(store.get(row.id).detail, /SERVER_BUSY.*try later/);
  assert.equal(store.nextRetry(engine.config, chain.wallet), undefined);
  assert.ok(!JSON.stringify(store.records()).includes('signed_json'));
  assert.ok(!JSON.stringify(store.records()).includes('raw_data'));
});
test('a receipt arriving before replay prevents a duplicate send', async t => {
  const { chain, engine, offer } = await fixture(t); offer(3);
  const success = chain.receipt.bind(chain); let reads = 0;
  chain.executionReceipt = async id => ++reads === 1 ? {} : success(id);
  chain.receipt = async id => reads >= 1 ? success(id) : {};
  chain.broadcast = async () => { chain.broadcasts++; throw new Error('lost response'); };
  await engine.sendNext(); assert.equal(chain.broadcasts, 1); assert.equal(chain.signed, 1); assert.equal(engine.metrics.sent, 1);
});
test('a successful third retry stops the retry loop and clears the failure streak', async t => {
  const { chain, engine, offer } = await fixture(t); offer(3);
  const success = chain.receipt.bind(chain);
  chain.receipt = chain.executionReceipt = async id => chain.broadcasts >= 4 ? success(id) : {};
  await engine.sendNext(); assert.equal(chain.broadcasts, 4); assert.equal(chain.signed, 1);
  assert.equal(engine.metrics.sent, 1); assert.equal(engine.failureStreak(), 0);
});
test('only three consecutive failed recipients stop, and a success resets the sequence', async t => {
  const { chain, engine, offer, missing } = await fixture(t);
  const success = chain.receipt.bind(chain); missing();
  for (const n of [3, 4]) { offer(n); await engine.sendNext(); assert.equal(engine.running, true); }
  assert.equal(engine.failureStreak(), 2);
  chain.executionReceipt = success; offer(5); await engine.sendNext(); assert.equal(engine.failureStreak(), 0);
  missing();
  for (const n of [6, 7]) { offer(n); await engine.sendNext(); assert.equal(engine.running, true); }
  offer(8); const untouched = offer(10); await engine.sendNext();
  assert.equal(engine.running, false); assert.equal(engine.state, 'fault');
  assert.match(engine.lastError, /连续 3 笔/); assert.equal(engine.store.get(untouched.id).status, 'queued');
  assert.equal(chain.broadcasts, 21);
});
test('pause after ambiguous broadcast allows read-only checks but never another broadcast', async t => {
  const { store, chain, engine, offer, missing } = await fixture(t); const row = offer(3); missing();
  chain.broadcast = async () => { chain.broadcasts++; engine.stop(); throw new Error('offline'); };
  await engine.sendNext(); await engine.confirmExecuted();
  assert.equal(chain.broadcasts, 1); assert.equal(store.retryInfo(store.get(row.id)).attempts, 1);
  assert.equal(store.get(row.id).status, 'uncertain');
});
test('restart restores exactly the remaining attempts and persisted signed transaction', async t => {
  const { dir, c, store, chain, engine, offer, missing } = await fixture(t); const row = offer(3); missing();
  chain.broadcast = async () => { chain.broadcasts++; if (chain.broadcasts === 2) engine.stop(); return { result: false }; };
  await engine.sendNext(); await engine.close();
  const before = store.get(row.id); assert.equal(store.retryInfo(before).attempts, 2);
  const reopened = new Store(dir), second = new FakeChain(c);
  second.receipt = second.executionReceipt = async () => ({});
  const next = new Engine(reopened, () => c, () => second, { executionWaitMs: 0, retryDelayMs: 0 }); next.loop = async () => {};
  try {
    await next.start('live'); await next.sendNext();
    assert.equal(second.broadcasts, 2); assert.equal(second.signed, 0);
    assert.equal(reopened.get(row.id).txid, before.txid); assert.equal(reopened.retryInfo(before).attempts, 4);
    await next.stopAndWait(); next.state = 'stopped'; // This fixture replaces the lifecycle loop with direct calls.
    await next.start('live'); await next.sendNext(); assert.equal(second.broadcasts, 2);
  } finally { await next.close(); reopened.close(); }
});
test('legacy unknown records wait for expiry proof while newer recipients can proceed', async t => {
  const { store, chain, engine, offer, missing } = await fixture(t); const old = offer(3), fresh = offer(4); missing();
  store.update(old.id, 'uncertain', { txid: 'c'.repeat(64), wallet: chain.wallet, raw_amount: '168000000000000000000' });
  const timestamp = Date.parse(store.get(old.id).updated_at);
  await engine.sendNext(); assert.equal(chain.broadcasts, 0);
  assert.equal(store.attempt('c'.repeat(64)).expiration, timestamp + LEGACY_EXPIRATION_MS);
  chain.executionReceipt = id => FakeChain.prototype.receipt.call(chain, id);
  await engine.sendNext(); assert.equal(chain.broadcasts, 1); assert.equal(store.get(fresh.id).status, 'executed');
  chain.replacementReady = async () => true;
  store.deferRetry(store.get(old.id), 0);
  const success = chain.executionReceipt;
  chain.executionReceipt = id => id === 'c'.repeat(64) ? {} : success(id);
  await engine.sendNext(); assert.equal(chain.broadcasts, 2); assert.equal(store.retryInfo(store.get(old.id)).attempts, 2);
  assert.equal(store.attempt('c'.repeat(64)).status, 'expired');
});
test('late final confirmation recovers an exhausted unknown record without sending again', async t => {
  const { chain, store, engine, offer, missing } = await fixture(t); const row = offer(3), success = chain.receipt.bind(chain); missing();
  await engine.sendNext(); assert.equal(engine.failureStreak(), 1);
  engine.stop(); chain.receipt = success; await engine.confirmExecuted();
  assert.equal(store.get(row.id).status, 'confirmed'); assert.equal(engine.failureStreak(), 0); assert.equal(chain.broadcasts, 4);
});
test('confirmed failed attempt costs survive replacement and successful quantity is counted once', async t => {
  const { store, chain, engine, offer } = await fixture(t); const row = offer(3), at = Date.now();
  chain.receipt = async id => chain.transfers.size === 1 ? { id, blockTimeStamp: at, receipt: { result: 'REVERT', energy_usage_total: 50 }, fee: 1000000 }
    : { ...receipt(engine.config.tokenContract, chain.wallet, row.address, '168000000000000000000', id), blockTimeStamp: at, receipt: { result: 'SUCCESS', energy_usage_total: 100 }, fee: 2000000 };
  await engine.sendNext(); await engine.confirmExecuted();
  assert.equal(chain.broadcasts, 2); assert.equal(chain.signed, 2);
  const result = queryStatistics(store.db, { period: 'all' });
  assert.equal(result.totals.count, 1); assert.equal(result.totals.otherCount, 1);
  assert.equal(result.totals.energy, '150'); assert.equal(result.totals.feeTrx, '3'); assert.equal(result.totals.amounts[0].amount, '168');
});
test('replacement requires confirmed time beyond expiry plus four empty transaction lookups', async () => {
  const chain = new Chain(config()); chain.request = fn => fn(); const expiration = Date.now() - 120000; let reads = 0;
  chain.tron.trx.getConfirmedCurrentBlock = async () => ({ block_header: { raw_data: { number: 123, timestamp: expiration + FINALITY_MARGIN_MS } } });
  chain.tron.fullNode.request = chain.tron.solidityNode.request = async () => { reads++; return {}; };
  assert.equal(await chain.replacementReady('a'.repeat(64), expiration), false); assert.equal(reads, 0);
  chain.tron.trx.getConfirmedCurrentBlock = async () => ({ block_header: { raw_data: { number: 123, timestamp: expiration + FINALITY_MARGIN_MS + 1 } } });
  assert.equal(await chain.replacementReady('a'.repeat(64), expiration), true); assert.equal(reads, 4);
  chain.tron.fullNode.request = async () => ({ Error: 'busy' });
  assert.equal(await chain.replacementReady('a'.repeat(64), expiration), false);
  chain.tron.fullNode.request = async () => { throw new Error('HTTP 429'); };
  await assert.rejects(chain.replacementReady('a'.repeat(64), expiration), /429/);
});
test('replacement rejects stale or future watermarks and malformed transaction identities', async () => {
  const chain = new Chain(config()); chain.request = fn => fn(); let reads = 0;
  chain.tron.fullNode.request = chain.tron.solidityNode.request = async () => { reads++; return {}; };
  const expiration = Date.now() - 600000;
  for (const raw of [{ number: 123, timestamp: Date.now() - 300001 }, { number: 123, timestamp: Date.now() + 30000 },
    { timestamp: Date.now() }, { number: 0, timestamp: Date.now() }, { number: 123, timestamp: '123' }]) {
    chain.tron.trx.getConfirmedCurrentBlock = async () => ({ block_header: { raw_data: raw } });
    assert.equal(await chain.replacementReady('a'.repeat(64), expiration), false);
  }
  assert.equal(await chain.replacementReady('invalid', expiration), false);
  assert.equal(await chain.replacementReady('a'.repeat(64), 0), false);
  assert.equal(await chain.replacementReady('a'.repeat(64), null), false);
  assert.equal(reads, 0);
});

function expiryTransaction() {
  const timestamp = Date.now() - 120000;
  const tx = { visible: false, raw_data: { timestamp, expiration: timestamp + 60000,
    ref_block_bytes: '1234', ref_block_hash: '1234567890abcdef', fee_limit: 10000000,
    contract: [{ type: 'TriggerSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: {
      owner_address: TronWeb.address.toHex(address(1)), contract_address: TronWeb.address.toHex(address(9)),
      data: 'a9059cbb' + TronWeb.address.toHex(address(3)).slice(2).padStart(64, '0') + '1'.padStart(64, '0')
    } } }] } };
  const pb = utils.transaction.txJsonToPb(tx);
  tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb);
  tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  tx.ret = [{ contractRet: 'SUCCESS' }];
  return tx;
}
test('transaction expiration is bound to hash and raw bytes for saved or node transactions', async () => {
  const chain = new Chain(config()); chain.request = fn => fn(); const tx = expiryTransaction();
  assert.equal(checkedTransactionExpiration(tx.txID, tx), tx.raw_data.expiration);
  chain.tron.fullNode.request = chain.tron.solidityNode.request = async () => structuredClone(tx);
  assert.deepEqual(await chain.transactionExpiration(tx.txID), { expiration: tx.raw_data.expiration, source: 'chain',
    execution_results: { full: 'SUCCESS', confirmed: 'SUCCESS' } });
  chain.tron.fullNode.request = async () => ({});
  assert.deepEqual(await chain.transactionExpiration(tx.txID), { expiration: tx.raw_data.expiration, source: 'chain',
    execution_results: { full: null, confirmed: 'SUCCESS' } });
  chain.tron.solidityNode.request = async () => ({});
  assert.equal(await chain.transactionExpiration(tx.txID), null);
  for (const bad of [{ Error: 'busy' }, { code: 'SERVER_BUSY' }, null, [], { ...tx, txID: 'a'.repeat(64) },
    { ...tx, raw_data: { ...tx.raw_data, expiration: tx.raw_data.expiration + 1 } },
    { ...tx, raw_data: { ...tx.raw_data, expiration: null } }, { ...tx, raw_data_hex: 'aa' }, { ...tx, ret: [] },
    { ...tx, ret: [{ contractRet: null }] }]) {
    chain.tron.fullNode.request = async () => bad;
    await assert.rejects(chain.transactionExpiration(tx.txID));
  }
  chain.tron.fullNode.request = async () => structuredClone(tx);
  chain.tron.solidityNode.request = async () => ({ ...tx, raw_data: { ...tx.raw_data, expiration: tx.raw_data.expiration + 1 } });
  await assert.rejects(chain.transactionExpiration(tx.txID), error => error.observed_execution_results.full === 'SUCCESS' && error.transaction_found);
  chain.tron.solidityNode.request = async () => { throw new Error('timeout'); };
  await assert.rejects(chain.transactionExpiration(tx.txID), error => error.observed_execution_results.full === 'SUCCESS' && error.transaction_found);
  await assert.rejects(chain.transactionExpiration('invalid'));
});
test('malformed receipts are neither successful nor proof of an on-chain failure', async t => {
  const { engine, chain, store, offer } = await fixture(t); const row = offer(3);
  const prepared = await chain.buildAndSign(row, 18); store.retryInfo(row); store.prepareAttempt(row, prepared); store.beginAttempt(store.get(row.id));
  chain.receipt = async id => ({ id });
  await assert.rejects(engine.settle(store.get(row.id), false, true), /不完整/);
  assert.equal(store.attempt(prepared.txid).status, 'prepared');
});
test('concurrent background confirmation reserves a row so the sender cannot replace it', async t => {
  const { chain, store, engine, offer } = await fixture(t); const old = offer(3), fresh = offer(4);
  store.update(old.id, 'uncertain', { txid: 'c'.repeat(64), wallet: chain.wallet, raw_amount: '168000000000000000000' });
  let release, entered; const ready = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; });
  chain.receipt = async () => { entered(); await gate; return {}; };
  const confirming = engine.confirmExecuted(); await ready;
  chain.executionReceipt = id => FakeChain.prototype.receipt.call(chain, id);
  try { await engine.sendNext(); assert.equal(store.get(fresh.id).status, 'executed'); assert.equal(chain.broadcasts, 1); }
  finally { release(); await confirming; }
});
test('node diagnostics preserve code and decode hex messages', () => {
  assert.equal(nodeReason({ code: 'SERVER_BUSY', message: Buffer.from('queue is full').toString('hex') }), 'SERVER_BUSY · queue is full');
  assert.equal(nodeReason({ response: { status: 429, data: { Error: 'limit' } } }), 'HTTP 429 · limit');
});
test('saved retry signatures validate the original hash and exact recipient, token and amount offline', async () => {
  // A fixed test key and synthetic block references; no RPC or broadcast.
  const c = config(), chain = new Chain(c), rawAmount = '168000000000000000000';
  const row = { address: address(3), token: c.tokenContract, raw_amount: rawAmount, wallet: chain.wallet };
  const expiration = Date.now() + 60000;
  const tx = { visible: false, raw_data: { ref_block_bytes: '1234', ref_block_hash: '1234567890abcdef', timestamp: Date.now(), expiration,
    fee_limit: Number(c.feeLimitTrx) * 1000000,
    contract: [{ type: 'TriggerSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: {
      owner_address: TronWeb.address.toHex(chain.wallet), contract_address: TronWeb.address.toHex(row.token),
      data: 'a9059cbb' + TronWeb.address.toHex(row.address).slice(2).padStart(64, '0') + BigInt(rawAmount).toString(16).padStart(64, '0')
    } } }] } };
  const protobuf = utils.transaction.txJsonToPb(tx);
  tx.raw_data_hex = utils.transaction.txPbToRawDataHex(protobuf);
  tx.txID = utils.transaction.txPbToTxID(protobuf).replace(/^0x/, '');
  const signed = await chain.tron.trx.sign(tx, c.privateKey); row.txid = signed.txID;
  const attempt = { signed_json: JSON.stringify(signed), expiration };
  assert.equal(chain.restoreAttempt(row, attempt).txid, row.txid);
  for (const patch of [{ address: address(4) }, { token: address(8) }, { raw_amount: '1' }, { txid: 'a'.repeat(64) }]) {
    assert.throws(() => chain.restoreAttempt({ ...row, ...patch }, attempt), error => error.halt === true);
  }
  const modified = structuredClone(signed); modified.signature[0] = '0'.repeat(130);
  assert.throws(() => chain.restoreAttempt(row, { ...attempt, signed_json: JSON.stringify(modified) }), error => error.halt === true);
});
test('scanner retries more than five temporary failures without skipping a height or stopping delivery', async t => {
  const { chain, engine, store } = await fixture(t); let reads = 0;
  engine.height = 10; engine.headHeight = 11; chain.head = async () => 11;
  chain.block = async h => { assert.equal(h, 11); if (++reads <= 6) throw new Error('temporary node error'); engine.stop(); return { transactions: [] }; };
  engine.wait = async () => {};
  await engine.scanLoop(); assert.equal(reads, 7); assert.equal(engine.failure, null);
  assert.equal(engine.height, 10); assert.equal(store.getMeta(engine.cursorKey), 10);
});
