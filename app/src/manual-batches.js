'use strict';
const crypto = require('node:crypto');
const { TronWeb } = require('tronweb');
const { effectiveConfig, validate, walletAddress, decimalUnits, formatUnits } = require('./config');
const MAX_ADDRESSES = 10000;
const IN_PROGRESS = new Set(['queued', 'prepared', 'pending', 'uncertain', 'executed']);
const FINAL_ATTEMPTS = new Set(['confirmed', 'failed_final', 'expired', 'cancelled', 'not_broadcast']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function parseAddresses(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('请粘贴地址或导入不超过 1 MB 的 TXT / 单列 CSV');
  const entries = text.replace(/^\uFEFF/, '').split(/[\s,，;；]+/).filter(Boolean).map(s => s.replace(/^"(.*)"$/, '$1'));
  if (/^(address|地址|收款地址)$/i.test(entries[0] || '')) entries.shift();
  if (!entries.length) throw new Error('请先填写收款地址');
  if (entries.length > MAX_ADDRESSES) throw new Error(`每批最多 ${MAX_ADDRESSES.toLocaleString('zh-CN')} 条地址，请分批导入`);
  return entries;
}

class ManualBatches {
  constructor(engine) {
    this.engine = engine; this.store = engine.store; this.preview = null; this.revision = 0;
    // Opening the app never resumes an interrupted manual batch implicitly.
    this.holdUnsent();
  }
  holdUnsent() {
    return this.store.db.prepare(`UPDATE manual_batches SET paused=1 WHERE paused=0
      AND EXISTS(SELECT 1 FROM deliveries d WHERE d.manual_batch_id=manual_batches.id AND d.status='queued')`).run().changes;
  }
  cancelPreview() { this.preview = null; this.revision++; }
  assertAvailable() {
    const e = this.engine;
    if (e.closed || e.pool?.running || e.energyRecovery || ['starting', 'stopping'].includes(e.state) || (e.busy && !e.running)) throw new Error('请等待当前操作结束，或先取消自动恢复后再添加批量投放');
  }
  repeatBlock(row, mode) {
    if (row.id === this.engine.activeDeliveryId || IN_PROGRESS.has(row.status)) return '同地址正在排队、发送或等待确认';
    const attempts = this.store.deliveryAttempts(row.id), order = this.store.energyOrder(row.id);
    if (row.status === 'confirmed' || (mode === 'simulate' && row.status === 'simulated')) {
      if (attempts.some(a => !FINAL_ATTEMPTS.has(a.status)) || (order?.submitted && (!order.resolved || order.transaction_status !== 'success'))) return '历史交易或平台订单仍需核查';
      return null;
    }
    if (['failed', 'cancelled', 'skipped', 'skipped_restart'].includes(row.status) && !row.txid && !attempts.length && !order?.submitted) return null;
    return '历史结果未知或失败交易需核查，请先处理原记录';
  }
  classify(entries, mode, config, token, historyPolicy = 'dedupe', expectedVersions = null) {
    const e = this.engine, accepted = [], skipped = [], seen = new Set();
    const counts = { input: entries.length, invalid: 0, duplicate: 0, blocked: 0, existing: 0, promoted: 0, added: 0, repeated: 0 };
    const own = new Set([walletAddress(config), walletAddress({ privateKey: config.poolFundingKey }), token?.issuer]);
    const history = this.store.db.prepare("SELECT rowid AS history_rowid,* FROM deliveries WHERE mode=? AND address=? AND (asset_scope='' OR asset_scope=?) ORDER BY rowid DESC");
    for (const address of entries) {
      let reason, category, promote, repeated = false, historyVersion = 0;
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) || !TronWeb.isAddress(address)) { category = 'invalid'; reason = '地址格式或校验码无效'; }
      else if (seen.has(address)) { category = 'duplicate'; reason = '名单内重复'; }
      else if (config.blacklist.includes(address) || own.has(address) || e.pool?.ownAddress(address)) { category = 'blocked'; reason = '黑名单、投放钱包或发行地址'; }
      else {
        const rows = history.all(mode, address, config.assetType + ':' + config.tokenContract);
        historyVersion = rows[0]?.history_rowid || 0;
        const row = rows.find(r => r.dedupe_cleared_at === null);
        const promotable = row && row.status === 'queued' && !row.txid && row.source_kind === 'scan' && row.id !== e.activeDeliveryId
          && row.token === config.tokenContract && row.amount === config.sendAmount && row.rpc === config.rpcUrl
          && row.asset_type === config.assetType && !this.store.energyOrder(row.id)?.submitted;
        if (historyPolicy === 'repeat') {
          reason = rows.filter(r => !promotable || r.id !== row.id).map(r => this.repeatBlock(r, mode)).find(Boolean);
          if (!reason && !promotable && expectedVersions && historyVersion !== expectedVersions.get(address)) reason = '预览后同地址出现了新投放，请重新预览';
          if (reason) category = 'existing';
          else if (promotable) promote = row.id;
          else repeated = rows.length > 0 || this.store.hasRecipient(mode, address, '', config);
        } else if (promotable) promote = row.id;
        else if (this.store.hasRecipient(mode, address, '', config)) { category = 'existing'; reason = '已有去重记录、正在处理或已在手动队列'; }
      }
      seen.add(address);
      if (reason) { counts[category]++; if (skipped.length < 50) skipped.push({ address, reason }); }
      else { counts[promote ? 'promoted' : repeated ? 'repeated' : 'added']++; accepted.push({ address, promote, repeated, historyVersion }); }
    }
    return { counts, accepted, skipped };
  }
  assertCapacity(plan, mode, config) {
    if (this.store.queueSummary(mode, config).manual + plan.accepted.length > MAX_ADDRESSES) throw new Error('手动等待队列最多 10,000 个地址，请等当前批次处理后再添加');
  }
  async prepare(input) {
    this.assertAvailable(); this.cancelPreview();
    const revision = this.revision, e = this.engine, running = e.running, runId = e.runId;
    const mode = running ? e.mode : input.mode;
    if (!['live', 'simulate'].includes(mode) || (running && input.mode !== mode)) throw new Error('请选择投放模式；运行期间必须沿用当前模式');
    const historyPolicy = input.historyPolicy === undefined ? 'dedupe' : input.historyPolicy;
    if (!['dedupe', 'repeat'].includes(historyPolicy)) throw new Error('请选择去重发送或历史地址也发送');
    const config = effectiveConfig(validate(e.getConfig(), mode)), fingerprint = hash(JSON.stringify(config));
    const entries = parseAddresses(input.text);
    const checked = running ? e.preflightResult : await e.preflight(mode);
    this.assertAvailable();
    if (revision !== this.revision || running !== e.running || runId !== e.runId || fingerprint !== hash(JSON.stringify(effectiveConfig(e.getConfig())))) throw new Error('运行状态或参数已变化，请重新预览');
    const plan = this.classify(entries, mode, config, checked.token, historyPolicy);
    this.assertCapacity(plan, mode, config);
    const confirmationToken = crypto.randomBytes(24).toString('hex'), expires = Date.now() + 120000;
    this.preview = { confirmationToken, expires, revision, running, runId, mode, config, fingerprint,
      token: checked.token, historyPolicy, historyVersions: new Map(plan.accepted.map(a => [a.address, a.historyVersion])), addresses: plan.accepted.map(a => a.address), counts: plan.counts };
    return { confirmationToken, expiresAt: new Date(expires).toISOString(), mode, running, historyPolicy,
      assetType: config.assetType, token: config.tokenContract, symbol: checked.token.symbol, amount: config.sendAmount,
      totalAmount: formatUnits(decimalUnits(config.sendAmount, checked.token.decimals) * BigInt(plan.accepted.length), checked.token.decimals),
      intervalSeconds: config.sendIntervalSeconds, remainingLimit: config.maxPerRun ? Math.max(0, config.maxPerRun - (running ? e.metrics.sent + e.metrics.simulated : 0)) : null,
      restartPolicy: config.unfinishedPolicy, counts: plan.counts, eligible: plan.accepted.length,
      addresses: plan.accepted.slice(0, 100).map(a => ({ address: a.address, promoted: Boolean(a.promote), repeated: a.repeated })), skipped: plan.skipped };
  }
  assertPreview(p, { starting = false } = {}) {
    if (p.revision !== this.revision || p.expires < Date.now() || p.fingerprint !== hash(JSON.stringify(effectiveConfig(this.engine.getConfig())))
      || (!starting && (p.running !== this.engine.running || p.runId !== this.engine.runId))) throw new Error('批量投放预览已过期，或运行状态、参数已变化，请重新预览');
  }
  resumeBatch(id, config) {
    const batch = this.store.db.prepare('SELECT * FROM manual_batches WHERE id=?').get(id);
    if (!batch) throw new Error('没有找到这个手动批次');
    if (!batch.paused) throw new Error('本批未暂停，无需续发');
    if (batch.asset_type !== config.assetType || batch.token !== config.tokenContract || batch.amount !== config.sendAmount || batch.rpc !== config.rpcUrl) {
      throw new Error('当前代币、每地址数量或节点与原批次不同，请恢复原设置后续发；原进度保留');
    }
    if (this.engine.running && this.engine.mode !== batch.mode) throw new Error('当前运行模式与原批次不同，请先暂停主任务');
    const rows = this.store.db.prepare("SELECT * FROM deliveries WHERE manual_batch_id=? AND status='queued' AND txid IS NULL ORDER BY manual_position").all(id);
    if (!rows.length) throw new Error('本批已没有尚未发送的地址；已发送交易继续核查，不重新创建投放');
    return { batch, rows };
  }
  async prepareResume(id) {
    this.assertAvailable(); this.cancelPreview();
    const e = this.engine, revision = this.revision, running = e.running, runId = e.runId;
    const current = this.store.db.prepare('SELECT mode FROM manual_batches WHERE id=?').get(id);
    if (!current) throw new Error('没有找到这个手动批次');
    const config = effectiveConfig(validate(e.getConfig(), current.mode)), fingerprint = hash(JSON.stringify(config));
    this.resumeBatch(id, config);
    const checked = running ? e.preflightResult : await e.preflight(current.mode);
    this.assertAvailable();
    const p = { resumeId: id, revision, running, runId, mode: current.mode, config, fingerprint,
      confirmationToken: crypto.randomBytes(24).toString('hex'), expires: Date.now() + 120000 };
    this.assertPreview(p);
    const { batch, rows } = this.resumeBatch(id, config);
    this.preview = p;
    return { confirmationToken: p.confirmationToken, expiresAt: new Date(p.expires).toISOString(), id,
      mode: batch.mode, running, remaining: rows.length, total: batch.total, assetType: batch.asset_type,
      token: batch.token, symbol: checked.token.symbol, amount: batch.amount, intervalSeconds: config.sendIntervalSeconds,
      historyPolicy: batch.history_policy, restartScanMode: config.restartScanMode,
      remainingLimit: config.maxPerRun ? Math.max(0, config.maxPerRun - (running ? e.metrics.sent + e.metrics.simulated : 0)) : null };
  }
  async resume(input) {
    if (typeof input.confirmationToken !== 'string' || !/^[a-f\d]{48}$/.test(input.confirmationToken) || input.confirmed !== true) throw new Error('请先预览并确认续发剩余地址');
    const tokenHash = hash(input.confirmationToken);
    const existing = this.store.db.prepare('SELECT id FROM manual_batches WHERE last_resume_hash=?').get(tokenHash);
    if (existing) return { id: existing.id, duplicate: true };
    this.assertAvailable();
    const p = this.preview;
    if (!p?.resumeId || p.confirmationToken !== input.confirmationToken) throw new Error('续发预览已过期，请重新点击继续发送');
    this.assertPreview(p); this.resumeBatch(p.resumeId, p.config); this.preview = null;
    let result;
    const activate = () => {
      const { rows } = this.resumeBatch(p.resumeId, p.config);
      this.store.db.prepare('UPDATE manual_batches SET paused=0,last_resume_hash=? WHERE id=?').run(tokenHash, p.resumeId);
      result = { id: p.resumeId, count: rows.length };
    };
    if (p.running) this.store.transaction(activate);
    else {
      this.starting = true;
      try {
        await this.engine.start(p.mode, undefined, null, {
          assertCurrent: () => this.assertPreview(p, { starting: true }),
          beforeRun: () => { this.assertPreview(p, { starting: true }); activate(); },
        });
      } finally { this.starting = false; }
    }
    this.engine.log('info', `手动批次继续发送剩余 ${result.count} 个地址；沿用原记录，不重复创建已发送投放；间隔 ${p.config.sendIntervalSeconds} 秒`);
    this.engine.queueWaiter?.();
    return result;
  }
  enqueue(p) {
    const plan = this.classify(p.addresses, p.mode, p.config, p.token, p.historyPolicy, p.historyVersions);
    this.assertCapacity(plan, p.mode, p.config);
    if (!plan.accepted.length) throw new Error('这些地址已进入处理或已有去重记录，请重新预览');
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const summary = { ...p.counts, added: plan.counts.added, promoted: plan.counts.promoted, repeated: plan.counts.repeated, changed: p.addresses.length - plan.accepted.length };
    this.store.db.prepare('INSERT INTO manual_batches(id,confirmation_hash,mode,asset_type,token,amount,rpc,total,summary_json,created_at,history_policy) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, hash(p.confirmationToken), p.mode, p.config.assetType, p.config.tokenContract, p.config.sendAmount, p.config.rpcUrl, plan.accepted.length, JSON.stringify(summary), now, p.historyPolicy);
    const mark = this.store.db.prepare("UPDATE deliveries SET source_kind='manual',manual_batch_id=?,manual_position=?,updated_at=?,detail=? WHERE id=? AND status='queued' AND txid IS NULL");
    for (const [index, item] of plan.accepted.entries()) {
      let deliveryId = item.promote;
      if (!deliveryId) {
        const source = 'manual:' + id + ':' + index;
        if (item.repeated) {
          if (p.historyPolicy !== 'repeat') throw new Error('本批未确认允许历史地址再次发送');
          deliveryId = crypto.randomUUID();
          this.store.db.prepare(`INSERT INTO deliveries(id,mode,address,source_tx,source_asset,source_amount,token,amount,status,created_at,updated_at,rpc,asset_type,asset_scope,source_kind,manual_batch_id,manual_position,manual_repeat)
            VALUES(?,?,?,?,'MANUAL','0',?,?,'queued',?,?,?,?,?,'manual',?,?,1)`)
            .run(deliveryId, p.mode, item.address, source, p.config.tokenContract, p.config.sendAmount, now, now, p.config.rpcUrl, p.config.assetType, p.config.assetType + ':' + p.config.tokenContract, id, index);
        } else {
          if (!this.store.offer(p.mode, { to: item.address, txid: source, asset: 'MANUAL', amount: '0' }, p.config, null)) throw new Error('地址状态发生变化，请重新预览');
          deliveryId = this.store.db.prepare('SELECT id FROM deliveries WHERE mode=? AND asset_scope=? AND source_tx=?').get(p.mode, p.config.assetType + ':' + p.config.tokenContract, source).id;
        }
      }
      mark.run(id, index, now, item.promote ? '已由扫描队列转入手动优先批次；原触发交易保留' : item.repeated ? '本批已确认向历史地址再次发送；新增记录，保留原历史与去重；沿用投放间隔' : '手动批量添加，优先于扫描等待队列；沿用投放间隔', deliveryId);
    }
    return { id, count: plan.accepted.length, ...summary };
  }
  async submit(input) {
    if (typeof input.confirmationToken !== 'string' || !/^[a-f\d]{48}$/.test(input.confirmationToken) || input.confirmed !== true) throw new Error('请先预览并确认本批投放地址与数量');
    // A lost HTTP response must never create another batch or restart a campaign.
    const existing = this.store.db.prepare('SELECT id,total FROM manual_batches WHERE confirmation_hash=?').get(hash(input.confirmationToken));
    if (existing) return { id: existing.id, count: existing.total, duplicate: true };
    this.assertAvailable();
    const p = this.preview;
    if (!p || p.resumeId || p.confirmationToken !== input.confirmationToken) throw new Error('批量投放预览已过期，请重新预览');
    if (p.historyPolicy === 'repeat' && input.confirmRepeat !== true) throw new Error('请确认本批允许向历史地址再次发送');
    this.assertPreview(p);
    this.preview = null;
    let result;
    if (p.running) result = this.store.transaction(() => this.enqueue(p));
    else {
      this.starting = true;
      try {
        await this.engine.start(p.mode, undefined, null, {
          assertCurrent: () => this.assertPreview(p, { starting: true }),
          beforeRun: () => { this.assertPreview(p, { starting: true }); result = this.enqueue(p); },
        });
      } finally { this.starting = false; }
    }
    this.engine.log('info', `手动批次已加入 ${result.count} 个地址${result.promoted ? `（含扫描队列转入 ${result.promoted} 个）` : ''}；${p.historyPolicy === 'repeat' ? '本批允许历史地址再次发送，历史地址 ' + result.repeated + ' 个' : '去重发送'}；优先发送，扫描继续入队，投放间隔 ${p.config.sendIntervalSeconds} 秒`);
    // Only wake an idle sender. Never shorten its post-send interval.
    this.engine.queueWaiter?.();
    return result;
  }
  list(page = 1) {
    page = Math.max(1, Math.min(1000000, Math.floor(Number(page)) || 1));
    const total = this.store.db.prepare('SELECT COUNT(*) n FROM manual_batches').get().n, limit = 10;
    const items = this.store.db.prepare(`SELECT * FROM manual_batches ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(limit, (page - 1) * limit).map(batch => {
      const counts = Object.fromEntries(this.store.db.prepare('SELECT status,COUNT(*) n FROM deliveries WHERE manual_batch_id=? GROUP BY status').all(batch.id).map(row => [row.status, row.n]));
      const { confirmation_hash, last_resume_hash, summary_json, ...publicBatch } = batch;
      return { ...publicBatch, counts, summary: JSON.parse(summary_json) };
    });
    return { total, page, limit, items };
  }
  cancel(id) {
    const batch = this.store.db.prepare('SELECT id FROM manual_batches WHERE id=?').get(id);
    if (!batch) throw new Error('没有找到这个手动批次');
    const count = this.store.db.prepare(`UPDATE deliveries SET status='cancelled',updated_at=?,detail='用户取消手动批次剩余地址；保留去重记录'
      WHERE manual_batch_id=? AND status='queued' AND txid IS NULL AND id!=?`).run(new Date().toISOString(), id, this.engine.activeDeliveryId || '').changes;
    this.engine.log('info', `已取消手动批次剩余 ${count} 个地址；正在处理的一笔继续核查，扫描队列按原间隔继续`);
    return { count };
  }
}
module.exports = { ManualBatches, parseAddresses, MAX_ADDRESSES };
