'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { RuntimeControl } = require('../src/runtime-control');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { createApp } = require('../src/server');
const { atomicJson, fingerprint, effectiveConfig } = require('../src/config');
const { config, address, FakeChain } = require('./fixtures');
const linked = extra => config({ energyTransport: 'platform', platformUrl: 'https://energy.example', platformToken: 'runtime-device-secret',
  platformDeviceId: 'runtime-device', platformWallet: address(1), maxPerRun: 0, ...extra });
const policy = () => ({ device_id: 'runtime-device', wallet_address: address(1), revision: 7, desired_mode: 'local', effective_mode: 'local',
  transition_state: 'stable', valid_until: new Date(Date.now() + 60000).toISOString(), enabled: true,
  price_sun: 950000, max_fee_limit_sun: 10000000, min_trx_sun: 15000000, trx_stop_sun: 15000000, trx_resume_sun: 20000000,
  auto_resume: true, low_trx_latched: false });
function command(report, extra = {}) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), action: 'start_live', status: 'queued', instance_id: report.instance_id,
    config_fingerprint: report.config_fingerprint, policy_revision: 7, created_at: now,
    expires_at: new Date(Date.parse(now) + 60000).toISOString(), detail: '', ...extra };
}
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-runtime-')), store = new Store(dir), c = linked(extra);
  const calls = { reports: [], claims: [], results: [], starts: 0 }, state = { command: null, clock: 0 };
  const engine = { state: 'stopped', mode: null, running: false, busy: false, headHeight: null, lastError: '',
    energyPolicy: { value: { revision: 7 }, requireMode: () => 'local' }, scanProgress: () => null, log: () => {} };
  const client = {
    runtime: async report => { calls.reports.push(structuredClone(report)); return { server_time: new Date().toISOString(), command: state.command }; },
    claimCommand: async (id, input) => { calls.claims.push({ id, ...input }); return { execute: true, command: state.command, server_time: new Date().toISOString() }; },
    commandResult: async (id, input) => { calls.results.push({ id, ...input }); return { id, ...input }; },
  };
  const control = new RuntimeControl(store, () => c, engine, { factory: () => client, monotonic: () => state.clock,
    startLive: async guard => { calls.starts++; guard(); engine.state = 'running'; engine.mode = 'live'; engine.running = true; } });
  const offer = (extra = {}) => { state.command = command({ instance_id: control.instanceId, config_fingerprint: control.configFingerprint() }, extra); return state.command; };
  const tick = async () => { await control.sync(); await control.execution; };
  t.after(async () => { await control.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, c, calls, state, engine, client, control, offer, tick };
}

test('runtime reports current version and explicit state without exposing secrets or inventing a scan', async t => {
  const f = fixture(t); await f.tick();
  const report = f.calls.reports[0];
  assert.equal(report.client_version, require('../package.json').version); assert.equal(report.sequence, 1);
  assert.equal(report.state, 'stopped'); assert.equal(report.last_scan_at, null); assert.equal(report.scan_height, null);
  assert.equal(report.start_block_reason, ''); assert.equal(report.start_config.token, f.c.tokenContract);
  assert.equal(report.start_config.amount, f.c.sendAmount);
  assert.match(report.config_fingerprint, /^[a-f0-9]{64}$/);
  const text = JSON.stringify(report);
  for (const secret of [f.c.privateKey, f.c.platformToken, f.c.watchedAddresses[0], f.c.rpcUrl]) assert.ok(!text.includes(secret));
});

test('standalone installations make no runtime or command requests', async t => {
  const f = fixture(t, { energyTransport: 'local' }); f.offer(); await f.tick();
  assert.equal(f.calls.reports.length, 0); assert.equal(f.calls.claims.length, 0); assert.equal(f.calls.starts, 0);
});

