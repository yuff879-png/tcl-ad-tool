'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { receiptMetrics } = require('./statistics');
const { LEGACY_EXPIRATION_MS } = require('./delivery-retry');
const DELIVERY_SCHEMA = `CREATE TABLE IF NOT EXISTS deliveries(
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, address TEXT NOT NULL, source_tx TEXT NOT NULL,
  source_asset TEXT NOT NULL, source_amount TEXT NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL,
  status TEXT NOT NULL, txid TEXT, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, block_height INTEGER, raw_amount TEXT, wallet TEXT, rpc TEXT,
  dedupe_cleared_at TEXT, asset_type TEXT NOT NULL DEFAULT 'TRC20', asset_scope TEXT NOT NULL DEFAULT '', UNIQUE(mode,asset_scope,source_tx));`;

class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'records.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS legacy_addresses(address TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS legacy_transactions(txid TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      ${DELIVERY_SCHEMA}
      CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL);`);
    try {
      if (!this.db.prepare('PRAGMA table_info(deliveries)').all().some(row => row.name === 'rpc')) this.db.exec('ALTER TABLE deliveries ADD COLUMN rpc TEXT');
      if (!this.db.prepare('PRAGMA table_info(deliveries)').all().some(row => row.name === 'dedupe_cleared_at')) {
        const folder = path.join(directory, 'backups', '升级数据库前-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
        fs.mkdirSync(folder, { recursive: true });
        this.db.exec("VACUUM INTO '" + path.join(folder, 'records.sqlite').replace(/'/g, "''") + "'");
        for (const name of ['config.json', 'migration-report.json']) if (fs.existsSync(path.join(directory, name))) fs.copyFileSync(path.join(directory, name), path.join(folder, name));
        // Rebuild only to replace the old permanent address constraint. Transaction
        // identity remains unique forever, including after the user clears addresses.
        this.transaction(() => {
          this.db.exec(`ALTER TABLE deliveries RENAME TO deliveries_v1;
            ${DELIVERY_SCHEMA}
            INSERT INTO deliveries(rowid,id,mode,address,source_tx,source_asset,source_amount,token,amount,status,txid,detail,created_at,updated_at,block_height,raw_amount,wallet,rpc)
            SELECT rowid,id,mode,address,source_tx,source_asset,source_amount,token,amount,status,txid,detail,created_at,updated_at,block_height,raw_amount,wallet,rpc FROM deliveries_v1;
            DROP TABLE deliveries_v1;`);
        });
      }
      if (!this.db.prepare('PRAGMA table_info(deliveries)').all().some(row => row.name === 'asset_type')) {
        const folder = path.join(directory, 'backups', 'TRC10迁移前-' + Date.now());
        fs.mkdirSync(folder, { recursive: true });
        this.db.exec("VACUUM INTO '" + path.join(folder, 'records.sqlite').replace(/'/g, "''") + "'");
        if (fs.existsSync(path.join(directory, 'config.json'))) fs.copyFileSync(path.join(directory, 'config.json'), path.join(folder, 'config.json'));
        this.transaction(() => {
          this.db.exec(`ALTER TABLE deliveries RENAME TO deliveries_legacy;
            ${DELIVERY_SCHEMA}
            INSERT INTO deliveries(rowid,id,mode,address,source_tx,source_asset,source_amount,token,amount,status,txid,detail,created_at,updated_at,block_height,raw_amount,wallet,rpc,dedupe_cleared_at)
            SELECT rowid,id,mode,address,source_tx,source_asset,source_amount,token,amount,status,txid,detail,created_at,updated_at,block_height,raw_amount,wallet,rpc,dedupe_cleared_at FROM deliveries_legacy;
            DROP TABLE deliveries_legacy;`);
        });
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS delivery_status ON deliveries(mode,status);
        CREATE UNIQUE INDEX IF NOT EXISTS active_delivery_address ON deliveries(mode,asset_scope,address) WHERE dedupe_cleared_at IS NULL;
        CREATE TABLE IF NOT EXISTS delivery_receipts(
          delivery_id TEXT PRIMARY KEY, txid TEXT NOT NULL COLLATE NOCASE, block_time INTEGER,
          energy TEXT, fee_sun TEXT, checked_at TEXT, retry_after INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS receipt_retry ON delivery_receipts(retry_after);
        CREATE TABLE IF NOT EXISTS delivery_retry(
          delivery_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
          exhausted INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS delivery_attempts(
          txid TEXT PRIMARY KEY COLLATE NOCASE, delivery_id TEXT NOT NULL,
          signed_json TEXT, expiration INTEGER, status TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          block_time INTEGER, energy TEXT, fee_sun TEXT,
          receipt_retry_after INTEGER NOT NULL DEFAULT 0, receipt_attempts INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS attempts_delivery ON delivery_attempts(delivery_id);
        CREATE TABLE IF NOT EXISTS energy_orders(
          delivery_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE, platform_origin TEXT NOT NULL,
          device_id TEXT NOT NULL, admission_id TEXT, order_id TEXT, txid TEXT, route TEXT,
          price_sun TEXT, customer_fee_sun TEXT, service_status TEXT, transaction_status TEXT,
          billing_status TEXT, submitted INTEGER NOT NULL DEFAULT 0, resolved INTEGER NOT NULL DEFAULT 0,
          detail TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);`);
      for (const table of ['delivery_receipts', 'delivery_attempts']) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'bandwidth')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN bandwidth TEXT`);
      }
      if (!this.db.prepare('PRAGMA table_info(delivery_attempts)').all().some(c => c.name === 'wallet')) this.db.exec('ALTER TABLE delivery_attempts ADD COLUMN wallet TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS delivery_wallet_status ON deliveries(wallet,status)');
    } catch (error) { this.db.close(); throw error; }
  }
  getMeta(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, JSON.stringify(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  hasRecipient(mode, address, txid, config) {
    return Boolean((!this.getMeta('legacyAddressesClearedAt') && this.db.prepare('SELECT 1 FROM legacy_addresses WHERE address=?').get(address))
      || this.db.prepare('SELECT 1 FROM legacy_transactions WHERE txid=?').get(txid)
      || this.db.prepare(`SELECT 1 FROM deliveries WHERE mode=? AND ((address=? AND dedupe_cleared_at IS NULL) OR source_tx=?) ${config ? "AND (asset_scope='' OR asset_scope=?)" : ''}`).get(mode, address, txid, ...(config ? [(config.assetType || 'TRC20') + ':' + config.tokenContract] : [])));
  }
  offer(mode, candidate, config, blockHeight) {
    if (this.hasRecipient(mode, candidate.to, candidate.txid, config)) return false;
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO deliveries
      (id,mode,address,source_tx,source_asset,source_amount,token,amount,status,created_at,updated_at,block_height,rpc,asset_type,asset_scope)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), mode, candidate.to, candidate.txid,
      candidate.asset, candidate.amount, config.tokenContract, config.sendAmount, 'queued', now, now, blockHeight, config.rpcUrl, config.assetType || 'TRC20', (config.assetType || 'TRC20') + ':' + config.tokenContract).changes > 0;
  }
  next(mode, config) { return this.db.prepare(`SELECT * FROM deliveries WHERE mode=? AND status='queued' ${config ? 'AND asset_type=? AND token=?' : ''} ORDER BY created_at,rowid LIMIT 1`).get(mode, ...(config ? [config.assetType || 'TRC20', config.tokenContract] : [])); }
  get(id) { return this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id); }
  energyOrder(id) { return this.db.prepare('SELECT * FROM energy_orders WHERE delivery_id=?').get(id) || null; }
  energyIntent(row, config) {
    this.db.prepare(`INSERT OR IGNORE INTO energy_orders(delivery_id,intent_id,platform_origin,device_id,updated_at) VALUES(?,?,?,?,?)`)
      .run(row.id, crypto.randomUUID(), config.platformUrl, config.platformDeviceId, new Date().toISOString());
    return this.energyOrder(row.id);
  }
  updateEnergyOrder(id, values) {
    const allowed = ['admission_id', 'order_id', 'txid', 'route', 'price_sun', 'customer_fee_sun', 'service_status', 'transaction_status', 'billing_status', 'submitted', 'resolved', 'detail'];
    const fields = allowed.filter(k => Object.hasOwn(values, k));
    this.db.prepare(`UPDATE energy_orders SET updated_at=?${fields.map(k => ',' + k + '=?').join('')} WHERE delivery_id=?`)
      .run(new Date().toISOString(), ...fields.map(k => values[k]), id);
    return this.energyOrder(id);
  }
  unresolvedEnergyOrders() { return this.db.prepare('SELECT * FROM energy_orders WHERE submitted=1 AND resolved=0 ORDER BY updated_at').all(); }
  retryInfo(row) {
    this.db.prepare('INSERT OR IGNORE INTO delivery_retry(delivery_id,attempts) VALUES(?,?)').run(row.id, row.txid ? 1 : 0);
    const legacyExpiration = Number.isFinite(Date.parse(row.updated_at)) ? Date.parse(row.updated_at) + LEGACY_EXPIRATION_MS : null;
    if (row.txid) this.db.prepare(`INSERT OR IGNORE INTO delivery_attempts(txid,delivery_id,expiration,status,detail,created_at)
      VALUES(?,?,?,?,?,?)`).run(row.txid, row.id, legacyExpiration,
        row.status, '旧版记录，仅有交易哈希；核实过期后才能重新构建', row.updated_at);
    return this.db.prepare('SELECT * FROM delivery_retry WHERE delivery_id=?').get(row.id);
  }
  attempt(txid) { return this.db.prepare('SELECT * FROM delivery_attempts WHERE txid=? COLLATE NOCASE').get(txid); }
  beginAttempt(row) {
    this.retryInfo(row);
    this.db.prepare('UPDATE delivery_retry SET attempts=attempts+1,retry_after=0 WHERE delivery_id=?').run(row.id);
    return this.retryInfo(this.get(row.id)).attempts;
  }
  refundAttempt(row) {
    this.db.prepare('UPDATE delivery_retry SET attempts=MAX(0,attempts-1) WHERE delivery_id=?').run(row.id);
  }
  prepareAttempt(row, prepared, atomic = true) {
    const save = () => {
      this.db.prepare(`INSERT INTO delivery_attempts(txid,delivery_id,signed_json,expiration,status,created_at,wallet)
        VALUES(?,?,?,?,?,?,?)`).run(prepared.txid, row.id, JSON.stringify(prepared.signed), prepared.signed.raw_data.expiration, 'prepared', new Date().toISOString(), prepared.wallet);
      this.update(row.id, 'prepared', { txid: prepared.txid, raw_amount: prepared.rawAmount, wallet: prepared.wallet, detail: '交易及重试次数已保存，准备广播' });
    };
    if (atomic) this.transaction(save); else save();
  }
  attemptStatus(txid, status, detail = '') {
    this.db.prepare('UPDATE delivery_attempts SET status=?,detail=? WHERE txid=? COLLATE NOCASE').run(status, detail, txid);
  }
  deferRetry(row, retryAfter) { this.retryInfo(row); this.db.prepare('UPDATE delivery_retry SET retry_after=? WHERE delivery_id=?').run(retryAfter, row.id); }
  exhaustRetry(row) { this.retryInfo(row); this.db.prepare('UPDATE delivery_retry SET exhausted=1 WHERE delivery_id=?').run(row.id); }
  nextRetry(config, wallet, now = Date.now(), excluded = []) {
    return this.db.prepare(`SELECT d.* FROM deliveries d LEFT JOIN delivery_retry r ON r.delivery_id=d.id
      WHERE d.mode='live' AND d.status IN ('prepared','pending','uncertain')
        AND COALESCE(r.exhausted,0)=0 AND COALESCE(r.retry_after,0)<=?
        AND d.token=? AND d.amount=? AND d.rpc=? AND d.asset_type=? ${config.assetType === 'TRC10' ? '' : 'AND d.wallet=?'}
        ${excluded.length ? 'AND d.id NOT IN (' + excluded.map(() => '?').join(',') + ')' : ''}
      ORDER BY d.created_at,d.rowid LIMIT 1`).get(now, config.tokenContract, config.sendAmount, config.rpcUrl, config.assetType || 'TRC20', ...(config.assetType === 'TRC10' ? [] : [wallet]), ...excluded);
  }
  queued(mode, config) { return this.db.prepare(`SELECT * FROM deliveries WHERE mode=? AND status='queued' ${config ? 'AND asset_type=? AND token=?' : ''} ORDER BY created_at,rowid`).all(mode, ...(config ? [config.assetType || 'TRC20', config.tokenContract] : [])); }
  skipUnsent(mode) {
    const at = new Date().toISOString();
    // Only never-broadcast rows can be abandoned. Their source transaction remains
    // unique, but a later NEW trigger may offer the same recipient again.
    return this.db.prepare(`UPDATE deliveries SET status='skipped_restart',updated_at=?,dedupe_cleared_at=?,
      detail='按重新启动设置略过：中断前尚未发送；仅允许以后的新交易重新触发'
      WHERE mode=? AND status='queued' AND txid IS NULL`).run(at, at, mode).changes;
  }
  update(id, status, values = {}) {
    const allowed = ['txid', 'detail', 'raw_amount', 'wallet'];
    const fields = allowed.filter(k => Object.hasOwn(values, k));
    this.db.prepare(`UPDATE deliveries SET status=?,updated_at=?${fields.map(k => ',' + k + '=?').join('')} WHERE id=?`)
      .run(status, new Date().toISOString(), ...fields.map(k => values[k]), id);
  }
  pending() { return this.db.prepare("SELECT * FROM deliveries WHERE mode='live' AND status IN ('prepared','pending','uncertain','executed') ORDER BY created_at,rowid").all(); }
  deliveryAttempts(id) { return this.db.prepare('SELECT * FROM delivery_attempts WHERE delivery_id=? ORDER BY created_at,rowid').all(id); }
  requiresAllAttemptReview(row) {
    return row?.mode === 'live' && ['prepared', 'pending', 'uncertain', 'executed'].includes(row.status)
      && this.getMeta('delivery-review:' + row.id)?.all_attempts === true;
  }
  ensureReviewAttempt(row) {
    if (row.txid) this.db.prepare(`INSERT OR IGNORE INTO delivery_attempts(txid,delivery_id,status,detail,created_at,wallet)
      VALUES(?,?,?,?,?,?)`).run(row.txid, row.id, row.status, '旧版记录未保存可验证有效期；仅查询原交易，不推定过期', row.updated_at, row.wallet);
  }
  reviewFingerprint(row) {
    return crypto.createHash('sha256').update(JSON.stringify([row.status, row.txid, row.updated_at, row.wallet, row.token, row.address, row.raw_amount, row.rpc, row.dedupe_cleared_at,
      this.deliveryAttempts(row.id).map(a => [a.txid, a.status, a.expiration, a.wallet, a.signed_json])])).digest('hex');
  }
  recovery(row) {
    const saved = this.getMeta('delivery-review:' + row.id), pending = row.mode === 'live' && ['prepared', 'pending', 'uncertain', 'executed'].includes(row.status);
    const canRecheck = pending || row.status === 'archived_unconfirmed';
    const fresh = saved && saved.fingerprint === this.reviewFingerprint(row) && Date.parse(saved.checked_at) + 60000 > Date.now();
    return { can_recheck: canRecheck, can_close: Boolean(pending && fresh && saved.can_close), close_action: pending && fresh ? saved.close_action : null,
      reason: saved?.fingerprint === this.reviewFingerprint(row) ? saved.reason : canRecheck ? '请先重新核查原交易；不会签名、广播或补发' : '这条记录已不在待核查队列',
      checked_at: saved?.checked_at || null, closed_at: saved?.closed_at || null, note: saved?.note || null };
  }
  record(id) {
    const row = this.get(id); if (!row) return null;
    row.retry = this.db.prepare('SELECT attempts,exhausted,retry_after FROM delivery_retry WHERE delivery_id=?').get(row.id) || null;
    row.energyOrder = this.energyOrder(row.id);
    if (row.energyOrder) row.energyOrder.first_submit_error = this.getMeta('delivery-platform-submit-error:' + row.id);
    // Signed payloads are local recovery material, never part of a UI/API response.
    row.attempts = this.db.prepare('SELECT txid,status,detail,created_at FROM delivery_attempts WHERE delivery_id=? ORDER BY created_at,rowid').all(row.id);
    row.recovery = this.recovery(row);
    row.manualRetry = require('./manual-retry').manualRetryState(this, row);
    return row;
  }
  saveReceipt(row, info) {
    const metrics = receiptMetrics(row, info);
    if (!metrics) return false;
    const current = this.db.prepare("SELECT 1 FROM deliveries WHERE id=? AND mode='live' AND txid=? COLLATE NOCASE").get(row.id, row.txid);
    if (!current && !this.db.prepare('SELECT 1 FROM delivery_attempts WHERE delivery_id=? AND txid=? COLLATE NOCASE').get(row.id, row.txid)) return false;
    this.db.prepare(`UPDATE delivery_attempts SET block_time=COALESCE(?,block_time),energy=COALESCE(?,energy),bandwidth=COALESCE(?,bandwidth),fee_sun=COALESCE(?,fee_sun),receipt_retry_after=0
      WHERE txid=? COLLATE NOCASE`).run(metrics.blockTime, metrics.energy, metrics.bandwidth ?? null, metrics.feeSun, row.txid);
    if (current) this.db.prepare(`INSERT INTO delivery_receipts(delivery_id,txid,block_time,energy,bandwidth,fee_sun,checked_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO UPDATE SET
      txid=excluded.txid,block_time=CASE WHEN txid=excluded.txid THEN COALESCE(excluded.block_time,block_time) ELSE excluded.block_time END,
      energy=CASE WHEN txid=excluded.txid THEN COALESCE(excluded.energy,energy) ELSE excluded.energy END,
      bandwidth=CASE WHEN txid=excluded.txid THEN COALESCE(excluded.bandwidth,bandwidth) ELSE excluded.bandwidth END,
      fee_sun=CASE WHEN txid=excluded.txid THEN COALESCE(excluded.fee_sun,fee_sun) ELSE excluded.fee_sun END,checked_at=excluded.checked_at,retry_after=0`)
      .run(row.id, row.txid, metrics.blockTime, metrics.energy, metrics.bandwidth ?? null, metrics.feeSun, new Date().toISOString());
    return metrics.blockTime !== null && metrics.energy !== null && metrics.feeSun !== null && (row.asset_type !== 'TRC10' || metrics.bandwidth !== null);
  }
  nextReceiptBackfill(now = Date.now()) {
    const historical = this.db.prepare(`SELECT a.* FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
      WHERE d.mode='live' AND a.txid!=d.txid COLLATE NOCASE AND a.status='failed_final'
        AND (a.block_time IS NULL OR a.energy IS NULL OR (d.asset_type='TRC10' AND a.bandwidth IS NULL) OR a.fee_sun IS NULL) AND a.receipt_retry_after<=?
      ORDER BY a.receipt_retry_after,a.created_at LIMIT 1`).get(now);
    if (historical) { const delivery = this.get(historical.delivery_id); return { ...delivery, wallet: historical.wallet || delivery.wallet, txid: historical.txid, historyOnly: true, receipt_attempts: historical.receipt_attempts }; }
    return this.db.prepare(`SELECT d.*,COALESCE(r.attempts,0) AS receipt_attempts FROM deliveries d
      LEFT JOIN delivery_receipts r ON r.delivery_id=d.id AND r.txid=d.txid COLLATE NOCASE
      WHERE d.mode='live' AND d.status IN ('confirmed','failed','uncertain') AND length(d.txid)=64
        AND NOT EXISTS (SELECT 1 FROM energy_orders e WHERE e.delivery_id=d.id AND e.resolved=1 AND e.transaction_status='not_broadcast')
        AND (r.block_time IS NULL OR r.energy IS NULL OR (d.asset_type='TRC10' AND r.bandwidth IS NULL) OR r.fee_sun IS NULL) AND COALESCE(r.retry_after,0)<=?
      ORDER BY COALESCE(r.retry_after,0),d.created_at DESC,d.rowid DESC LIMIT 1`).get(now);
  }
  deferReceiptBackfill(row, now = Date.now()) {
    const attempts = (row.receipt_attempts || 0) + 1;
    const retry = now + Math.min(21600000, 60000 * 2 ** Math.min(attempts - 1, 9));
    if (row.historyOnly) {
      this.db.prepare('UPDATE delivery_attempts SET receipt_retry_after=?,receipt_attempts=? WHERE txid=?').run(retry, attempts, row.txid);
      return;
    }
    this.db.prepare(`INSERT INTO delivery_receipts(delivery_id,txid,retry_after,attempts) VALUES(?,?,?,?)
      ON CONFLICT(delivery_id) DO UPDATE SET retry_after=excluded.retry_after,attempts=excluded.attempts`)
      .run(row.id, row.txid, retry, attempts);
  }
  counts() {
    const rows = this.db.prepare('SELECT mode,status,COUNT(*) AS count FROM deliveries GROUP BY mode,status').all();
    const delivered = this.deliveredCounts();
    return { rows, legacy: delivered.legacy, delivered };
  }
  deliveredCounts() {
    const legacyCleared = this.getMeta('legacyAddressesClearedAt') ? 1 : 0;
    const legacy = legacyCleared ? 0 : this.db.prepare('SELECT COUNT(*) AS count FROM legacy_addresses').get().count;
    const live = this.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT address FROM legacy_addresses WHERE ?=0 UNION
      SELECT address FROM deliveries WHERE mode='live' AND status='confirmed' AND dedupe_cleared_at IS NULL)`).get(legacyCleared).count;
    const simulate = this.db.prepare("SELECT COUNT(DISTINCT address) AS count FROM deliveries WHERE mode='simulate' AND status='simulated' AND dedupe_cleared_at IS NULL").get().count;
    return { live, simulate, legacy };
  }
  clearDeliveredAddresses(mode, backupPath) {
    if (!['live', 'simulate'].includes(mode)) throw new Error('清空范围无效');
    return this.transaction(() => {
      if (this.pending().length) throw new Error('还有待确认交易，请先核查完成后再清空');
      const count = this.deliveredCounts()[mode];
      const at = new Date().toISOString();
      this.db.prepare('UPDATE deliveries SET dedupe_cleared_at=? WHERE mode=? AND status=? AND dedupe_cleared_at IS NULL')
        .run(at, mode, mode === 'live' ? 'confirmed' : 'simulated');
      if (mode === 'live') this.setMeta('legacyAddressesClearedAt', at);
      const result = { mode, count, at };
      this.setMeta('lastAddressReset', { ...result, backupPath });
      return result;
    });
  }
  records({ search = '', mode = '', status = '', page = 1, limit = 50 } = {}) {
    const filters = [], params = [];
    if (search) { filters.push('(instr(address,?)>0 OR instr(source_tx,?)>0 OR instr(COALESCE(txid,\'\'),?)>0)'); params.push(search, search, search); }
    if (mode) { filters.push('mode=?'); params.push(mode); }
    if (status) { filters.push('status=?'); params.push(status); }
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM deliveries' + where).get(...params).count;
    const items = this.db.prepare('SELECT * FROM deliveries' + where + ' ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(...params, limit, (page - 1) * limit);
    return { total, page, limit, items: items.map(row => this.record(row.id)) };
  }
  log(level, message) {
    this.db.prepare('INSERT INTO logs(time,level,message) VALUES(?,?,?)').run(new Date().toISOString(), level, message);
    if (this.db.prepare('SELECT MAX(id) AS id FROM logs').get().id % 200 === 0) this.db.exec('DELETE FROM logs WHERE id < (SELECT MAX(id)-10000 FROM logs)');
  }
  logs(after = 0) { return this.db.prepare('SELECT * FROM (SELECT * FROM logs WHERE id>? ORDER BY id DESC LIMIT 150) ORDER BY id').all(after); }
  close() { this.db.close(); }
}
module.exports = { Store };
