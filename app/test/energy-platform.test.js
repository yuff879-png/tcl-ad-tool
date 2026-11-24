'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { EnergyPolicy } = require('../src/energy-policy');
const { RentalClient, platformOrigin } = require('../src/rental-client');
const { fingerprint, publicConfig, redact, atomicJson } = require('../src/config');
const { queryStatistics, statisticsCsv } = require('../src/statistics');
const { createApp } = require('../src/server');
const { config, FakeChain, address, receipt } = require('./fixtures');
const linked = extra => config({ maxPerRun: 0, energyTransport: 'platform', platformUrl: 'https://energy.example', platformToken: 'secret-device-token', platformDeviceId: 'device-1', platformWallet: address(1), ...extra });
const policyValue = extra => ({ device_id: 'device-1', wallet_address: address(1), revision: 1, desired_mode: 'seamless', effective_mode: 'seamless', transition_state: 'stable',
  valid_until: new Date(Date.now() + 60000).toISOString(), price_sun: 950000, max_fee_limit_sun: 10000000, min_trx_sun: 15000000,
  trx_stop_sun: 15000000, trx_resume_sun: 20000000, auto_resume: true, low_trx_latched: false, enabled: true, ...extra });
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-energy-')), c = linked(options.config), store = new Store(directory), chains = [], calls = { policy: 0, ack: [], admit: [], submit: [], query: [] };
  let currentPolicy = policyValue(options.policy), returnedOrder = null;
  const client = {
    async policy() { calls.policy++; return { ...currentPolicy }; },
    async ack(input) { calls.ack.push(input); if (input.ready) currentPolicy = { ...currentPolicy, effective_mode: input.mode, transition_state: 'stable' }; return { ...currentPolicy }; },
    async admit(input) { calls.admit.push(input); return { admission_id: 'admission-' + calls.admit.length, expires_at: new Date(Date.now() + 20000).toISOString(), price_sun: 950000 }; },
    async submit(input) { calls.submit.push(input); returnedOrder = { id: 'order-1', intent_id: calls.admit.at(-1).intent_id, txid: input.txid, status: 'pending', route: 'catfee', service_status: 'unknown', tx_status: 'pending', billing_status: 'frozen', charge_sun: 950000 }; if (options.timeout) throw new Error('lost response'); return returnedOrder; },
    async byIntent(id) { calls.query.push(id); return returnedOrder; }, async order(id) { calls.query.push(id); return returnedOrder; },
  };
  const engine = new Engine(store, () => c, cfg => { const chain = new FakeChain(cfg); if (options.lowResources) chain.resources = async () => ({ wallet: chain.wallet, balanceSun: '1000000', energy: 0, bandwidth: 1000 }); chains.push(chain); return chain; }, { executionWaitMs: 0, retryDelayMs: 0 });
  const policy = new EnergyPolicy(() => c, { factory: () => client, boundary: () => ({ ready: !engine.activeDeliveryId && !store.pending().length && !store.unresolvedEnergyOrders().length, pending_txid: store.pending()[0]?.txid || null }) });
  engine.energyPolicy = policy; engine.loop = async () => {};
  t.after(async () => { await policy.close(); await engine.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await engine.start('live');
  const offer = (n = 3) => { store.offer('live', { to: address(n), txid: n.toString(16).padStart(64, 'a'), asset: 'TRX', amount: '150' }, c, 11); return store.queued('live').at(-1); };
  return { directory, c, store, engine, policy, client, chains, calls, offer,
    changePolicy: patch => { currentPolicy = { ...currentPolicy, ...patch }; }, order: () => returnedOrder, changeOrder: patch => { returnedOrder = { ...returnedOrder, ...patch }; } };
}

test('platform client pins HTTPS origin and never retries a lost submission or follows redirects', async () => {
  for (const value of ['http://energy.example', 'https://u:p@energy.example', 'https://energy.example/path', 'https://energy.example?token=x']) assert.throws(() => platformOrigin(value));
  let calls = 0;
  const client = new RentalClient('https://energy.example/', 'secret', { fetch: async (url, options) => { calls++; assert.equal(url, 'https://energy.example/api/energy/device/submit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer secret'); throw new Error('lost response'); } });
  await assert.rejects(client.submit({ txid: 'a'.repeat(64) }), /lost response/); assert.equal(calls, 1);
});

test('platform capacity response preserves the exact no-forwarding proof', async () => {
  const client = new RentalClient('https://energy.example', 'secret', { fetch: async () => new Response(JSON.stringify({ detail: {
    code: 'energy_capacity_wait', message: '等待无感广播容量，本笔尚未转发', broadcast_started: false, retry_after_seconds: 1,
  } }), { status: 429 }) });
  await assert.rejects(client.submit({}), error => error.status === 429 && error.code === 'energy_capacity_wait' && error.broadcastStarted === false && error.retryAfter === 1);
});

test('standalone local mode performs no platform requests and retains its original resource protection', async t => {
  const f = await fixture(t, { config: { energyTransport: 'local' } });
  assert.equal(f.calls.policy, 0); f.offer(); await f.engine.sendNext();
  assert.equal(f.calls.submit.length, 0); assert.equal(f.chains.reduce((n, c) => n + c.broadcasts, 0), 1);
  assert.throws(() => f.engine.checkFunds({ energy: 0, balanceSun: '1000000' }, { rawBalance: '100000' }, f.c, '1'), /能量/);
});

test('seamless delegates the shared TRX threshold to gateway fresh checks without a second local latch', async t => {
  const f = await fixture(t, { lowResources: true }); const row = f.offer();
  const before = fingerprint(f.c, 'live'); await f.engine.sendNext();
  assert.equal(f.calls.submit.length, 1); assert.equal(f.chains.reduce((n, c) => n + c.broadcasts, 0), 0);
  assert.equal(f.chains.find(c => c.signed)?.config.feeLimitTrx, '10'); assert.equal(f.c.feeLimitTrx, '30');
  assert.equal(fingerprint(f.c, 'live'), before); assert.equal(f.store.retryInfo(f.store.get(row.id)).exhausted, 1);
  assert.equal(f.store.energyOrder(row.id).customer_fee_sun, null);
  assert.ok(!JSON.stringify(f.calls.submit).includes(f.c.privateKey)); assert.ok(!JSON.stringify(f.store.records()).includes('raw_data'));
});

test('platform cannot raise the locally configured execution fee limit', async t => {
  const f = await fixture(t, { config: { feeLimitTrx: '1' } }); f.offer(); await f.engine.sendNext();
  assert.equal(f.chains.find(c => c.signed)?.config.feeLimitTrx, '1');
});

test('startup locks the engine before awaiting platform policy', async t => {
  const f = await fixture(t); f.engine.stop(); await f.engine.loopPromise; f.engine.state = 'stopped';
  let release;
  const gate = new Promise(resolve => { release = resolve; }), refresh = f.policy.refreshForSend.bind(f.policy);
  f.policy.refreshForSend = async () => { await gate; return refresh(); };
  const starting = f.engine.start('live'); assert.equal(f.engine.state, 'starting'); assert.equal(f.engine.busy, true);
  release(); await starting;
});

test('lost submit response and a missing order never cause local or platform resubmission', async t => {
  const f = await fixture(t, { timeout: true }); const row = f.offer(); await f.engine.sendNext();
  f.client.byIntent = async () => { f.calls.query.push('404'); throw Object.assign(new Error('not found'), { status: 404 }); };
  await f.engine.syncEnergyOrders(); await f.engine.sendNext();
  assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.query.length, 1); assert.equal(f.store.energyOrder(row.id).submitted, 1);
  assert.equal(f.store.nextRetry(f.c, address(1)), undefined); assert.equal(f.chains.reduce((n, c) => n + c.broadcasts, 0), 0);
  const reopened = new Store(f.directory); assert.equal(reopened.energyOrder(row.id).submitted, 1); assert.equal(reopened.nextRetry(f.c, address(1)), undefined); reopened.close();
});

