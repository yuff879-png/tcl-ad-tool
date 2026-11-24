'use strict';
const { TronWeb, utils } = require('tronweb');
const { RentalClient, platformOrigin } = require('./rental-client');
const { walletAddress, redact } = require('./config');
const VERSION = require('../package.json').version;
const SUCCESSFUL_DELIVERIES = `SELECT d.id AS delivery_id,a.txid,
  COALESCE(a.wallet,CASE WHEN a.txid=d.txid COLLATE NOCASE THEN d.wallet END) AS owner_address,
  d.address AS recipient_address,d.asset_type,d.token AS asset_id,d.raw_amount AS amount_raw,
  COALESCE(a.block_time,CASE WHEN a.txid=d.txid COLLATE NOCASE THEN r.block_time END) AS block_time_ms
  FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
  LEFT JOIN delivery_receipts r ON r.delivery_id=d.id AND r.txid=a.txid COLLATE NOCASE
  WHERE d.mode='live' AND a.status='confirmed'
  UNION ALL
  SELECT d.id,d.txid,d.wallet,d.address,d.asset_type,d.token,d.raw_amount,r.block_time
  FROM deliveries d LEFT JOIN delivery_receipts r ON r.delivery_id=d.id AND r.txid=d.txid COLLATE NOCASE
  WHERE d.mode='live' AND d.status='confirmed'
    AND NOT EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.txid=d.txid COLLATE NOCASE AND a.status='confirmed')`;

