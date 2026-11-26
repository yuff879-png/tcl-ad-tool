'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/store');
const { config, address } = require('./fixtures');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-dedupe-'));
  const store = new Store(directory), c = config();
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const offer = (mode, recipient, status, txid = String(recipient).padStart(64, '0')) => {
    const item = { to: address(recipient), txid, asset: 'TRX', amount: '150' };
    assert.ok(store.offer(mode, item, c, 11));
    const row = store.db.prepare('SELECT id FROM deliveries WHERE mode=? AND source_tx=?').get(mode, txid);
    store.update(row.id, status, { txid: 'b'.repeat(64) });
    return item;
  };
  return { directory, store, c, offer };
}

test('clear sent addresses preserves audit and transaction dedupe but allows a new trigger', t => {
  const { store, c, offer } = fixture(t);
  const sent = offer('live', 3, 'confirmed');
  store.db.prepare('INSERT INTO legacy_addresses VALUES(?)').run(address(7));
  store.db.prepare('INSERT INTO legacy_transactions VALUES(?)').run('legacy-trigger');
  const simulated = offer('simulate', 4, 'simulated');
  const queued = offer('live', 5, 'queued');
  const failed = offer('live', 6, 'failed');
  const cancelled = offer('live', 8, 'cancelled');
  const skipped = offer('live', 9, 'skipped');
  store.setMeta('cursor:preserved', 123);
  assert.deepEqual(store.deliveredCounts(), { live: 2, simulate: 1, legacy: 1 });
  const cleared = store.clearDeliveredAddresses('live', 'snapshot');
  assert.equal(cleared.count, 2);
  assert.deepEqual(store.deliveredCounts(), { live: 0, simulate: 1, legacy: 0 });
  assert.equal(store.records().total, 6);
  assert.equal(store.getMeta('cursor:preserved'), 123);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM legacy_addresses').get().n, 1);
  assert.equal(store.hasRecipient('live', sent.to, 'new-trigger'), false);
  assert.equal(store.hasRecipient('live', sent.to, sent.txid), true);
  assert.equal(store.hasRecipient('live', address(7), 'legacy-trigger'), true);
  assert.equal(store.hasRecipient('live', address(7), 'new-trigger'), false);
  assert.equal(store.hasRecipient('simulate', simulated.to, 'new-trigger'), true);
  for (const item of [queued, failed, cancelled, skipped]) assert.equal(store.hasRecipient('live', item.to, 'new-trigger'), true);
  assert.ok(store.offer('live', { ...sent, txid: 'new-trigger' }, c, 12));
  assert.equal(store.records().total, 7);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status='confirmed'").get().n, 1);
  assert.equal(store.getMeta('lastAddressReset').backupPath, 'snapshot');
});

test('simulation clearing is independent and persistent after reopening', t => {
  const { store, c, offer, directory } = fixture(t);
  const sim = offer('simulate', 3, 'simulated'); offer('live', 3, 'confirmed');
  store.clearDeliveredAddresses('simulate', 'snapshot');
  assert.deepEqual(store.deliveredCounts(), { live: 1, simulate: 0, legacy: 0 });
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.hasRecipient('simulate', sim.to, 'new'), false);
    assert.equal(reopened.hasRecipient('live', sim.to, 'new'), true);
    assert.equal(reopened.offer('simulate', sim, c, 11), false);
    assert.equal(reopened.offer('simulate', { ...sim, txid: 'new' }, c, 12), true);
  } finally { reopened.close(); }
});

test('pending, prepared, uncertain and executed transfers block clearing in either mode', t => {
  const { store, offer } = fixture(t);
  offer('live', 3, 'confirmed'); offer('simulate', 4, 'simulated'); offer('live', 5, 'prepared');
  const pending = store.pending()[0];
  for (const status of ['prepared', 'pending', 'uncertain', 'executed']) {
    store.update(pending.id, status);
    for (const mode of ['live', 'simulate']) assert.throws(() => store.clearDeliveredAddresses(mode, 'snapshot'), /待确认/);
    assert.equal(store.deliveredCounts().live, 1); assert.equal(store.deliveredCounts().simulate, 1);
    assert.equal(store.pending()[0].txid, 'b'.repeat(64));
  }
});

test('version 1 database migration backs up and preserves records, queue, cursor and legacy addresses', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-v1-db-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config()));
  const old = new DatabaseSync(path.join(directory, 'records.sqlite'));
  old.exec(`CREATE TABLE deliveries(id TEXT PRIMARY KEY,mode TEXT NOT NULL,address TEXT NOT NULL,source_tx TEXT NOT NULL,
    source_asset TEXT NOT NULL,source_amount TEXT NOT NULL,token TEXT NOT NULL,amount TEXT NOT NULL,status TEXT NOT NULL,
    txid TEXT,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,block_height INTEGER,raw_amount TEXT,wallet TEXT,rpc TEXT,
    UNIQUE(mode,address),UNIQUE(mode,source_tx));
    CREATE INDEX delivery_status ON deliveries(mode,status);
    CREATE TABLE legacy_addresses(address TEXT PRIMARY KEY);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const insert = old.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const [i, status] of [[3, 'confirmed'], [4, 'queued'], [5, 'uncertain']]) insert.run('id'+i,'live',address(i),'source'+i,'TRX','150',address(9),'168',status,'tx'+i,'保留原说明','2026-10-18','2026-10-18',123,'168000000000000000000',address(1),config().rpcUrl);
  old.prepare('INSERT INTO legacy_addresses VALUES(?)').run(address(7));
  old.prepare('INSERT INTO meta VALUES(?,?)').run('cursor:live', '123');
  const before = old.prepare('SELECT rowid,* FROM deliveries ORDER BY rowid').all(); old.close();
  const store = new Store(directory);
  try {
    const after = store.db.prepare('SELECT rowid,* FROM deliveries ORDER BY rowid').all();
    assert.deepEqual(after.map(({ dedupe_cleared_at, asset_type, asset_scope, source_kind, manual_batch_id, manual_position, ...row }) => ({ ...row })), before.map(row => ({ ...row })));
    assert.ok(after.every(row => row.source_kind === 'scan' && row.manual_batch_id === null && row.manual_position === null));
    assert.ok(after.every(row => row.dedupe_cleared_at === null && row.asset_type === 'TRC20' && row.asset_scope === ''));
    assert.equal(store.next('live').id, 'id4'); assert.equal(store.pending()[0].id, 'id5');
    assert.equal(store.getMeta('cursor:live'), 123); assert.equal(store.deliveredCounts().live, 2);
    assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const backups = fs.readdirSync(path.join(directory, 'backups'));
    assert.equal(backups.length, 1);
    const folder = path.join(directory, 'backups', backups[0]);
    assert.equal(fs.readFileSync(path.join(folder, 'config.json'), 'utf8'), fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    const snapshot = new DatabaseSync(path.join(folder, 'records.sqlite'), { readOnly: true });
    try { assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 3); } finally { snapshot.close(); }
  } finally { store.close(); }
});
