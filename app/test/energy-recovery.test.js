'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { createApp } = require('../src/server');
const { normalize, validate, fingerprint, atomicJson } = require('../src/config');
const { config, address, trxBlock, FakeChain } = require('./fixtures');

async function until(predicate) {
  for (let n = 0; n < 1000; n++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), 'expected engine state was not reached');
}
function gate() {
  let enter, release;
  return { entered: new Promise(r => { enter = r; }), wait: new Promise(r => { release = r; }), enter: () => enter(), release: () => release() };
}
async function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-energy-'));
  const c = config({ autoResumeEnergy: true, maxPerRun: 0, minEnergy: 100, ...extra });
  const store = new Store(dir), chain = new FakeChain(c), checked = await chain.preflight();
  const engine = new Engine(store, () => c, () => chain);
  const resource = { ...checked.resources, energy: 0 };
  let reads = 0, head = 20, seed = true;
  chain.resources = async () => { reads++; return { ...resource, checkedAt: new Date().toISOString() }; };
  chain.head = async () => head;
  // Run the real sender and startup policy with a deterministic scanner feed.
  engine.scanLoop = async () => { if (seed) { seed = false; offer(3, engine.mode); } };
  engine.startBackgroundConfirmation = () => {};
  function offer(n, mode = 'live') {
    store.offer(mode, { to: address(n), txid: n.toString(16).padStart(64, '0'), asset: 'TRX', amount: '150' }, c, head);
    return store.db.prepare('SELECT * FROM deliveries WHERE source_tx=?').get(n.toString(16).padStart(64, '0'));
  }
  t.after(async () => { await engine.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { c, dir, store, chain, engine, resource, offer, reads: () => reads, head: value => { head = value; },
    begin: async (mode = 'live') => { await engine.start(mode, checked); await engine.loopPromise; } };
}

test('energy recovery is opt-in, strictly boolean and uses a 120 second interval', async t => {
  assert.equal(normalize({}).autoResumeEnergy, false);
  validate(config({ autoResumeEnergy: true }));
  for (const value of ['false', 1, null]) assert.throws(() => validate(config({ autoResumeEnergy: value })), /开关/);
  const f = await fixture(t);
  assert.equal(f.c.energyRecoverySeconds, 120);
  assert.equal(f.engine.energyRecovery, null);
  assert.equal(f.engine.state, 'stopped');
});

test('energy check intervals are configurable and strictly validated', async t => {
  assert.equal(normalize({}).energyRecoverySeconds, 120);
  assert.equal(validate(config({ energyRecoverySeconds: '300' })).energyRecoverySeconds, 300);
  for (const value of [0, 9, 86401, 120.5, Infinity, 'bad']) assert.throws(() => validate(config({ energyRecoverySeconds: value })), /检查间隔/);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 });
  const f = await fixture(t, { energyRecoverySeconds: 300 }); await f.begin();
  const reads = f.reads();
  assert.equal(f.engine.snapshot().energyRecovery.intervalSeconds, 300);
  t.mock.timers.tick(299999); assert.equal(f.reads(), reads);
  t.mock.timers.tick(1); await until(() => !f.engine.energyRecoveryPass);
  assert.equal(f.reads(), reads + 1);
  assert.equal(f.engine.energyRecovery.status.nextCheckAt, Date.now() + 300000);
  assert.ok(f.store.logs().some(log => log.message.includes('300 秒')));
});

