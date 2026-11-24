'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { TronWeb, utils } = require('tronweb');
const { createApp } = require('../src/server');
const { Chain } = require('../src/chain');
const { FINALITY_MARGIN_MS } = require('../src/delivery-retry');
const { atomicJson, decimalUnits } = require('../src/config');
const { config, address, receipt, key } = require('./fixtures');

function transaction(c, row, age = 0, nonce = 0) {
  const timestamp = Date.now() + age + nonce;
  const tx = { visible: false, raw_data: { ref_block_bytes: '1234', ref_block_hash: '1234567890abcdef', timestamp,
    expiration: timestamp + 60000, fee_limit: Number(decimalUnits(c.feeLimitTrx, 6)),
    contract: [{ type: 'TriggerSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: {
      owner_address: TronWeb.address.toHex(address(1)), contract_address: TronWeb.address.toHex(row.token),
      data: 'a9059cbb' + TronWeb.address.toHex(row.address).slice(2).padStart(64, '0') + BigInt(row.raw_amount).toString(16).padStart(64, '0'),
    } } }] } };
  const pb = utils.transaction.txJsonToPb(tx);
  tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb); tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  return tx;
}
async function fixture(t, options = {}) {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-manual-retry-'));
  const c = config({ maxPerRun: 0, energyTransport: 'platform', platformUrl: 'https://energy.example', platformToken: 'secret-device-token',
    platformDeviceId: 'device-1', platformWallet: address(1), apiKey: 'secret-rpc-key' });
  atomicJson(path.join(directory, 'config.json'), c);
  const calls = { sign: 0, submit: 0, admit: 0, broadcast: 0, replacement: 0, build: 0, chainQueries: [] }, remote = new Map(), chains = [], gates = {};
  let nonce = 0;
  const policy = { device_id: 'device-1', wallet_address: address(1), revision: 1, desired_mode: 'seamless', effective_mode: 'seamless', transition_state: 'stable',
    valid_until: new Date(Date.now() + 60000).toISOString(), price_sun: 950000, max_fee_limit_sun: 10000000,
    trx_stop_sun: 15000000, trx_resume_sun: 20000000, auto_resume: true, low_trx_latched: false, enabled: true };
  const client = {
    async policy() { if (gates.policy) await gates.policy; return { ...policy, valid_until: new Date(Date.now() + 60000).toISOString() }; },
    async ack() { return this.policy(); },
    async byIntent(id) { if (gates.query) await gates.query; return structuredClone(remote.get(id)); },
    async order(id) { return structuredClone([...remote.values()].find(o => o.id === id)); },
    async admit(input) {
      calls.admit++; if (gates.admit) await gates.admit;
      const order = remote.get(input.intent_id); order.status = 'admitted';
      return { intent_id: input.intent_id, order_id: order.id, status: 'admitted', policy_revision: policy.revision,
        admission_id: 'admission-' + input.intent_id, price_sun: order.charge_sun, expires_at: new Date(Date.now() + 20000).toISOString() };
    },
    async submit(input) {
      calls.submit++; if (options.submitError) throw new Error('可用带宽不足 ' + c.platformToken + ' ' + c.apiKey);
      const order = remote.get(input.admission_id.slice('admission-'.length));
      Object.assign(order, { status: 'pending', txid: input.txid, broadcast_started: true, billing_status: 'frozen', tx_status: 'pending', service_status: 'unknown', route: 'catfee' });
      return structuredClone(order);
    },
  };
  const app = await createApp({ dataDir: directory, automaticUpdates: false, rentalFactory: () => client, chainFactory: cfg => {
    const chain = new Chain(cfg); chains.push(chain);
    chain.tokenInfo = async () => ({ contract: cfg.tokenContract, decimals: 18, symbol: 'TEST', rawBalance: '1000000000000000000000000' });
    chain.resources = async () => ({ wallet: address(1), balanceSun: '1000000000', energy: 0, bandwidth: 100 });
    chain.tokenBalance = async () => '1000000000000000000000000';
    chain.tron.trx.getConfirmedCurrentBlock = async () => {
      if (options.rpcError) throw new Error('RPC timeout');
      return { block_header: { raw_data: { number: 12345, timestamp: Date.now() + (options.solidOffset || 0) } } };
    };
    for (const node of ['fullNode', 'solidityNode']) chain.tron[node].request = async (endpoint, input) => {
      calls.chainQueries.push({ node, endpoint, txid: input.value });
      if (options.lookupError === endpoint) throw new Error('RPC lookup timeout');
      return options.found && (!options.foundTxid || options.foundTxid === input.value)
        && (!options.foundEndpoint || options.foundEndpoint === endpoint) ? { id: input.value } : {};
    };
    chain.replacementReady = async (...args) => {
      calls.replacement++; if (gates.replacement) await gates.replacement;
      return Chain.prototype.replacementReady.call(chain, ...args);
    };
    chain.receipt = async () => ({}); chain.executionReceipt = async () => ({});
    chain.request = fn => fn();
    chain.tron.transactionBuilder.triggerSmartContract = async (token, method, opts, params) => {
      calls.build++; if (gates.build) await gates.build;
      return { result: { result: true }, transaction: transaction(cfg, { token, address: params[0].value, raw_amount: params[1].value }, 0, ++nonce) };
    };
    const sign = chain.tron.trx.sign.bind(chain.tron.trx);
    chain.tron.trx.sign = async (...args) => { calls.sign++; if (gates.sign) await gates.sign; return sign(...args); };
    chain.broadcast = async () => { calls.broadcast++; throw new Error('Local broadcast forbidden'); };
    return chain;
  } });
  clearInterval(app.engine.confirmationTimer); clearInterval(app.engine.statisticsTimer); await app.energyPolicy.close(); app.energyPolicy.closed = false;
  const base = `http://127.0.0.1:${app.port}`;
  const request = async (route, input, headers = {}) => {
    const response = await fetch(base + '/api/' + route, { method: 'POST', headers: { Cookie: 'tcl_session=' + app.token,
      Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  let offered = 0;
  const offer = async (recipient = address(3), extra = {}) => {
    offered++;
    const existing = app.store.db.prepare('SELECT id FROM deliveries WHERE address=? AND dedupe_cleared_at IS NULL').get(recipient);
    if (existing) app.store.db.prepare('UPDATE deliveries SET dedupe_cleared_at=? WHERE id=?').run(new Date().toISOString(), existing.id);
    const configForRow = { ...c, sendAmount: extra.amount || '168' };
    app.store.offer('live', { to: recipient, txid: offered.toString(16).padStart(64, 'e'), asset: 'TRX', amount: '150' }, configForRow, 11);
    const row = app.store.next('live'), raw = decimalUnits(row.amount, 18).toString();
    const signed = await new TronWeb({ fullHost: 'https://offline.invalid' }).trx.sign(transaction(c, { ...row, raw_amount: raw }, -86400000, offered), c.privateKey);
    app.store.prepareAttempt(row, { signed, txid: signed.txID, rawAmount: raw, wallet: address(1) });
    app.store.attemptStatus(signed.txID, 'cancelled'); app.store.update(row.id, 'failed');
    const energy = app.store.energyIntent(row, c);
    app.store.updateEnergyOrder(row.id, { order_id: 'order-' + offered, txid: signed.txID, submitted: 1, resolved: 1,
      service_status: 'not_delivered', transaction_status: 'not_broadcast', billing_status: 'released' });
    remote.set(energy.intent_id, { id: 'order-' + offered, intent_id: energy.intent_id, address: address(1), contract: c.tokenContract,
      recipient, amount_raw: raw, txid: null, broadcast_started: false, status: 'cancelled', tx_status: 'not_broadcast',
      service_status: 'not_delivered', billing_status: 'released', charge_sun: 950000 });
    return app.store.get(row.id);
  };
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { app, c, directory, calls, remote, policy, chains, gates, request, offer, options,
    advance: milliseconds => { clock += milliseconds; } };
}
const preview = (f, row) => f.request('records/prepare-retry', { id: row.id });
const send = (f, row, p) => f.request('records/retry', { id: row.id, confirmationToken: p.body.retry.confirmationToken, confirmed: true });
const markerKey = row => 'delivery-manual-retry:' + row.id;
const historyKey = row => 'delivery-manual-retry-history:' + row.id;
function expireAttempts(f, row) {
  const expiration = Math.max(...f.app.store.deliveryAttempts(row.id).map(attempt => attempt.expiration));
  f.advance(Math.max(0, expiration + FINALITY_MARGIN_MS + 1 - Date.now()));
}
function confirmNeverBroadcast(f, row) {
  const order = f.remote.get(f.app.store.energyOrder(row.id).intent_id);
  Object.assign(order, { status: 'cancelled', tx_status: 'not_broadcast', broadcast_started: false,
    txid: null, service_status: 'not_delivered', billing_status: 'released' });
  f.app.engine.acceptEnergyOrder(row.id, order);
  return order;
}
async function failedRound(f, row, { expire = false } = {}) {
  const p = await preview(f, row);
  assert.equal(p.body.retry.eligible, true, p.body.retry.reason);
  const response = await send(f, row, p);
  assert.equal(response.status, 200); assert.equal(response.body.manualRetry.phase, 'uncertain');
  const marker = f.app.store.getMeta(markerKey(row));
  confirmNeverBroadcast(f, row);
  if (expire) expireAttempts(f, row);
  return { preview: p, marker };
}

test('single manual resend reuses intent and original record, signs once and never starts scanning', async t => {
  const f = await fixture(t), row = await f.offer(), original = f.app.store.energyOrder(row.id);
  const p = await preview(f, row); assert.equal(p.status, 200); assert.equal(p.body.retry.eligible, true, p.body.retry.reason);
  assert.equal(f.calls.sign, 0); assert.equal(f.calls.admit, 0);
  assert.equal(p.body.retry.amount, '168'); assert.equal(p.body.retry.serviceFeeSun, '950000'); assert.equal(p.body.retry.feeLimitSun, '10000000');
  const response = await send(f, row, p); assert.equal(response.status, 200); assert.equal(response.body.manualRetry.phase, 'submitted', response.body.manualRetry.reason);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1); assert.equal(f.calls.broadcast, 0);
  assert.equal(f.app.engine.running, false); assert.equal(f.app.store.energyOrder(row.id).intent_id, original.intent_id);
  assert.equal(f.app.store.get(row.id).source_tx, row.source_tx); assert.equal(f.app.store.get(row.id).dedupe_cleared_at, null);
  assert.equal(f.app.store.deliveryAttempts(row.id).length, 2); assert.equal(f.app.store.retryInfo(f.app.store.get(row.id)).exhausted, 1);
  assert.equal((await send(f, row, p)).status, 400);
  assert.equal((await preview(f, row)).body.retry.eligible, false);
});

test('lost submission response preserves original cause and reopening requires fresh expiry checks', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const response = await send(f, row, await preview(f, row));
  assert.equal(response.body.manualRetry.phase, 'uncertain'); assert.equal(f.calls.submit, 1);
  const error = response.body.energyOrder.first_submit_error;
  assert.match(error.message, /可用带宽不足/); assert.ok(!error.message.includes(f.c.platformToken)); assert.ok(!error.message.includes(f.c.apiKey));
  const order = f.remote.get(f.app.store.energyOrder(row.id).intent_id); order.status = 'cancelled';
  f.app.engine.acceptEnergyOrder(row.id, order);
  assert.deepEqual(f.app.store.record(row.id).energyOrder.first_submit_error, error);
  f.app.engine.recordEnergySubmitError(row.id, new Error('later')); assert.deepEqual(f.app.store.record(row.id).energyOrder.first_submit_error, error);
  const { Store } = require('../src/store'), reopened = new Store(f.directory);
  assert.equal(reopened.record(row.id).manualRetry.canPrepare, true); reopened.close();
  assert.equal((await preview(f, row)).body.retry.eligible, false); assert.equal(f.calls.sign, 1);
});

test('cancelled never-broadcast retry can start a distinct manual round only after all signatures expire', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer(), original = f.app.store.energyOrder(row.id);
  const first = await failedRound(f, row);
  const firstError = f.app.store.record(row.id).energyOrder.first_submit_error;
  const beforeExpiry = await preview(f, row);
  assert.equal(beforeExpiry.body.retry.eligible, false);
  assert.match(beforeExpiry.body.retry.reason, /过期|节点/);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.admit, 1); assert.equal(f.calls.submit, 1);
  assert.deepEqual(f.app.store.getMeta(markerKey(row)), first.marker);
  expireAttempts(f, row);
  const next = await preview(f, row);
  assert.equal(next.body.retry.eligible, true, next.body.retry.reason);
  assert.notEqual(next.body.retry.confirmationToken, first.preview.body.retry.confirmationToken);
  assert.equal((await send(f, row, first.preview)).status, 400);
  assert.equal(f.calls.sign, 1);
  // A rejected old token consumes that in-memory confirmation; the caller
  // must explicitly prepare again rather than replaying another preview.
  const fresh = await preview(f, row);
  f.options.submitError = false;
  const response = await send(f, row, fresh);
  assert.equal(response.status, 200); assert.equal(response.body.manualRetry.phase, 'submitted');
  const secondMarker = f.app.store.getMeta(markerKey(row));
  assert.match(secondMarker.run_id, /^[a-f0-9-]{36}$/i);
  assert.notEqual(secondMarker.run_id, first.marker.run_id);
  assert.deepEqual(f.app.store.getMeta(historyKey(row)), [first.marker]);
  assert.equal(f.calls.sign, 2); assert.equal(f.calls.submit, 2); assert.equal(f.calls.admit, 2); assert.equal(f.calls.broadcast, 0);
  const saved = f.app.store.energyOrder(row.id);
  assert.equal(saved.intent_id, original.intent_id); assert.equal(saved.order_id, original.order_id);
  assert.equal(saved.price_sun, '950000'); assert.equal(f.app.store.get(row.id).dedupe_cleared_at, null);
  assert.equal(f.app.store.deliveryAttempts(row.id).length, 3);
  assert.equal(f.app.store.retryInfo(f.app.store.get(row.id)).exhausted, 1);
  assert.deepEqual(f.app.store.record(row.id).energyOrder.first_submit_error, firstError);
  assert.equal(f.app.engine.running, false);
  assert.equal((await send(f, row, fresh)).status, 400);
  assert.equal((await preview(f, row)).body.retry.eligible, false);
});

