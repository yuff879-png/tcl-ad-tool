'use strict';
// Install the signed candidate with the actual 1.3.9 updater in an isolated copy.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { sha256, verifyManifest } = require('../app/src/updater');
const { atomicJson } = require('../app/src/config');
const root = path.resolve(__dirname, '..'), version = '1.3.10', from = '1.3.9';
const plain = value => JSON.parse(JSON.stringify(value)), hashFile = file => sha256(fs.readFileSync(file));
async function checkInstalled() {
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const target = path.resolve(process.argv[1]), expected = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { Store } = require(path.join(target, 'src/store'));
  const store = new Store(path.join(target, 'data'));
  for (const table of expected.tables) {
    assert.deepEqual(JSON.parse(JSON.stringify(store.db.prepare(`SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`).all())), table.rows, table.name);
    assert.deepEqual(store.db.prepare(`PRAGMA table_info(${table.name})`).all().map(c => c.name), table.name === 'deliveries' ? [...table.columns, 'manual_repeat'] : table.name === 'manual_batches' ? [...table.columns, 'history_policy', 'paused', 'last_resume_hash'] : table.columns);
  }
  assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE source_kind='scan' AND manual_batch_id IS NULL").get().n, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM manual_batches').get().n, 1);
  store.close();
  const { FakeChain } = require(path.join(target, 'test/fixtures'));
  const settings = JSON.parse(fs.readFileSync(path.join(target, 'data/config.json'), 'utf8'));
  const chain = new FakeChain(settings); let broadcasts = 0, signatures = 0, platformCalls = 0;
  chain.buildAndSign = () => { signatures++; throw new Error('No signing during upgrade verification'); };
  chain.broadcast = () => { broadcasts++; throw new Error('No broadcasts during upgrade verification'); };
  const app = await require(path.join(target, 'src/server')).createApp({ dataDir: path.join(target, 'data'), automaticUpdates: false, automaticRuntime: false,
    chainFactory: () => chain, rentalFactory: () => { platformCalls++; throw new Error('No platform requests during upgrade verification'); } });
  try {
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { Cookie: 'tcl_session=' + app.token } })).json();
    assert.equal(state.version, '1.3.10'); assert.equal(state.state, 'stopped'); assert.equal(state.pool.unlocked, false); assert.equal(state.energyRecovery, null);
    app.pool.unlock('synthetic-upgrade-password'); assert.equal(app.pool.snapshot().total, 1);
    const { address } = require(path.join(target, 'test/fixtures'));
    const batch = app.engine.manualBatches.list().items[0];
    assert.equal(batch.id, 'synthetic-old-batch'); assert.equal(batch.paused, 1); assert.equal(batch.history_policy, 'dedupe'); assert.equal(batch.counts.queued, 2);
    assert.equal(app.store.next('live', settings), undefined);
    app.engine.loop = async () => {};
    const beforeIds = app.store.db.prepare("SELECT id FROM deliveries WHERE manual_batch_id=? ORDER BY rowid").all(batch.id).map(r => r.id);
    const resume = await app.engine.manualBatches.prepareResume(batch.id);
    await app.engine.manualBatches.resume({ confirmationToken: resume.confirmationToken, confirmed: true });
    assert.equal(app.store.next('live', settings).id, beforeIds[0]);
    const previous = app.store.db.prepare('SELECT * FROM deliveries WHERE address=?').get(address(21));
    const repeat = await app.engine.manualBatches.prepare({ text: address(21), mode: 'live', historyPolicy: 'repeat' });
    assert.equal(repeat.counts.repeated, 1);
    await app.engine.manualBatches.submit({ confirmationToken: repeat.confirmationToken, confirmed: true, confirmRepeat: true });
    assert.deepEqual({ ...app.store.get(previous.id) }, { ...previous });
    assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM deliveries WHERE address=?').get(address(21)).n, 2);
    assert.equal(app.store.hasRecipient('live', address(21), 'new-trigger', settings), true);
    const reopened = new Store(path.join(target, 'data'));
    try { assert.equal(reopened.db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); } finally { reopened.close(); }
    assert.equal(broadcasts + signatures + platformCalls, 0);
    console.log(JSON.stringify({ version: state.version, startupPaused: true, encryptedVaultUnlockPassed: true,
      businessTablesPreserved: expected.tables.length, oldManualBatchResumed: true, originalRowsPreserved: true, repeatCreatedDistinctRecord: true, scanDedupePreserved: true, broadcasts, signatures, platformCalls }));
  } finally { await app.close(); }
}
async function main() {
  const folder = path.join(__dirname, 'manual-update-1.3.10-' + Date.now()); fs.mkdirSync(folder);
  const baseline = path.join(root, 'publish/v1.3.9/tcl-ad-tool-1.3.9-win-x64.zip');
  const oldManifest = verifyManifest(JSON.parse(fs.readFileSync(path.join(root, 'publish/v1.3.9/update.json'))));
  assert.equal(hashFile(baseline), oldManifest.sha256);
  const extract = spawnSync('python', ['-X', 'utf8', '-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert all(n.startswith("TCL广告投放工具/") and ".." not in n.split("/") and "\\\\" not in n for n in z.namelist())\n z.extractall(sys.argv[2])', baseline, folder], { windowsHide: true, encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  const target = path.join(folder, 'TCL广告投放工具'), dataDir = path.join(target, 'data'); fs.mkdirSync(dataDir);
  const { config, address } = require(path.join(target, 'test/fixtures')), settings = config({ maxPerRun: 0 });
  atomicJson(path.join(dataDir, 'config.json'), settings);
  const { Store } = require(path.join(target, 'src/store')), store = new Store(dataDir);
  const { DeliveryReporter } = require(path.join(target, 'src/delivery-reporter')); await new DeliveryReporter(store, () => settings).close();
  for (const [i, status] of ['queued', 'confirmed', 'failed'].entries()) {
    store.offer('live', { to: address(20 + i), txid: String(i + 1).repeat(64), asset: 'TRX', amount: '150' }, settings, 12345);
    const row = store.db.prepare('SELECT * FROM deliveries WHERE address=?').get(address(20 + i));
    if (status !== 'queued') store.update(row.id, status, { txid: String(i + 5).repeat(64), raw_amount: '168000000000000000000', wallet: address(1) });
    if (status === 'failed') { store.exhaustRetry(store.get(row.id)); store.energyIntent(row, { platformUrl: 'https://synthetic.example', platformDeviceId: 'synthetic' }); }
  }
  store.db.prepare('INSERT INTO manual_batches(id,confirmation_hash,mode,asset_type,token,amount,rpc,total,summary_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('synthetic-old-batch', 'c'.repeat(64), 'live', 'TRC20', settings.tokenContract, settings.sendAmount, settings.rpcUrl, 2, '{}', new Date().toISOString());
  store.offer('live', { to: address(23), txid: 'd'.repeat(64), asset: 'MANUAL', amount: '0' }, settings, null);
  store.db.prepare("UPDATE deliveries SET source_kind='manual',manual_batch_id='synthetic-old-batch',manual_position=rowid WHERE address IN (?,?)").run(address(20), address(23));
  store.setMeta('cursor:upgrade-fixture', 12345); store.db.prepare('INSERT INTO legacy_addresses(address) VALUES(?)').run(address(90));
  const { PoolVault } = require(path.join(target, 'src/pool-vault'));
  const vault = new PoolVault(dataDir); vault.initialize('synthetic-upgrade-password');
  vault.require().data.wallets.push({ id: 'synthetic-wallet', address: address(70), key: '46'.padStart(64, '0'), batchId: 'synthetic-batch', createdAt: new Date().toISOString() }); vault.save(); vault.lock();
  const { WalletPool } = require(path.join(target, 'src/pool'));
  const pool = new WalletPool(store, dataDir, () => settings, () => { throw new Error('No chain during fixture setup'); });
  pool.unlock('synthetic-upgrade-password'); await pool.close();
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => ({ name,
    columns: store.db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name), rows: plain(store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()) }));
  store.close(); const expectedFile = path.join(folder, 'expected.json'); atomicJson(expectedFile, { tables });
  const configHash = hashFile(path.join(dataDir, 'config.json')), vaultHash = hashFile(vault.file);
  const originalWorkerHash = hashFile(path.join(target, 'src/update-worker.js')), originalUpdaterHash = hashFile(path.join(target, 'src/updater.js'));
  const envelope = fs.readFileSync(path.join(root, 'publish/v1.3.10/update.json'));
  const bytes = fs.readFileSync(path.join(root, 'publish/v1.3.10/tcl-ad-tool-1.3.10-win-x64.zip'));
  const signed = verifyManifest(JSON.parse(envelope)), proof = require('./package-verification-1.3.10.json');
  assert.equal(sha256(bytes), signed.sha256); assert.equal(signed.sha256, proof.sha256); assert.equal(signed.size, bytes.length);
  assert.throws(() => verifyManifest({ ...JSON.parse(envelope), signature: Buffer.alloc(64).toString('base64') }), /签名/);
  let requests = 0;
  const { Updater } = require(path.join(target, 'src/updater'));
  const updater = new Updater({ root: target, fetcher: async url => { requests++; return new Response(url.endsWith('/update.json') ? envelope : bytes); } });
  assert.equal((await updater.check()).latestVersion, version);
  const directory = await updater.prepare(version);
  assert.equal(hashFile(path.join(directory, 'src/update-worker.js')), originalWorkerHash);
  const progress = require(path.join(directory, 'src/update-progress')).createProgress({ directory, version });
  const result = await require(path.join(directory, 'src/update-worker')).install({ root: target, dataDir, directory, reopen: false, progress });
  assert.equal(result.ok, true); assert.equal(result.version, version); assert.equal(progress.snapshot().status, 'installed');
  for (const [name, digest] of Object.entries(proof.sourceHashes)) assert.equal(hashFile(path.join(target, name)), digest, name);
  assert.equal(hashFile(path.join(dataDir, 'config.json')), configHash); assert.equal(hashFile(vault.file), vaultHash);
  assert.equal(hashFile(path.join(result.backupDir, 'config.json')), configHash); assert.equal(hashFile(path.join(result.backupDir, 'pool-vault.json')), vaultHash);
  const backup = new DatabaseSync(path.join(result.backupDir, 'records.sqlite'), { readOnly: true });
  try { for (const table of tables) assert.deepEqual(plain(backup.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all()), table.rows); } finally { backup.close(); }
  const checked = spawnSync(path.join(target, 'runtime/node.exe'), ['--disable-warning=ExperimentalWarning', '-e', '(' + checkInstalled.toString() + ')().catch(e=>{console.error(e);process.exitCode=1})', target, expectedFile], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const output = { from, version, status: 'passed', originalUpdaterHash, originalWorkerHash, originalReleasedUpdater: true, originalReleasedWorker: true,
    baselineSha256: oldManifest.sha256, signedCandidateSha256: signed.sha256, signatureVerified: true, tamperedSignatureRejected: true,
    installedSourcesMatch: true, backupVerified: true, configUnchanged: true, encryptedVaultUnchanged: true, injectedRequests: requests,
    actualNetworkRequests: 0, actualUserInstallationChanged: false, nativeWindowReopenTested: false, installedSmoke: JSON.parse(checked.stdout.trim()), isolatedDirectory: folder };
  atomicJson(path.join(__dirname, 'manual-update-verification-1.3.10.json'), output); console.log(JSON.stringify(output, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
