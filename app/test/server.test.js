'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/server');
const { atomicJson } = require('../src/config');
const { config, FakeChain, address } = require('./fixtures');
async function appFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-api-')), dir = path.join(root, 'data');
  if (options.fixtureInstallRoot) { options.updater.root = root; delete options.fixtureInstallRoot; }
  atomicJson(path.join(dir, 'config.json'), config());
  const app = await createApp({ dataDir: dir, chainFactory: c => new FakeChain(c), automaticUpdates: false, ...options });
  const base = `http://127.0.0.1:${app.port}`;
  const request = (route, body, headers = {}) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Cookie: 'tcl_session=' + app.token, Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, request, base, dir };
}
test('local API requires session; state never returns secret keys', async t => {
  const { request, base } = await appFixture(t);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const response = await request('/api/state'); const state = await response.json(); assert.equal(state.config.privateKey, undefined); assert.equal(state.config.hasPrivateKey, true);
});
test('wallet pool APIs preserve encrypted backup and block changes during preparation', async t => {
  const { app, request } = await appFixture(t);
  const password = 'isolated-api-wallet-password';
  assert.equal((await request('/api/pool/unlock', { password, initialize: true })).status, 200);
  assert.equal((await request('/api/pool/generate', { count: 2 })).status, 200); await app.pool.work;
  const body = await (await request('/api/pool')).text();
  assert.equal(JSON.parse(body).total, 2); assert.ok(!body.includes(password));
  for (const wallet of app.pool.vault.require().data.wallets) assert.ok(!body.includes(wallet.key));
  const backup = await (await request('/api/backup', {})).json();
  assert.equal(fs.readFileSync(path.join(backup.path, 'pool-vault.json'), 'utf8'), fs.readFileSync(app.pool.vault.file, 'utf8'));
  assert.equal((await request('/api/pool/verify-backup', { password })).status, 200);
  assert.equal(app.pool.backedUp(), true);
  app.pool.running = true;
  for (const [route, input] of [['config', { assetType: 'TRC10' }], ['backup', {}], ['pool/lock', {}], ['pool/generate', { count: 1 }]]) {
    assert.equal((await request('/api/' + route, input)).status, 400);
  }
  app.pool.running = false;
  assert.equal((await request('/api/pool/lock', {})).status, 200);
  assert.equal(app.pool.vault.unlocked, false);
});
test('switching asset type suspends old retries but preserves original pending transaction', async t => {
  const { app, request } = await appFixture(t);
  app.store.offer('live', { to: address(3), txid: 'e'.repeat(64), asset: 'TRX', amount: '150' }, config(), 11);
  const row = app.store.next('live'); app.store.update(row.id, 'uncertain', { txid: 'f'.repeat(64) });
  assert.equal((await request('/api/config', { assetType: 'TRC10', tokenId: '1000016' })).status, 200);
  assert.equal(app.store.get(row.id).txid, 'f'.repeat(64));
  assert.equal(app.store.retryInfo(app.store.get(row.id)).exhausted, 1);
  assert.equal(app.store.pending().length, 1);
  assert.equal((await request('/api/config', { assetType: 'TRC20' })).status, 200);
  assert.equal(app.store.retryInfo(app.store.get(row.id)).exhausted, 1);
});
test('cross-origin and missing request markers cannot mutate settings', async t => {
  const { request } = await appFixture(t); assert.equal((await request('/api/config', { sendAmount: '99' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request('/api/config', {}, { 'X-TCL-Request': '' })).status, 403);
});
test('live start requires one-time confirmation tied to unchanged config', async t => {
  const { app, request } = await appFixture(t);
  assert.equal((await request('/api/start', { mode: 'live' })).status, 400);
  const p = await (await request('/api/prepare', {})).json();
  await request('/api/config', { sendAmount: '169' });
  assert.equal((await request('/api/start', { mode: 'live', confirmationToken: p.confirmationToken })).status, 400);
  const fresh = await (await request('/api/prepare', {})).json();
  assert.equal((await request('/api/start', { mode: 'live', confirmationToken: fresh.confirmationToken })).status, 200);
  await app.engine.loopPromise;
  assert.equal((await request('/api/start', { mode: 'live', confirmationToken: fresh.confirmationToken })).status, 400);
});
test('simulate full API flow and backup yields consistent database/config files', async t => {
  const { app, request } = await appFixture(t);
  assert.equal((await request('/api/start', { mode: 'simulate' })).status, 200); await app.engine.loopPromise;
  const rows = await (await request('/api/records')).json(); assert.equal(rows.items[0].status, 'simulated');
  const exported = await (await request('/api/export')).text(); assert.match(exported, /simulated/);
  const backup = await (await request('/api/backup', {})).json(); assert.ok(fs.existsSync(path.join(backup.path, 'records.sqlite'))); assert.ok(fs.existsSync(path.join(backup.path, 'config.json')));
  const env = await (await request('/api/environment')).json(); assert.equal(env['数据库检查'], 'ok');
});
test('preflight blocks concurrent config edits to keep its confirmation accurate', async t => {
  const { app, request } = await appFixture(t); let release, entered;
  const ready = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; });
  const original = app.engine.preflight.bind(app.engine); app.engine.preflight = async (...args) => { entered(); await gate; return original(...args); };
  const preparing = request('/api/prepare', {}); await ready;
  assert.equal((await request('/api/config', { sendAmount: '999' })).status, 400); release(); assert.equal((await preparing).status, 200);
});
test('address reset requires confirmation, backs up first and retains history in records and CSV', async t => {
  const { app, request } = await appFixture(t);
  const item = { to: address(3), txid: 'source', asset: 'TRX', amount: '150' };
  app.store.offer('live', item, config(), 11);
  app.store.update(app.store.next('live').id, 'confirmed', { txid: 'b'.repeat(64) });
  const prepared = await (await request('/api/prepare', {})).json();
  assert.equal((await request('/api/clear-delivered', { mode: 'live' })).status, 400);
  assert.equal((await request('/api/clear-delivered', { mode: 'all', confirmed: true })).status, 400);
  assert.equal(app.store.deliveredCounts().live, 1);
  const result = await (await request('/api/clear-delivered', { mode: 'live', confirmed: true })).json();
  assert.equal(result.count, 1); assert.ok(fs.existsSync(path.join(result.backupPath, 'config.json')));
  const snapshot = new DatabaseSync(path.join(result.backupPath, 'records.sqlite'), { readOnly: true });
  try { assert.equal(snapshot.prepare('SELECT dedupe_cleared_at FROM deliveries').get().dedupe_cleared_at, null); } finally { snapshot.close(); }
  assert.equal(app.store.deliveredCounts().live, 0); assert.equal(app.store.records().total, 1);
  assert.match(await (await request('/api/export')).text(), /地址去重清空时间/);
  assert.equal((await request('/api/start', { mode: 'live', confirmationToken: prepared.confirmationToken })).status, 400);
});
test('address reset rejects pending transfers and active runs without modifying data', async t => {
  const { app, request, dir } = await appFixture(t);
  const item = { to: address(3), txid: 'source', asset: 'TRX', amount: '150' };
  app.store.offer('live', item, config(), 11); const row = app.store.next('live');
  app.store.db.prepare('INSERT INTO legacy_addresses VALUES(?)').run(address(4));
  app.store.update(row.id, 'uncertain', { txid: 'b'.repeat(64) });
  assert.equal((await request('/api/clear-delivered', { mode: 'live', confirmed: true })).status, 400);
  assert.equal(app.store.pending().length, 1); assert.equal(app.store.deliveredCounts().live, 1);
  app.store.update(row.id, 'confirmed');
  app.engine.state = 'running';
  assert.equal((await request('/api/clear-delivered', { mode: 'live', confirmed: true })).status, 400);
  app.engine.state = 'stopped';
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
  assert.equal(app.store.deliveredCounts().live, 2);
});
test('backup failure leaves delivered address dedupe untouched', async t => {
  const { app, request, dir } = await appFixture(t);
  app.store.db.prepare('INSERT INTO legacy_addresses VALUES(?)').run(address(3));
  fs.writeFileSync(path.join(dir, 'backups'), 'simulate an unwritable backup destination');
  assert.equal((await request('/api/clear-delivered', { mode: 'live', confirmed: true })).status, 400);
  assert.equal(app.store.deliveredCounts().live, 1); assert.equal(app.store.getMeta('lastAddressReset'), null);
});
test('update checks remain read-only during campaigns while installation stays blocked', async t => {
  let called = 0;
  const { app, request } = await appFixture(t, { updater: {
    snapshot: () => ({ currentVersion: '1.0.3', available: false }),
    check: async () => { called++; return { currentVersion: '1.0.3', latestVersion: '1.0.4', available: true }; },
  } });
  assert.equal((await request('/api/update')).status, 200);
  app.engine.state = 'running';
  assert.equal((await request('/api/update/check', {})).status, 200); assert.equal(called, 1);
  assert.equal(app.engine.state, 'running');
  assert.equal((await request('/api/update/install', { confirmed: true, version: '1.0.4' })).status, 400);
  app.engine.state = 'stopped';
  const result = await (await request('/api/update/check', {})).json(); assert.equal(result.available, true); assert.equal(called, 2);
  assert.equal((await request('/api/update/install', { confirmed: false, version: '1.0.4' })).status, 400);
  assert.equal((await request('/api/update/install', { confirmed: true, version: '1.0.4' })).status, 400);
});
test('a slow update check never holds the campaign operation lock', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { app, request } = await appFixture(t, { updater: {
    snapshot: () => ({ currentVersion: '1.0.4', available: false }),
    check: async () => { entered(); await gate; return { available: false }; }
  } });
  const checking = request('/api/update/check', {});
  await ready;
  try {
    assert.equal((await request('/api/preflight', {})).status, 200);
    const state = await (await request('/api/state')).json();
    assert.equal(state.update.currentVersion, '1.0.4');
    assert.equal(app.engine.state, 'stopped');
  } finally { release(); }
  assert.equal((await checking).status, 200);
});
test('paused unknown records do not block live confirmation or update installation and remain intact', async t => {
  let prepared = 0, launched = 0;
  const { app, request, dir } = await appFixture(t, { fixtureInstallRoot: true, updater: {
    snapshot: () => ({ available: true }),
    readyDirectory: async version => { assert.equal(version, '1.0.9'); prepared++; return 'verified-fixture'; },
    launch: async (directory, dataDir) => { assert.equal(directory, 'verified-fixture'); assert.equal(dataDir, dir); launched++; }
  } });
  app.store.offer('live', { to: address(3), txid: 'source', asset: 'TRX', amount: '150' }, config(), 11);
  const row = app.store.next('live'); app.store.update(row.id, 'uncertain', { txid: 'b'.repeat(64) });
  assert.equal((await request('/api/prepare', {})).status, 200);
  assert.equal((await request('/api/update/install', { confirmed: true, version: '1.0.9' })).status, 200);
  assert.equal(prepared, 1); assert.equal(launched, 1); assert.equal(app.store.get(row.id).status, 'uncertain');
  assert.equal((await request('/api/start', { mode: 'simulate' })).status, 400);
});
test('download requests work during delivery and expose progress without taking the operation lock or installing', async t => {
  let starts = 0, launched = 0;
  const transfer = { phase: 'downloading', version: '1.0.11', percent: 25, received: 25, total: 100 };
  const { app, request } = await appFixture(t, { updater: {
    snapshot: () => ({ available: true, download: transfer }),
    startDownload: version => { assert.equal(version, '1.0.11'); starts++; return { download: transfer }; },
    readyDirectory: async () => { throw new Error('请先下载新版本'); }, launch: async () => launched++
  } });
  app.engine.state = 'running';
  const downloading = await request('/api/update/download', { version: '1.0.11' });
  assert.equal(downloading.status, 200); assert.equal((await downloading.json()).download.percent, 25);
  const state = await (await request('/api/state')).json(); assert.equal(state.state, 'running'); assert.equal(state.update.download.received, 25);
  assert.equal((await request('/api/stop', {})).status, 200); assert.equal(starts, 1); assert.equal(launched, 0);
  app.engine.state = 'stopped';
  assert.equal((await request('/api/preflight', {})).status, 200);
});
test('installation requires explicit confirmation and a verified download, never downloads implicitly', async t => {
  let launches = 0, ready = false, prepares = 0;
  const { request } = await appFixture(t, { fixtureInstallRoot: true, updater: {
    snapshot: () => ({ available: true }),
    prepare: async () => prepares++,
    readyDirectory: async () => { if (!ready) throw new Error('请先下载新版本'); return 'verified-fixture'; },
    launch: async () => launches++
  } });
  assert.equal((await request('/api/update/install', { confirmed: true, version: '1.0.11' })).status, 400);
  ready = true;
  assert.equal((await request('/api/update/install', { confirmed: false, version: '1.0.11' })).status, 400);
  assert.equal(launches, 0);
  assert.equal((await request('/api/update/install', { confirmed: true, version: '1.0.11' })).status, 200);
  assert.equal(launches, 1); assert.equal(prepares, 0);
});
test('application lifetime starts and stops automatic update checks', async t => {
  let started = 0, stopped = 0;
  const { app } = await appFixture(t, { automaticUpdates: true, updater: {
    snapshot: () => ({ available: false }),
    startAutomaticChecks: () => started++, stopAutomaticChecks: () => stopped++
  } });
  assert.equal(started, 1); await app.close(); assert.equal(stopped, 1);
});
test('statistics default to the current configured token and Beijing time, and follow a token change', async t => {
  const { app, request } = await appFixture(t);
  for (const n of [9, 10]) {
    app.store.offer('live', { to: address(n + 10), txid: String(n).padStart(64, 'a'), asset: 'TRX', amount: '150' }, config({ tokenContract: address(n), sendAmount: String(n) }), 10);
    const row = app.store.next('live'), txid = String(n).padStart(64, 'b');
    app.store.update(row.id, 'confirmed', { txid });
    app.store.saveReceipt({ ...row, txid }, { id: txid, blockTimeStamp: Date.now(), receipt: { result: 'SUCCESS', energy_usage_total: 65000 }, fee: 127000 });
  }
  const first = await (await request('/api/statistics?period=all')).json();
  assert.equal(first.range.timeZone, 'Asia/Shanghai'); assert.equal(first.currentToken, address(9));
  assert.equal(first.totals.count, 1); assert.deepEqual(first.totals.amounts, [{ token: address(9), amount: '9' }]);
  assert.equal((await request('/api/config', { tokenContract: address(10) })).status, 200);
  const second = await (await request('/api/statistics?token=current&period=all')).json();
  assert.equal(second.currentToken, address(10)); assert.deepEqual(second.totals.amounts, [{ token: address(10), amount: '10' }]);
  const exported = await (await request('/api/statistics/export?token=current&period=all')).text();
  assert.ok(exported.includes(address(10))); assert.ok(!exported.includes(address(9))); assert.match(exported, /北京时间/);
  const all = await (await request('/api/statistics?token=&period=all')).json(); assert.equal(all.totals.count, 2);
  const explicit = await (await request('/api/statistics?token=' + address(9) + '&period=all&timeZone=UTC')).json();
  assert.equal(explicit.totals.count, 1); assert.equal(explicit.range.timeZone, 'UTC');
  assert.equal((await request('/api/statistics?timeZone=Asia%2FYangon')).status, 400);
});
test('an unconfigured current token never silently mixes historical tokens', async t => {
  const { app, request } = await appFixture(t);
  app.store.offer('live', { to: address(3), txid: 'a'.repeat(64), asset: 'TRX', amount: '150' }, config(), 10);
  const row = app.store.next('live'), txid = 'b'.repeat(64);
  app.store.update(row.id, 'confirmed', { txid });
  app.store.saveReceipt({ ...row, txid }, { id: txid, blockTimeStamp: Date.now(), receipt: { result: 'SUCCESS', energy_usage_total: 65000 }, fee: 0 });
  assert.equal((await request('/api/config', { tokenContract: '' })).status, 200);
  const current = await (await request('/api/statistics?period=all')).json();
  assert.equal(current.requiresToken, true); assert.equal(current.totals.count, 0);
  assert.equal((await (await request('/api/statistics?token=&period=all')).json()).totals.count, 1);
});