test('polls every 120 seconds, resumes at the current head and abandons old queues and retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 });
  const f = await fixture(t, { restartScanMode: 'resume', unfinishedPolicy: 'resend' });
  await f.begin();
  assert.equal(f.engine.state, 'energy_wait');
  const old = f.store.next('live'), reads = f.reads();
  const signed = f.offer(4), prepared = await f.chain.buildAndSign(signed, 18);
  f.store.prepareAttempt(signed, prepared); f.store.beginAttempt(f.store.get(signed.id));
  f.store.update(signed.id, 'uncertain');
  const receipt = f.chain.receipt.bind(f.chain);
  f.chain.receipt = async id => id === prepared.txid ? {} : receipt(id);
  f.chain.executionReceipt = f.chain.receipt;
  t.mock.timers.tick(119999); assert.equal(f.reads(), reads);
  t.mock.timers.tick(1); await until(() => !f.engine.energyRecoveryPass);
  assert.equal(f.reads(), reads + 1); assert.equal(f.chain.broadcasts, 0);
  assert.equal(f.engine.energyRecovery.status.nextCheckAt, Date.now() + 120000);
  f.resource.energy = 100; f.head(80);
  t.mock.timers.tick(120000); await until(() => f.engine.state === 'running');
  assert.equal(f.engine.height, 80);
  assert.equal(f.store.getMeta('cursor:' + fingerprint(f.c, 'live')), 80);
  assert.equal(f.store.get(old.id).status, 'skipped_restart');
  assert.equal(f.store.retryInfo(f.store.get(signed.id)).exhausted, 1);
  assert.equal(f.store.get(signed.id).txid, prepared.txid);
  assert.equal(f.engine.energyRecovery, null); assert.equal(f.chain.broadcasts, 0);
  assert.equal(f.c.restartScanMode, 'resume'); assert.equal(f.c.unfinishedPolicy, 'resend');
  f.chain.block = async h => trxBlock(h, address(5), 'e'.repeat(64));
  await f.engine.scanOne(81); await until(() => f.chain.broadcasts === 1);
  assert.equal(f.store.records().items.filter(r => r.status === 'queued').length, 0);
  assert.equal(f.store.get(signed.id).status, 'uncertain');
});

test('disabled switch, simulation and initial preflight failure do not arm recovery', async t => {
  const disabled = await fixture(t, { autoResumeEnergy: false });
  await disabled.begin(); assert.equal(disabled.engine.state, 'fault'); assert.equal(disabled.engine.energyRecovery, null);
  const simulate = await fixture(t, { maxPerRun: 1 });
  await simulate.begin('simulate'); assert.equal(simulate.engine.state, 'stopped'); assert.equal(simulate.engine.energyRecovery, null); assert.equal(simulate.chain.signed, 0);
  const initial = await fixture(t);
  await assert.rejects(initial.engine.start('live'), /能量/);
  assert.equal(initial.engine.energyRecovery, null); assert.equal(initial.chain.signed, 0);
});

test('TRC10 and unrelated failures never auto resume', async t => {
  const native = await fixture(t, { assetType: 'TRC10', tokenId: '1000016' });
  native.engine.loop = async () => native.engine.fail(Object.assign(new Error('energy'), { code: 'INSUFFICIENT_ENERGY' }));
  await native.begin(); assert.equal(native.engine.energyRecovery, null);
  const f = await fixture(t); f.resource.energy = 100; f.resource.balanceSun = '0';
  await f.begin(); assert.equal(f.engine.state, 'fault'); assert.equal(f.engine.energyRecovery, null);
  const waiting = await fixture(t); await waiting.begin();
  waiting.engine.fail(new Error('交易到账核对未通过'));
  assert.equal(waiting.engine.state, 'fault'); assert.equal(waiting.engine.energyRecovery, null);
});

test('manual pause cancels waiting and prevents rearming after a late low-energy response', async t => {
  const f = await fixture(t); await f.begin(); f.engine.stop();
  f.resource.energy = 100; await f.engine.checkEnergyRecovery();
  assert.equal(f.engine.state, 'stopped'); assert.equal(f.chain.broadcasts, 0);
  const late = await fixture(t), g = gate();
  const read = late.chain.resources.bind(late.chain);
  late.chain.resources = async () => { g.enter(); await g.wait; return read(); };
  const starting = late.engine.start('live', { ...await new FakeChain(late.c).preflight() });
  await g.entered; late.engine.stop(); g.release(); await starting; await late.engine.loopPromise;
  assert.equal(late.engine.energyRecovery, null); assert.equal(late.chain.signed, 0);
});