test('multiple stopped rounds append complete immutable markers and keep all signed attempts', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const first = await failedRound(f, row, { expire: true });
  const second = await failedRound(f, row, { expire: true });
  const third = await failedRound(f, row);
  assert.deepEqual(f.app.store.getMeta(historyKey(row)), [first.marker, second.marker]);
  assert.equal(new Set([first.marker.run_id, second.marker.run_id, third.marker.run_id]).size, 3);
  assert.equal(f.app.store.deliveryAttempts(row.id).length, 4);
  assert.equal(f.calls.sign, 3); assert.equal(f.calls.submit, 3); assert.equal(f.calls.broadcast, 0);
  const { Store } = require('../src/store'), reopened = new Store(f.directory);
  assert.deepEqual(reopened.getMeta(historyKey(row)), [first.marker, second.marker]);
  assert.deepEqual(reopened.getMeta(markerKey(row)), third.marker); reopened.close();
});

for (const missing of ['original', 'earlier_round'])
test('missing ' + missing + ' signature history blocks even when the latest round identity still matches', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const first = await failedRound(f, row, { expire: true });
  await failedRound(f, row, { expire: true });
  const current = f.app.store.getMeta(markerKey(row)), latest = f.app.store.deliveryAttempts(row.id).at(-1);
  assert.equal(current.txid, latest.txid); assert.equal(current.txid, f.app.store.get(row.id).txid);
  const removed = missing === 'original' ? row.txid : first.marker.txid;
  f.app.store.db.prepare('DELETE FROM delivery_attempts WHERE txid=?').run(removed);
  const p = await preview(f, row);
  assert.equal(p.body.retry.eligible, false);
  assert.match(p.body.retry.reason, /历史|签名|轮次/);
  assert.equal(f.calls.sign, 2); assert.equal(f.calls.submit, 2);
});

