'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { DeliveryReporter, reportPayload, attemptAmount } = require('../src/delivery-reporter');
const { RentalClient } = require('../src/rental-client');
const { createApp } = require('../src/server');
const { atomicJson, effectiveConfig } = require('../src/config');
const { config, address, key } = require('./fixtures');
const linked = () => config({ energyTransport: 'platform', platformUrl: 'https://energy.example', platformToken: 'private-device-token', platformDeviceId: 'device-1', platformWallet: address(1) });
const TIME = Date.parse('2026-11-19T18:32:00Z');
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-report-')), c = linked(), store = new Store(dir), requests = [];
  let now = TIME, sequence = 30;
  const client = { reportDeliveries: async body => { requests.push(structuredClone(body)); return { accepted_txids: body.items.map(item => item.txid), rejected: [] }; } };
  const makeReporter = () => new DeliveryReporter(store, () => c, { factory: () => client, now: () => now, ...options });
  let reporter = makeReporter();
  t.after(async () => { await reporter.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  function offer({ mode = 'live', status = 'confirmed', asset = 'TRC20', owner = address(1), timestamp = TIME, attempt = true, history = false } = {}) {
    sequence++;
    const cfg = effectiveConfig({ ...c, assetType: asset, tokenId: '1000016', trc10SendAmount: '168' });
    store.offer(mode, { to: address(sequence), txid: sequence.toString(16).padStart(64, '0'), asset: 'TRX', amount: '150' }, cfg, 10);
    const row = store.next(mode), txid = sequence.toString(16).padStart(64, 'a');
    store.update(row.id, status, { txid, wallet: owner, raw_amount: '168' });
    if (attempt) store.db.prepare(`INSERT INTO delivery_attempts(txid,delivery_id,wallet,status,created_at,block_time,signed_json)
      VALUES(?,?,?,?,?,?,?)`).run(txid, row.id, owner, status, new Date(now).toISOString(), timestamp, null);
    if (timestamp !== null) store.saveReceipt(store.get(row.id), { id: txid, blockTimeStamp: timestamp,
      receipt: { result: status === 'failed' ? 'REVERT' : 'SUCCESS', energy_usage_total: 65000, net_usage: 300 }, nativeValidated: asset === 'TRC10' });
    if (history) store.update(row.id, 'uncertain', { txid: sequence.toString(16).padStart(64, 'b') });
    return { ...store.get(row.id), txid };
  }
  return { dir, c, store, client, requests, offer, get reporter() { return reporter; }, advance: (ms = 3600001) => { now += ms; },
    reopen: async () => { await reporter.close(); reporter = makeReporter(); } };
}

test('reports unique final successful ordinary, seamless and historical attempts using their chain date', async t => {
  const f = fixture(t), normal = f.offer(), legacy = f.offer({ attempt: false }), history = f.offer({ history: true });
  const seamless = f.offer(); f.store.energyIntent(seamless, f.c);
  f.store.updateEnergyOrder(seamless.id, { txid: seamless.txid, submitted: 1, transaction_status: 'success', route: 'local', billing_status: 'free' });
  f.offer({ status: 'executed' }); f.offer({ status: 'pending' }); f.offer({ status: 'failed' }); f.offer({ mode: 'simulate' });
  f.offer({ timestamp: null });
  await f.reporter.sync();
  const body = f.requests[0]; assert.equal(body.client_version, require('../package.json').version);
  assert.deepEqual(new Set(body.items.map(row => row.txid)), new Set([normal.txid, legacy.txid, history.txid, seamless.txid]));
  assert.ok(body.items.every(row => row.block_time_ms === TIME && row.amount_raw === '168'));
  assert.ok(!JSON.stringify(body).includes('signature')); assert.ok(!JSON.stringify(body).includes(f.c.privateKey)); assert.ok(!JSON.stringify(body).includes(f.c.platformToken));
  assert.equal(f.reporter.snapshot().unreportable, 1);
  f.advance(); await f.reporter.sync(); assert.equal(f.requests[1].items.length, 0);
  assert.equal(f.reporter.snapshot().accepted, 4);
});

test('lost response survives restart, backs off and repeats the same public transaction facts', async t => {
  const f = fixture(t); f.offer(); let calls = 0, first;
  f.client.reportDeliveries = async body => { calls++; first ||= structuredClone(body.items); if (calls === 1) throw new Error('offline ' + f.c.platformToken); return { accepted_txids: body.items.map(row => row.txid), rejected: [] }; };
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().queued, 1); assert.ok(!f.reporter.snapshot().error.includes(f.c.platformToken));
  await f.reopen(); await f.reporter.sync(); assert.equal(calls, 1);
  f.advance(); await f.reporter.sync(); assert.equal(calls, 2); assert.equal(f.reporter.snapshot().accepted, 1);
  const saved = JSON.parse(f.store.db.prepare('SELECT payload FROM platform_delivery_reports').get().payload);
  assert.deepEqual(saved, first[0]);
});

