'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { createApp } = require('../src/server');
const { atomicJson } = require('../src/config');
const { parseAddresses } = require('../src/manual-batches');
const { config, FakeChain, address, trxBlock } = require('./fixtures');

function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-manual-batches-'));
  const c = config({ maxPerRun: 0, sendIntervalSeconds: 1, ...extra }), store = new Store(directory), chain = new FakeChain(c);
  const engine = new Engine(store, () => c, () => chain, { executionWaitMs: 0, receiptPollMs: 1, retryDelayMs: 0 });
  t.after(async () => { await engine.close(); store.close(); fs.rmSync(directory, { force: true, recursive: true }); });
  const offer = (n, mode = 'live') => {
    store.offer(mode, { to: address(n), txid: n.toString(16).padStart(64, '0'), asset: 'TRX', amount: '150' }, c, 10);
    return store.db.prepare('SELECT * FROM deliveries WHERE mode=? AND address=?').get(mode, address(n));
  };
  const prepare = (numbers, mode = 'live') => engine.manualBatches.prepare({ text: numbers.map(address).join('\n'), mode });
  const submit = p => engine.manualBatches.submit({ confirmationToken: p.confirmationToken, confirmed: true });
  const start = async () => { engine.loop = async () => {}; await engine.start('live'); };
  return { directory, c, store, chain, engine, offer, prepare, submit, start };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for isolated test state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('TXT and single-column CSV preserve every entry for validation and enforce import limits', () => {
  assert.deepEqual(parseAddresses('\uFEFFaddress\r\n"' + address(3) + '"\r\n' + address(4) + ',' + address(3) + ';bad'), [address(3), address(4), address(3), 'bad']);
  assert.throws(() => parseAddresses(''), /填写/);
  assert.throws(() => parseAddresses('x'.repeat(1024 * 1024 + 1)), /1 MB/);
  assert.throws(() => parseAddresses(Array(10001).fill(address(3)).join('\n')), /最多/);
});

test('preview separates invalid, duplicate, owned, blacklisted and deduped addresses without creating transfers', async t => {
  const f = fixture(t, { blacklist: [address(6)], sendAmount: '0.123456789012345678' });
  const old = f.offer(7); f.store.update(old.id, 'confirmed');
  const p = await f.engine.manualBatches.prepare({ text: [address(3), address(4), address(3), address(1), address(6), address(7), 'invalid'].join('\n'), mode: 'live' });
  assert.deepEqual(p.counts, { input: 7, invalid: 1, duplicate: 1, blocked: 2, existing: 1, promoted: 0, added: 2 });
  assert.equal(p.totalAmount, '0.246913578024691356');
  assert.equal(f.store.records().total, 1); assert.equal(f.engine.manualBatches.list().total, 0);
  assert.equal(f.chain.signed, 0); assert.equal(f.chain.broadcasts, 0);
  assert.ok(!JSON.stringify(p).includes(f.c.privateKey));
});

test('a confirmed idle batch is admitted after restart skipping and before the first sender claims work', async t => {
  const f = fixture(t); const old = f.offer(8);
  let first;
  f.engine.loop = async () => { first = f.store.next('live'); };
  const p = await f.prepare([4, 5]); const result = await f.submit(p);
  assert.equal(f.store.get(old.id).status, 'skipped_restart');
  assert.equal(first.address, address(4)); assert.equal(first.manual_batch_id, result.id);
  assert.equal(f.engine.running, true); assert.equal(f.store.queueSummary('live', f.c).manual, 2);
  assert.equal(f.chain.broadcasts, 0);
  assert.equal(f.engine.manualBatches.list().items[0].counts.queued, 2);
});

test('running batches promote matching queued scan records, preserving the source and input order', async t => {
  const f = fixture(t); await f.start(); const normal = f.offer(3), promote = f.offer(4);
  const p = await f.prepare([5, 4]); assert.equal(p.counts.promoted, 1);
  const result = await f.submit(p);
  assert.equal(f.store.records().total, 3); assert.equal(f.store.get(promote.id).source_tx, promote.source_tx);
  assert.equal(f.store.get(promote.id).manual_batch_id, result.id);
  assert.equal(f.store.next('live', f.c).address, address(5)); await f.engine.sendNext();
  assert.equal(f.store.next('live', f.c).id, promote.id); await f.engine.sendNext();
  assert.equal(f.store.next('live', f.c).id, normal.id); await f.engine.sendNext();
  assert.equal(f.chain.broadcasts, 3); assert.equal(f.engine.metrics.sent, 3);
  assert.equal(f.store.hasRecipient('live', address(4), 'new-scan-trigger', f.c), true);
  assert.equal(f.store.records({ search: result.id }).total, 2);
});

test('current delivery is never promoted or duplicated, and later batches stay behind an earlier manual batch', async t => {
  const f = fixture(t); await f.start(); const active = f.offer(3);
  f.engine.activeDeliveryId = active.id;
  const p = await f.prepare([3, 4]); assert.equal(p.counts.existing, 1); await f.submit(p);
  await f.submit(await f.prepare([5]));
  assert.equal(f.store.get(active.id).source_kind, 'scan'); assert.equal(f.store.next('live', f.c).address, address(4));
  f.engine.activeDeliveryId = null;
  await f.engine.sendNext(); assert.equal(f.store.next('live', f.c).address, address(5));
});