test('first gateway failure remains separate from later admission expiry and hides configured secrets', async t => {
  const f = await fixture(t), row = f.offer();
  f.client.submit = async () => { throw new Error('本笔可用带宽不足 ' + f.c.platformToken + ' ' + f.c.privateKey); };
  await f.engine.sendNext();
  const first = f.store.record(row.id).energyOrder.first_submit_error;
  assert.match(first.message, /可用带宽不足/);
  assert.ok(!first.message.includes(f.c.platformToken)); assert.ok(!first.message.includes(f.c.privateKey));
  const saved = f.store.energyOrder(row.id);
  f.engine.acceptEnergyOrder(row.id, { id: 'cancelled-order', intent_id: saved.intent_id, txid: null, status: 'cancelled',
    service_status: 'not_delivered', tx_status: 'not_broadcast', billing_status: 'released', charge_sun: 950000,
    broadcast_started: false, reason: '发送许可已过期，尚未广播' });
  assert.deepEqual(f.store.record(row.id).energyOrder.first_submit_error, first);
  assert.match(f.store.record(row.id).energyOrder.detail, /许可已过期/);
  const other = f.offer(4); assert.equal(f.store.record(other.id).energyOrder, null);
});

test('gateway persistence is atomic before the request starts', async t => {
  const f = await fixture(t); const row = f.offer();
  f.client.submit = async () => { const saved = f.store.energyOrder(row.id); assert.equal(saved.submitted, 1); assert.equal(saved.txid, f.store.get(row.id).txid); assert.equal(f.store.retryInfo(f.store.get(row.id)).exhausted, 1); throw new Error('lost'); };
  await f.engine.sendNext(); assert.equal(f.store.pending().length, 1);
});