test('partial acknowledgements and unrelated acknowledgements never erase unaccepted transactions', async t => {
  const f = fixture(t), a = f.offer(), b = f.offer();
  f.client.reportDeliveries = async () => ({ accepted_txids: [a.txid], rejected: [] });
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().accepted, 1); assert.equal(f.reporter.snapshot().queued, 1);
  f.advance(); f.client.reportDeliveries = async () => ({ accepted_txids: ['f'.repeat(64)], rejected: [] });
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().queued, 1);
  f.advance(); f.client.reportDeliveries = async () => ({ accepted_txids: [], rejected: [{ txid: b.txid, code: 'transaction_conflict', message: 'mismatch' }] });
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().rejected, 1); assert.equal(f.reporter.snapshot().accepted, 1);
});

test('wallet registration rejection clears stale proof and keeps the transaction retryable', async t => {
  const f = fixture(t, { authorizeOwner: async () => true }), row = f.offer({ asset: 'TRC10', owner: address(8) });
  const marker = 'delivery-report-wallet:' + JSON.stringify([f.c.platformUrl, f.c.platformDeviceId, f.c.platformWallet, address(8)]);
  f.store.setMeta(marker, true);
  f.client.reportDeliveries = async () => ({ accepted_txids: [], rejected: [{ txid: row.txid, code: 'wallet_not_registered' }] });
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().queued, 1); assert.equal(f.reporter.snapshot().rejected, 0);
  assert.equal(f.store.getMeta(marker), false);
  f.advance(); f.client.reportDeliveries = async () => ({ accepted_txids: [row.txid], rejected: [] });
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().accepted, 1);
});

test('invalid numeric and date boundaries cannot poison an otherwise valid report batch', async t => {
  const f = fixture(t), good = f.offer(), future = f.offer({ timestamp: TIME + 300001 }), oversized = f.offer({ asset: 'TRC10' });
  f.store.update(oversized.id, 'confirmed', { raw_amount: '9223372036854775808' });
  await f.reporter.sync(); assert.deepEqual(f.requests[0].items.map(row => row.txid), [good.txid]);
  assert.equal(f.reporter.snapshot().unreportable, 2);
  const payload = { txid: good.txid, owner_address: address(1), recipient_address: address(4), asset_type: 'TRC20', asset_id: address(9), amount_raw: '168', block_time_ms: TIME, delivery_id: good.id };
  assert.equal(reportPayload({ ...payload, block_time_ms: 253402300799001 }, 253402300799001), null);
  assert.equal(reportPayload({ ...payload, amount_raw: (1n << 256n).toString() }, TIME), null);
  assert.equal(reportPayload({ ...payload, delivery_id: 'a'.repeat(101) }, TIME), null);
  assert.equal(reportPayload({ ...payload, recipient_address: payload.owner_address }, TIME), null);
  assert.equal(reportPayload({ ...payload, block_time_ms: TIME + 300000 }, TIME).txid, good.txid);
  assert.ok(future.txid);
});

test('historical attempt amount comes from its hash-verified transaction instead of the replacement amount', () => {
  const { TronWeb, utils } = require('tronweb');
  const raw = { ref_block_bytes: '1234', ref_block_hash: '0123456789abcdef', timestamp: TIME - 60000, expiration: TIME,
    fee_limit: 10000000, contract: [{ type: 'TriggerSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: {
      owner_address: TronWeb.address.toHex(address(1)), contract_address: TronWeb.address.toHex(address(9)),
      data: 'a9059cbb' + TronWeb.address.toHex(address(4)).slice(2).padStart(64, '0') + BigInt(777).toString(16).padStart(64, '0'),
    } } }] };
  const tx = { visible: false, raw_data: raw }, pb = utils.transaction.txJsonToPb(tx);
  tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).toLowerCase(); tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '').toLowerCase();
  const row = { txid: tx.txID, owner_address: address(1), recipient_address: address(4), asset_type: 'TRC20', asset_id: address(9), amount_raw: '999' };
  assert.equal(attemptAmount(row, { signed_json: JSON.stringify(tx) }), '777');
  assert.equal(attemptAmount({ ...row, txid: 'a'.repeat(64) }, { signed_json: JSON.stringify(tx) }), null);
  assert.equal(attemptAmount({ ...row, recipient_address: address(5) }, { signed_json: JSON.stringify(tx) }), null);
});