for (const phase of ['submit_started', 'submitted'])
test('archived ' + phase + ' marker blocks a new round despite all current cancellation evidence', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const first = await failedRound(f, row, { expire: true });
  await failedRound(f, row, { expire: true });
  f.app.store.setMeta(historyKey(row), [{ ...first.marker, phase }]);
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  assert.equal(f.calls.sign, 2); assert.equal(f.calls.submit, 2);
});

for (const phase of ['stopped', 'uncertain'])
test('legacy ' + phase + ' marker without run_id or new txid remains eligible after complete old-attempt proof', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const first = await failedRound(f, row, { expire: true });
  const legacy = { phase, at: first.marker.at, reason: 'Legacy interrupted operation', original_txid: row.txid };
  f.app.store.setMeta(markerKey(row), legacy);
  const p = await preview(f, row);
  assert.equal(p.body.retry.eligible, true, p.body.retry.reason);
  const response = await send(f, row, p);
  assert.equal(response.status, 200); assert.equal(response.body.manualRetry.phase, 'uncertain');
  assert.deepEqual(f.app.store.getMeta(historyKey(row)), [legacy]);
  assert.match(f.app.store.getMeta(markerKey(row)).run_id, /^[a-f0-9-]{36}$/i);
  assert.equal(f.calls.sign, 2); assert.equal(f.calls.submit, 2);
});