test('explicit pre-forwarding capacity rejection retries only the same gateway payload and forwards once', async t => {
  const f = await fixture(t); f.offer(); Object.assign(f.engine.timing, { gatewayRetryMs: 0, gatewayJitterMs: 0 });
  const submit = f.client.submit.bind(f.client), payloads = []; let forwarded = 0;
  f.client.submit = async input => {
    payloads.push(JSON.stringify(input));
    if (payloads.length < 3) throw Object.assign(new Error('capacity'), { status: 429, code: 'energy_capacity_wait', broadcastStarted: false });
    forwarded++; return submit(input);
  };
  await f.engine.sendNext(); assert.equal(payloads.length, 3); assert.equal(new Set(payloads).size, 1); assert.equal(forwarded, 1);
  assert.equal(f.calls.admit.length, 1); assert.equal(f.chains.reduce((n, chain) => n + chain.signed, 0), 1);
  assert.equal(f.chains.reduce((n, chain) => n + chain.broadcasts, 0), 0);
});

test('capacity rejection followed by a lost response permanently switches to original-order queries', async t => {
  const f = await fixture(t, { timeout: true }); f.offer(); Object.assign(f.engine.timing, { gatewayRetryMs: 0, gatewayJitterMs: 0 });
  const submit = f.client.submit.bind(f.client); let calls = 0;
  f.client.submit = async input => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('capacity'), { status: 429, code: 'energy_capacity_wait', broadcastStarted: false });
    return submit(input);
  };
  await f.engine.sendNext(); await f.engine.syncEnergyOrders(); await f.engine.sendNext();
  assert.equal(calls, 2); assert.equal(f.calls.query.length, 1); assert.equal(f.calls.admit.length, 1);
  assert.equal(f.chains.reduce((n, chain) => n + chain.signed, 0), 1);
});