test('disconnected clients perform no network calls and device changes keep separate durable acknowledgements', async t => {
  const f = fixture(t); f.offer(); f.c.energyTransport = 'local'; await f.reporter.sync(); assert.equal(f.requests.length, 0);
  f.c.energyTransport = 'platform'; await f.reporter.sync(); assert.equal(f.reporter.snapshot().accepted, 1);
  f.c.platformDeviceId = 'device-2'; await f.reporter.sync(); assert.equal(f.requests.length, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM platform_delivery_reports').get().n, 2);
  f.c.platformDeviceId = 'device-1'; f.advance(); await f.reporter.sync(); assert.equal(f.requests[2].items.length, 0);
});

test('TRC10 pool reports wait for ownership proof and never include funding jobs', async t => {
  let unlocked = false;
  const f = fixture(t, { authorizeOwner: async (_client, binding, owner) => { assert.equal(binding.wallet, address(1)); assert.equal(owner, address(8)); return unlocked; } });
  f.offer({ asset: 'TRC10', owner: address(8) });
  f.store.db.exec("CREATE TABLE pool_jobs(txid TEXT,status TEXT); INSERT INTO pool_jobs VALUES('funding-only','confirmed')");
  await f.reporter.sync(); assert.equal(f.requests[0].items.length, 0); assert.equal(f.reporter.snapshot().unlockRequired, true);
  unlocked = true; f.advance(); await f.reporter.sync();
  assert.equal(f.requests[1].items.length, 1); assert.equal(f.requests[1].items[0].asset_type, 'TRC10');
  assert.equal(f.requests[1].items[0].asset_id, '1000016'); assert.equal(f.reporter.snapshot().unlockRequired, false);
});

test('late receipt completion is discovered after earlier history was already acknowledged', async t => {
  const f = fixture(t), early = f.offer({ timestamp: null }); f.offer();
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().accepted, 1);
  f.store.saveReceipt(early, { id: early.txid, blockTimeStamp: TIME - 86400000, receipt: { result: 'SUCCESS', energy_usage_total: 1 } });
  f.advance(); await f.reporter.sync(); assert.equal(f.requests[1].items[0].txid, early.txid); assert.equal(f.requests[1].items[0].block_time_ms, TIME - 86400000);
  assert.equal(f.reporter.snapshot().accepted, 2);
});

test('late receipt insertion requeues a confirmed attempt while its delivery is still under review', async t => {
  const f = fixture(t), row = f.offer({ timestamp: null });
  f.store.update(row.id, 'uncertain');
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().unreportable, 1);
  f.store.db.prepare(`INSERT INTO delivery_receipts(delivery_id,txid,block_time) VALUES(?,?,?)`).run(row.id, row.txid, TIME);
  f.advance(); await f.reporter.sync(); assert.equal(f.reporter.snapshot().accepted, 1);
});

test('historical backlog stays bounded per request and old successful attempts with missing dates remain visible', async t => {
  const f = fixture(t);
  for (let i = 0; i < 26; i++) f.offer();
  f.offer({ history: true, timestamp: null });
  await f.reporter.sync(); assert.equal(f.requests[0].items.length, 20); assert.equal(f.reporter.snapshot().queued, 6);
  assert.equal(f.reporter.snapshot().unreportable, 1);
  f.advance(2001); await f.reporter.sync(); assert.equal(f.requests[1].items.length, 6); assert.equal(f.reporter.snapshot().accepted, 26);
});