for (const stage of ['resources', 'preflight', 'head']) test(`pause during recovery ${stage} cannot restart or sign after the response returns`, async t => {
  const f = await fixture(t); await f.begin(); f.resource.energy = 100;
  const g = gate(), original = f.chain[stage].bind(f.chain);
  f.chain[stage] = async () => { g.enter(); await g.wait; return original(); };
  const checking = f.engine.checkEnergyRecovery(); await g.entered;
  f.engine.stop(); assert.equal(f.engine.energyRecovery, null);
  g.release(); await checking;
  assert.equal(f.engine.state, 'stopped'); assert.equal(f.engine.running, false);
  assert.equal(f.chain.signed, 0); assert.equal(f.chain.broadcasts, 0);
});

test('only one recovery check can run, and a network failure waits without spending delivery attempts', async t => {
  const f = await fixture(t); await f.begin();
  const g = gate(), read = f.chain.resources.bind(f.chain);
  f.chain.resources = async () => { g.enter(); await g.wait; throw new Error('网络暂不可用'); };
  const a = f.engine.checkEnergyRecovery(); await g.entered;
  assert.equal(f.engine.checkEnergyRecovery(), a);
  g.release(); await a;
  assert.equal(f.engine.state, 'energy_wait'); assert.match(f.engine.snapshot().energyRecovery.message, /网络/);
  assert.equal(f.store.retryInfo(f.store.next('live')).attempts, 0);
  f.chain.resources = read; f.resource.energy = 100;
  await f.engine.checkEnergyRecovery(); assert.equal(f.engine.state, 'running'); assert.equal(f.chain.broadcasts, 0);
});

test('a changed campaign invalidates an in-flight energy result', async t => {
  const f = await fixture(t); await f.begin(); f.resource.energy = 100;
  const g = gate(), read = f.chain.resources.bind(f.chain);
  f.chain.resources = async () => { g.enter(); await g.wait; return read(); };
  const checking = f.engine.checkEnergyRecovery(); await g.entered;
  f.c.tokenContract = address(10); g.release(); await checking;
  assert.equal(f.engine.energyRecovery, null); assert.equal(f.engine.state, 'stopped');
  assert.equal(f.chain.broadcasts, 0);
});

test('a transient error during fresh preflight keeps the recovery timer and the original queue', async t => {
  const f = await fixture(t); await f.begin(); f.resource.energy = 100;
  const preflight = f.chain.preflight.bind(f.chain);
  f.chain.preflight = async () => { throw new Error('节点暂不可用'); };
  await f.engine.checkEnergyRecovery();
  assert.equal(f.engine.state, 'energy_wait'); assert.equal(f.store.next('live').status, 'queued');
  f.chain.preflight = preflight;
  await f.engine.checkEnergyRecovery(); assert.equal(f.engine.state, 'running'); assert.equal(f.chain.broadcasts, 0);
});

for (const shortage of ['trx', 'token']) test(`energy alone cannot bypass a ${shortage} shortage on restart`, async t => {
  const f = await fixture(t); await f.begin(); f.resource.energy = 100;
  if (shortage === 'trx') f.resource.balanceSun = '0';
  else { const tokenInfo = f.chain.tokenInfo.bind(f.chain); f.chain.tokenInfo = async () => ({ ...await tokenInfo(), rawBalance: '0' }); }
  await f.engine.checkEnergyRecovery();
  assert.equal(f.engine.state, 'fault'); assert.equal(f.engine.energyRecovery, null);
  assert.match(f.engine.lastError, /自动恢复已停止/); assert.equal(f.chain.broadcasts, 0);
  assert.equal(f.store.next('live').status, 'queued');
});

test('the original address cap and successful count survive automatic restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 });
  const f = await fixture(t, { maxPerRun: 2, sendIntervalSeconds: 1 });
  f.resource.energy = 100;
  f.engine.scanLoop = async () => { f.offer(3); f.offer(4); };
  const broadcast = f.chain.broadcast.bind(f.chain);
  f.chain.broadcast = async (...args) => { f.resource.energy = 0; return broadcast(...args); };
  await f.engine.start('live'); await until(() => f.engine.metrics.sent === 1);
  t.mock.timers.tick(1000); await until(() => f.engine.state === 'energy_wait');
  f.engine.scanLoop = async () => { f.offer(5); f.offer(6); };
  f.resource.energy = 100; await f.engine.checkEnergyRecovery();
  await until(() => f.engine.state === 'stopped');
  assert.equal(f.engine.metrics.sent, 2); assert.equal(f.chain.broadcasts, 2);
  assert.equal(f.engine.energyRecovery, null);
  assert.equal(f.store.records().items.filter(r => r.status === 'queued').length, 1);
});