test('late scanner admission is merged at submit, while late execution is excluded', async t => {
  const f = fixture(t); await f.start(); const p = await f.prepare([4, 5]);
  const promoted = f.offer(4), done = f.offer(5); f.store.update(done.id, 'executed', { txid: 'f'.repeat(64) });
  const result = await f.submit(p);
  assert.equal(result.count, 1); assert.equal(result.promoted, 1); assert.equal(result.changed, 1);
  assert.equal(f.store.get(promoted.id).source_kind, 'manual'); assert.equal(f.store.records().total, 2);
});

test('retrying the same confirmation after response loss or reopening never requeues or restarts', async t => {
  const f = fixture(t); await f.start(); const p = await f.prepare([4]); const result = await f.submit(p);
  f.engine.stop(); await f.engine.loopPromise;
  assert.deepEqual(await f.submit(p), { id: result.id, count: 1, duplicate: true });
  assert.equal(f.engine.running, false); assert.equal(f.store.records().total, 1);
  const reopened = new Store(f.directory), next = new Engine(reopened, () => f.c, () => f.chain);
  try {
    assert.equal((await next.manualBatches.submit({ confirmationToken: p.confirmationToken, confirmed: true })).duplicate, true);
    assert.equal(next.running, false); assert.equal(next.manualBatches.list().total, 1);
  } finally { await next.close(); reopened.close(); }
});

test('missing consent, changed configuration, changed run and expired preview cannot enqueue', async t => {
  const f = fixture(t); await f.start(); let p = await f.prepare([4]);
  await assert.rejects(f.engine.manualBatches.submit({ confirmationToken: p.confirmationToken }), /确认/);
  f.c.sendAmount = '169'; await assert.rejects(f.submit(p), /变化/);
  p = await f.prepare([4]); f.engine.manualBatches.preview.expires = Date.now() - 1; await assert.rejects(f.submit(p), /过期/);
  p = await f.prepare([4]); f.engine.stop(); f.engine.state = 'stopped'; await assert.rejects(f.submit(p), /过期/);
  assert.equal(f.engine.manualBatches.list().total, 0); assert.equal(f.chain.broadcasts, 0);
});

test('failed startup leaves the old queue intact and creates no approved batch', async t => {
  const f = fixture(t), old = f.offer(3), p = await f.prepare([4]);
  const resources = f.chain.resources.bind(f.chain); f.chain.resources = async () => ({ ...await resources(), energy: 0 });
  await assert.rejects(f.submit(p), /能量/);
  assert.equal(f.store.get(old.id).status, 'queued'); assert.equal(f.engine.manualBatches.list().total, 0); assert.equal(f.chain.broadcasts, 0);
});

test('cancelling a batch affects only its unclaimed queue, preserving active work and scanned work', async t => {
  const f = fixture(t); await f.start(); const scanned = f.offer(3);
  const result = await f.submit(await f.prepare([4, 5])); const active = f.store.next('live', f.c); f.engine.activeDeliveryId = active.id;
  const cancelled = f.engine.manualBatches.cancel(result.id);
  assert.equal(cancelled.count, 1); assert.equal(f.store.get(active.id).status, 'queued'); assert.equal(f.store.get(scanned.id).status, 'queued');
  assert.equal(f.store.hasRecipient('live', address(5), 'later-scan', f.c), true);
  f.engine.activeDeliveryId = null; await f.engine.sendNext(); assert.equal(f.store.next('live', f.c).id, scanned.id);
});

test('restart skip/resend policies apply to manual batches and preserve their history', async t => {
  for (const policy of ['skip', 'resend']) {
    const f = fixture(t, { unfinishedPolicy: policy }); await f.start(); const result = await f.submit(await f.prepare([4]));
    f.engine.stop(); await f.engine.loopPromise; f.engine.state = 'stopped'; await f.engine.start('live');
    const batch = f.engine.manualBatches.list().items.find(b => b.id === result.id);
    assert.equal(batch.counts[policy === 'skip' ? 'skipped_restart' : 'queued'], 1);
    assert.equal(f.chain.broadcasts, 0);
  }
});

test('manual queued work outranks due scanner retries, without changing the retry budget', async t => {
  const f = fixture(t); await f.start(); const scan = f.offer(3);
  const signed = await f.chain.buildAndSign(scan, 18); f.store.prepareAttempt(scan, signed); f.store.beginAttempt(f.store.get(scan.id));
  f.store.update(scan.id, 'uncertain');
  const attempts = f.store.retryInfo(f.store.get(scan.id)).attempts;
  await f.submit(await f.prepare([4])); await f.engine.sendNext();
  assert.equal(f.store.get(scan.id).status, 'uncertain'); assert.equal(f.store.retryInfo(f.store.get(scan.id)).attempts, attempts);
  assert.equal([...f.chain.transfers.values()].at(-1).address, address(4));
});

