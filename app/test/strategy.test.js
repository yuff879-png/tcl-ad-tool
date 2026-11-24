'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { Chain } = require('../src/chain');
const { DEFAULTS, normalize, validate, fingerprint } = require('../src/config');
const { config, address, trxBlock, FakeChain } = require('./fixtures');

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-strategy-'));
  const c = config(extra), store = new Store(dir), chain = new FakeChain(c);
  const engine = new Engine(store, () => c, () => chain, { executionWaitMs: 0, retryDelayMs: 0 });
  t.after(async () => { await engine.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const offer = (n, mode = 'live') => {
    const candidate = { to: address(n), txid: n.toString(16).padStart(64, '0'), asset: 'TRX', amount: '150' };
    assert.ok(store.offer(mode, candidate, c, 9));
    return store.db.prepare('SELECT * FROM deliveries WHERE mode=? AND source_tx=?').get(mode, candidate.txid);
  };
  return { dir, c, store, chain, engine, offer };
}

test('new settings default to unlimited, latest block and skipping unsent work', () => {
  const c = normalize({});
  assert.equal(c.maxPerRun, 0); assert.equal(c.restartScanMode, 'latest'); assert.equal(c.unfinishedPolicy, 'skip');
  assert.equal(DEFAULTS.maxPerRun, 0);
  validate(config({ maxPerRun: 0 })); validate(config({ maxPerRun: 1 }));
  for (const maxPerRun of [-1, 1.5, 100001, Infinity]) assert.throws(() => validate(config({ maxPerRun })));
  for (const extra of [{ restartScanMode: 'bad' }, { unfinishedPolicy: 'bad' }]) assert.throws(() => validate(config(extra)));
});

test('latest start reads the head at START, ignores a saved cursor and never drops confirmed work', async t => {
  const { c, store, chain, engine, offer } = fixture(t, { maxCatchUpBlocks: 1 });
  const old = offer(3), confirmed = offer(4), simulated = offer(5, 'simulate');
  store.update(confirmed.id, 'confirmed', { txid: 'a'.repeat(64) });
  store.setMeta('cursor:' + fingerprint(c, 'live'), 1);
  chain.head = async () => 500;
  // Isolate the atomic startup policy from the independent scan/send workers.
  engine.loop = async () => {};
  await engine.start('live', { ...await chain.preflight(), height: 10 });
  assert.equal(engine.height, 500); assert.equal(store.getMeta('cursor:' + fingerprint(c, 'live')), 500);
  const row = store.records().items.find(r => r.id === old.id);
  assert.equal(row.status, 'skipped_restart'); assert.ok(row.dedupe_cleared_at);
  assert.equal(store.hasRecipient('live', old.address, old.source_tx), true);
  assert.equal(store.hasRecipient('live', old.address, 'future-new-trigger'), false);
  assert.equal(store.records().items.find(r => r.id === confirmed.id).status, 'confirmed');
  assert.equal(store.records().items.find(r => r.id === simulated.id).status, 'queued');
  assert.equal(chain.broadcasts, 0);
});

test('resume and resend keep the exact old cursor and queue', async t => {
  const { c, store, chain, engine, offer } = fixture(t, { restartScanMode: 'resume', unfinishedPolicy: 'resend' });
  const old = offer(3); store.setMeta('cursor:' + fingerprint(c, 'live'), 7); chain.head = async () => 12;
  engine.loop = async () => {}; await engine.start('live');
  assert.equal(engine.height, 7); assert.equal(store.next('live').id, old.id);
  assert.equal(store.records().items[0].dedupe_cleared_at, null);
});

test('resume and skip affect the cursor and old waiting addresses independently', async t => {
  const { c, store, chain, engine, offer } = fixture(t, { restartScanMode: 'resume' });
  offer(3); store.setMeta('cursor:' + fingerprint(c, 'live'), 7); chain.head = async () => 12;
  engine.loop = async () => {}; await engine.start('live');
  assert.equal(engine.height, 7); assert.equal(store.next('live'), undefined);
  assert.equal(store.records().items[0].status, 'skipped_restart');
});

test('latest and resend skip offline blocks but keep waiting addresses', async t => {
  const { c, store, chain, engine, offer } = fixture(t, { unfinishedPolicy: 'resend' });
  const old = offer(3); store.setMeta('cursor:' + fingerprint(c, 'live'), 7); chain.head = async () => 12;
  engine.loop = async () => {}; await engine.start('live');
  assert.equal(engine.height, 12); assert.equal(store.next('live').id, old.id);
});

test('a failed start leaves old waiting work and the cursor intact', async t => {
  const { c, store, chain, engine, offer } = fixture(t);
  const old = offer(3); store.setMeta('cursor:' + fingerprint(c, 'live'), 7);
  const checked = await chain.preflight(); checked.resources.energy = 0;
  await assert.rejects(engine.start('live', checked), /能量/);
  assert.equal(store.next('live').id, old.id); assert.equal(store.getMeta('cursor:' + fingerprint(c, 'live')), 7);
});

test('resending validates EVERY old queued amount before sending or changing progress', async t => {
  const { c, store, engine, offer } = fixture(t, { unfinishedPolicy: 'resend' });
  offer(3); const second = offer(4); store.db.prepare('UPDATE deliveries SET amount=? WHERE id=?').run('999', second.id);
  store.setMeta('cursor:' + fingerprint(c, 'live'), 7);
  await assert.rejects(engine.start('live'), /旧节点、合约或金额/);
  assert.equal(store.getMeta('cursor:' + fingerprint(c, 'live')), 7); assert.equal(store.queued('live').length, 2);
});

test('unlimited is not treated as a zero-address cap', async t => {
  const { store, chain, engine, offer } = fixture(t, { maxPerRun: 0, unfinishedPolicy: 'resend', sendIntervalSeconds: 1 });
  for (const n of [3, 4, 5]) offer(n, 'simulate');
  chain.block = async h => ({ block_header: { raw_data: { number: h } }, transactions: [] });
  const update = store.update.bind(store); let processed = 0;
  store.update = (...args) => { update(...args); if (args[1] === 'simulated' && ++processed === 3) engine.stop(); };
  await engine.start('simulate'); await engine.loopPromise;
  assert.equal(engine.metrics.simulated, 3); assert.equal(chain.broadcasts, 0);
});

test('second send follows execution success and the interval without waiting for finality', async t => {
  const { store, chain, engine } = fixture(t, { maxPerRun: 2, sendIntervalSeconds: 1 });
  const originalBlock = chain.block.bind(chain);
  chain.block = async h => { const b = await originalBlock(h); b.transactions.push(trxBlock(h, address(4), 'c'.repeat(64)).transactions[0]); return b; };
  const execution = chain.receipt.bind(chain); const times = [], executedAt = [];
  chain.broadcast = async () => { chain.broadcasts++; times.push(Date.now()); return { result: true }; };
  chain.executionReceipt = async id => { const info = await execution(id); executedAt.push(Date.now()); return info; };
  chain.receipt = async () => ({});
  await engine.start('live'); await engine.loopPromise;
  assert.equal(chain.broadcasts, 2); assert.equal(engine.metrics.sent, 2);
  assert.equal(store.pending().length, 2); assert.ok(store.pending().every(r => r.status === 'executed'));
  assert.ok(times[1] - executedAt[0] >= 990, 'Send interval must begin AFTER execution success');
  chain.receipt = execution; await engine.confirmExecuted();
  assert.equal(store.pending().length, 0); assert.ok(store.records().items.every(r => r.status === 'confirmed'));
  assert.equal(chain.broadcasts, 2);
});

test('explicit rejection is checked then replayed within the three-retry budget', async t => {
  const { store, chain, engine, offer } = fixture(t); let receipts = 0;
  engine.loop = async () => {}; await engine.start('live'); offer(3);
  chain.broadcast = async () => { chain.broadcasts++; return { result: false, code: 'CONTRACT_VALIDATE_ERROR' }; };
  chain.receipt = async () => { receipts++; return {}; };
  await engine.sendNext();
  assert.equal(engine.running, true); assert.equal(chain.broadcasts, 4); assert.ok(receipts > 0);
  assert.equal(engine.metrics.sent, 0); assert.equal(store.pending()[0].status, 'uncertain');
  assert.match(store.pending()[0].detail, /CONTRACT_VALIDATE_ERROR/);
});

test('unfinalized execution failure waits for finality without blocking a later recipient', async t => {
  const { store, chain, engine, offer } = fixture(t);
  engine.loop = async () => {}; await engine.start('live');
  const first = offer(3); offer(4);
  chain.executionReceipt = async id => ({ id, receipt: { result: 'OUT_OF_ENERGY' } });
  chain.receipt = async () => ({});
  await engine.sendNext(); assert.equal(chain.broadcasts, 1);
  assert.equal(store.get(first.id).status, 'uncertain'); assert.equal(engine.running, true);
  await engine.sendNext(); assert.equal(chain.broadcasts, 2); assert.equal(engine.metrics.sent, 0);
});

test('final failure after execution success is retained for retry without stopping other work', async t => {
  const { store, chain, engine } = fixture(t);
  const execution = chain.receipt.bind(chain); chain.executionReceipt = execution; chain.receipt = async () => ({});
  await engine.start('live'); await engine.loopPromise;
  const row = store.pending()[0]; assert.equal(row.status, 'executed');
  chain.receipt = async () => { throw new Error('temporary offline'); };
  await engine.confirmExecuted(); assert.equal(store.pending()[0].status, 'executed');
  assert.equal(engine.state, 'stopped');
  chain.receipt = async id => ({ id, receipt: { result: 'REVERT' } });
  await engine.confirmExecuted();
  assert.equal(engine.state, 'stopped'); assert.equal(store.records().items[0].status, 'uncertain');
  assert.equal(engine.metrics.sent, 0); assert.equal(chain.broadcasts, 1);
});

test('restart never abandons or re-broadcasts an already executed transaction', async t => {
  const { dir, c, store, chain, engine } = fixture(t);
  const execution = chain.receipt.bind(chain); chain.executionReceipt = execution; chain.receipt = async () => ({});
  await engine.start('live'); await engine.loopPromise; await engine.close();
  const before = store.pending()[0]; const reopened = new Store(dir);
  const nextChain = new FakeChain(c); nextChain.receipt = async () => ({});
  const next = new Engine(reopened, () => c, () => nextChain);
  try {
    next.loop = async () => {}; await next.start('live');
    assert.equal(reopened.pending()[0].txid, before.txid); assert.equal(reopened.pending()[0].status, 'executed');
    assert.equal(nextChain.broadcasts, 0);
    nextChain.receipt = execution; await next.confirmExecuted(); assert.equal(reopened.pending().length, 0);
    assert.equal(nextChain.broadcasts, 0);
  } finally { await next.close(); reopened.close(); }
});

test('polling head jumps and transient block failures are scanned in exact height order', async t => {
  const { c, chain, store, engine } = fixture(t);
  engine.config = c; engine.chain = chain; engine.mode = 'simulate'; engine.height = 10;
  engine.cursorKey = 'cursor:' + fingerprint(c, 'simulate'); engine.running = true;
  chain.head = async () => 14; const heights = []; let failed = false;
  chain.block = async h => {
    heights.push(h);
    if (h === 12 && !failed) { failed = true; throw new Error('transient'); }
    return { block_header: { raw_data: { number: h } }, transactions: [] };
  };
  engine.wait = async () => {};
  const scan = engine.scanOne.bind(engine);
  engine.scanOne = async h => { const result = await scan(h); if (h === 14) engine.running = false; return result; };
  await engine.scanLoop();
  assert.deepEqual(heights, [11, 12, 12, 13, 14]); assert.equal(store.getMeta(engine.cursorKey), 14);
});

test('fast receipt uses the full node and final receipt uses the solidity node', async () => {
  const chain = new Chain(config()); const calls = [];
  chain.request = async fn => fn();
  chain.tron.fullNode.request = async (...args) => { calls.push(['full', ...args]); return {}; };
  chain.tron.solidityNode.request = async (...args) => { calls.push(['solid', ...args]); return {}; };
  await chain.executionReceipt('a'.repeat(64)); await chain.receipt('a'.repeat(64));
  assert.equal(calls[0][1], 'wallet/gettransactioninfobyid'); assert.equal(calls[1][1], 'walletsolidity/gettransactioninfobyid');
});

test('per-send checks query fresh resources and balance without re-reading metadata', async t => {
  const { chain, engine } = fixture(t); let metadata = 0, balances = 0;
  const token = chain.tokenInfo.bind(chain);
  chain.tokenInfo = async () => { metadata++; return token(); };
  chain.tokenBalance = async () => { balances++; return '1000000000000000000000000'; };
  await engine.start('live'); await engine.loopPromise;
  assert.equal(metadata, 1); assert.equal(balances, 1); assert.equal(chain.broadcasts, 1);
});