// The queue contains public transaction facts only. It never stores credentials,
// signed transactions or private keys. A device change gets a separate queue.
class DeliveryReporter {
  constructor(store, getConfig, { factory = (origin, token) => new RentalClient(origin, token), authorizeOwner = async () => false, now = Date.now } = {}) {
    this.store = store; this.db = store.db; this.getConfig = getConfig;
    this.factory = factory; this.authorizeOwner = authorizeOwner; this.now = now;
    this.pass = null; this.timer = null; this.closed = false; this.error = '';
    this.db.exec(`CREATE TABLE IF NOT EXISTS platform_delivery_reports(
      platform_origin TEXT NOT NULL, device_id TEXT NOT NULL, binding_wallet TEXT NOT NULL, txid TEXT NOT NULL COLLATE NOCASE,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      retry_after INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      PRIMARY KEY(platform_origin,device_id,binding_wallet,txid));
      CREATE INDEX IF NOT EXISTS platform_delivery_report_retry ON platform_delivery_reports(platform_origin,device_id,binding_wallet,status,retry_after);
      CREATE INDEX IF NOT EXISTS delivery_attempt_confirmed ON delivery_attempts(status,delivery_id);
      CREATE INDEX IF NOT EXISTS delivery_confirmed ON deliveries(mode,status);
      CREATE INDEX IF NOT EXISTS delivery_report_txid ON deliveries(txid COLLATE NOCASE) WHERE mode='live' AND status='confirmed';
      CREATE TABLE IF NOT EXISTS platform_delivery_candidates(
        id INTEGER PRIMARY KEY AUTOINCREMENT,txid TEXT NOT NULL UNIQUE COLLATE NOCASE);`);
    // Each final confirmation or later receipt completion moves that txid past
    // every device's durable cursor. No full-history scan runs in the send loop.
    for (const [name, table, event, condition, value] of [
      ['attempt_insert', 'delivery_attempts', 'INSERT', "NEW.status='confirmed'", 'NEW.txid'],
      ['attempt_update', 'delivery_attempts', 'UPDATE OF status,block_time,wallet', "NEW.status='confirmed'", 'NEW.txid'],
      ['delivery_insert', 'deliveries', 'INSERT', "NEW.mode='live' AND NEW.status='confirmed'", 'NEW.txid'],
      ['delivery_update', 'deliveries', 'UPDATE OF status,txid,wallet,raw_amount', "NEW.mode='live' AND NEW.status='confirmed'", 'NEW.txid'],
      ['receipt_insert', 'delivery_receipts', 'INSERT', "EXISTS(SELECT 1 FROM deliveries d WHERE d.id=NEW.delivery_id AND d.mode='live' AND (d.status='confirmed' OR EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.delivery_id=d.id AND a.txid=NEW.txid COLLATE NOCASE AND a.status='confirmed')))", 'NEW.txid'],
      ['receipt_update', 'delivery_receipts', 'UPDATE OF block_time', "EXISTS(SELECT 1 FROM deliveries d WHERE d.id=NEW.delivery_id AND d.mode='live' AND (d.status='confirmed' OR EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.delivery_id=d.id AND a.txid=NEW.txid COLLATE NOCASE AND a.status='confirmed')))", 'NEW.txid'],
    ]) this.db.exec(`CREATE TRIGGER IF NOT EXISTS platform_report_${name} AFTER ${event} ON ${table}
      WHEN ${condition} AND length(${value})>0 BEGIN
      INSERT INTO platform_delivery_candidates(txid) VALUES(lower(${value})) ON CONFLICT(txid) DO UPDATE SET id=(SELECT COALESCE(MAX(id),0)+1 FROM platform_delivery_candidates);
      END;`);
    if (!this.store.getMeta('delivery-report-history-indexed-v1')) this.store.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO platform_delivery_candidates(txid) SELECT lower(txid) FROM (${SUCCESSFUL_DELIVERIES}) WHERE length(txid)>0`);
      this.store.setMeta('delivery-report-history-indexed-v1', true);
    });
  }
  binding() {
    const c = this.getConfig();
    if (c.energyTransport !== 'platform' || !c.platformToken || !c.platformDeviceId || c.platformWallet !== walletAddress(c)) return null;
    return { origin: platformOrigin(c.platformUrl), device: String(c.platformDeviceId), wallet: c.platformWallet, token: c.platformToken };
  }
  unchanged(binding) {
    const current = this.binding();
    return current && current.origin === binding.origin && current.device === binding.device && current.wallet === binding.wallet && current.token === binding.token;
  }
  cursorKey(binding) { return 'delivery-report-scan:' + JSON.stringify([binding.origin, binding.device, binding.wallet]); }
  enqueue(binding, limit = 100) {
    // A final successful attempt is a real delivery even when another attempt
    // keeps the business record under review. Never report preparation/funding
    // pool_jobs, simulated records or mere supplier acknowledgements.
    const cursorKey = this.cursorKey(binding), cursor = this.store.getMeta(cursorKey) || 0;
    const candidates = this.db.prepare('SELECT id,txid FROM platform_delivery_candidates WHERE id>? ORDER BY id LIMIT ?').all(cursor, limit);
    const query = this.db.prepare(`SELECT * FROM (${SUCCESSFUL_DELIVERIES}) WHERE txid=? COLLATE NOCASE LIMIT 1`);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO platform_delivery_reports
      (platform_origin,device_id,binding_wallet,txid,payload,status,detail,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
    this.store.transaction(() => {
      for (const candidate of candidates) {
        const row = query.get(candidate.txid); if (!row) continue;
        const attempt = this.store.attempt(row.txid);
        const originalAmount = attemptAmount(row, attempt);
        const payload = reportPayload({ ...row, amount_raw: originalAmount }, this.now()), valid = payload !== null;
        insert.run(binding.origin, binding.device, binding.wallet, String(row.txid || '').toLowerCase(), JSON.stringify(payload || {}), valid ? 'queued' : 'invalid',
          valid ? '' : '本地历史记录缺少有效的链上投放参数，未上报', new Date(this.now()).toISOString());
        if (valid) this.db.prepare(`UPDATE platform_delivery_reports SET payload=?,status='queued',detail='',retry_after=0,updated_at=?
          WHERE platform_origin=? AND device_id=? AND binding_wallet=? AND txid=? AND status='invalid'`).run(JSON.stringify(payload), new Date(this.now()).toISOString(), binding.origin, binding.device, binding.wallet, row.txid);
      }
      if (candidates.length) this.store.setMeta(cursorKey, candidates.at(-1).id);
    });
    return candidates.length;
  }
  defer(binding, row, message) {
    const attempts = row.attempts + 1, delay = message.startsWith('等待投放钱包所有权证明') ? 15000 : Math.min(3600000, 15000 * 2 ** Math.min(attempts - 1, 8));
    this.db.prepare(`UPDATE platform_delivery_reports SET attempts=?,retry_after=?,detail=?,updated_at=?
      WHERE platform_origin=? AND device_id=? AND binding_wallet=? AND txid=?`).run(attempts, this.now() + delay, message.slice(0, 500), new Date(this.now()).toISOString(), binding.origin, binding.device, binding.wallet, row.txid);
  }
  sync() {
    if (this.pass) return this.pass;
    if (this.closed) return Promise.resolve();
    this.pass = (async () => {
      const binding = this.binding(); if (!binding) return;
      this.enqueue(binding);
      const stateKey = 'delivery-report-retry:' + JSON.stringify([binding.origin, binding.device, binding.wallet]);
      const previous = this.store.getMeta(stateKey);
      if (previous?.retry_after > this.now()) return;
      const rows = this.db.prepare(`SELECT * FROM platform_delivery_reports
        WHERE platform_origin=? AND device_id=? AND binding_wallet=? AND status='queued' AND retry_after<=?
        ORDER BY retry_after,updated_at LIMIT 20`).all(binding.origin, binding.device, binding.wallet, this.now());
      const client = this.factory(binding.origin, binding.token);
      const ready = []; let authorizationError = false;
      for (const row of rows) {
        if (this.closed || !this.unchanged(binding)) break;
        try {
          const payload = JSON.parse(row.payload);
          if (payload.owner_address !== binding.wallet) {
            const authorized = await this.authorizeOwner(client, binding, payload.owner_address);
            if (authorized === null) {
              this.db.prepare(`UPDATE platform_delivery_reports SET status='unreportable',detail='原投放钱包不属于当前绑定或本机钱包池，请使用原钱包绑定后补报'
                WHERE platform_origin=? AND device_id=? AND binding_wallet=? AND txid=?`).run(binding.origin, binding.device, binding.wallet, row.txid);
              continue;
            }
            if (!authorized) { this.defer(binding, row, '等待投放钱包所有权证明；解锁原钱包库后自动补报'); continue; }
          }
          if (this.closed || !this.unchanged(binding)) break;
          ready.push({ row, payload });
        } catch (error) {
          this.error = redact(error.message || String(error), this.getConfig());
          this.defer(binding, row, this.error);
          authorizationError = true;
          // Bound failed requests per pass; a service outage must never slow
          // the delivery loop or create a burst of identical failing requests.
          break;
        }
      }
      if (this.closed || !this.unchanged(binding)) return;
      try {
        const counts = this.snapshot();
        const result = await client.reportDeliveries({ client_version: VERSION, items: ready.map(item => item.payload),
          pending_count: counts.queued, unreportable_count: counts.unreportable });
        if (!Array.isArray(result?.accepted_txids) || !Array.isArray(result.rejected)) throw new Error('平台投放统计确认不完整，保留待补报记录');
        const submitted = new Set(ready.map(item => item.row.txid));
        const accepted = new Set(result.accepted_txids.map(txid => typeof txid === 'string' ? txid.toLowerCase() : ''));
        const rejected = new Map(result.rejected.map(item => [typeof item?.txid === 'string' ? item.txid.toLowerCase() : '', item]));
        if ([...accepted, ...rejected.keys()].some(txid => !submitted.has(txid)) || [...accepted].some(txid => rejected.has(txid))) throw new Error('平台投放统计回执与本批交易不匹配');
        this.store.transaction(() => {
          for (const { row } of ready) {
            if (accepted.has(row.txid) || rejected.has(row.txid)) {
              const rejection = rejected.get(row.txid);
              if (rejection?.code === 'wallet_not_registered') {
                const payload = JSON.parse(row.payload);
                this.store.setMeta('delivery-report-wallet:' + JSON.stringify([binding.origin, binding.device, binding.wallet, payload.owner_address]), false);
                this.defer(binding, row, '平台尚未登记原钱包，稍后重新证明归属并补报');
                continue;
              }
              this.db.prepare(`UPDATE platform_delivery_reports SET status=?,detail=?,updated_at=?
                WHERE platform_origin=? AND device_id=? AND binding_wallet=? AND txid=?`).run(rejection ? 'rejected' : 'accepted',
                  rejection ? '平台未接收：' + String(rejection.code || '核对未通过').slice(0, 100) : '', new Date(this.now()).toISOString(), binding.origin, binding.device, binding.wallet, row.txid);
            } else this.defer(binding, row, '平台尚未确认接收本笔，稍后重试');
          }
          this.store.setMeta(stateKey, { failures: 0, retry_after: this.now() + (ready.length ? 2000 : 15000) });
        });
        if (!authorizationError) this.error = '';
      } catch (error) {
        this.error = redact(error.message || String(error), this.getConfig());
        for (const { row } of ready) this.defer(binding, row, this.error);
        const failures = (previous?.failures || 0) + 1;
        this.store.setMeta(stateKey, { failures, retry_after: this.now() + Math.min(3600000, 15000 * 2 ** Math.min(failures - 1, 8)) });
      }
    })().catch(error => { this.error = redact(error.message || String(error), this.getConfig()); }).finally(() => { this.pass = null; });
    return this.pass;
  }
  snapshot() {
    const binding = this.binding();
    if (!binding) return { linked: false, queued: 0, accepted: 0, rejected: 0, unreportable: 0, unlockRequired: false, error: '' };
    const counts = this.db.prepare(`SELECT status,COUNT(*) AS count FROM platform_delivery_reports WHERE platform_origin=? AND device_id=? AND binding_wallet=? GROUP BY status`).all(binding.origin, binding.device, binding.wallet);
    const totals = Object.fromEntries(counts.map(row => [row.status, row.count]));
    const undiscovered = this.db.prepare(`SELECT COUNT(*) AS n FROM platform_delivery_candidates c WHERE c.id>?
      AND NOT EXISTS(SELECT 1 FROM platform_delivery_reports p WHERE p.platform_origin=? AND p.device_id=?
        AND p.binding_wallet=? AND p.txid=c.txid COLLATE NOCASE)`).get(this.store.getMeta(this.cursorKey(binding)) || 0, binding.origin, binding.device, binding.wallet).n;
    const incomplete = this.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE mode='live' AND status='confirmed' AND COALESCE(length(txid),0)=0").get().n;
    const unlockRequired = Boolean(this.db.prepare(`SELECT 1 FROM platform_delivery_reports WHERE platform_origin=? AND device_id=? AND binding_wallet=? AND status='queued' AND detail LIKE '等待投放钱包所有权证明%' LIMIT 1`).get(binding.origin, binding.device, binding.wallet));
    return { linked: true, queued: (totals.queued || 0) + undiscovered, accepted: totals.accepted || 0, rejected: totals.rejected || 0,
      unreportable: incomplete + (totals.invalid || 0) + (totals.unreportable || 0), unlockRequired, error: this.error };
  }
  start() {
    if (this.closed || this.timer) return;
    const tick = async () => { await this.sync(); if (!this.closed) { this.timer = setTimeout(tick, 2000); this.timer.unref(); } };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  async close() { this.closed = true; clearTimeout(this.timer); await this.pass; }
}
function attemptAmount(row, attempt) {
  // Current delivery.raw_amount belongs to the latest attempt. Historical
  // attempts may have a different amount; recover it only from their locally
  // retained transaction whose hash and immutable transfer fields all match.
  if (!attempt?.signed_json) return row.amount_raw;
  let tx;
  try { tx = JSON.parse(attempt.signed_json); } catch { return null; }
  try {
    if (tx.txID?.toLowerCase() !== row.txid.toLowerCase() || !utils.transaction.txCheck(tx) || tx.raw_data.contract?.length !== 1) return null;
    const contract = tx.raw_data.contract[0], value = contract.parameter?.value;
    if (!value || contract.Permission_id || TronWeb.address.fromHex(value.owner_address) !== row.owner_address) return null;
    if (row.asset_type === 'TRC10') {
      if (contract.type !== 'TransferAssetContract' || TronWeb.address.fromHex(value.to_address) !== row.recipient_address
        || value.asset_name?.toLowerCase() !== Buffer.from(row.asset_id).toString('hex') || !Number.isSafeInteger(value.amount) || value.amount <= 0) return null;
      return String(value.amount);
    }
    if (contract.type !== 'TriggerSmartContract' || TronWeb.address.fromHex(value.contract_address) !== row.asset_id
      || !/^a9059cbb[0-9a-f]{128}$/i.test(value.data) || (value.call_value || 0) !== 0 || value.call_token_value || value.token_id) return null;
    const recipient = '41' + value.data.slice(32, 72);
    if (TronWeb.address.fromHex(recipient) !== row.recipient_address || !/^0{24}$/i.test(value.data.slice(8, 32))) return null;
    return BigInt('0x' + value.data.slice(72)).toString();
  } catch { return null; }
}
function reportPayload(row, now = Date.now()) {
  if (!/^[a-f\d]{64}$/i.test(row.txid || '') || row.owner_address?.length !== 34 || row.recipient_address?.length !== 34 || !TronWeb.isAddress(row.owner_address) || !TronWeb.isAddress(row.recipient_address) || row.owner_address === row.recipient_address
    || !['TRC20', 'TRC10'].includes(row.asset_type) || !(row.asset_type === 'TRC20' ? row.asset_id?.length === 34 && TronWeb.isAddress(row.asset_id) : /^[1-9]\d{0,18}$/.test(row.asset_id))
    || !/^[1-9]\d{0,77}$/.test(row.amount_raw || '') || BigInt(row.amount_raw) > (row.asset_type === 'TRC10' ? 9223372036854775807n : (1n << 256n) - 1n)
    || !Number.isSafeInteger(row.block_time_ms) || row.block_time_ms <= 0 || row.block_time_ms > 253402300799000 || row.block_time_ms > now + 300000
    || typeof row.delivery_id !== 'string' || row.delivery_id.length > 100 || !row.delivery_id) return null;
  return { txid: row.txid.toLowerCase(), owner_address: row.owner_address, recipient_address: row.recipient_address,
    asset_type: row.asset_type, asset_id: row.asset_id, amount_raw: row.amount_raw, block_time_ms: row.block_time_ms,
    delivery_id: row.delivery_id };
}
module.exports = { DeliveryReporter, reportPayload, attemptAmount };