test('generic 429, stop, changed policy and retry limit cannot extend gateway retries', async t => {
  const f = await fixture(t); Object.assign(f.engine.timing, { gatewayRetryMs: 0, gatewayJitterMs: 0 });
  const payload = { admission_id: 'same-admission', txid: 'b'.repeat(64), signed_transaction: { raw_data: { expiration: Date.now() + 60000 } } };
  const expires = new Date(Date.now() + 20000).toISOString(); let calls = 0;
  const capacity = () => Object.assign(new Error('capacity'), { status: 429, code: 'energy_capacity_wait', broadcastStarted: false });
  await assert.rejects(f.engine.submitGateway({ submit: async () => { calls++; throw Object.assign(new Error('proxy limit'), { status: 429, broadcastStarted: false }); } }, payload, expires, 1));
  assert.equal(calls, 1); calls = 0;
  await assert.rejects(f.engine.submitGateway({ submit: async () => { calls++; throw capacity(); } }, payload, expires, 1)); assert.equal(calls, 12);
  calls = 0; f.engine.wait = async () => { f.policy.value.revision = 2; };
  await assert.rejects(f.engine.submitGateway({ submit: async () => { calls++; throw capacity(); } }, payload, expires, 1)); assert.equal(calls, 1);
  calls = 0; f.policy.value.revision = 1; f.engine.wait = async () => { f.engine.stop(); };
  await assert.rejects(f.engine.submitGateway({ submit: async () => { calls++; throw capacity(); } }, payload, expires, 1)); assert.equal(calls, 1);
});

test('local signing rechecks lease before persisting or broadcasting a new transaction', async t => {
  const f = await fixture(t, { policy: { desired_mode: 'local', effective_mode: 'local' } }); const row = f.offer();
  const sign = f.engine.chain.buildAndSign.bind(f.engine.chain);
  f.engine.chain.buildAndSign = async (...args) => { const prepared = await sign(...args); f.policy.value.valid_until = new Date(Date.now() - 1).toISOString(); return prepared; };
  await f.engine.sendNext(); assert.equal(f.store.get(row.id).status, 'queued'); assert.equal(f.store.get(row.id).txid, null);
  assert.equal(f.store.pending().length, 0); assert.equal(f.chains.reduce((n, c) => n + c.broadcasts, 0), 0); assert.equal(f.engine.running, true);
});

test('manual pause during seamless signing never submits or creates an uncertain delivery', async t => {
  const f = await fixture(t); const row = f.offer(), chain = f.engine.getChain({ ...f.engine.config, feeLimitTrx: '10' });
  const sign = chain.buildAndSign.bind(chain);
  chain.buildAndSign = async (...args) => { const prepared = await sign(...args); f.engine.stop(); return prepared; };
  await f.engine.sendNext(); assert.equal(f.calls.submit.length, 0); assert.equal(f.store.get(row.id).status, 'queued'); assert.equal(f.store.energyOrder(row.id).submitted, 0);
});

test('fresh gateway low-TRX rejection retires only the unbroadcast signature and resumes the same intent after server recovery', async t => {
  const f = await fixture(t, { lowResources: true }); const row = f.offer(), cursor = f.engine.height;
  const submit = f.client.submit.bind(f.client); let attempted = 0, rejectedTxid;
  f.client.submit = async input => {
    attempted++;
    if (attempted === 1) {
      rejectedTxid = input.txid;
      f.changePolicy({ enabled: false, low_trx_latched: true, paused_reason: 'TRX 低于 15，等待达到 20 后连续两次确认' });
      throw Object.assign(new Error('TRX 保护已暂停'), { status: 409, code: 'energy_trx_paused', broadcastStarted: false,
        admissionId: input.admission_id, intentId: f.calls.admit.at(-1).intent_id });
    }
    return submit(input);
  };
  await f.engine.sendNext(); const intent = f.store.energyOrder(row.id).intent_id;
  assert.equal(f.store.get(row.id).status, 'queued'); assert.equal(f.store.get(row.id).txid, null);
  assert.equal(f.store.pending().length, 0); assert.equal(f.store.unresolvedEnergyOrders().length, 0); assert.equal(f.engine.running, true);
  assert.equal(f.store.attempt(rejectedTxid).status, 'not_broadcast'); assert.ok(f.store.attempt(rejectedTxid).signed_json);
  f.engine.chain.resources = async () => ({ wallet: address(1), balanceSun: '17000000', energy: 0, bandwidth: 1000 });
  await f.engine.sendNext(); assert.equal(attempted, 1); assert.equal(f.engine.height, cursor); assert.equal(f.engine.metrics.sent, 0);
  // A first high reading still leaves the authoritative server latch set.
  f.engine.chain.resources = async () => ({ wallet: address(1), balanceSun: '20000000', energy: 0, bandwidth: 1000 });
  await f.engine.sendNext(); assert.equal(attempted, 1);
  f.changePolicy({ enabled: true, low_trx_latched: false, paused_reason: '' });
  await f.engine.sendNext(); assert.equal(attempted, 2); assert.equal(f.calls.admit.length, 2);
  assert.equal(f.calls.admit[1].intent_id, intent); assert.equal(f.calls.submit[0].admission_id, 'admission-2');
  assert.notEqual(f.calls.submit[0].txid, rejectedTxid); assert.equal(f.engine.failureStreak(), 0);
});