test('one successful claim starts exactly once and duplicate delivery only republishes the result', async t => {
  const f = fixture(t); f.offer(); await f.tick(); await f.tick();
  assert.equal(f.calls.claims.length, 1); assert.equal(f.calls.starts, 1);
  assert.equal(f.calls.results[0].status, 'succeeded'); assert.equal(f.engine.state, 'running');
});

test('lost claim response burns the command and never retries a start', async t => {
  const f = fixture(t); f.offer();
  f.client.claimCommand = async () => { f.calls.claims.push({}); throw new Error('connection lost'); };
  await f.tick(); await f.tick();
  assert.equal(f.calls.claims.length, 1); assert.equal(f.calls.starts, 0); assert.equal(f.calls.results[0].status, 'failed');
  const independent = new Store(f.dir);
  assert.equal(independent.getMeta(f.control.commandKey(f.control.binding(), f.state.command)).result.status, 'failed'); independent.close();
});

test('claim refusal or a mismatched permission never starts', async t => {
  for (const changed of [{ execute: false }, { command: { id: crypto.randomUUID() } }]) {
    const f = fixture(t); f.offer(); f.client.claimCommand = async () => ({ execute: true, command: f.state.command, server_time: new Date().toISOString(), ...changed });
    await f.tick(); assert.equal(f.calls.starts, 0); assert.equal(f.calls.results[0].status, 'failed');
  }
});

test('stale process, configuration, policy and expired commands are never claimed', async t => {
  for (const changed of [{ instance_id: crypto.randomUUID() }, { config_fingerprint: 'a'.repeat(64) }, { policy_revision: 8 },
    { created_at: new Date(Date.now() - 120000).toISOString(), expires_at: new Date(Date.now() - 60000).toISOString() }]) {
    const f = fixture(t); f.offer(changed); await f.tick(); assert.equal(f.calls.claims.length, 0); assert.equal(f.calls.starts, 0);
  }
});

test('local pause or configuration change while claiming cancels an otherwise valid command', async t => {
  for (const change of [f => f.control.invalidate(), f => { f.c.sendAmount = '123'; }, f => { f.c.platformToken = 'rebound'; }]) {
    const f = fixture(t); f.offer(); f.client.claimCommand = async () => { change(f); return { execute: true, command: f.state.command, server_time: new Date().toISOString() }; };
    await f.tick(); assert.equal(f.calls.starts, 0);
  }
});

test('command lifetime includes slow claim and preflight work', async t => {
  const f = fixture(t); f.offer(); f.client.claimCommand = async () => {
    f.state.clock = 61000; return { execute: true, command: f.state.command, server_time: new Date().toISOString() };
  };
  await f.tick(); assert.equal(f.calls.starts, 0); assert.match(f.calls.results[0].detail, /过期/);
  const g = fixture(t); g.offer(); g.control.startLive = async guard => { g.state.clock = 61000; guard(); g.calls.starts++; };
  await g.tick(); assert.equal(g.calls.starts, 0); assert.match(g.calls.results[0].detail, /过期/);
});

test('preflight failure is reported safely and cannot be mistaken for accepted execution', async t => {
  const f = fixture(t); f.offer(); f.control.startLive = async () => { throw new Error('余额不足 ' + f.c.privateKey + ' ' + f.c.platformToken); };
  await f.tick(); const result = f.calls.results[0];
  assert.equal(result.status, 'failed'); assert.match(result.detail, /余额不足/);
  assert.ok(!result.detail.includes(f.c.privateKey)); assert.ok(!result.detail.includes(f.c.platformToken));
});

test('start acknowledgement requires an actually running live engine', async t => {
  const f = fixture(t); f.offer(); f.control.startLive = async () => {};
  await f.tick(); assert.equal(f.calls.results[0].status, 'failed'); assert.match(f.calls.results[0].detail, /未处于正式/);
});