test('unsupported platform and an in-flight reporting request leave the delivery engine free to work', async t => {
  const f = fixture(t); f.offer(); let finish, calls = 0;
  f.client.reportDeliveries = body => { calls++; return new Promise(resolve => { finish = () => resolve({ accepted_txids: body.items.map(row => row.txid), rejected: [] }); }); };
  const pass = f.reporter.sync();
  assert.equal(calls, 1); assert.equal(f.reporter.sync(), pass);
  const queued = f.offer({ status: 'queued', timestamp: null, attempt: false });
  f.store.update(queued.id, 'executed'); assert.equal(f.store.get(queued.id).status, 'executed');
  finish(); await pass; assert.equal(f.reporter.snapshot().accepted, 1);
  f.advance(); f.offer(); f.client.reportDeliveries = async () => { throw Object.assign(new Error('not found'), { status: 404 }); };
  await f.reporter.sync(); assert.equal(f.reporter.snapshot().queued, 1);
  const attempts = f.store.db.prepare("SELECT attempts FROM platform_delivery_reports WHERE status='queued'").get().attempts;
  await f.reporter.sync(); assert.equal(f.store.db.prepare("SELECT attempts FROM platform_delivery_reports WHERE status='queued'").get().attempts, attempts);
});

test('client report routes use pinned HTTPS and bearer token without sending a transaction signature', async () => {
  const calls = [], client = new RentalClient('https://energy.example', 'device-secret', { fetch: async (url, options) => {
    calls.push({ url, options }); return { ok: true, text: async () => '{"accepted_txids":[],"rejected":[]}' };
  } });
  await client.reportDeliveries({ client_version: '1.3.7', items: [], pending_count: 0, unreportable_count: 0 });
  assert.equal(calls[0].url, 'https://energy.example/api/energy/device/deliveries/report'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer device-secret');
});

test('server registers only an unlocked pool wallet with a domain and device bound ownership signature', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-report-server-')), c = linked(), registrations = [];
  atomicJson(path.join(dir, 'config.json'), c);
  const client = { async policy() { throw new Error('not needed'); }, async reportDeliveries(body) { return { accepted_txids: body.items.map(row => row.txid), rejected: [] }; },
    async registerDeliveryWallet(body) { registrations.push(body); return { registered: true, owner_address: body.owner_address }; } };
  const app = await createApp({ dataDir: dir, automaticUpdates: false, rentalFactory: () => client });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  app.pool.vault.initialize('isolated-report-test-password');
  app.pool.vault.session.data.wallets.push({ id: 'pool-id', address: address(8), key: key(8), batchId: 'batch', createdAt: new Date().toISOString() });
  app.store.db.prepare('INSERT INTO pool_wallets(id,address,batch_id,created_at) VALUES(?,?,?,?)').run('pool-id', address(8), 'batch', new Date().toISOString());
  const binding = app.deliveryReporter.binding();
  assert.equal(await app.deliveryReporter.authorizeOwner(client, binding, address(8)), true);
  const proof = registrations[0], message = `TCL delivery statistics wallet\nv1\nhttps://energy.example\ndevice-1\n${address(8)}`;
  assert.equal(require('tronweb').Trx.verifyMessageV2(message, proof.signature), address(8));
  assert.deepEqual(Object.keys(proof).sort(), ['owner_address', 'signature']);
  app.pool.vault.lock(); assert.equal(await app.deliveryReporter.authorizeOwner(client, binding, address(8)), true);
  assert.equal(await app.deliveryReporter.authorizeOwner(client, binding, address(7)), null);
  assert.equal(registrations.length, 1);
});

test('TRC10 keeps its local delivery route when the linked platform has seamless mode', async t => {
  const f = fixture(t), c = effectiveConfig({ ...f.c, assetType: 'TRC10', tokenId: '1000016', trc10SendAmount: '168', maxPerRun: 0 });
  const engine = new Engine(f.store, () => c);
  engine.config = c; engine.mode = 'live'; engine.running = true; engine.chain = { wallet: address(1) };
  engine.energyPolicy = { linked: () => true, refreshForSend: async () => 'seamless', requireMode: () => 'seamless' };
  let local = 0; engine.deliver = async () => { local++; return true; }; engine.deliverSeamless = async () => { throw new Error('must not request TRC20 rental'); };
  f.store.offer('live', { to: address(3), txid: '7'.repeat(64), asset: 'TRX', amount: '150' }, c, 10);
  try { assert.equal(await engine.sendNext(), true); assert.equal(local, 1); } finally { await engine.close(); }
});