test('disabled TRX auto-resume waits for platform manual recovery and never restarts a manually stopped task', async t => {
  const f = await fixture(t); f.offer();
  f.changePolicy({ enabled: false, low_trx_latched: true, auto_resume: false, paused_reason: '余额已回升，等待手动恢复' });
  await f.engine.sendNext(); await f.engine.sendNext(); assert.equal(f.calls.submit.length, 0); assert.equal(f.engine.running, true);
  assert.match(f.engine.resourceWait, /手动恢复/); assert.equal(f.engine.metrics.sent, 0);
  f.engine.stop(); f.changePolicy({ enabled: true, low_trx_latched: false });
  await f.policy.sync(); await f.engine.sendNext(); assert.equal(f.calls.submit.length, 0); assert.equal(f.engine.running, false);
});

test('an unrelated TRX-pause response cannot clear an uncertain submitted transaction', async t => {
  const f = await fixture(t); const row = f.offer();
  f.client.submit = async input => { throw Object.assign(new Error('TRX paused'), { status: 409, code: 'energy_trx_paused', broadcastStarted: false, admissionId: input.admission_id, intentId: 'another-intent' }); };
  await f.engine.sendNext(); assert.equal(f.store.get(row.id).status, 'uncertain'); assert.equal(f.store.energyOrder(row.id).submitted, 1);
  assert.equal(f.store.retryInfo(f.store.get(row.id)).exhausted, 1);
});

test('free existing-resource route records zero service fee and waits for receipt before releasing next slot', async t => {
  const f = await fixture(t, { config: { maxPerRun: 1 } }); const row = f.offer(); await f.engine.sendNext(); f.offer(4);
  f.changeOrder({ route: 'local', status: 'complete', tx_status: 'success', service_status: 'not_needed', billing_status: 'free', charge_sun: 0 });
  await f.engine.syncEnergyOrders(); assert.equal(f.store.energyOrder(row.id).customer_fee_sun, '0');
  await f.engine.sendNext(); assert.equal(f.calls.submit.length, 1);
  await f.engine.confirmExecuted(); assert.equal(f.engine.metrics.sent, 1); await f.engine.sendNext(); assert.equal(f.calls.submit.length, 1);
});

test('capacity admission waits before signing without consuming retry count', async t => {
  const f = await fixture(t); const row = f.offer(); f.client.admit = async () => ({ queued: true });
  await f.engine.sendNext(); assert.equal(f.chains.reduce((n, c) => n + c.signed, 0), 0);
  assert.equal(f.store.retryInfo(row).attempts, 0); assert.equal(f.engine.failureStreak(), 0); assert.equal(f.store.get(row.id).status, 'queued');
});

test('mode changes preserve scan cursor, queued recipients and counters and never start a stopped task', async t => {
  const f = await fixture(t); const row = f.offer(), cursor = f.engine.height; f.engine.metrics.sent = 7;
  f.engine.stop(); f.changePolicy({ revision: 2, desired_mode: 'local', transition_state: 'pending' }); await f.policy.sync();
  assert.equal(f.policy.requireMode(), 'local'); assert.equal(f.engine.running, false); assert.equal(f.engine.height, cursor);
  assert.equal(f.engine.metrics.sent, 7); assert.equal(f.store.get(row.id).status, 'queued'); assert.equal(f.engine.config.rpcUrl, f.c.rpcUrl);
});