test('malformed archived marker list is not silently discarded by another retry round', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const first = await failedRound(f, row, { expire: true });
  f.app.store.setMeta(historyKey(row), { old: first.marker });
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
});

for (const phase of ['admission_started', 'signing_started', 'prepared', 'submit_started', 'submitted'])
test('an active ' + phase + ' marker cannot open another round despite cancelled labels', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const first = await failedRound(f, row, { expire: true });
  f.app.store.setMeta(markerKey(row), { ...first.marker, phase });
  assert.equal(f.app.store.record(row.id).manualRetry.canPrepare, false);
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
});

for (const [field, value] of [
  ['status', 'admitted'], ['tx_status', 'unknown'], ['billing_status', 'frozen'],
  ['service_status', 'unknown'], ['broadcast_started', true], ['txid', 'a'.repeat(64)],
  ['amount_raw', '1'], ['recipient', address(4)],
]) test('fresh remote ' + field + ' evidence must still prove the previous round was never broadcast', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  await failedRound(f, row, { expire: true });
  const order = f.remote.get(f.app.store.energyOrder(row.id).intent_id); order[field] = value;
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
});

for (const endpoint of ['wallet/gettransactionbyid', 'wallet/gettransactioninfobyid',
  'walletsolidity/gettransactionbyid', 'walletsolidity/gettransactioninfobyid'])
