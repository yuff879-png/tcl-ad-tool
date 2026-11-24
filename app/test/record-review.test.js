'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { Store } = require('../src/store');
const { atomicJson } = require('../src/config');
const { queryStatistics } = require('../src/statistics');
const { config, FakeChain, address, receipt } = require('./fixtures');
const OLD = new Date(Date.now() - 6 * 86400000).toISOString();
const RAW = '168000000000000000000';
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-review-')), c = config();
  atomicJson(path.join(directory, 'config.json'), c);
  const chain = new FakeChain(c), empty = async () => ({});
  chain.receipt = empty; chain.executionReceipt = empty; chain.transactionExpiration = async () => null;
  chain.replacementReady = async () => false;
  const app = await createApp({ dataDir: directory, chainFactory: () => chain, automaticUpdates: false });
  clearInterval(app.engine.confirmationTimer); clearInterval(app.engine.statisticsTimer);
  const base = `http://127.0.0.1:${app.port}`;
  const request = async (route, body) => {
    const response = await fetch(base + '/api/' + route, { method: 'POST', headers: { Cookie: 'tcl_session=' + app.token, Origin: base,
      'X-TCL-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const offer = (n = 3, age = OLD) => {
    app.store.offer('live', { to: address(n), txid: n.toString(16).repeat(64), asset: 'TRX', amount: '150' }, c, 11);
    const row = app.store.next('live');
    app.store.update(row.id, 'uncertain', { txid: n.toString(16).padStart(64, 'a'), wallet: chain.wallet, raw_amount: RAW });
    app.store.db.prepare('UPDATE deliveries SET created_at=?,updated_at=? WHERE id=?').run(age, age, row.id);
    return app.store.get(row.id);
  };
  t.after(async () => { await app.close(); assert.equal(chain.signed, 0); assert.equal(chain.broadcasts, 0); fs.rmSync(directory, { recursive: true, force: true }); });
  return { app, chain, request, offer, c, directory };
}
const close = (request, row, action = 'archive') => request('records/close-review', { id: row.id, confirmed: true, expected_action: action, note: '核查历史记录并停止自动追查' });
test('old hash-only record can be archived as unknown without invented expiration, deletion or replay', async t => {
  const { app, chain, request, offer, c } = await fixture(t), row = offer();
  const checked = await request('records/recheck', { id: row.id });
  assert.equal(checked.status, 200); assert.equal(checked.body.recovery.close_action, 'archive');
  assert.match(checked.body.recovery.reason, /不能根据记录日期推定/);
  assert.equal(app.store.attempt(row.txid).expiration, null);
  assert.equal(checked.body.attempts[0].signed_json, undefined);
  const done = await close(request, row);
  assert.equal(done.body.status, 'archived_unconfirmed'); assert.equal(done.body.txid, row.txid);
  assert.equal(done.body.recovery.can_recheck, true); assert.ok(done.body.recovery.closed_at);
  assert.equal(app.store.pending().length, 0); assert.equal(app.store.nextRetry(c, chain.wallet), undefined);
  assert.equal(app.store.retryInfo(done.body).exhausted, 1); assert.equal(app.store.attempt(row.txid).expiration, null);
  assert.equal(app.store.hasRecipient('live', row.address, 'new-source', c), true);
  assert.equal(queryStatistics(app.store.db, { period: 'all' }).pending.undated, 1);
  await app.engine.confirmExecuted(); assert.equal(app.store.get(row.id).status, 'archived_unconfirmed');
  const revived = new Date().toISOString();
  chain.receipt = async id => ({ ...receipt(row.token, row.wallet, row.address, RAW, id), blockTimeStamp: Date.now(), receipt: { result: 'SUCCESS', energy_usage_total: 2 } });
  const rechecked = await request('records/recheck', { id: row.id });
  assert.equal(rechecked.body.status, 'confirmed'); assert.equal(app.store.retryInfo(rechecked.body).exhausted, 1);
  assert.ok(rechecked.body.recovery.closed_at < revived || rechecked.body.recovery.closed_at === revived);
  assert.equal(queryStatistics(app.store.db, { period: 'all' }).totals.count, 1);
});
test('recent unknown, executed, malformed receipt, and successful amount mismatch cannot be archived', async t => {
  const { app, chain, request, offer } = await fixture(t);
  let row = offer(3, new Date().toISOString());
  assert.equal((await request('records/recheck', { id: row.id })).body.recovery.can_close, false);
  row = offer(4); app.store.update(row.id, 'executed');
  assert.equal((await request('records/recheck', { id: row.id })).body.recovery.can_close, false);
  row = offer(5); chain.receipt = async id => ({ id, receipt: { result: 'INVENTED_FAILURE' } });
  assert.equal((await close(request, row)).body.status, 'uncertain');
  assert.equal(app.store.get(row.id).status, 'uncertain');
  chain.receipt = async id => receipt(row.token, row.wallet, address(9), RAW, id);
  const mismatch = await request('records/recheck', { id: row.id });
  assert.equal(mismatch.body.recovery.can_close, false); assert.match(mismatch.body.recovery.reason, /参数未核对/);
});
test('archival persists across database reopen with unknown costs and original dedupe intact', async t => {
  const { app, chain, request, offer, c, directory } = await fixture(t), row = offer();
  await close(request, row); await app.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.get(row.id).status, 'archived_unconfirmed');
    assert.equal(reopened.get(row.id).txid, row.txid); assert.equal(reopened.pending().length, 0);
    assert.equal(reopened.nextRetry(c, chain.wallet), undefined); assert.equal(reopened.retryInfo(reopened.get(row.id)).exhausted, 1);
    assert.equal(reopened.hasRecipient('live', row.address, 'later-trigger', c), true);
    assert.equal(reopened.attempt(row.txid).fee_sun, null); assert.equal(reopened.attempt(row.txid).expiration, null);
    assert.equal(reopened.record(row.id).recovery.can_recheck, true);
  } finally { reopened.close(); }
});
test('node outage can only archive old local TRC20 as unknown and cannot erase prior observed success', async t => {
  const { chain, request, offer } = await fixture(t), row = offer();
  chain.receipt = chain.executionReceipt = async () => { throw new Error('HTTP 429'); };
  chain.transactionExpiration = async () => { throw new Error('network timeout'); };
  let result = await request('records/recheck', { id: row.id });
  assert.equal(result.body.recovery.close_action, 'archive'); assert.match(result.body.recovery.reason, /费用未知/);
  chain.transactionExpiration = async () => { throw Object.assign(new Error('timeout'), { observed_execution_results: { full: 'SUCCESS', confirmed: null }, transaction_found: true }); };
  result = await close(request, row);
  assert.equal(result.body.status, 'uncertain'); assert.equal(result.body.recovery.can_close, false);
});
test('platform-linked record can query original platform result but never be locally archived', async t => {
  const { app, request, offer } = await fixture(t), row = offer();
  app.store.energyIntent(row, { platformUrl: 'https://energy.example', platformDeviceId: 'old-device' });
  const result = await close(request, row);
  assert.equal(result.body.status, 'uncertain'); assert.equal(result.body.recovery.can_close, false);
  assert.match(result.body.recovery.reason, /平台订单/);
});
test('all historical attempts are inspected and historical success blocks archive when another remains unknown', async t => {
  const { app, chain, request, offer } = await fixture(t), row = offer(), oldHash = 'd'.repeat(64);
  app.store.db.prepare('INSERT INTO delivery_attempts(txid,delivery_id,status,detail,created_at,wallet) VALUES(?,?,?,?,?,?)')
    .run(oldHash, row.id, 'pending', '', OLD, row.wallet);
  const seen = [];
  chain.receipt = async id => { seen.push(id); return id === oldHash ? receipt(row.token, row.wallet, row.address, RAW, id) : {}; };
  const result = await close(request, row);
  assert.equal(result.body.status, 'uncertain'); assert.equal(result.body.recovery.can_close, false);
  assert.ok(seen.includes(oldHash) && seen.includes(row.txid)); assert.match(result.body.recovery.reason, /历史尝试存在已到账/);
  chain.receipt = async () => { throw new Error('RPC temporarily unavailable'); };
  const again = await close(request, row);
  assert.equal(again.body.status, 'uncertain'); assert.equal(again.body.recovery.can_close, false);
  assert.equal(app.store.attempt(oldHash).status, 'confirmed');
  assert.equal(app.store.retryInfo(row).exhausted, 1);
});
test('successful historical attempt is reconciled as confirmed once every other attempt is final', async t => {
  const { app, chain, request, offer } = await fixture(t), row = offer(), oldHash = 'd'.repeat(64);
  app.store.db.prepare('INSERT INTO delivery_attempts(txid,delivery_id,status,detail,created_at,wallet) VALUES(?,?,?,?,?,?)')
    .run(oldHash, row.id, 'pending', '', OLD, row.wallet);
  chain.receipt = async id => id === oldHash ? receipt(row.token, row.wallet, row.address, RAW, id) : { id, receipt: { result: 'REVERT' } };
  const result = await request('records/recheck', { id: row.id });
  assert.equal(result.body.status, 'confirmed'); assert.equal(result.body.txid, oldHash);
  assert.equal(result.body.attempts.length, 2); assert.equal(app.store.attempt(row.txid).status, 'failed_final');
  assert.equal(app.store.retryInfo(result.body).exhausted, 1);
});
test('repeated conflicting failure receipts never erase a historical confirmed attempt', async t => {
  const { app, chain, request, offer } = await fixture(t), row = offer(), oldHash = 'd'.repeat(64);
  app.store.db.prepare('INSERT INTO delivery_attempts(txid,delivery_id,status,detail,created_at,wallet) VALUES(?,?,?,?,?,?)')
    .run(oldHash, row.id, 'confirmed', '已核实到账', OLD, row.wallet);
  chain.receipt = async id => ({ id, receipt: { result: 'REVERT' } });
  for (let i = 0; i < 2; i++) {
    const result = await close(request, row, 'fail');
    assert.equal(result.body.status, 'uncertain'); assert.equal(result.body.recovery.can_close, false);
    assert.equal(app.store.attempt(oldHash).status, 'confirmed');
  }
});
test('background and batch single-hash checks cannot settle a manually reviewed multi-attempt record', async t => {
  const { app, chain, request, offer, c, directory } = await fixture(t), row = offer(), oldHash = 'd'.repeat(64);
  app.store.db.prepare('INSERT INTO delivery_attempts(txid,delivery_id,status,detail,created_at,wallet) VALUES(?,?,?,?,?,?)')
    .run(oldHash, row.id, 'pending', '', OLD, row.wallet);
  chain.receipt = async id => id === row.txid ? receipt(row.token, row.wallet, row.address, RAW, id) : {};
  const checked = await request('records/recheck', { id: row.id });
  assert.equal(checked.body.status, 'uncertain'); assert.equal(app.store.attempt(row.txid).status, 'confirmed');
  assert.equal(app.store.requiresAllAttemptReview(app.store.get(row.id)), true);
  assert.equal(app.store.nextRetry(c, chain.wallet), undefined);
  for (const result of ['SUCCESS', 'REVERT']) {
    let reads = 0;
    chain.receipt = async id => { reads++; return result === 'SUCCESS' ? receipt(row.token, row.wallet, row.address, RAW, id) : { id, receipt: { result } }; };
    await app.engine.confirmExecuted();
    const batch = await app.engine.reconcile(); assert.match(batch[0].error, /全部历史尝试/);
    assert.equal(await app.engine.settle(app.store.get(row.id), false, true, chain), false);
    assert.equal(reads, 0); assert.equal(app.store.get(row.id).status, 'uncertain'); assert.equal(app.store.attempt(row.txid).status, 'confirmed');
  }
  const reopened = new Store(directory);
  try { assert.equal(reopened.requiresAllAttemptReview(reopened.get(row.id)), true); assert.equal(reopened.nextRetry(c, chain.wallet), undefined); }
  finally { reopened.close(); }
  chain.receipt = async id => id === row.txid ? receipt(row.token, row.wallet, row.address, RAW, id) : { id, receipt: { result: 'REVERT' } };
  const resolved = await request('records/recheck', { id: row.id });
  assert.equal(resolved.body.status, 'confirmed'); assert.equal(app.store.requiresAllAttemptReview(app.store.get(row.id)), false);
});
test('first pairing allows ordinary pending records but mode acknowledgement remains unready', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-review-pair-')), c = config();
  atomicJson(path.join(directory, 'config.json'), c);
  const acks = [], p = { device_id: 'device-1', wallet_address: address(1), revision: 1, desired_mode: 'seamless', effective_mode: 'local', transition_state: 'pending',
    valid_until: new Date(Date.now() + 60000).toISOString(), price_sun: 950000, max_fee_limit_sun: 10000000,
    trx_stop_sun: 15000000, trx_resume_sun: 20000000, auto_resume: true, low_trx_latched: false, enabled: true };
  const chain = new FakeChain(c); chain.signBindingChallenge = async () => 'proof'; chain.receipt = async () => ({});
  let challenges = 0;
  const client = { challenge: async input => { challenges++; return { message: 'Energy Desk device binding\n' + input.wallet_address }; },
    pair: async () => ({ device_token: 'test-device-token', device_id: 'device-1' }), policy: async () => p,
    ack: async input => { acks.push(input); return p; } };
  const app = await createApp({ dataDir: directory, automaticUpdates: false, rentalFactory: () => client, chainFactory: () => chain });
  t.after(async () => { await app.close(); assert.equal(chain.broadcasts, 0); assert.equal(chain.signed, 0); fs.rmSync(directory, { recursive: true, force: true }); });
  app.store.offer('live', { to: address(3), txid: 'e'.repeat(64), asset: 'TRX', amount: '150' }, c, 11);
  const row = app.store.next('live'); app.store.update(row.id, 'uncertain', { txid: 'f'.repeat(64), wallet: address(1), raw_amount: RAW });
  const base = `http://127.0.0.1:${app.port}`;
  const response = await fetch(base + '/api/energy/pair', { method: 'POST', headers: { Cookie: 'tcl_session=' + app.token, Origin: base,
    'X-TCL-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ platformUrl: 'https://energy.example', code: 'once' }) });
  assert.equal(response.status, 200); assert.equal(challenges, 1); assert.equal(app.energyPolicy.linked(), true);
  assert.equal(acks.at(-1).ready, false); assert.equal(acks.at(-1).pending_txid, 'f'.repeat(64));
  assert.equal(app.engine.running, false); assert.throws(() => app.energyPolicy.requireMode(), /切换/);
  assert.equal(app.store.get(row.id).txid, 'f'.repeat(64));
});
test('real expiration closure checks every attempt and preserves final failed receipt costs', async t => {
  const { app, chain, request, offer } = await fixture(t), row = offer(), oldHash = 'd'.repeat(64);
  app.store.db.prepare('INSERT INTO delivery_attempts(txid,delivery_id,status,detail,created_at,wallet) VALUES(?,?,?,?,?,?)')
    .run(oldHash, row.id, 'pending', '', OLD, row.wallet);
  chain.receipt = async id => id === row.txid ? { id, blockTimeStamp: Date.now(), receipt: { result: 'REVERT', energy_usage_total: 7 }, fee: 765432 } : {};
  chain.transactionExpiration = async () => ({ expiration: Date.now() - 5 * 86400000, source: 'chain', execution_results: { full: 'REVERT', confirmed: null } });
  const checked = [];
  chain.replacementReady = async id => { checked.push(id); return true; };
  const result = await close(request, row, 'expire');
  assert.equal(result.body.status, 'expired_unconfirmed'); assert.deepEqual(checked, [oldHash]);
  assert.equal(app.store.attempt(row.txid).status, 'failed_final');
  const stats = queryStatistics(app.store.db, { period: 'all' });
  assert.equal(stats.totals.feeSun, '765432'); assert.equal(stats.totals.count, 0); assert.equal(stats.totals.otherCount, 1);
});
test('recheck condition changes require renewed confirmation and invalid confirmation never mutates', async t => {
  const { app, chain, request, offer } = await fixture(t), row = offer();
  chain.transactionExpiration = async () => ({ expiration: Date.now() - 5 * 86400000, source: 'chain', execution_results: {} });
  chain.replacementReady = async () => true;
  assert.equal((await request('records/recheck', { id: row.id })).body.recovery.close_action, 'expire');
  chain.transactionExpiration = async () => null;
  const changed = await close(request, row, 'expire');
  assert.equal(changed.body.status, 'uncertain'); assert.equal(changed.body.recovery.close_action, 'archive');
  assert.match(changed.body.recovery.reason, /重新确认/);
  assert.equal((await request('records/close-review', { id: row.id, expected_action: 'archive', note: 'x' })).status, 400);
  assert.equal(app.store.get(row.id).status, 'uncertain');
});
test('review waits for in-flight confirmation and cannot overwrite concurrent final success', async t => {
  const { app, chain, request, offer } = await fixture(t), row = offer();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  chain.receipt = async id => { entered(); await gate; return receipt(row.token, row.wallet, row.address, RAW, id); };
  const background = app.engine.confirmExecuted(); await ready;
  const ending = close(request, row); release(); await background;
  const result = await ending;
  assert.equal(result.body.status, 'confirmed'); assert.equal(app.store.get(row.id).status, 'confirmed');
  assert.equal((await request('records/recheck', { id: row.id })).body.status, 'confirmed');
});
test('review operations reject active tasks and preserve original RPC for old-wallet record', async t => {
  const { app, chain, request, offer } = await fixture(t), row = offer();
  app.engine.running = true;
  assert.equal((await request('records/recheck', { id: row.id })).status, 400);
  app.engine.running = false;
  let used;
  app.engine.getChain = c => { used = c; return chain; };
  app.store.db.prepare('UPDATE deliveries SET rpc=? WHERE id=?').run('https://old.example', row.id);
  await request('records/recheck', { id: row.id }); assert.equal(used.rpcUrl, 'https://old.example');
});