test('pending gateway order blocks mode acknowledgement and new signing', async t => {
  const f = await fixture(t); f.offer(); await f.engine.sendNext(); f.offer(4);
  f.changePolicy({ revision: 2, desired_mode: 'local', transition_state: 'pending' }); await f.policy.sync(); await f.engine.sendNext();
  assert.equal(f.calls.ack.at(-1).ready, false); assert.equal(f.calls.submit.length, 1); assert.equal(f.engine.running, true);
});

test('expired, disabled or revoked policy blocks new sends while keeping pending queries available', async t => {
  const f = await fixture(t); f.offer(); f.changePolicy({ valid_until: new Date(Date.now() - 1000).toISOString() });
  await f.engine.sendNext(); assert.equal(f.calls.submit.length, 0); assert.match(f.engine.resourceWait, /过期/);
  f.changePolicy({ valid_until: new Date(Date.now() + 60000).toISOString(), enabled: false }); await f.engine.sendNext(); assert.equal(f.calls.submit.length, 0);
  f.client.policy = async () => { throw Object.assign(new Error('revoked'), { status: 401 }); }; await f.policy.sync(); assert.equal(f.policy.value, null);
});

test('chain success does not turn an unknown platform fee into zero; settled fee updates original chain date once', async t => {
  const f = await fixture(t); const row = f.offer(); await f.engine.sendNext();
  const delivery = f.store.get(row.id), info = { ...receipt(row.token, address(1), row.address, delivery.raw_amount, delivery.txid), blockTimeStamp: Date.parse('2026-11-19T10:00:00Z') };
  info.receipt.energy_usage_total = 27957; info.fee = 0; f.store.saveReceipt(delivery, info); f.store.update(row.id, 'confirmed');
  let report = queryStatistics(f.store.db, { period: 'all' }, Date.parse('2026-11-20T12:00:00Z'));
  assert.equal(report.totals.missingServiceFee, 1); assert.equal(report.totals.serviceFeeSun, '0');
  f.changeOrder({ status: 'complete', tx_status: 'success', service_status: 'delivered', billing_status: 'charged' });
  await f.engine.syncEnergyOrders(); await f.engine.syncEnergyOrders();
  report = queryStatistics(f.store.db, { period: 'all' }, Date.parse('2026-11-20T12:00:00Z'));
  assert.equal(report.totals.serviceFeeSun, '950000'); assert.equal(report.totals.feeSun, '0'); assert.equal(report.items[0].date, '2026-11-19'); assert.equal(report.totals.missingServiceFee, 0);
  assert.match(statisticsCsv(report), /平台服务费 TRX/); assert.match(statisticsCsv(report), /0.95/);
});

test('authoritative cancelled never-broadcast admission becomes failed without replay', async t => {
  const f = await fixture(t, { timeout: true }); const row = f.offer(); await f.engine.sendNext();
  f.changeOrder({ status: 'cancelled', service_status: 'not_delivered', tx_status: 'not_broadcast', billing_status: 'released', broadcast_started: false });
  await f.engine.syncEnergyOrders(); assert.equal(f.store.get(row.id).status, 'failed'); assert.equal(f.store.unresolvedEnergyOrders().length, 0);
  assert.equal(f.calls.submit.length, 1); assert.equal(f.store.energyOrder(row.id).customer_fee_sun, '0');
  assert.equal(f.store.nextReceiptBackfill(), undefined); assert.equal(queryStatistics(f.store.db).pending.undated, 0);
});