test('an older signed attempt found at ' + endpoint + ' blocks the new round', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  await failedRound(f, row, { expire: true });
  Object.assign(f.options, { found: true, foundTxid: row.txid, foundEndpoint: endpoint });
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  assert.ok(f.calls.chainQueries.some(call => call.endpoint === endpoint && call.txid === row.txid));
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
});

test('a renewed-round node error or stale confirmed block is not proof of expiry', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  await failedRound(f, row, { expire: true });
  f.options.lookupError = 'walletsolidity/gettransactioninfobyid';
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  f.options.lookupError = null; f.options.solidOffset = -300001;
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
});

test('changed round marker or preserved history invalidates a confirmation before any new admission', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const first = await failedRound(f, row, { expire: true });
  const p = await preview(f, row);
  f.app.store.setMeta(markerKey(row), { ...first.marker, run_id: 'changed-round' });
  assert.equal((await send(f, row, p)).status, 400);
  f.app.store.setMeta(markerKey(row), first.marker);
  const next = await preview(f, row);
  f.app.store.setMeta(historyKey(row), [{ phase: 'uncertain', txid: 'f'.repeat(64) }]);
  assert.equal((await send(f, row, next)).status, 400);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.admit, 1); assert.equal(f.calls.submit, 1);
});

test('mismatched last marker transaction cannot be treated as the cancelled signed attempt', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  const first = await failedRound(f, row, { expire: true });
  f.app.store.setMeta(markerKey(row), { ...first.marker, txid: row.txid });
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.admit, 1);
});

test('second-round concurrent confirmation and changed original parameters cannot sign twice', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer();
  await failedRound(f, row, { expire: true });
  const p = await preview(f, row);
  f.app.store.update(row.id, 'failed', { raw_amount: '1' });
  assert.equal((await send(f, row, p)).status, 400); assert.equal(f.calls.sign, 1);
  f.app.store.update(row.id, 'failed', { raw_amount: row.raw_amount });
  const next = await preview(f, row); assert.equal(next.body.retry.eligible, true, next.body.retry.reason);
  f.options.submitError = false;
  let release; f.gates.admit = new Promise(resolve => { release = resolve; });
  const first = send(f, row, next);
  for (let i = 0; i < 100 && f.calls.admit < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await send(f, row, next)).status, 400); release();
  assert.equal((await first).status, 200);
  assert.equal(f.calls.sign, 2); assert.equal(f.calls.admit, 2); assert.equal(f.calls.submit, 2);
});

