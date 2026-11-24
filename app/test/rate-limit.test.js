'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { NodeAccess, NodeCapacityError, isRateLimitError, COOLDOWN_MS } = require('../src/node-access');
const { Chain } = require('../src/chain');
const { Engine } = require('../src/engine');
const { Store } = require('../src/store');
const { config, FakeChain, address, trxBlock } = require('./fixtures');
const rate = () => Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } });
const timing = { delay: 0, publicDelay: 0 };

test('capacity detection accepts HTTP and quota responses but excludes execution and ordinary errors', () => {
  for (const error of [rate(), { Error: 'Too many requests' }, { code: 'RATE_LIMIT_EXCEEDED' },
    { Error: 'The key exceeds the frequency limit' }, { result: { message: Buffer.from('daily quota exhausted').toString('hex') } },
    new NodeCapacityError(), { response: { status: 403, data: { Error: 'daily usage limit exceeded' } } }]) assert.equal(isRateLimitError(error), true);
  for (const error of [new Error('offline'), { code: 'OUT_OF_ENERGY' }, { receipt: { result: 'REVERT' } }, { result: true }]) assert.equal(isRateLimitError(error), false);
});
test('key quota failure switches to a credential-free client and remains public for subsequent calls', async () => {
  const c = config({ apiKey: 'synthetic-test-key' }), before = JSON.stringify(c), options = [], calls = [], events = [];
  const chain = new Chain(c, { ...timing, onEvent: (...event) => events.push(event), createClient: opts => {
    options.push(opts); const keyed = Boolean(opts.headers['TRON-PRO-API-KEY']);
    return { setAddress() {}, trx: { getConfirmedCurrentBlock: async () => { calls.push(keyed); if (keyed) throw rate(); return trxBlock(20); } } };
  } });
  assert.equal(await chain.head(), 20); assert.equal(await chain.head(), 20);
  assert.deepEqual(calls, [true, false, false]); assert.deepEqual(options[1].headers, {});
  assert.ok(options.every(o => !o.privateKey)); assert.equal(JSON.stringify(c), before);
  assert.equal(chain.nodeStatus().source, 'public'); assert.equal(chain.nodeStatus().fallback, true);
  assert.equal(events.length, 1); assert.match(events[0][1], /切换公共节点/);
  assert.ok(!JSON.stringify(chain.nodeStatus()).includes(c.apiKey));
});
test('shared cooldown blocks repeated foreground/background requests and recovers after Retry-After', async () => {
  const sessions = new Map(), c = config({ apiKey: 'synthetic-test-key' }); let now = 1000, calls = 0;
  const a = new NodeAccess(c, { ...timing, sessions, now: () => now });
  const limited = () => { calls++; const error = rate(); error.response.headers = { 'retry-after': '120' }; throw error; };
  await assert.rejects(a.run(limited), error => error.code === 'NODE_CAPACITY' && error.retryAt === 121000);
  assert.equal(calls, 2);
  const b = new NodeAccess(c, { ...timing, sessions, now: () => now });
  await assert.rejects(b.run(limited), NodeCapacityError); assert.equal(calls, 2);
  assert.equal(b.source, 'public'); now = 121001;
  assert.equal(await b.run(() => 'recovered'), 'recovered'); assert.equal(a.snapshot().state, 'ready');
});
test('anonymous TronGrid is already public: one rate request, then cooldown, without fake fallback', async () => {
  const access = new NodeAccess(config(), timing); let calls = 0;
  await assert.rejects(access.run(() => { calls++; throw rate(); }), NodeCapacityError);
  assert.equal(calls, 1); assert.equal(access.source, 'public'); assert.equal(access.snapshot().fallback, false);
});
test('stalled statistics queue cannot delay a foreground request but still shares fallback and cooldown', async () => {
  const sessions = new Map(), c = config({ apiKey: 'test' });
  const foreground = new NodeAccess(c, { ...timing, sessions });
  const background = new NodeAccess(c, { ...timing, sessions, queueGroup: 'statistics' });
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = background.run(async () => {
    if (background.source === 'primary') { entered(); await gate; throw rate(); }
    return 'statistics';
  });
  await ready;
  try {
    assert.equal(await foreground.run(() => {
      if (foreground.source === 'primary') throw rate(); return 'sent';
    }), 'sent');
    assert.equal(background.source, 'public');
  } finally { release(); }
  assert.equal(await waiting, 'statistics'); assert.equal(foreground.snapshot().state, 'ready');
  await assert.rejects(background.run(() => { throw rate(); }), NodeCapacityError);
  let called = false;
  await assert.rejects(foreground.run(() => { called = true; }), NodeCapacityError); assert.equal(called, false);
});
test('unknown RPC networks never fallback to mainnet and non-capacity errors do not switch', async () => {
  const custom = new NodeAccess(config({ rpcUrl: 'https://nile.trongrid.io', apiKey: 'test' }), timing); let calls = 0;
  await assert.rejects(custom.run(() => { calls++; throw rate(); }), NodeCapacityError);
  assert.equal(calls, 1); assert.equal(custom.source, 'custom');
  const primary = new NodeAccess(config({ apiKey: 'test' }), timing);
  await assert.rejects(primary.run(() => { throw new Error('timeout'); }), /timeout/); assert.equal(primary.source, 'primary');
});
test('token reads after fallback bind to the public contract, including already-cached contracts', async () => {
  let limited = false; const calls = [];
  const chain = new Chain(config({ apiKey: 'test' }), { ...timing, createClient: opts => {
    const keyed = Boolean(opts.headers['TRON-PRO-API-KEY']);
    return { setAddress() {}, contract: () => ({ at: async () => ({ balanceOf: () => ({ call: async () => {
      calls.push(keyed); if (limited && keyed) throw rate(); return 100n;
    } }) }) }) };
  } });
  assert.equal(await chain.tokenBalance(), '100'); limited = true;
  assert.equal(await chain.tokenBalance(), '100'); assert.equal(await chain.tokenBalance(), '100');
  assert.deepEqual(calls, [true, true, false, false]);
});
test('fallback broadcasts the identical saved payload once per node and never retries uncertain responses', async () => {
  const payload = { fake: true, txID: 'a'.repeat(64) }, seen = [];
  const chain = new Chain(config({ apiKey: 'test' }), { ...timing, createClient: opts => {
    const keyed = Boolean(opts.headers['TRON-PRO-API-KEY']);
    return { setAddress() {}, trx: { sendRawTransaction: async signed => { seen.push(signed); return keyed ? { Error: 'daily quota exhausted' } : { result: true }; } } };
  } });
  assert.deepEqual(await chain.broadcast(payload), { result: true }); assert.deepEqual(seen, [payload, payload]);
  let calls = 0; chain.tron.trx.sendRawTransaction = async () => { calls++; throw new Error('lost response'); };
  await assert.rejects(chain.broadcast(payload), /lost response/); assert.equal(calls, 1);
});
test('replacement lookups use the active node after switching, without dropping expiry checks', async () => {
  const seen = [], expiration = Date.now() - 120000;
  const chain = new Chain(config({ apiKey: 'test' }), { ...timing, createClient: opts => {
    const keyed = Boolean(opts.headers['TRON-PRO-API-KEY']);
    const request = async endpoint => { seen.push([keyed, endpoint]); if (keyed) throw rate(); return {}; };
    return { setAddress() {}, trx: { getConfirmedCurrentBlock: async () => ({ block_header: { raw_data: { number: 12345, timestamp: Date.now() } } }) }, fullNode: { request }, solidityNode: { request } };
  } });
  assert.equal(await chain.replacementReady('a'.repeat(64), expiration), true);
  assert.equal(seen.length, 5); assert.ok(seen.slice(1).every(item => item[0] === false));
});
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-capacity-')), c = config({ maxPerRun: 0 });
  const store = new Store(dir), chain = new FakeChain(c);
  const engine = new Engine(store, () => c, () => chain, { executionWaitMs: 0, retryDelayMs: 0 });
  engine.loop = async () => {}; await engine.start('live');
  clearInterval(engine.confirmationTimer); clearInterval(engine.statisticsTimer);
  engine.wait = async () => {};
  t.after(async () => { await engine.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.offer('live', { to: address(3), txid: 'a'.repeat(64), asset: 'TRX', amount: '150' }, c, 11);
  return { c, store, chain, engine, row: store.next('live') };
}
for (const method of ['resources', 'tokenBalance', 'buildAndSign']) test(`${method} capacity failures do not consume attempts or stop delivery and recover automatically`, async t => {
  const { store, chain, engine, row } = await fixture(t), original = chain[method].bind(chain);
  chain[method] = async () => { throw new NodeCapacityError(); };
  for (let i = 0; i < 6; i++) await engine.sendNext();
  assert.equal(store.retryInfo(row).attempts, 0); assert.equal(chain.broadcasts, 0);
  assert.equal(engine.failureStreak(), 0); assert.equal(engine.running, true); assert.equal(engine.failure, null);
  chain[method] = original; await engine.sendNext();
  assert.equal(store.retryInfo(row).attempts, 1); assert.equal(engine.metrics.sent, 1);
});
test('explicit broadcast rate rejection refunds the reservation but preserves the signature for recovery', async t => {
  const { store, chain, engine, row } = await fixture(t), original = chain.broadcast.bind(chain);
  chain.receipt = chain.executionReceipt = async () => ({});
  chain.broadcast = async () => { throw new NodeCapacityError(); };
  for (let i = 0; i < 5; i++) await engine.sendNext();
  assert.equal(store.retryInfo(row).attempts, 0); assert.equal(chain.signed, 1); assert.ok(store.get(row.id).txid);
  assert.equal(engine.failureStreak(), 0); assert.equal(engine.running, true);
  chain.broadcast = original;
  chain.executionReceipt = id => chain.broadcasts ? FakeChain.prototype.receipt.call(chain, id) : {};
  await engine.sendNext(); assert.equal(chain.broadcasts, 1); assert.equal(chain.signed, 1);
  assert.equal(store.retryInfo(row).attempts, 1); assert.equal(engine.metrics.sent, 1);
});
test('rate limit after acceptance and during receipt/expiry checks never replays or exhausts an existing transaction', async t => {
  const { store, chain, engine, row } = await fixture(t);
  chain.executionReceipt = async () => { throw new NodeCapacityError(); };
  await engine.sendNext(); assert.equal(chain.broadcasts, 1); assert.equal(store.retryInfo(row).attempts, 1);
  chain.receipt = async () => { throw new NodeCapacityError(); };
  for (let i = 0; i < 5; i++) await engine.sendNext();
  assert.equal(chain.broadcasts, 1); assert.equal(chain.signed, 1); assert.equal(store.retryInfo(row).attempts, 1);
  await engine.confirmExecuted(); assert.equal(engine.failure, null); assert.equal(engine.confirmationErrors, 0);
  assert.equal(engine.confirmingIds.size, 0); assert.equal(store.retryInfo(row).exhausted, 0);
  chain.receipt = chain.executionReceipt = async () => ({});
  store.db.prepare('UPDATE delivery_attempts SET expiration=? WHERE delivery_id=?').run(Date.now() - 1000, row.id);
  chain.replacementReady = async () => { throw new NodeCapacityError(); };
  await engine.sendNext(); assert.equal(chain.signed, 1); assert.equal(chain.broadcasts, 1);
  chain.receipt = id => FakeChain.prototype.receipt.call(chain, id);
  await engine.sendNext(); assert.equal(engine.metrics.sent, 1); assert.equal(chain.broadcasts, 1);
});
test('capacity waiting is interruptible so pause/upgrade can proceed without broadcasting', async t => {
  const { chain, engine, store, row } = await fixture(t);
  engine.wait = Engine.prototype.wait; chain.resources = async () => { throw new NodeCapacityError(); };
  const sending = engine.sendNext(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(engine.waiters.size); engine.stop(); await sending;
  assert.equal(engine.waiters.size, 0); assert.equal(store.retryInfo(row).attempts, 0); assert.equal(chain.broadcasts, 0);
});
test('capacity recovery preserves scan height and catches up even if cooldown created a larger backlog', async t => {
  const { chain, engine, store } = await fixture(t); engine.config.maxCatchUpBlocks = 1;
  let heads = 0; const blocks = [], waits = [];
  chain.head = async () => { if (++heads === 1) throw new NodeCapacityError(Date.now() + COOLDOWN_MS); return 13; };
  chain.block = async h => { blocks.push(h); return { block_header: { raw_data: { number: h } }, transactions: [] }; };
  engine.wait = async ms => { waits.push(ms); if (engine.height === 13) engine.stop(); };
  await engine.scanLoop(); assert.deepEqual(blocks, [11, 12, 13]); assert.ok(waits[0] >= 59000);
  assert.equal(store.getMeta(engine.cursorKey), 13); assert.equal(engine.failure, null);
});
test('a lagging public replica does not rewind or stop the scanner', async t => {
  const { chain, engine, store } = await fixture(t); let heads = 0;
  chain.head = async () => ++heads === 1 ? 9 : 11;
  engine.wait = async () => { if (engine.height === 11) engine.stop(); };
  await engine.scanLoop(); assert.equal(store.getMeta(engine.cursorKey), 11); assert.equal(engine.failure, null);
});
test('preflight and background clients reuse capacity state without exposing credentials in UI status', async t => {
  const { c, engine } = await fixture(t); engine.chains.clear(); c.apiKey = 'synthetic-test-key';
  engine.factory = config => new Chain(config, { ...timing, sessions: engine.nodeSessions, createClient: () => ({ setAddress() {}, trx: { getConfirmedCurrentBlock: async () => { throw rate(); } } }) });
  await assert.rejects(engine.preflight(), NodeCapacityError);
  const status = engine.snapshot().node; assert.equal(status.state, 'cooldown'); assert.equal(status.source, 'public');
  assert.ok(!JSON.stringify(status).includes(c.apiKey));
  assert.equal(engine.getChain(c), engine.getChain(c));
  c.apiKey = 'new-synthetic-key'; assert.equal(engine.nodeStatus().state, 'ready'); assert.equal(engine.nodeStatus().source, 'primary');
});