test('new priority work never shortens the previous send interval and scanning continues into the normal queue', async t => {
  const f = fixture(t, { maxPerRun: 4, pollSeconds: 2 }), sent = [], executed = [];
  f.chain.block = async h => trxBlock(h, address(h === 11 ? 3 : 6), h.toString(16).padStart(64, 'c'));
  const broadcast = f.chain.broadcast.bind(f.chain), receipt = f.chain.receipt.bind(f.chain);
  f.chain.broadcast = async signed => { sent.push({ address: f.chain.transfers.get(signed.txid).address, at: Date.now() }); return broadcast(signed); };
  f.chain.executionReceipt = async id => { const result = await receipt(id); executed.push(Date.now()); return result; };
  f.chain.receipt = async () => ({});
  await f.engine.start('live'); await until(() => executed.length === 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  await f.submit(await f.prepare([4, 5]));
  f.chain.headValue = 12;
  await f.engine.scanOne(12);
  assert.equal(f.engine.height, 12); assert.equal(f.engine.metrics.matched, 2);
  assert.deepEqual(f.store.queueSummary('live', f.c), { manual: 2, scan: 1 });
  await f.engine.loopPromise;
  assert.deepEqual(sent.map(row => row.address), [3, 4, 5, 6].map(address));
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - executed[i - 1] >= 990, 'Import must not wake a sender out of its rate-limit interval');
  assert.equal(f.chain.broadcasts, 4); assert.equal(f.store.pending().length, 4);
});

test('simulation batches never sign and do not consume the live recipient namespace', async t => {
  const f = fixture(t, { maxPerRun: 2 }); f.chain.headValue = 10;
  const p = await f.prepare([4, 5], 'simulate'); await f.submit(p); await f.engine.loopPromise;
  assert.equal(f.chain.signed, 0); assert.equal(f.chain.broadcasts, 0); assert.equal(f.engine.metrics.simulated, 2);
  assert.equal(f.store.hasRecipient('live', address(4), 'new', f.c), false);
});

test('batch list paginates, records omit confirmation secrets, and legacy rows default to scan priority', async t => {
  const f = fixture(t); await f.start();
  for (let i = 0; i < 11; i++) await f.submit(await f.prepare([20 + i]));
  const first = f.engine.manualBatches.list(), second = f.engine.manualBatches.list(2);
  assert.equal(first.total, 11); assert.equal(first.items.length, 10); assert.equal(second.items.length, 1);
  assert.equal(first.items[0].confirmation_hash, undefined);
  const scanned = f.offer(3); assert.equal(scanned.source_kind, 'scan'); assert.equal(scanned.manual_batch_id, null);
});

async function apiFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-manual-api-'));
  const c = config({ maxPerRun: 0 }); atomicJson(path.join(directory, 'config.json'), c);
  const chain = new FakeChain(c), app = await createApp({ dataDir: directory, chainFactory: () => chain, automaticUpdates: false, automaticRuntime: false });
  const base = `http://127.0.0.1:${app.port}`;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(base + '/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: {
      Cookie: 'tcl_session=' + app.token, Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json', ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { app, chain, request };
}

test('batch API enforces authentication, confirmation and idempotency, and supports a running campaign', async t => {
  const f = await apiFixture(t);
  assert.equal((await f.request('manual-batches', undefined, { Cookie: '' })).status, 401);
  assert.equal((await f.request('manual-batches/prepare', { text: address(4), mode: 'live' }, { Origin: 'https://other.example' })).status, 403);
  f.app.engine.loop = async () => {}; await f.app.engine.start('live');
  const p = await f.request('manual-batches/prepare', { text: address(4), mode: 'live' }); assert.equal(p.status, 200);
  assert.equal((await f.request('manual-batches/submit', { confirmationToken: p.body.confirmationToken })).status, 400);
  const input = { confirmationToken: p.body.confirmationToken, confirmed: true };
  const result = await f.request('manual-batches/submit', input); assert.equal(result.status, 200);
  assert.equal((await f.request('manual-batches/submit', input)).body.duplicate, true);
  assert.equal((await f.request('manual-batches')).body.items[0].counts.queued, 1);
  assert.equal((await f.request('manual-batches/cancel', { id: result.body.id })).body.count, 1);
  assert.equal(f.chain.broadcasts, 0);
});

test('local pause cancels a slow batch startup before queue admission, and configuration stays locked', async t => {
  const f = await apiFixture(t), p = await f.request('manual-batches/prepare', { text: address(4), mode: 'live' });
  let release, waiting = false;
  f.chain.head = async () => { waiting = true; return new Promise(resolve => { release = () => resolve(10); }); };
  const starting = f.request('manual-batches/submit', { confirmationToken: p.body.confirmationToken, confirmed: true });
  await until(() => waiting);
  assert.equal((await f.request('config', { sendAmount: '999' })).status, 400);
  assert.equal((await f.request('stop', {})).status, 200);
  release(); assert.equal((await starting).status, 400);
  assert.equal(f.app.store.records().total, 0); assert.equal(f.app.engine.manualBatches.list().total, 0);
  assert.equal(f.chain.broadcasts, 0); assert.equal(f.app.engine.running, false);
});