test('manual expired-unconfirmed closure releases the original task without success or replay', async t => {
  const f = await fixture(t, { timeout: true }); const row = f.offer(); await f.engine.sendNext();
  const intent = f.store.energyOrder(row.id).intent_id;
  f.changeOrder({ status: 'complete', service_status: 'not_delivered', tx_status: 'expired_unconfirmed', billing_status: 'released', reason: '人工复核已过期且多节点未查到原交易' });
  await f.engine.syncEnergyOrders();
  assert.equal(f.store.get(row.id).status, 'expired_unconfirmed'); assert.match(f.store.get(row.id).detail, /已过期未确认，预留款已释放/);
  assert.equal(f.store.energyOrder(row.id).intent_id, intent); assert.equal(f.store.energyOrder(row.id).customer_fee_sun, '0');
  assert.equal(f.store.pending().length, 0); assert.equal(f.store.unresolvedEnergyOrders().length, 0); assert.equal(f.engine.metrics.sent, 0);
  assert.equal(f.store.nextRetry(f.c, address(1)), undefined); assert.equal(f.store.nextReceiptBackfill(), undefined);
  assert.equal(f.store.offer('live', { to: row.address, txid: 'e'.repeat(64), asset: 'TRX', amount: '150' }, f.c, 12), false);
  await f.engine.sendNext(); assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.admit.length, 1);
  const totals = queryStatistics(f.store.db); assert.equal(totals.totals.count, 0); assert.equal(totals.pending.undated, 0);
});

test('platform binding token is redacted and cannot change via ordinary configuration API', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-energy-api-')); atomicJson(path.join(directory, 'config.json'), config());
  let disconnects = 0; const p = policyValue({ desired_mode: 'local', effective_mode: 'local' });
  const client = { challenge: async input => ({ message: 'Energy Desk device binding\n' + input.wallet_address }), pair: async () => ({ device_token: 'secret-device-token', device_id: 'device-1' }), policy: async () => p, ack: async () => p, disconnect: async () => { disconnects++; return { disconnected: true }; } };
  const app = await createApp({ dataDir: directory, automaticUpdates: false, rentalFactory: () => client, chainFactory: c => { const chain = new FakeChain(c); chain.signBindingChallenge = async () => 'proof'; return chain; } });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  const request = async (route, input) => fetch(base + '/api/' + route, { method: input ? 'POST' : 'GET', headers: { Cookie: 'tcl_session=' + app.token, Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
  assert.equal((await request('config', { energyTransport: 'local' })).status, 400);
  assert.equal((await request('energy/pair', { platformUrl: 'https://energy.example', code: 'once' })).status, 200);
  assert.ok(!(await (await request('state')).text()).includes('secret-device-token')); assert.equal(app.engine.running, false);
  assert.equal((await request('config', { privateKey: '2'.padStart(64, '0') })).status, 400);
  app.store.offer('live', { to: address(3), txid: 'a'.repeat(64), asset: 'TRX', amount: '150' }, linked(), 11);
  const row = app.store.next('live'); app.store.update(row.id, 'confirmed', { txid: 'b'.repeat(64) });
  const saved = app.store.energyIntent(row, linked()); app.store.updateEnergyOrder(row.id, { submitted: 1, txid: 'b'.repeat(64) });
  client.policy = async () => { throw Object.assign(new Error('device revoked'), { status: 401 }); };
  await app.energyPolicy.sync(); assert.equal(app.energyPolicy.value, null);
  client.disconnect = async ids => { disconnects++; assert.deepEqual(ids, [saved.intent_id]); if (disconnects === 1) throw new Error('lost disconnect response'); return { disconnected: true, orders: [{ id: 'order-1', intent_id: saved.intent_id, txid: 'b'.repeat(64), route: 'catfee', status: 'complete', service_status: 'delivered', tx_status: 'success', billing_status: 'charged', charge_sun: 950000 }] }; };
  assert.equal((await request('energy/disconnect', {})).status, 400); assert.equal(app.energyPolicy.linked(), true);
  assert.equal((await request('energy/disconnect', {})).status, 200); assert.equal(disconnects, 2); assert.equal(app.energyPolicy.linked(), false);
  assert.equal(app.store.energyOrder(row.id).customer_fee_sun, '950000');
  assert.equal(publicConfig(linked()).platformToken, undefined); assert.equal(redact('secret-device-token', linked()), '[已隐藏]');
});