test('close cancels a read in flight and reopening with the switch enabled stays paused', async t => {
  const f = await fixture(t); await f.begin(); f.resource.energy = 100;
  const g = gate(), read = f.chain.resources.bind(f.chain);
  f.chain.resources = async () => { g.enter(); await g.wait; return read(); };
  const checking = f.engine.checkEnergyRecovery(); await g.entered;
  const closing = f.engine.close(); g.release(); await checking; await closing;
  assert.equal(f.chain.broadcasts, 0); assert.equal(f.engine.energyRecovery, null);
  const reopened = new Engine(f.store, () => f.c, () => f.chain);
  assert.equal(reopened.state, 'stopped'); assert.equal(reopened.energyRecovery, null); await reopened.close();
});

async function appFixture(t, updater) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-energy-api-')), dataDir = path.join(root, 'data');
  const c = config({ autoResumeEnergy: true, maxPerRun: 0, minEnergy: 100 });
  atomicJson(path.join(dataDir, 'config.json'), c);
  const chain = new FakeChain(c); let energy = 100;
  const resources = chain.resources.bind(chain);
  chain.resources = async () => ({ ...await resources(), energy });
  if (updater) updater.root = root;
  const app = await createApp({ dataDir, chainFactory: () => chain, automaticUpdates: false, ...(updater ? { updater } : {}) });
  const base = `http://127.0.0.1:${app.port}`;
  const request = (route, body) => fetch(base + '/api/' + route, { method: body ? 'POST' : 'GET', headers: { Cookie: 'tcl_session=' + app.token, Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const prepare = await (await request('prepare', {})).json(); energy = 0;
  assert.equal((await request('start', { mode: 'live', confirmationToken: prepare.confirmationToken })).status, 200);
  await app.engine.loopPromise; assert.equal(app.engine.state, 'energy_wait');
  return { app, request, dataDir, chain, energy: value => { energy = value; } };
}

test('API persists opt-in, hides secrets and cancels waiting when configuration changes', async t => {
  const f = await appFixture(t);
  const state = await (await f.request('state')).text();
  assert.equal(JSON.parse(state).config.autoResumeEnergy, true);
  assert.equal(JSON.parse(state).energyRecovery.intervalSeconds, 120);
  assert.ok(!state.includes(config().privateKey));
  assert.equal((await f.request('config', { autoResumeEnergy: false, energyRecoverySeconds: 300 })).status, 200);
  assert.equal(f.app.engine.energyRecovery, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json'))).autoResumeEnergy, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json'))).energyRecoverySeconds, 300);
  f.energy(100); await f.app.engine.checkEnergyRecovery(); assert.equal(f.chain.broadcasts, 0);
});

test('installing an update cancels waiting before preparing the installer', async t => {
  let f, launched = 0;
  const updater = { snapshot: () => ({}), readyDirectory: async () => {
    assert.equal(f.app.engine.energyRecovery, null); f.energy(100); await f.app.engine.checkEnergyRecovery();
    return 'synthetic-package';
  }, launch: async () => { launched++; } };
  f = await appFixture(t, updater);
  assert.equal((await f.request('update/install', { version: '1.2.1', confirmed: true })).status, 200);
  assert.equal(launched, 1); assert.equal(f.chain.broadcasts, 0);
});

test('exit API revokes recovery immediately', async t => {
  const f = await appFixture(t);
  assert.equal((await f.request('exit', {})).status, 200);
  assert.equal(f.app.engine.energyRecovery, null); f.energy(100);
  await f.app.engine.checkEnergyRecovery(); assert.equal(f.chain.broadcasts, 0);
});