for (const option of [{ found: true }, { rpcError: true }]) test('old chain uncertainty blocks without signing ' + Object.keys(option)[0], async t => {
  const f = await fixture(t, option), row = await f.offer(), p = await preview(f, row);
  assert.equal(p.body.retry.eligible, false); assert.equal(f.calls.sign, 0); assert.equal(f.calls.admit, 0);
});

test('extra same-recipient cancelled failure is allowed only after every old signed attempt is verified', async t => {
  const f = await fixture(t), older = await f.offer(address(3), { amount: '9' }), row = await f.offer();
  const p = await preview(f, row); assert.equal(p.body.retry.eligible, true, p.body.retry.reason);
  assert.equal(p.body.retry.histories.length, 2); assert.equal(f.calls.replacement, 2);
  assert.equal(p.body.retry.histories[0].outcome, 'not_broadcast_expired');
  f.app.store.attemptStatus(older.txid, 'confirmed');
  assert.equal((await send(f, row, p)).status, 400); assert.equal(f.calls.sign, 0);
});

async function skippedHistory(f) {
  const older = await f.offer(), row = await f.offer();
  f.app.store.db.prepare('DELETE FROM delivery_attempts WHERE delivery_id=?').run(older.id);
  f.app.store.db.prepare('DELETE FROM energy_orders WHERE delivery_id=?').run(older.id);
  f.app.store.update(older.id, 'skipped_restart', { txid: null, raw_amount: null, wallet: null });
  f.app.store.db.prepare('INSERT OR REPLACE INTO delivery_retry(delivery_id,attempts) VALUES(?,0)').run(older.id);
  return { older, row };
}

test('the observed old skipped and never-signed history permits the current cancelled record', async t => {
  const f = await fixture(t), { row } = await skippedHistory(f), p = await preview(f, row);
  assert.equal(p.body.retry.eligible, true, p.body.retry.reason);
  assert.equal(p.body.retry.histories[0].outcome, 'never_signed'); assert.equal(f.calls.replacement, 1);
});

for (const conflict of ['txid', 'attempt', 'receipt', 'energy', 'retry_count', 'review']) test('skipped history with ' + conflict + ' evidence still blocks', async t => {
  const f = await fixture(t), { older, row } = await skippedHistory(f), db = f.app.store.db;
  if (conflict === 'txid') f.app.store.update(older.id, 'skipped_restart', { txid: older.txid });
  if (conflict === 'attempt') db.prepare("INSERT INTO delivery_attempts(txid,delivery_id,status,created_at) VALUES(?,?,'uncertain',?)").run(older.txid, older.id, new Date().toISOString());
  if (conflict === 'receipt') db.prepare('INSERT INTO delivery_receipts(delivery_id,txid) VALUES(?,?)').run(older.id, older.txid);
  if (conflict === 'energy') f.app.store.energyIntent(older, f.c);
  if (conflict === 'retry_count') db.prepare('UPDATE delivery_retry SET attempts=1 WHERE delivery_id=?').run(older.id);
  if (conflict === 'review') f.app.store.setMeta('delivery-review:' + older.id, { evidence: [{ kind: 'conflict' }] });
  assert.equal((await preview(f, row)).body.retry.eligible, false); assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0);
});

for (const status of ['confirmed', 'executed', 'uncertain', 'archived_unconfirmed']) test('same-recipient ' + status + ' history blocks even from another wallet', async t => {
  const f = await fixture(t), older = await f.offer(), row = await f.offer();
  f.app.store.update(older.id, status, { wallet: address(7) });
  const p = await preview(f, row); assert.equal(p.body.retry.eligible, false); assert.equal(f.calls.sign, 0);
});

