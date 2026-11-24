'use strict';
// The original 1.3.7 updater/worker install locally injected, genuinely signed
// 1.3.8 release bytes. Only a new directory and synthetic business data are used.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { atomicJson } = require('../app/src/config');
const { sha256, verifyManifest } = require('../app/src/updater');
const root = path.resolve(__dirname, '..'), version = '1.3.8', from = '1.3.7';
const hashFile = file => sha256(fs.readFileSync(file));
// Runs in a separate process with the installed runtime and package modules.
function verifyInstalledRelease() {
  'use strict';
  // Launched with the installed package's own Node runtime. Never a real wallet.
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const target = path.resolve(process.argv[1]), expected = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  assert.equal(path.basename(path.dirname(target)).startsWith('tcl-1.3.8-upgrade-'), true);
  async function main() {
    const { Store } = require(path.join(target, 'src/store'));
    const store = new Store(path.join(target, 'data'));
    for (const table of expected.tables) {
      const rows = store.db.prepare(`SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`).all();
      assert.deepEqual(JSON.parse(JSON.stringify(rows)), table.rows, 'preserved ' + table.name);
    }
    for (const table of expected.tables) assert.deepEqual(store.db.prepare(`PRAGMA table_info(${table.name})`).all().map(column => column.name), table.columns, 'original schema ' + table.name);
    assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM energy_orders').get().n, expected.energyOrderCount);
    store.close();
    const { createApp } = require(path.join(target, 'src/server'));
    let broadcasts = 0, signatures = 0, platformCalls = 0;
    const app = await createApp({ dataDir: path.join(target, 'data'), automaticUpdates: false,
      rentalFactory: () => { platformCalls++; throw new Error('Platform network forbidden in isolated upgrade'); },
      chainFactory: () => ({ receipt: async () => ({}), deliveryReceipt: async () => ({}),
        buildAndSign: () => { signatures++; throw new Error('Signing forbidden in isolated upgrade'); },
        broadcast: () => { broadcasts++; throw new Error('Broadcast forbidden in isolated upgrade'); } }) });
    try {
      // The 1.3.7 reporting schema and all existing rows must survive this upgrade.
      const migrationKey = 'delivery-report-history-indexed-v1';
      function preserved(allowedMeta = new Set([migrationKey]), allowReportingWrites = false) {
        for (const table of expected.tables) {
          if (allowReportingWrites && table.name.startsWith('platform_delivery_')) continue;
          assert.deepEqual(app.store.db.prepare(`PRAGMA table_info(${table.name})`).all().map(column => column.name), table.columns, 'unchanged schema ' + table.name);
          let rows = JSON.parse(JSON.stringify(app.store.db.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all()));
          if (table.name === 'meta') rows = rows.filter(row => !allowedMeta.has(row.key));
          const original = table.name === 'meta' ? table.rows.filter(row => !allowedMeta.has(row.key)) : table.rows;
          assert.deepEqual(rows, original, 'preserved after upgrade ' + table.name);
        }
      }
      assert.equal(app.store.getMeta(migrationKey), true);
      preserved();
      assert.deepEqual(app.store.db.prepare('PRAGMA table_info(platform_delivery_reports)').all().map(row => row.name),
        ['platform_origin', 'device_id', 'binding_wallet', 'txid', 'payload', 'status', 'attempts', 'retry_after', 'detail', 'updated_at']);
      assert.deepEqual(app.store.db.prepare('PRAGMA table_info(platform_delivery_candidates)').all().map(row => row.name), ['id', 'txid']);
      assert.equal(app.store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'platform_report_%'").get().n, 6);
      assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM platform_delivery_reports').get().n, 0);
      await app.deliveryReporter.sync(); assert.equal(platformCalls, 0);
      await app.deliveryReporter.close();
      // Synthetic platform only. Lose one acknowledgement, read the durable
      // queue through a separate SQLite connection, then retry after restart.
      const { DeliveryReporter } = require(path.join(target, 'src/delivery-reporter'));
      const { walletAddress } = require(path.join(target, 'src/config'));
      const { DatabaseSync } = require('node:sqlite');
      const linked = { ...app.engine.getConfig(), energyTransport: 'platform', platformUrl: 'https://isolated-platform.example',
        platformToken: 'synthetic-report-token', platformDeviceId: 'fixture-report-device', platformWallet: walletAddress(app.engine.getConfig()) };
      const confirmed = expected.tables.find(table => table.name === 'deliveries').rows.filter(row => row.status === 'confirmed');
      assert.equal(confirmed.length, 1);
      const receipt = expected.tables.find(table => table.name === 'delivery_receipts').rows.find(row => row.delivery_id === confirmed[0].id);
      const original = confirmed[0];
      const publicFacts = { txid: original.txid.toLowerCase(), owner_address: original.wallet, recipient_address: original.address,
        asset_type: original.asset_type, asset_id: original.token, amount_raw: original.raw_amount,
        block_time_ms: receipt.block_time, delivery_id: original.id };
      const requests = []; let now = Date.now();
      const makeReporter = () => new DeliveryReporter(app.store, () => linked, { now: () => now, factory: (origin, token) => {
        assert.equal(origin, linked.platformUrl); assert.equal(token, linked.platformToken);
        return { reportDeliveries: async body => {
          requests.push(structuredClone(body)); assert.equal(body.client_version, '1.3.8');
          assert.deepEqual(body.items, [publicFacts]);
          const serialized = JSON.stringify(body);
          for (const secret of [linked.privateKey, linked.platformToken, 'signed_json', 'signature']) assert.ok(!serialized.includes(secret), 'public transaction facts only');
          if (requests.length === 1) throw new Error('Synthetic response lost');
          return { accepted_txids: body.items.map(item => item.txid), rejected: [] };
        } };
      } });
      let reporter = makeReporter();
      await reporter.sync(); assert.equal(requests.length, 1); assert.equal(reporter.snapshot().queued, 1);
      await reporter.close();
      const persisted = new DatabaseSync(path.join(target, 'data/records.sqlite'), { readOnly: true });
      try {
        const rows = persisted.prepare('SELECT payload,status,attempts FROM platform_delivery_reports').all();
        assert.equal(rows.length, 1); assert.equal(rows[0].status, 'queued'); assert.equal(rows[0].attempts, 1);
        assert.deepEqual(JSON.parse(rows[0].payload), publicFacts);
      } finally { persisted.close(); }
      reporter = makeReporter(); await reporter.sync(); assert.equal(requests.length, 1, 'Persisted retry delay prevents immediate duplicate send');
      now += 3600001; await reporter.sync(); assert.equal(requests.length, 2); assert.equal(reporter.snapshot().accepted, 1); assert.equal(reporter.snapshot().queued, 0);
      await reporter.close();
      const bindingKeys = JSON.stringify([linked.platformUrl, linked.platformDeviceId, linked.platformWallet]);
      preserved(new Set([migrationKey, 'delivery-report-scan:' + bindingKeys, 'delivery-report-retry:' + bindingKeys]), true);
      assert.equal(app.store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      const base = `http://127.0.0.1:${app.port}`, headers = { Cookie: 'tcl_session=' + app.token };
      const stateText = await (await fetch(base + '/api/state', { headers })).text(), state = JSON.parse(stateText);
      assert.equal(state.version, '1.3.8'); assert.equal(state.state, 'stopped'); assert.equal(state.energyRecovery, null);
      assert.equal(state.config.energyTransport, 'local'); assert.equal(state.energyPlatform.linked, false);
      assert.equal(state.config.autoResumeEnergy, true); assert.equal(state.pool.unlocked, false);
      assert.equal(state.config.hasPrivateKey, true); assert.equal(state.config.privateKey, undefined);
      assert.ok(!stateText.includes(expected.syntheticPrivateKey));
      const records = await (await fetch(base + '/api/records', { headers })).json(); assert.equal(records.total, expected.recordCount);
      assert.equal(records.items.filter(row => row.status === 'queued').length, 1);
      assert.equal(records.items.filter(row => row.status === 'uncertain').length, 1);
      assert.ok(!JSON.stringify(records).includes('signed_json'));
      assert.ok(!JSON.stringify(records).includes(expected.syntheticPrivateKey));
      const byId = new Map(records.items.map(row => [row.id, row]));
      assert.equal(expected.cancelled.length, 3);
      for (const [i, original] of expected.cancelled.entries()) {
        const row = byId.get(original.id); assert.ok(row, 'cancelled record retained');
        assert.equal(row.status, 'failed'); assert.equal(row.dedupe_cleared_at, null);
        for (const field of ['address', 'source_tx', 'txid', 'raw_amount']) assert.equal(row[field], original[field]);
        assert.equal(row.energyOrder.intent_id, original.intent_id); assert.equal(row.energyOrder.order_id, original.order_id);
        assert.equal(row.energyOrder.transaction_status, 'not_broadcast'); assert.equal(row.energyOrder.resolved, 1);
        assert.equal(row.energyOrder.billing_status, 'released'); assert.equal(row.energyOrder.service_status, 'not_delivered');
        assert.equal(row.energyOrder.customer_fee_sun, '0'); assert.deepEqual(row.energyOrder.first_submit_error, original.firstError);
        assert.equal(row.attempts.length, 1); assert.equal(row.attempts[0].txid, original.txid); assert.equal(row.attempts[0].status, 'cancelled');
        assert.equal(row.manualRetry.canPrepare, true, 'Legacy cancelled retry markers permit a fresh review only');
        assert.equal(row.retry.exhausted, 1);
        assert.equal(app.store.hasRecipient('live', row.address, 'e'.repeat(64), app.engine.getConfig()), true);
      }
      const skipped = byId.get(expected.skippedId); assert.ok(skipped, 'never-signed history retained');
      assert.equal(skipped.status, 'skipped_restart'); assert.equal(skipped.address, expected.cancelled[2].address);
      assert.equal(skipped.txid, null); assert.equal(skipped.wallet, null); assert.equal(skipped.raw_amount, null);
      assert.ok(skipped.dedupe_cleared_at); assert.equal(skipped.attempts.length, 0); assert.equal(skipped.energyOrder, null);
      assert.equal(skipped.retry.attempts, 0);
      assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM delivery_receipts WHERE delivery_id=?').get(skipped.id).n, 0);
      assert.deepEqual(app.store.getMeta('delivery-manual-retry:' + expected.cancelled[0].id), expected.marker);
      assert.deepEqual(app.store.getMeta('delivery-manual-retry-history:' + expected.cancelled[0].id), expected.retryHistory);
      assert.deepEqual(JSON.parse(JSON.stringify(app.store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(expected.cancelled[0].id))), expected.receiptPlaceholder);
      // Exercise the installed eligibility guard with synthetic platform/chain
      // responses. canPrepare alone does not inspect receipt evidence.
      const { ManualRetry } = require(path.join(target, 'src/manual-retry'));
      const reviewConfig = { ...app.engine.getConfig(), platformUrl: 'https://isolated-platform.example', platformDeviceId: 'fixture-device' };
      const receiptRow = app.store.get(expected.cancelled[0].id), receiptOrder = app.store.energyOrder(receiptRow.id);
      let syntheticOriginalOrderChecks = 0, syntheticExpiredSignatureChecks = 0;
      const reviewEngine = { store: app.store, closed: false, getConfig: () => reviewConfig,
        energyPolicy: { client: () => ({ byIntent: async intent => {
          syntheticOriginalOrderChecks++; assert.equal(intent, receiptOrder.intent_id);
          return { id: receiptOrder.order_id, intent_id: intent, address: receiptRow.wallet, contract: receiptRow.token,
            recipient: receiptRow.address, amount_raw: receiptRow.raw_amount, status: 'cancelled', tx_status: 'not_broadcast',
            broadcast_started: false, txid: null, service_status: 'not_delivered', billing_status: 'released', charge_sun: receiptOrder.price_sun };
        } }) }, getChain: () => ({ replacementReady: async (txid, expiration) => {
          syntheticExpiredSignatureChecks++; assert.equal(txid, receiptRow.txid); assert.ok(expiration < Date.now()); return true;
        } }) };
      const offlineReview = new ManualRetry(reviewEngine);
      assert.equal((await offlineReview.oldRecord(receiptRow, reviewConfig, offlineReview.context())).id, receiptOrder.order_id);
      assert.equal(syntheticOriginalOrderChecks, 1); assert.equal(syntheticExpiredSignatureChecks, 1);
      assert.equal(byId.get(expected.cancelled[0].id).manualRetry.phase, expected.marker.phase);
      assert.deepEqual(app.store.getMeta('delivery-manual-retry-review:' + expected.cancelled[1].id), expected.review);
      assert.equal(byId.get(expected.cancelled[1].id).manualRetry.checkedAt, expected.review.checkedAt);
      const html = await (await fetch(base, { headers })).text(); assert.ok(html.includes('energy-pair-code'));
      const script = html.match(/src="(\/app\.js[^"\s]*)"/); assert.ok(script, 'Application script is referenced');
      const servedScript = Buffer.from(await (await fetch(base + script[1], { headers })).arrayBuffer());
      assert.deepEqual(servedScript, fs.readFileSync(path.join(target, 'public/app.js')));
      app.pool.unlock('isolated-upgrade-password'); assert.equal(app.pool.snapshot().total, 1);
      assert.equal(app.pool.vault.require().data.wallets[0].address, expected.poolAddress); app.pool.vault.lock();
      const statistics = await (await fetch(base + '/api/statistics', { headers })).json();
      assert.equal(typeof statistics.totals.serviceFeeSun, 'string'); assert.equal(statistics.totals.serviceFeeSun, '0');
      await app.energyPolicy.sync(); await app.engine.confirmExecuted();
      assert.equal(app.engine.running, false); assert.equal(app.engine.state, 'stopped');
      assert.equal(signatures, 0); assert.equal(broadcasts, 0); assert.equal(platformCalls, 0);
      console.log(JSON.stringify({ version: state.version, startsPaused: true, autoResumeFlagDoesNotAutoStart: true,
        defaultIndependentLocal: true, records: records.total, pending: state.pending,
        preservedTables: expected.tables.map(table => table.name), originalTableSchemasPreserved: true, reportingOutboxMigrationVerified: true, reportingOutboxPreservedFrom137: true,
        originalRowsUnchangedAfterReporting: true, unboundReportingMakesNoRequests: true, syntheticReportingRequests: requests.length,
        syntheticPublicFactsOnly: true, syntheticReporterRestartAndBackoffVerified: true, syntheticHistoricalDeliveryAccepted: 1,
        encryptedPoolUnlocks: true, poolStartsLocked: true,
        energyOrdersPreserved: true, cancelledOrdersPreserved: expected.cancelled.length, originalSubmissionErrorsPreserved: true,
        neverSignedSameRecipientHistoryPreserved: true, durableRetryMarkerPreserved: true, archivedRetryHistoryPreserved: true, legacyMarkerAllowsFreshReview: true, manualRetryReviewPreserved: true,
        recipientDedupePreserved: true, receiptRetryPlaceholderPreserved: true,
        receiptRetryPlaceholderAllowsFreshReview: true, receiptGuardVerifiedWithSyntheticResponses: true,
        syntheticOriginalOrderChecks, syntheticExpiredSignatureChecks, statisticsReadable: true, platformRequests: platformCalls,
        signatures, realBroadcasts: broadcasts, packagedUiAssetsPresent: true }));
    } finally { await app.close(); }
  }
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const folder = fs.mkdtempSync(path.join(__dirname, 'tcl-1.3.8-upgrade-'));
  const target = path.join(folder, 'TCL广告投放工具'), dataDir = path.join(target, 'data');
  assert.equal(path.dirname(folder), __dirname);
  const oldArchive = path.join(root, `publish/v${from}/tcl-ad-tool-${from}-win-x64.zip`);
  const oldEnvelope = JSON.parse(fs.readFileSync(path.join(root, `publish/v${from}/update.json`), 'utf8'));
  const oldManifest = verifyManifest(oldEnvelope);
  assert.equal(oldManifest.version, from);
  assert.equal(fs.statSync(oldArchive).size, oldManifest.size);
  assert.equal(hashFile(oldArchive), oldManifest.sha256);
  const extraction = spawnSync('python', ['-X', 'utf8', path.join(__dirname, 'extract-release.py'), oldArchive, target], { encoding: 'utf8', windowsHide: true });
  if (extraction.status !== 0) throw new Error(extraction.stderr);
  const originalWorkerHash = hashFile(path.join(target, 'src/update-worker.js'));
  const originalUpdaterHash = hashFile(path.join(target, 'src/updater.js'));
  const oldConfig = require(path.join(target, 'src/config'));
  const { config: fixtureConfig, address, key } = require(path.join(target, 'test/fixtures'));
  const settings = oldConfig.normalize(fixtureConfig({ privateKey: key(1), apiKey: 'synthetic-offline-key', poolFundingKey: key(900), rpcUrl: 'https://127.0.0.1:9', autoResumeEnergy: true, restartScanMode: 'resume', unfinishedPolicy: 'resend' }));
  assert.equal(settings.energyTransport, 'local', 'The migration fixture must preserve independent local mode');
  atomicJson(path.join(dataDir, 'config.json'), settings);
  const { Store } = require(path.join(target, 'src/store'));
  const store = new Store(dataDir);
  const { DeliveryReporter: BaselineReporter } = require(path.join(target, 'src/delivery-reporter'));
  const baselineReporter = new BaselineReporter(store, () => settings);
  await baselineReporter.close();
  for (const [i, status] of ['confirmed', 'queued', 'uncertain', 'executed', 'failed'].entries()) {
    const source = String(i).padStart(64, 'a');
    store.offer('live', { to: address(100 + i), txid: source, asset: 'TRX', amount: '150' }, settings, 12345);
    const row = store.db.prepare('SELECT * FROM deliveries WHERE source_tx=?').get(source);
    store.update(row.id, status, { txid: status === 'queued' ? null : String(i).padStart(64, 'b'), wallet: address(1), raw_amount: '168000000000000000000', detail: 'isolated 1.3.7 upgrade fixture' });
    const current = store.get(row.id);
    if (status === 'failed') {
      store.energyIntent(current, { platformUrl: 'https://isolated-platform.example', platformDeviceId: 'fixture-device' });
      store.updateEnergyOrder(row.id, { submitted: 1, resolved: 1, order_id: 'fixture-complete-order',
        txid: current.txid, route: 'catfee', price_sun: '950000', customer_fee_sun: '0',
        billing_status: 'released', transaction_status: 'failed', service_status: 'not_delivered' });
    }
    if (current.txid) {
      store.retryInfo(current);
      store.db.prepare('UPDATE delivery_attempts SET signed_json=?,expiration=? WHERE txid=?').run(status === 'confirmed' ? null : '{"isolatedTestOnly":true}', Date.now() + 60000, current.txid);
    }
    if (status === 'confirmed') store.saveReceipt(current, { id: current.txid, blockTimeStamp: Date.now(), fee: 123, receipt: { result: 'SUCCESS', energy_usage_total: 27957 } });
  }
  // Reproduce the observed third recipient's older history: skipped before any
  // signature, with only its address dedupe released for the later trigger.
  const skippedSource = 'd'.repeat(64), skippedAt = new Date().toISOString();
  assert.equal(store.offer('live', { to: address(203), txid: skippedSource, asset: 'TRX', amount: '150' }, settings, 12346), true);
  const skipped = store.db.prepare('SELECT * FROM deliveries WHERE source_tx=?').get(skippedSource);
  store.update(skipped.id, 'skipped_restart', { txid: null, raw_amount: null, wallet: null, detail: 'synthetic never-signed history' });
  store.db.prepare('UPDATE deliveries SET dedupe_cleared_at=? WHERE id=?').run(skippedAt, skipped.id);
  store.retryInfo(store.get(skipped.id));

  const { TronWeb, utils } = require(path.join(target, 'node_modules/tronweb'));
  const offlineTron = new TronWeb({ fullHost: 'https://offline.invalid' });
  const cancelled = [];
  for (let i = 0; i < 3; i++) {
    const source = String(i + 1).padStart(64, 'c'), recipient = address(201 + i);
    assert.equal(store.offer('live', { to: recipient, txid: source, asset: 'TRX', amount: '150' }, settings, 12347 + i), true);
    const row = store.db.prepare('SELECT * FROM deliveries WHERE source_tx=?').get(source);
    const raw = oldConfig.decimalUnits(row.amount, 18).toString(), timestamp = Date.now() - 86400000 + i;
    const transaction = { visible: false, raw_data: { ref_block_bytes: '1234', ref_block_hash: '1234567890abcdef', timestamp,
      expiration: timestamp + 60000, fee_limit: Number(oldConfig.decimalUnits(settings.feeLimitTrx, 6)),
      contract: [{ type: 'TriggerSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: {
        owner_address: TronWeb.address.toHex(address(1)), contract_address: TronWeb.address.toHex(row.token),
        data: 'a9059cbb' + TronWeb.address.toHex(recipient).slice(2).padStart(64, '0') + BigInt(raw).toString(16).padStart(64, '0'),
      } } }] } };
    const protobuf = utils.transaction.txJsonToPb(transaction);
    transaction.raw_data_hex = utils.transaction.txPbToRawDataHex(protobuf);
    transaction.txID = utils.transaction.txPbToTxID(protobuf).replace(/^0x/, '');
    const signed = await offlineTron.trx.sign(transaction, key(1));
    store.prepareAttempt(row, { signed, txid: signed.txID, rawAmount: raw, wallet: address(1) });
    store.attemptStatus(signed.txID, 'cancelled', 'synthetic platform confirmed never broadcast');
    store.update(row.id, 'failed', { detail: 'synthetic cancelled order, released fee' });
    store.exhaustRetry(store.get(row.id));
    const order = store.energyIntent(row, { platformUrl: 'https://isolated-platform.example', platformDeviceId: 'fixture-device' });
    store.updateEnergyOrder(row.id, { submitted: 1, resolved: 1, order_id: 'fixture-cancelled-' + (i + 1),
      txid: signed.txID, route: 'catfee', price_sun: '950000', customer_fee_sun: '0',
      billing_status: 'released', transaction_status: 'not_broadcast', service_status: 'not_delivered' });
    const firstError = { message: 'synthetic original bandwidth rejection [REDACTED]', at: new Date(timestamp).toISOString() };
    store.setMeta('delivery-platform-submit-error:' + row.id, firstError);
    cancelled.push({ id: row.id, address: recipient, source_tx: source, txid: signed.txID, raw_amount: raw,
      intent_id: order.intent_id, order_id: 'fixture-cancelled-' + (i + 1), firstError });
  }
  const marker = { phase: 'uncertain', reason: 'synthetic durable once-only retry marker', at: new Date().toISOString() };
  // Reproduce the actual old Store retry placeholder. No receipt metrics or
  // checked_at are fabricated; preserve this row instead of deleting evidence.
  store.deferReceiptBackfill(store.get(cancelled[0].id));
  const receiptPlaceholder = store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(cancelled[0].id);
  assert.equal(receiptPlaceholder.checked_at, null);
  for (const field of ['block_time', 'energy', 'bandwidth', 'fee_sun']) assert.equal(receiptPlaceholder[field], null);
  store.setMeta('delivery-manual-retry:' + cancelled[0].id, marker);
  const retryHistory = [{ phase: 'stopped', reason: 'synthetic archived previous review',
    at: new Date(Date.now() - 86400000).toISOString(), original_txid: cancelled[0].txid }];
  store.setMeta('delivery-manual-retry-history:' + cancelled[0].id, retryHistory);
  const review = { reason: 'synthetic reviewed cancellation, awaiting explicit confirmation', checkedAt: new Date().toISOString() };
  store.setMeta('delivery-manual-retry-review:' + cancelled[1].id, review);
  store.db.prepare('INSERT INTO legacy_addresses VALUES(?)').run(address(500));
  store.db.prepare('INSERT INTO legacy_transactions VALUES(?)').run('f'.repeat(64));
  store.setMeta('cursor:' + oldConfig.fingerprint(settings, 'live'), 12345);
  const { PoolVault } = require(path.join(target, 'src/pool-vault'));
  const vault = new PoolVault(dataDir); vault.initialize('isolated-upgrade-password');
  const wallet = { id: 'fixture-wallet', address: address(700), key: key(700), batchId: 'fixture-batch', createdAt: new Date().toISOString() };
  vault.require().data.wallets.push(wallet); vault.save(); vault.lock();
  const { WalletPool } = require(path.join(target, 'src/pool'));
  const pool = new WalletPool(store, dataDir, () => settings, () => { throw new Error('No chain during synthetic setup'); });
  pool.unlock('isolated-upgrade-password');
  store.db.prepare("UPDATE pool_wallets SET active=1,enabled=1,state='recovering',token_id='1000016',free_bandwidth=251,raw_balance='12345' WHERE id=?").run(wallet.id);
  store.db.prepare('INSERT INTO pool_batches(id,kind,token_id,rpc,owner,decimals,amount,total,group_size,budget_sun,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('fixture-batch', 'activate', '1000016', settings.rpcUrl, address(1), 0, '1', 1, 1, '1000000', 'paused', wallet.createdAt);
  store.db.prepare('INSERT INTO pool_jobs(id,batch_id,wallet_id,address,token,amount,raw_amount,wallet,rpc,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('fixture-job', 'fixture-batch', wallet.id, wallet.address, '1000016', '1', '1', address(1), settings.rpcUrl, wallet.createdAt);
  await pool.close();
  const tables = ['deliveries', 'legacy_addresses', 'legacy_transactions', 'meta', 'delivery_attempts', 'delivery_retry', 'delivery_receipts', 'pool_wallets', 'pool_batches', 'pool_jobs', 'energy_orders', 'platform_delivery_reports', 'platform_delivery_candidates']
    .map(name => ({ name, columns: store.db.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name), rows: store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() }));
  store.close();
  const expectedFile = path.join(folder, 'expected.json');
  atomicJson(expectedFile, { tables, recordCount: tables.find(table => table.name === 'deliveries').rows.length,
    energyOrderCount: tables.find(table => table.name === 'energy_orders').rows.length,
    cancelled, skippedId: skipped.id, marker, retryHistory, review, receiptPlaceholder, syntheticPrivateKey: key(1), poolAddress: wallet.address });
  const configHash = hashFile(path.join(dataDir, 'config.json')), vaultHash = hashFile(vault.file);
  const envelope = fs.readFileSync(path.join(root, `publish/v${version}/update.json`));
  const bytes = fs.readFileSync(path.join(root, `publish/v${version}/tcl-ad-tool-${version}-win-x64.zip`));
  // Bind directly to signed archive bytes while the independent audit report is finalized.
  const sourceRead = spawnSync('python', ['-X', 'utf8', '-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read("TCL广告投放工具/release-manifest.json").decode("utf-8"))',
    path.join(root, `publish/v${version}/tcl-ad-tool-${version}-win-x64.zip`)], { encoding: 'utf8', windowsHide: true });
  assert.equal(sourceRead.status, 0, sourceRead.stderr);
  const packagedManifest = JSON.parse(sourceRead.stdout), signedRelease = verifyManifest(JSON.parse(envelope));
  assert.equal(packagedManifest.version, version); assert.equal(signedRelease.version, version); assert.equal(signedRelease.size, bytes.length);
  const packageProof = { sha256: signedRelease.sha256, startupSourceHashes: packagedManifest.sourceHashes };
  assert.equal(packageProof.sha256, sha256(bytes));
  const { Updater } = require(path.join(target, 'src/updater'));
  let injectedRequests = 0;
  const updater = new Updater({ root: target, fetcher: async url => { injectedRequests++; return new Response(url.endsWith('/update.json') ? envelope : bytes); } });
  assert.equal((await updater.check()).latestVersion, version);
  const directory = await updater.prepare(version);
  assert.equal(hashFile(path.join(target, 'src/updater.js')), originalUpdaterHash);
  assert.equal(hashFile(path.join(target, 'src/update-worker.js')), originalWorkerHash);
  assert.equal(hashFile(path.join(directory, 'src/update-worker.js')), originalWorkerHash);
  const { install } = require(path.join(directory, 'src/update-worker'));
  const progress = require(path.join(directory, 'src/update-progress')).createProgress({ directory, version });
  const installed = await install({ root: target, dataDir, directory, reopen: false, progress });
  assert.equal(progress.snapshot().status, 'installed');
  assert.equal(installed.ok, true); assert.equal(installed.version, version);
  for (const [name, expectedHash] of Object.entries(packageProof.startupSourceHashes)) assert.equal(hashFile(path.join(target, name)), expectedHash, 'installed ' + name);
  const installedWorkerHash = hashFile(path.join(target, 'src/update-worker.js'));
  assert.equal(installedWorkerHash, originalWorkerHash, 'Reporting release preserves the published updater worker source');
  assert.equal(hashFile(path.join(dataDir, 'config.json')), configHash); assert.equal(hashFile(vault.file), vaultHash);
  assert.equal(hashFile(path.join(installed.backupDir, 'config.json')), configHash);
  assert.equal(hashFile(path.join(installed.backupDir, 'pool-vault.json')), vaultHash);
  assert.ok(fs.existsSync(path.join(installed.backupDir, 'records.sqlite')));
  const backup = new DatabaseSync(path.join(installed.backupDir, 'records.sqlite'), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    for (const table of tables) assert.deepEqual(backup.prepare(`SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`).all(), table.rows, 'backup ' + table.name);
  } finally { backup.close(); }
  const checked = spawnSync(path.join(target, 'runtime/node.exe'), ['--disable-warning=ExperimentalWarning', '-e', '(' + verifyInstalledRelease.toString() + ')()', target, expectedFile], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (checked.status !== 0) throw new Error(checked.stderr || checked.stdout);
  assert.equal(hashFile(path.join(dataDir, 'config.json')), configHash); assert.equal(hashFile(vault.file), vaultHash);
  const result = { from, version, target, isolatedDirectory: folder, originalReleasedUpdater: true, originalReleasedWorker: true,
    originalUpdaterHash, originalWorkerHash, temporaryWorkerMatchesBaseline: true, installedWorkerHash,
    installedStartupSourcesMatchCandidate: true, signedCandidateVerified: true, packageSha256: sha256(bytes),
    baselineSignatureVerified: true, baselineSha256: oldManifest.sha256,
    injectedDownloadRequests: injectedRequests, networkDownloads: 0, configUnchanged: true, encryptedVaultUnchanged: true,
    backupVerified: true, backupDirectory: installed.backupDir, businessTablesPreserved: tables.map(table => table.name),
    installedSmoke: JSON.parse(checked.stdout.trim()), desktopWindowOpened: false, progressWindowOpened: false, visibleProgressTestedSeparately: true, realBroadcasts: 0, published: false };
  atomicJson(path.join(folder, 'result.json'), result);
  atomicJson(path.join(__dirname, 'upgrade-verification-1.3.8-from-1.3.7.json'), result);
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
