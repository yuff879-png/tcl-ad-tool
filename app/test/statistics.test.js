'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { StatisticsService } = require('../src/statistics-service');
const { receiptMetrics, statisticsOptions, queryStatistics, statisticsCsv } = require('../src/statistics');
const { createApp } = require('../src/server');
const { config, address, FakeChain, receipt } = require('./fixtures');
const { atomicJson } = require('../src/config');
const NOW = Date.parse('2026-11-13T12:00:00Z');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-statistics-')), store = new Store(dir), c = config();
  const chain = new FakeChain(c), engine = new Engine(store, () => c, () => chain);
  let n = 20;
  t.after(async () => { await engine.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  function offer({ mode = 'live', status = 'confirmed', amount = '168', token = c.tokenContract, timestamp = '2026-11-03T12:00:00Z', energy = 65000, fee = 123000, save = true } = {}) {
    n++;
    store.offer(mode, { to: address(n), txid: n.toString(16).padStart(64, '0'), asset: 'TRX', amount: '150' }, { ...c, sendAmount: amount, tokenContract: token }, 10);
    let row = store.next(mode);
    store.update(row.id, status, { txid: n.toString(16).padStart(64, 'a'), wallet: chain.wallet, raw_amount: '168000000000000000000' });
    row = store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(row.id);
    const info = { id: row.txid, receipt: { result: status === 'failed' ? 'REVERT' : 'SUCCESS', energy_usage_total: energy }, blockTimeStamp: timestamp === null ? null : Date.parse(timestamp) };
    if (fee !== undefined) info.fee = fee;
    if (save) store.saveReceipt(row, info);
    return { row, info };
  }
  return { store, c, chain, engine, dir, offer, query: input => queryStatistics(store.db, input, NOW) };
}
test('default calendar range is 15 inclusive days in a fixed timezone, with validated custom dates', () => {
  const o = statisticsOptions({}, NOW); assert.equal(o.start, '2026-10-30'); assert.equal(o.end, '2026-11-13');
  assert.equal(o.timeZone, 'Asia/Shanghai'); assert.equal(o.pageSize, 15);
  assert.equal(statisticsOptions({}, Date.parse('2026-11-12T16:00:00Z')).end, '2026-11-13');
  assert.equal(statisticsOptions({ timeZone: 'UTC' }, Date.parse('2026-11-12T16:00:00Z')).end, '2026-11-12');
  assert.throws(() => statisticsOptions({ timeZone: 'Asia/Yangon' }, NOW), /时区无效/);
  for (const input of [{ period: 'custom', start: '2026-02-30', end: '2026-03-01' }, { period: 'custom', start: '2026-11-13', end: '2026-11-12' }, { period: 'other' }, { timeZone: 'invalid' }, { page: '1.5' }]) assert.throws(() => statisticsOptions(input, NOW));
  assert.equal(statisticsOptions({ period: 'custom', start: '2024-02-29', end: '2024-03-01' }, NOW).start, '2024-02-29');
});
test('daily totals use receipt time, exact decimals, success amounts and real failed transaction costs', t => {
  const { offer, query, c } = fixture(t);
  offer({ amount: '9007199254740993.000000000000000001' });
  offer({ amount: '0.000000000000000009', energy: 1, fee: 1 });
  offer({ status: 'failed', amount: '999', energy: 2000, fee: 2000000 });
  offer({ mode: 'simulate', status: 'simulated' }); offer({ status: 'skipped_restart' });
  const report = query();
  assert.equal(report.totalDays, 1); assert.equal(report.items[0].date, '2026-11-03');
  assert.equal(report.totals.count, 2); assert.equal(report.totals.otherCount, 1);
  assert.deepEqual(report.totals.amounts, [{ token: c.tokenContract, amount: '9007199254740993.00000000000000001' }]);
  assert.equal(report.totals.energy, '67001'); assert.equal(report.totals.feeTrx, '2.123001');
});
test('late confirmation belongs to its original chain day and repeating a receipt never doubles totals', t => {
  const { offer, query, store } = fixture(t);
  const { row, info } = offer({ timestamp: '2026-11-02T15:59:59Z', save: false });
  assert.equal(query().pending.undated, 1); assert.equal(query().totals.count, 0);
  store.saveReceipt(row, info); store.saveReceipt(row, info); store.update(row.id, 'confirmed');
  assert.equal(query().items[0].date, '2026-11-02'); assert.equal(query().totals.count, 1);
  assert.equal(query().totals.energy, '65000');
  offer({ timestamp: '2026-11-02T16:00:00Z' });
  assert.deepEqual(query().items.map(r => r.date), ['2026-11-03', '2026-11-02']);
  assert.equal(query({ timeZone: 'UTC' }).totalDays, 1);
});
test('empty dates are omitted, pagination has 15 rows and every page retains full-range totals', t => {
  const { offer, query } = fixture(t);
  for (let n = 0; n < 34; n++) if (n % 4 !== 0) offer({ timestamp: new Date(NOW - n * 86400000).toISOString() });
  const recent = query(), all = query({ period: 'all' }), second = query({ period: 'all', page: 2 });
  assert.equal(recent.totalDays, 11); assert.equal(recent.pages, 1); assert.equal(recent.items.length, 11);
  assert.equal(all.totalDays, 25); assert.equal(all.items.length, 15); assert.equal(second.items.length, 10);
  assert.deepEqual(all.totals, second.totals); assert.equal(all.totals.count, 25);
  assert.equal(query({ period: 'all', page: 999 }).page, 2);
  const empty = query({ period: 'custom', start: '2025-01-01', end: '2025-01-02' });
  assert.equal(empty.totalDays, 0); assert.equal(empty.totals.count, 0); assert.deepEqual(empty.items, []);
});
test('amounts for distinct tokens remain separate and contract filtering includes only that contract', t => {
  const { offer, query, c } = fixture(t);
  offer({ amount: '168' }); offer({ token: address(10), amount: '99.5' });
  assert.equal(query().totals.amounts.length, 2);
  assert.equal(query({ token: c.tokenContract }).totals.count, 1);
  assert.deepEqual(query({ token: address(10) }).totals.amounts, [{ token: address(10), amount: '99.5' }]);
});
test('missing costs and dates remain visibly incomplete, while protobuf omitted zero fees are accepted', t => {
  const { offer, query, store } = fixture(t);
  const { row, info } = offer({ energy: null, fee: null });
  offer({ timestamp: null }); offer({ status: 'executed', save: false });
  const zero = offer({ energy: 0, fee: 0 }); delete zero.info.fee; assert.equal(store.saveReceipt(zero.row, zero.info), true);
  const result = query(); assert.equal(result.totals.count, 2); assert.equal(result.totals.missingEnergy, 1); assert.equal(result.totals.missingFee, 1);
  assert.equal(result.pending.undated, 1); assert.equal(result.pending.awaitingFinal, 1);
  assert.equal(store.saveReceipt(row, { ...info, id: 'f'.repeat(64) }), false);
  assert.equal(receiptMetrics(row, { ...info, receipt: { result: 'SUCCESS', energy_usage_total: Number.MAX_SAFE_INTEGER + 1 } }).energy, null);
  assert.equal(receiptMetrics(row, { ...info, receipt: { result: 'SUCCESS', energy_usage_total: -1 } }).energy, null);
  assert.equal(receiptMetrics(row, {}), null);
});
test('clearing delivered addresses and reopening the database preserve daily statistics', t => {
  const { offer, query, store, dir } = fixture(t); offer();
  const before = query(); store.clearDeliveredAddresses('live', 'test-backup');
  assert.equal(store.deliveredCounts().live, 0); assert.deepEqual(query().totals, before.totals);
  const reopened = new Store(dir);
  try { assert.deepEqual(queryStatistics(reopened.db, {}, NOW).totals, before.totals); } finally { reopened.close(); }
});
test('CSV exports all selected days, full totals, timezone and missing-data labels', t => {
  const { offer, query } = fixture(t);
  for (let i = 0; i < 20; i++) offer({ timestamp: new Date(NOW - i * 86400000).toISOString() });
  offer({ energy: null, fee: null }); offer({ timestamp: null });
  const exported = query({ period: 'all', page: 2, export: true }), csv = statisticsCsv(exported);
  assert.equal(exported.items.length, 20); assert.match(csv, /所选范围合计","21"/);
  assert.match(csv, /待补齐 1 笔/); assert.match(csv, /北京时间/); assert.match(csv, /日期待补齐（未计入日报，不限日期）","1"/);
});
test('historical backfill skips active work and saves costs without changing transaction status or sending', async t => {
  const { offer, engine, chain, store } = fixture(t);
  const { row, info } = offer({ save: false, status: 'failed' }); let requests = 0;
  chain.receipt = async () => { requests++; return info; };
  for (const state of ['running', 'starting', 'stopping']) { engine.state = state; await engine.backfillStatistics(); }
  assert.equal(requests, 0); engine.state = 'fault'; await engine.backfillStatistics();
  assert.equal(requests, 1); assert.equal(store.records().items[0].status, 'failed');
  assert.equal(store.db.prepare('SELECT energy FROM delivery_receipts WHERE delivery_id=?').get(row.id).energy, '65000');
  assert.equal(chain.signed, 0); assert.equal(chain.broadcasts, 0);
});
test('backfill failures persist retries, allow newer records through and never fault or resend', async t => {
  const { offer, engine, chain, store } = fixture(t);
  const good = offer({ save: false }), bad = offer({ save: false }); let calls = 0;
  chain.receipt = async id => { calls++; if (id === bad.row.txid) throw new Error('offline'); return good.info; };
  await engine.backfillStatistics(); assert.equal(calls, 2); assert.equal(engine.state, 'stopped'); assert.equal(chain.broadcasts, 0);
  const failure = store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(bad.row.id);
  assert.ok(failure.retry_after > Date.now()); assert.equal(failure.attempts, 1);
  assert.equal(store.db.prepare('SELECT energy FROM delivery_receipts WHERE delivery_id=?').get(good.row.id).energy, '65000');
  await engine.backfillStatistics(); assert.equal(calls, 2);
});
test('a stalled historical request does not block starting or sending a new campaign', async t => {
  const { offer, engine, chain } = fixture(t); const historical = offer({ save: false });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const ordinary = chain.receipt.bind(chain);
  chain.receipt = id => id === historical.row.txid ? gate : ordinary(id);
  const backfill = engine.backfillStatistics();
  try {
    await engine.start('live'); await engine.loopPromise;
    assert.equal(chain.broadcasts, 1); assert.equal(engine.metrics.sent, 1);
  } finally { release(historical.info); await backfill; }
});
test('reporting persistence errors do not change receipt success or halt a campaign', async t => {
  const { engine, chain, store } = fixture(t);
  store.saveReceipt = () => { throw new Error('statistics unavailable'); };
  await engine.start('live'); await engine.loopPromise;
  assert.equal(chain.broadcasts, 1); assert.equal(engine.state, 'stopped'); assert.equal(store.records().items[0].status, 'confirmed');
});
test('existing final confirmation stores receipt metrics without any additional chain lookup', async t => {
  const { offer, engine, chain, c, store } = fixture(t);
  const { row } = offer({ status: 'executed', save: false }); let requests = 0;
  chain.receipt = async id => { requests++; return { ...receipt(c.tokenContract, chain.wallet, row.address, row.raw_amount, id), blockTimeStamp: NOW, receipt: { result: 'SUCCESS', energy_usage_total: 58000 } }; };
  await engine.confirmExecuted(); assert.equal(requests, 1); assert.equal(chain.broadcasts, 0);
  assert.equal(store.records().items[0].status, 'confirmed'); assert.equal(store.db.prepare('SELECT energy FROM delivery_receipts').get().energy, '58000');
});
test('report worker reads the local database independently and closes cleanly', async t => {
  const { offer, dir } = fixture(t); offer({ timestamp: new Date().toISOString() });
  const service = new StatisticsService(path.join(dir, 'records.sqlite'));
  try {
    const result = await service.query({ period: 'all' }); assert.equal(result.totals.count, 1);
    assert.match(await service.query({ period: 'all', export: true }), /所选范围合计/);
    assert.equal(typeof await service.query({ export: 'true' }), 'object');
  } finally { await service.close(); }
  await assert.rejects(service.query(), /已关闭/);
});
test('statistics API remains available during a campaign, enforces sessions and validates dates without RPC', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-statistics-api-'));
  atomicJson(path.join(dir, 'config.json'), config({ privateKey: '', apiKey: '' })); let rpc = 0;
  const app = await createApp({ dataDir: dir, automaticUpdates: false, chainFactory: () => { rpc++; throw new Error('No network allowed'); } });
  t.after(async () => { app.engine.state = 'stopped'; await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`, headers = { Cookie: 'tcl_session=' + app.token };
  assert.equal((await fetch(base + '/api/statistics')).status, 401); app.engine.state = 'running';
  const response = await fetch(base + '/api/statistics', { headers }); assert.equal(response.status, 200);
  const report = await response.json(); assert.equal(report.range.period, '15'); assert.equal(report.totals.count, 0);
  assert.equal((await fetch(base + '/api/statistics?period=custom&start=2026-02-30&end=2026-03-01', { headers })).status, 400);
  const exported = await fetch(base + '/api/statistics/export?period=all', { headers });
  assert.equal(exported.status, 200); assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(await exported.text(), /投放笔数/); assert.equal(app.engine.state, 'running'); assert.equal(rpc, 0);
});