test('a bad old signature, legacy success evidence and unknown failure history are refused', async t => {
  const f = await fixture(t), row = await f.offer();
  const original = f.app.store.attempt(row.txid).signed_json;
  const broken = JSON.parse(original); broken.signature[0] = '0'.repeat(130);
  f.app.store.db.prepare('UPDATE delivery_attempts SET signed_json=? WHERE txid=?').run(JSON.stringify(broken), row.txid);
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  f.app.store.db.prepare('UPDATE delivery_attempts SET signed_json=? WHERE txid=?').run(original, row.txid);
  f.app.store.setMeta('delivery-review:' + row.id, { evidence: [{ kind: 'success' }] });
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  assert.equal(f.calls.sign, 0);
});

test('final on-chain failure is not eligible for this manual resend feature', async t => {
  const f = await fixture(t), row = await f.offer();
  f.app.store.attemptStatus(row.txid, 'failed_final');
  assert.equal((await preview(f, row)).body.retry.eligible, false); assert.equal(f.calls.sign, 0);
});

test('saved receipt or attempt resource evidence blocks even if the latest label says cancelled', async t => {
  const f = await fixture(t), row = await f.offer(), db = f.app.store.db;
  db.prepare('INSERT INTO delivery_receipts(delivery_id,txid,energy) VALUES(?,?,?)').run(row.id, row.txid, '1');
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  db.prepare('DELETE FROM delivery_receipts WHERE delivery_id=?').run(row.id);
  db.prepare('UPDATE delivery_attempts SET fee_sun=? WHERE txid=?').run('0', row.txid);
  assert.equal((await preview(f, row)).body.retry.eligible, false); assert.equal(f.calls.sign, 0);
});

test('empty statistics backfill preserves its retry placeholder and allows a freshly verified cancelled order', async t => {
  const f = await fixture(t), row = await f.offer(), store = f.app.store;
  store.update(row.id, 'uncertain'); store.updateEnergyOrder(row.id, { resolved: 0, transaction_status: 'unknown' });
  await f.app.engine.backfillStatistics();
  const before = store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(row.id);
  assert.equal(before.attempts, 1); assert.ok(before.retry_after > Date.now());
  for (const field of ['checked_at', 'block_time', 'energy', 'fee_sun', 'bandwidth']) assert.equal(before[field], null);
  confirmNeverBroadcast(f, row);
  const p = await preview(f, row);
  assert.equal(p.body.retry.eligible, true, p.body.retry.reason); assert.equal(f.calls.replacement, 1);
  assert.equal(f.calls.chainQueries.length, 4); assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0);
  assert.deepEqual(store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(row.id), before);
  assert.equal((await send(f, row, p)).status, 200); assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
  assert.equal(f.calls.broadcast, 0); assert.equal(store.deliveryAttempts(row.id).length, 2);
});

test('a placeholder from an earlier manual round permits recheck only after every saved signature expires', async t => {
  const f = await fixture(t, { submitError: true }), row = await f.offer(), store = f.app.store;
  store.deferReceiptBackfill(row);
  const placeholder = store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(row.id);
  await failedRound(f, row);
  assert.notEqual(store.get(row.id).txid, placeholder.txid);
  assert.equal((await preview(f, row)).body.retry.eligible, false);
  expireAttempts(f, row); const p = await preview(f, row);
  assert.equal(p.body.retry.eligible, true, p.body.retry.reason);
  assert.deepEqual(store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(row.id), placeholder);
  assert.equal(store.deliveryAttempts(row.id).length, 2); assert.equal(f.calls.sign, 1);
});

for (const field of ['checked_at', 'block_time', 'energy', 'fee_sun', 'bandwidth', 'attempts', 'retry_after', 'txid']) {
  test('a backfill row with real or unverified ' + field + ' evidence still blocks retry', async t => {
    const f = await fixture(t), row = await f.offer(), store = f.app.store;
    store.deferReceiptBackfill(row);
    const value = field === 'checked_at' ? new Date().toISOString() : field === 'txid' ? 'f'.repeat(64) : 0;
    store.db.prepare('UPDATE delivery_receipts SET ' + field + '=? WHERE delivery_id=?').run(value, row.id);
    const p = await preview(f, row);
    assert.equal(p.body.retry.eligible, false); assert.match(p.body.retry.reason, /链上回执或消耗证据/);
    assert.equal(f.calls.sign, 0); assert.equal(f.calls.admit, 0); assert.equal(f.calls.submit, 0);
  });
}