test('lost result responses are retried without another claim or start', async t => {
  const f = fixture(t); f.offer(); const original = f.client.commandResult; let failed = false;
  f.client.commandResult = async (...args) => { const result = await original(...args); if (!failed) { failed = true; throw new Error('lost result'); } return result; };
  await f.tick(); f.state.command = null; await f.tick();
  assert.equal(f.calls.starts, 1); assert.equal(f.calls.claims.length, 1); assert.equal(f.calls.results.length, 2);
  assert.deepEqual(f.calls.results[0], f.calls.results[1]);
});

test('first heartbeat lost before or after persistence retries sequence 1 with the exact body', async t => {
  const f = fixture(t); const original = f.client.runtime; let failed = false;
  f.client.runtime = async input => { const result = await original(input); if (!failed) { failed = true; throw new Error('lost heartbeat'); } return result; };
  await f.tick(); f.c.sendAmount = '177'; await f.tick(); await f.tick();
  assert.deepEqual(f.calls.reports[0], f.calls.reports[1]); assert.equal(f.calls.reports[2].sequence, 2);
  assert.equal(f.calls.reports[2].start_config.amount, '177');
});

test('restart with retained metadata cannot replay an old process command', async t => {
  const f = fixture(t); const old = f.offer();
  const replacement = new RuntimeControl(f.store, () => f.c, f.engine, { factory: () => f.client, startLive: async () => f.calls.starts++ });
  await replacement.sync(); await replacement.execution; await replacement.close();
  assert.notEqual(replacement.instanceId, old.instance_id); assert.equal(f.calls.claims.length, 0); assert.equal(f.calls.starts, 0);
});

test('pending transactions, automatic recovery and local activity block remote start before claim', async t => {
  for (const block of [f => { f.engine.busy = true; }, f => { f.engine.energyRecovery = {}; }, f => { f.control.idleReason = () => '正在备份'; },
    f => { f.store.offer('live', { to: address(3), txid: 'a'.repeat(64), asset: 'TRX', amount: '150' }, f.c, 10);
      const row = f.store.next('live'); f.store.update(row.id, 'uncertain', { txid: 'b'.repeat(64) }); }]) {
    const f = fixture(t); f.offer(); block(f); await f.tick(); assert.equal(f.calls.claims.length, 0); assert.equal(f.calls.starts, 0);
  }
});

test('last scan time is persisted only with a successfully committed block and scoped to current scan settings', async t => {
  const f = fixture(t, { energyTransport: 'local' }), chain = new FakeChain(f.c), engine = new Engine(f.store, () => f.c, () => chain);
  engine.config = effectiveConfig(f.c); engine.chain = chain; engine.mode = 'simulate'; engine.running = true;
  engine.cursorKey = 'cursor:' + fingerprint(engine.config, 'simulate');
  assert.equal(engine.scanProgress(), null);
  await engine.preflight(); assert.equal(engine.scanProgress(), null);
  await engine.scanOne(11); const scan = engine.scanProgress();
  assert.equal(scan.height, 11); assert.ok(Date.parse(scan.at));
  const independent = new Store(f.dir), restored = new Engine(independent, () => f.c, () => chain);
  assert.deepEqual(restored.scanProgress(), scan);
  chain.block = async () => { throw new Error('node timeout'); };
  await assert.rejects(engine.scanOne(12), /timeout/); assert.deepEqual(engine.scanProgress(), scan);
  f.c.watchedAddresses = [address(22)]; assert.equal(engine.scanProgress(), null);
  engine.running = false; await engine.close(); await restored.close(); independent.close();
});

