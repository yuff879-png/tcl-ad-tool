'use strict';
// A synthetic 1.3.8 database is opened by the 1.3.9 candidate. No user data/RPC.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const oldRoot = path.join(root, 'delivery-candidate/1.3.8/TCL广告投放工具');
const target = path.join(root, 'delivery-candidate/1.3.9/TCL广告投放工具');
const { Store: OldStore } = require(path.join(oldRoot, 'src/store'));
const { config, address, FakeChain } = require(path.join(oldRoot, 'test/fixtures'));
const { atomicJson, walletAddress } = require(path.join(oldRoot, 'src/config'));
const plain = value => JSON.parse(JSON.stringify(value));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-manual-migration-'));
async function main() {
  assert.equal(require(path.join(oldRoot, 'package.json')).version, '1.3.8');
  assert.equal(require(path.join(target, 'package.json')).version, '1.3.9');
  assert.equal(sha(path.join(oldRoot, 'src/store.js')), sha(path.join(root, 'verification/manual-batch-baseline-1.3.8/src/store.js')));
  const c = config({ maxPerRun: 0, autoResumeEnergy: true });
  atomicJson(path.join(directory, 'config.json'), c);
  // Let the original server create its complete schema, without starting sends.
  const old = await require(path.join(oldRoot, 'src/server')).createApp({
    dataDir: directory, automaticUpdates: false, automaticRuntime: false, chainFactory: () => new FakeChain(c),
  });
  await old.close();
  const store = new OldStore(directory);
  store.setMeta('cursor:isolated-manual-migration', 12345678);
  store.db.prepare('INSERT INTO legacy_addresses(address) VALUES(?)').run(address(40));
  store.db.prepare('INSERT INTO legacy_transactions(txid) VALUES(?)').run('a'.repeat(64));
  for (const [i, status] of ['queued', 'confirmed', 'failed'].entries()) {
    const recipient = address(10 + i);
    store.offer('live', { to: recipient, txid: String(i + 1).repeat(64), asset: 'TRX', amount: '150' }, c, 12345677);
    const row = store.db.prepare('SELECT * FROM deliveries WHERE address=?').get(recipient);
    if (status !== 'queued') store.update(row.id, status, { txid: String(i + 5).repeat(64), wallet: walletAddress(c), raw_amount: '168000000000000000000', detail: 'isolated migration history' });
    if (status === 'failed') { store.exhaustRetry(store.get(row.id)); store.setMeta('delivery-manual-retry-history:' + row.id, [{ phase: 'completed', evidence: 'synthetic' }]); }
  }
  const tableNames = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const tables = tableNames.map(name => ({ name, columns: store.db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name), rows: plain(store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()) }));
  store.close();
  const configHash = sha(path.join(directory, 'config.json'));
  const { Store } = require(path.join(target, 'src/store'));
  for (let pass = 0; pass < 2; pass++) {
    const migrated = new Store(directory);
    try {
      for (const table of tables) {
        const columns = migrated.db.prepare(`PRAGMA table_info(${table.name})`).all().map(c => c.name);
        assert.deepEqual(columns, table.name === 'deliveries' ? [...table.columns, 'source_kind', 'manual_batch_id', 'manual_position'] : table.columns);
        assert.deepEqual(plain(migrated.db.prepare(`SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`).all()), table.rows, 'retained ' + table.name);
      }
      assert.equal(migrated.db.prepare('SELECT COUNT(*) n FROM manual_batches').get().n, 0);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE source_kind='scan' AND manual_batch_id IS NULL AND manual_position IS NULL").get().n, 3);
      assert.equal(migrated.getMeta('cursor:isolated-manual-migration'), 12345678);
      assert.equal(migrated.hasRecipient('live', address(11), 'new-trigger', c), true);
      assert.equal(migrated.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    } finally { migrated.close(); }
  }
  let signatures = 0, broadcasts = 0, platformCalls = 0;
  const chain = new FakeChain(c);
  chain.buildAndSign = () => { signatures++; throw new Error('Signing forbidden'); };
  chain.broadcast = () => { broadcasts++; throw new Error('Broadcast forbidden'); };
  const app = await require(path.join(target, 'src/server')).createApp({
    dataDir: directory, automaticUpdates: false, automaticRuntime: false, chainFactory: () => chain,
    rentalFactory: () => { platformCalls++; throw new Error('Platform requests forbidden'); },
  });
  try {
    const headers = { Cookie: 'tcl_session=' + app.token }, base = `http://127.0.0.1:${app.port}`;
    const state = await (await fetch(base + '/api/state', { headers })).json();
    assert.equal(state.version, '1.3.9'); assert.equal(state.state, 'stopped'); assert.equal(state.pool.unlocked, false);
    assert.equal(state.energyRecovery, null); assert.equal(state.config.privateKey, undefined);
    const batches = await (await fetch(base + '/api/manual-batches', { headers })).json();
    assert.equal(batches.total, 0); assert.deepEqual(batches.queue, { manual: 0, scan: 1 });
    assert.equal(app.store.records().total, 3); assert.equal(app.store.next('live', c).address, address(10));
    assert.equal(sha(path.join(directory, 'config.json')), configHash);
    assert.equal(signatures, 0); assert.equal(broadcasts, 0); assert.equal(platformCalls, 0);
    const result = { from: '1.3.8', version: '1.3.9', status: 'passed', oldTablesPreserved: tables.length,
      oldDeliveryRowsPreserved: 3, newTable: 'manual_batches', addedDeliveryColumns: ['source_kind', 'manual_batch_id', 'manual_position'],
      repeatedMigrationPassed: true, configurationUnchanged: true, dedupePreserved: true, cursorPreserved: true,
      startupPaused: true, poolLocked: true, signatures, broadcasts, platformCalls, realUserDataUsed: false };
    atomicJson(path.join(__dirname, 'manual-upgrade-1.3.9.json'), result);
    console.log(JSON.stringify(result, null, 2));
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('tcl-manual-migration-')) fs.rmSync(resolved, { recursive: true, force: true });
});