test('a matching real receipt without resource metrics remains evidence after a later backfill deferral', async t => {
  const f = await fixture(t), row = await f.offer(), store = f.app.store;
  assert.equal(store.saveReceipt(row, { id: row.txid, receipt: { result: 'SUCCESS' } }), false);
  store.deferReceiptBackfill(row);
  const saved = store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(row.id);
  assert.ok(saved.checked_at); assert.equal(saved.attempts, 1);
  for (const field of ['block_time', 'energy', 'fee_sun', 'bandwidth']) assert.equal(saved[field], null);
  assert.equal((await preview(f, row)).body.retry.eligible, false); assert.equal(f.calls.sign, 0);
});

test('a bare legacy receipt row has unknown provenance and is never treated as a retry placeholder', async t => {
  const f = await fixture(t), row = await f.offer();
  f.app.store.db.prepare('INSERT INTO delivery_receipts(delivery_id,txid) VALUES(?,?)').run(row.id, row.txid);
  assert.equal((await preview(f, row)).body.retry.eligible, false); assert.equal(f.calls.sign, 0);
});

for (const options of [{ found: true }, { rpcError: true }]) test('a statistics placeholder never overrides chain uncertainty ' + Object.keys(options)[0], async t => {
  const f = await fixture(t, options), row = await f.offer(); f.app.store.deferReceiptBackfill(row);
  assert.equal((await preview(f, row)).body.retry.eligible, false); assert.equal(f.calls.sign, 0);
});

test('new receipt evidence after preview invalidates confirmation before admission or signing', async t => {
  const f = await fixture(t), row = await f.offer(); f.app.store.deferReceiptBackfill(row);
  const p = await preview(f, row); assert.equal(p.body.retry.eligible, true, p.body.retry.reason);
  f.app.store.saveReceipt(row, { id: row.txid, receipt: { result: 'SUCCESS' } });
  assert.equal((await send(f, row, p)).status, 400);
  assert.equal(f.calls.admit, 0); assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0);
});

for (const stage of ['admit', 'build', 'sign']) test('pause during ' + stage + ' prevents submission and cannot replay', async t => {
  const f = await fixture(t), row = await f.offer(), p = await preview(f, row);
  let release; f.gates[stage] = new Promise(resolve => { release = resolve; });
  const sending = send(f, row, p);
  for (let i = 0; i < 100 && f.calls[stage === 'admit' ? 'admit' : stage === 'build' ? 'build' : 'sign'] === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await f.request('stop', {}); release(); const result = await sending;
  assert.equal(result.status, 200); assert.equal(f.calls.submit, 0);
  assert.equal(f.calls.sign, stage === 'sign' ? 1 : 0);
  assert.equal((await preview(f, row)).body.retry.eligible, false);
});

test('pause invalidates an unconsumed preview and rejects missing CSRF/session', async t => {
  const f = await fixture(t), row = await f.offer(), p = await preview(f, row);
  assert.equal((await f.request('records/prepare-retry', { id: row.id }, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.request('records/retry', { id: row.id }, { Cookie: '' })).status, 401);
  await f.request('stop', {}); assert.equal((await send(f, row, p)).status, 400); assert.equal(f.calls.sign, 0);
});

test('config and policy price/revision changes require a fresh confirmation', async t => {
  const f = await fixture(t), row = await f.offer(), p = await preview(f, row);
  f.policy.revision++;
  assert.equal((await send(f, row, p)).status, 400); assert.equal(f.calls.sign, 0);
  const next = await preview(f, row);
  await f.request('config', { sendAmount: '169' });
  assert.equal((await send(f, row, next)).status, 400);
});

test('expired preview and duplicate concurrent clicks never admit twice', async t => {
  const f = await fixture(t), row = await f.offer(), p = await preview(f, row);
  f.app.engine.manualRetry.preview.expires = Date.now() - 1;
  assert.equal((await send(f, row, p)).status, 400);
  const next = await preview(f, row);
  let release; f.gates.admit = new Promise(resolve => { release = resolve; });
  const first = send(f, row, next);
  for (let i = 0; i < 100 && !f.calls.admit; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await send(f, row, next)).status, 400); release(); await first;
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.admit, 1); assert.equal(f.calls.submit, 1);
});