async function appFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-runtime-api-')), c = linked(), requests = [], results = [];
  atomicJson(path.join(dir, 'config.json'), c);
  let pending;
  const client = { policy: async () => policy(), ack: async () => ({ policy: policy() }),
    runtime: async report => { requests.push(structuredClone(report)); return { command: pending, server_time: new Date().toISOString() }; },
    claimCommand: async () => ({ execute: true, command: pending, server_time: new Date().toISOString() }),
    commandResult: async (id, result) => { results.push({ id, ...result }); return result; } };
  const chains = [];
  const app = await createApp({ dataDir: dir, chainFactory: conf => { const chain = new FakeChain(conf); chains.push(chain); return chain; },
    rentalFactory: () => client, automaticUpdates: false, automaticRuntime: false });
  await app.energyPolicy.sync();
  // Exercise actual startup/preflight and its guards, with the scan/send loop
  // replaced so even the synthetic chain cannot send a test transfer.
  app.engine.loop = async () => {};
  const origin = `http://127.0.0.1:${app.port}`;
  const request = (route, body) => fetch(origin + route, { method: 'POST', headers: { Cookie: 'tcl_session=' + app.token,
    Origin: origin, 'X-TCL-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const offer = async () => { await app.runtimeControl.sync(); pending = command(requests.at(-1)); await app.runtimeControl.sync(); };
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, client, request, requests, results, chains, offer };
}

test('server remote start uses the real live preflight and refuses configuration edits while it runs', async t => {
  const f = await appFixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const chain = f.app.engine.getChain(linked()), original = chain.preflight.bind(chain);
  chain.preflight = async () => { enter(); await gate; return original(); };
  await f.offer(); await entered;
  assert.equal(f.app.engine.state, 'starting');
  assert.equal((await f.request('/api/config', { sendAmount: '777' })).status, 400);
  release(); await f.app.runtimeControl.execution;
  // The local attempt to change parameters invalidates the earlier consent.
  assert.equal(f.app.engine.running, false); assert.equal(f.results[0].status, 'failed');
  assert.equal(f.chains.reduce((n, chain) => n + chain.signed + chain.broadcasts, 0), 0);
});

test('local pause during remote preflight prevents subsequent running and sending', async t => {
  const f = await appFixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const chain = f.app.engine.getChain(linked()), original = chain.preflight.bind(chain);
  chain.preflight = async () => { enter(); await gate; return original(); };
  await f.offer(); await entered;
  await f.app.runtimeControl.sync();
  assert.equal(f.requests.at(-1).state, 'starting');
  const response = await f.request('/api/stop', {}); assert.equal(response.status, 200);
  release(); await f.app.runtimeControl.execution;
  assert.equal(f.app.engine.running, false); assert.equal(f.results[0].status, 'failed');
  assert.equal(f.chains.reduce((n, chain) => n + chain.signed + chain.broadcasts, 0), 0);
});

test('closing during remote preflight waits safely and cannot start after the pending node read returns', async t => {
  const f = await appFixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const chain = f.app.engine.getChain(linked()), original = chain.preflight.bind(chain);
  chain.preflight = async () => { enter(); await gate; return original(); };
  await f.offer(); await entered;
  const closing = f.app.close(); release(); await closing;
  assert.equal(f.app.engine.running, false);
  assert.equal(f.chains.reduce((n, chain) => n + chain.signed + chain.broadcasts, 0), 0);
});

test('a policy change during preflight invalidates the original remote permission', async t => {
  const f = await appFixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const chain = f.app.engine.getChain(linked()), original = chain.preflight.bind(chain);
  chain.preflight = async () => { enter(); await gate; return original(); };
  await f.offer(); await entered;
  f.app.energyPolicy.value = { ...f.app.energyPolicy.value, revision: 8 };
  release(); await f.app.runtimeControl.execution;
  assert.equal(f.app.engine.running, false); assert.equal(f.results[0].status, 'failed'); assert.match(f.results[0].detail, /策略已变化/);
});

test('fresh remote consent uses existing startup policy and returns success only after running', async t => {
  const f = await appFixture(t); await f.offer(); await f.app.runtimeControl.execution;
  assert.equal(f.app.engine.running, true); assert.equal(f.app.engine.mode, 'live');
  assert.equal(f.app.engine.config.restartScanMode, 'latest'); assert.equal(f.app.engine.config.unfinishedPolicy, 'skip');
  assert.equal(f.results[0].status, 'succeeded');
  assert.equal(f.chains.reduce((n, chain) => n + chain.signed + chain.broadcasts, 0), 0);
});
