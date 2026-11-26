'use strict';
const { Chain, decodeCandidates, transferEvents, sleep, checkedTransactionExpiration } = require('./chain');
const { validate, fingerprint, decimalUnits, formatUnits, redact, walletAddress, effectiveConfig } = require('./config');
const { MAX_ATTEMPTS, FAILURE_LIMIT, nodeReason } = require('./delivery-retry');
const crypto = require('node:crypto');
const { Trc10Chain, validateNative } = require('./trc10');
const { isRateLimitError, initialNodeStatus, COOLDOWN_MS } = require('./node-access');
const { ManualRetry } = require('./manual-retry');
const { ManualBatches } = require('./manual-batches');
const REVIEW_PENDING = ['prepared', 'pending', 'uncertain', 'executed'];
const REVIEW_FAILURES = new Set(['REVERT', 'BAD_JUMP_DESTINATION', 'OUT_OF_MEMORY', 'PRECOMPILED_CONTRACT', 'STACK_TOO_SMALL', 'STACK_TOO_LARGE', 'ILLEGAL_OPERATION', 'STACK_OVERFLOW', 'OUT_OF_ENERGY', 'OUT_OF_TIME', 'JVM_STACK_OVER_FLOW', 'TRANSFER_FAILED', 'INVALID_CODE']);
// This is only a waiting policy for stopping an old local investigation. It is
// never used as evidence that the transaction expired or was absent on chain.
const REVIEW_ARCHIVE_WAIT_MS = 24 * 60 * 60 * 1000;

class Engine {
  constructor(store, getConfig, factory, timing = {}) {
    this.store = store; this.getConfig = getConfig;
    this.nodeSessions = new Map(); this.chains = new Map();
    this.factory = factory || ((config, options) => new (config.assetType === 'TRC10' ? Trc10Chain : Chain)(config, { ...options, sessions: this.nodeSessions, onEvent: (level, message) => this.log(level, message) }));
    this.state = 'stopped'; this.mode = null; this.running = false; this.busy = false;
    this.metrics = { scanned: 0, matched: 0, skipped: 0, sent: 0, simulated: 0 };
    this.wallet = null; this.preflightResult = null; this.height = null; this.headHeight = null;
    this.lastError = ''; this.loopPromise = null; this.waiters = new Set(); this.lastResourceAt = 0;
    this.failure = null; this.confirmationTimer = null; this.confirmationPass = null;
    this.confirmationOffset = 0; this.confirmationErrors = 0; this.reconciling = false; this.closed = false;
    this.statisticsTimer = null; this.statisticsPass = null;
    this.timing = { executionWaitMs: 15000, receiptPollMs: 3000, retryDelayMs: 3000, gatewayRetryMs: 1000, gatewayJitterMs: 250, ...timing };
    this.activeDeliveryId = null; this.confirmingIds = new Set(); this.outcomes = new Map();
    this.energyRecovery = null; this.energyRecoveryTimer = null; this.energyRecoveryPass = null;
    this.energyRecoveryAllowed = false;
    this.manualRetry = new ManualRetry(this);
    this.manualBatches = new ManualBatches(this); this.runId = null;
  }
  log(level, message) { this.store.log(level, redact(message, this.getConfig())); }
  getChain(config, queueGroup = 'foreground') {
    const key = crypto.createHash('sha256').update(JSON.stringify([config, queueGroup])).digest('hex');
    if (!this.chains.has(key)) this.chains.set(key, this.factory(config, { queueGroup }));
    const chain = this.chains.get(key);
    if (config.rpcUrl === this.getConfig().rpcUrl && config.apiKey === this.getConfig().apiKey) this.statusChain = chain;
    return chain;
  }
  nodeStatus() {
    const config = this.getConfig(), chain = this.statusChain;
    return chain?.config?.rpcUrl === config.rpcUrl && chain?.config?.apiKey === config.apiKey
      ? chain.nodeStatus?.() || initialNodeStatus(config) : initialNodeStatus(config);
  }
  async waitForCapacity(error, row) {
    if (row) {
      const current = this.store.get(row.id);
      this.store.update(row.id, current.status, { detail: '节点限流，等待恢复后先核查原交易；不消耗投放重试次数' });
    }
    if (this.running) await this.wait(Math.max(1000, (error.retryAt || Date.now() + COOLDOWN_MS) - Date.now()));
    return false;
  }
  snapshot() { return { state: this.state, mode: this.mode, metrics: this.metrics, wallet: this.wallet,
    height: this.height, headHeight: this.headHeight, lastScanAt: this.scanProgress()?.at || null, lastError: this.lastError, preflight: this.preflightResult,
    counts: this.store.counts(), pending: this.store.pending().length, consecutiveFailures: this.failureStreak(), node: this.nodeStatus(), resourceWait: this.resourceWait || null, energyRecovery: this.energyRecovery?.status || null, pool: this.pool?.snapshot() || null, energyPlatform: this.energyPolicy?.snapshot() || null, deliveryReporting: this.deliveryReporter?.snapshot() || null }; }
  async preflight(mode = 'simulate') {
    const config = effectiveConfig(validate(this.getConfig(), mode));
    if (mode === 'live') await this.energyPolicy?.refreshForSend();
    const result = await this.getChain(config).preflight();
    if (mode === 'live' && config.assetType !== 'TRC10' && this.energyPolicy?.requireMode() === 'seamless') {
      result.warnings = result.warnings.filter(message => !['钱包能量低于设置门槛，正式投放会停止', 'TRX 不足以覆盖单笔能量费上限与保留余额'].includes(message));
      result.warnings.push('无感模式：已有能量优先，按平台规则逐笔判断；服务费另列');
    }
    if (config.assetType === 'TRC10') {
      if (mode === 'live') this.pool?.assertReady();
      result.resources = { wallet: 'TRC10 钱包池', pool: this.pool?.snapshot() };
    }
    this.preflightResult = result; this.wallet = result.resources;
    this.log('info', `预检完成：${result.token.symbol}，精度 ${result.token.decimals}；已确认高度 ${result.height}`);
    return result;
  }
  checkFunds(resources, token, config, rawAmount) {
    if (config.assetType === 'TRC10') { this.pool?.assertReady(); return; }
    if (!resources) throw new Error('未配置投放钱包');
    if (!Number.isFinite(resources.energy) || resources.energy < 0) throw new Error('节点返回的能量数据无效，请重新预检');
    const seamless = this.energyPolicy?.requireMode() === 'seamless';
    if (seamless) {
      // Only the server owns the stop/resume latch. A local low reading cannot
      // safely clear it after a later reading between the two thresholds.
      if (!/^\d+$/.test(String(resources.balanceSun))) throw new Error('节点返回的 TRX 余额数据无效');
      if (!Number.isFinite(resources.bandwidth) || resources.bandwidth < 0) throw new Error('节点返回的带宽数据无效');
    } else {
      if (resources.energy < config.minEnergy) throw Object.assign(new Error(`能量 ${resources.energy} 低于门槛 ${config.minEnergy}`), { code: 'INSUFFICIENT_ENERGY', ...(this.energyPolicy?.linked() ? { policyWait: true } : {}) });
      if (BigInt(resources.balanceSun) < decimalUnits(config.feeLimitTrx, 6) + decimalUnits(config.reserveTrx, 6)) throw new Error('TRX 低于单笔能量费上限与保留余额之和');
    }
    if (token.rawBalance === null || BigInt(token.rawBalance) < BigInt(rawAmount)) throw new Error('广告代币余额不足');
  }
  async start(mode, preflight, recovery = null, { assertCurrent = () => {}, beforeRun = null } = {}) {
    assertCurrent();
    if (this.closed) throw new Error('程序已关闭');
    if (!['simulate', 'live'].includes(mode)) throw new Error('运行模式无效');
    if (this.busy || ['starting', 'running', 'stopping'].includes(this.state)) throw new Error('任务正在运行或停止中');
    if (!beforeRun) this.manualBatches.cancelPreview();
    this.runId = crypto.randomUUID();
    const config = effectiveConfig(validate(this.getConfig(), mode));
    if (recovery) this.assertEnergyRecovery(recovery);
    else this.cancelEnergyRecovery();
    const restartScanMode = recovery ? 'latest' : config.restartScanMode;
    const unfinishedPolicy = recovery ? 'skip' : config.unfinishedPolicy;
    const read = async fn => {
      try { return await fn(); }
      catch (error) { if (recovery) error.recoveryTransient = true; throw error; }
    };
    this.state = 'starting'; this.busy = true; this.lastError = ''; this.failure = null; this.resourceWait = null;
    try {
      if (mode === 'live') await this.energyPolicy?.refreshForSend();
      const chain = this.getChain(config);
      const checked = preflight || await read(() => chain.preflight());
      if (recovery) {
        this.assertEnergyRecovery(recovery);
        this.wallet = checked.resources;
        Object.assign(recovery.status, { energy: checked.resources?.energy ?? null, checkedAt: checked.resources?.checkedAt || new Date().toISOString() });
      }
      if (mode === 'live') this.checkFunds(checked.resources, checked.token, config, checked.amount);
      // The confirmation dialog may have been open for up to two minutes. Anchor
      // at the head read NOW, not the older height from its preflight.
      const latest = await read(() => chain.head());
      assertCurrent();
      if (recovery) {
        this.assertEnergyRecovery(recovery);
        if (this.runLimitReached()) throw new Error('已达到本次地址数上限，保持暂停');
        if (this.failureStreak() >= FAILURE_LIMIT) throw new Error('连续投放失败已达到上限，保持暂停');
      }
      if (this.closed) throw new Error('程序已关闭');
      if (this.failure) throw this.failure;
      this.preflightResult = checked; this.wallet = checked.resources;
      this.mode = mode; this.config = structuredClone(config); this.chain = chain;
      if (!recovery) { this.metrics = { scanned: 0, matched: 0, skipped: 0, sent: 0, simulated: 0 }; this.outcomes.clear(); }
      this.cursorKey = 'cursor:' + fingerprint(config, mode);
      this.height = restartScanMode === 'resume' ? this.store.getMeta(this.cursorKey) ?? latest : latest;
      this.headHeight = latest;
      if (latest < this.height) throw new Error('节点高度低于上次扫描进度，请核对节点');
      if (latest - this.height > config.maxCatchUpBlocks) throw new Error(`积压 ${latest - this.height} 个区块，超过补扫上限。请调整补扫上限，或把重新启动扫描起点设为“最新区块”`);
      // A saved queue contains exact amounts/contracts. Do not send it under new settings.
      if (unfinishedPolicy === 'resend' && this.store.queued(mode, config).some(row => row.token !== config.tokenContract || row.amount !== config.sendAmount || row.rpc !== config.rpcUrl)) throw new Error('等待队列使用旧节点、合约或金额，请先选择“不补发”或在记录页取消等待投放');
      let skipped = 0;
      this.store.transaction(() => {
        if (unfinishedPolicy === 'skip') skipped = this.store.skipUnsent(mode);
        if (recovery) {
          // Old signed transactions remain available for receipt checks only.
          // Never replay or replace them after an automatic energy restart.
          for (const row of this.store.pending()) {
            this.store.exhaustRetry(row);
            if (row.status !== 'executed') this.store.update(row.id, row.status, { detail: '能量恢复后从最新区块重新开始；旧交易只核查结果，不再补发' });
          }
        }
        this.store.setMeta(this.cursorKey, this.height);
        // Admit a newly confirmed manual batch atomically after the restart
        // policy, before either worker can claim its first delivery.
        beforeRun?.();
      });
      if (recovery) {
        clearTimeout(this.energyRecoveryTimer); this.energyRecoveryTimer = null; this.energyRecovery = null;
        this.log('info', `能量已恢复至 ${checked.resources.energy}，达到门槛 ${config.minEnergy}，自动继续；旧交易不补发，本次已成功 ${this.metrics.sent} 笔`);
      }
      this.energyRecoveryAllowed = mode === 'live' && config.assetType === 'TRC20' && config.autoResumeEnergy;
      this.running = true; this.state = 'running'; this.lastResourceAt = Date.now();
      this.log('info', `启动策略：${config.maxPerRun ? '本次上限 ' + config.maxPerRun + ' 个地址' : '本次无地址数上限'}；${restartScanMode === 'latest' ? '从最新已确认区块开始' : '接着上次区块扫描'}（${this.height}）；${unfinishedPolicy === 'skip' ? '不补发旧等待队列，已略过 ' + skipped + ' 条' : '补发旧等待队列'}`);
      this.log('info', mode === 'live' ? '正式投放已启动；仅处理已确认区块' : '模拟监听已启动；仅记录命中，不签名、不广播');
      this.startBackgroundConfirmation();
      this.loopPromise = this.loop().finally(() => { this.busy = false; this.armEnergyRecovery(); });
    } catch (error) { this.state = 'stopped'; this.busy = false; throw error; }
  }
  runLimitReached() { return this.config?.maxPerRun > 0 && this.metrics.sent + this.metrics.simulated >= this.config.maxPerRun; }
  cancelEnergyRecovery(reason = '') {
    const recovery = this.energyRecovery;
    this.energyRecoveryAllowed = false; this.energyRecovery = null;
    clearTimeout(this.energyRecoveryTimer); this.energyRecoveryTimer = null;
    if (!recovery) return;
    this.state = this.busy ? 'stopping' : 'stopped'; this.lastError = '';
    if (reason) this.log('info', reason);
  }
  recoveryCurrent(recovery) {
    return !this.closed && this.energyRecoveryAllowed && this.energyRecovery === recovery
      && JSON.stringify(effectiveConfig(this.getConfig())) === JSON.stringify(recovery.config);
  }
  assertEnergyRecovery(recovery) {
    if (!this.recoveryCurrent(recovery)) throw Object.assign(new Error('自动恢复已取消'), { cancelled: true });
  }
  armEnergyRecovery() {
    if (this.closed || this.running || this.energyRecovery || !this.energyRecoveryAllowed
      || this.failure?.code !== 'INSUFFICIENT_ENERGY' || this.mode !== 'live' || this.config?.assetType !== 'TRC20'
      || !this.config.autoResumeEnergy || this.runLimitReached() || this.failureStreak() >= FAILURE_LIMIT
      || JSON.stringify(effectiveConfig(this.getConfig())) !== JSON.stringify(this.config)) return;
    const recovery = { config: structuredClone(this.config), status: { wallet: walletAddress(this.config),
      energy: this.wallet?.energy ?? null, minEnergy: this.config.minEnergy, intervalSeconds: this.config.energyRecoverySeconds,
      checkedAt: this.wallet?.checkedAt || null, checking: false, nextCheckAt: null, message: '' } };
    this.energyRecovery = recovery;
    this.scheduleEnergyRecovery(recovery);
    this.log('warn', `能量不足，已暂停并等待自动恢复；每 ${recovery.status.intervalSeconds} 秒检查投放钱包，达标后从最新已确认区块开始，旧交易不补发。可随时取消自动恢复`);
  }
  scheduleEnergyRecovery(recovery) {
    if (!this.recoveryCurrent(recovery)) return;
    this.state = 'energy_wait'; recovery.status.checking = false;
    const intervalMs = recovery.status.intervalSeconds * 1000;
    recovery.status.nextCheckAt = Date.now() + intervalMs;
    clearTimeout(this.energyRecoveryTimer);
    this.energyRecoveryTimer = setTimeout(() => { this.checkEnergyRecovery().catch(error => this.fail(error)); }, intervalMs);
    this.energyRecoveryTimer.unref();
  }
  checkEnergyRecovery() {
    if (this.energyRecoveryPass) return this.energyRecoveryPass;
    const recovery = this.energyRecovery;
    if (!recovery) return Promise.resolve();
    if (!this.recoveryCurrent(recovery)) { this.cancelEnergyRecovery('设置已变化，已取消自动恢复'); return Promise.resolve(); }
    clearTimeout(this.energyRecoveryTimer); this.energyRecoveryTimer = null;
    recovery.status.checking = true; recovery.status.nextCheckAt = null;
    this.energyRecoveryPass = (async () => {
      try {
        let resources;
        try { resources = await this.getChain(recovery.config).resources(); }
        catch (error) { error.recoveryTransient = true; throw error; }
        this.assertEnergyRecovery(recovery);
        if (!Number.isFinite(resources?.energy) || resources.energy < 0) throw Object.assign(new Error('节点返回的能量数据无效'), { recoveryTransient: true });
        this.wallet = resources; this.lastResourceAt = Date.now();
        Object.assign(recovery.status, { energy: resources.energy, checkedAt: resources.checkedAt || new Date().toISOString(), message: '' });
        if (resources.energy < recovery.config.minEnergy) {
          recovery.status.message = `能量 ${resources.energy} / ${recovery.config.minEnergy}，尚未达标`;
          this.log('info', recovery.status.message + `；${recovery.status.intervalSeconds} 秒后再次检查`);
          return;
        }
        // A fresh full preflight checks TRX, token balance and the current head.
        // start() checks this token again after every await before committing.
        await this.start('live', undefined, recovery);
      } catch (error) {
        if (!this.recoveryCurrent(recovery)) return;
        if (error.code === 'INSUFFICIENT_ENERGY' || error.recoveryTransient || isRateLimitError(error)) {
          recovery.status.message = redact(error.message, this.getConfig());
          this.log('warn', `自动恢复检查暂未通过：${error.message}；${recovery.status.intervalSeconds} 秒后再次检查`);
        } else {
          this.cancelEnergyRecovery(); this.fail(new Error('自动恢复已停止：' + error.message));
        }
      }
    })().finally(() => {
      this.energyRecoveryPass = null;
      if (this.recoveryCurrent(recovery)) this.scheduleEnergyRecovery(recovery);
      else if (this.energyRecovery === recovery) this.cancelEnergyRecovery('启动条件已变化，已取消自动恢复');
    });
    return this.energyRecoveryPass;
  }
  async wait(ms, queue = false) {
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(finish); if (this.queueWaiter === finish) this.queueWaiter = null; resolve(); };
      const timer = setTimeout(finish, ms); this.waiters.add(finish);
      if (queue) this.queueWaiter = finish;
    });
  }
  wakeAll() { for (const finish of [...this.waiters]) finish(); }
  stop() {
    this.onManualStop?.();
    this.manualBatches.cancelPreview();
    this.manualRetry.cancel();
    this.cancelEnergyRecovery('已取消自动恢复；后续需手动启动');
    if (this.state === 'starting') throw new Error('预检正在完成，请稍后暂停');
    if (!this.running) return;
    this.running = false; this.state = 'stopping'; this.wakeAll();
    this.log('info', '正在暂停：不再开始新投放；已广播交易继续核查');
  }
  async stopAndWait() { this.stop(); await this.loopPromise; await this.energyRecoveryPass; }
  async close() {
    this.closed = true; clearInterval(this.confirmationTimer); this.confirmationTimer = null;
    clearInterval(this.statisticsTimer); this.statisticsTimer = null;
    await this.stopAndWait(); await this.confirmationPass; await this.statisticsPass;
  }
  fail(error) {
    this.manualBatches.cancelPreview();
    if (error.code !== 'INSUFFICIENT_ENERGY') {
      this.cancelEnergyRecovery();
      if (this.failure?.code === 'INSUFFICIENT_ENERGY') this.failure = error;
    }
    this.failure ||= error; this.running = false; this.wakeAll();
    this.state = this.busy ? 'stopping' : 'fault';
    this.lastError = redact(error.message || String(error), this.getConfig());
    this.log('error', error.message || String(error));
  }
  startBackgroundConfirmation() {
    if (this.confirmationTimer || this.closed) return;
    this.confirmationTimer = setInterval(() => {
      this.confirmExecuted().catch(error => { if (!this.closed && !isRateLimitError(error)) this.fail(error); });
    }, 5000);
    this.confirmationTimer.unref();
    this.statisticsTimer = setInterval(() => { this.backfillStatistics().catch(() => {}); }, 5000);
    this.statisticsTimer.unref();
  }
  captureReceipt(row, info) {
    // Reporting failure must never stop delivery or change its outcome.
    try { return this.store.saveReceipt(row, info); }
    catch { return false; }
  }
  backfillStatistics() {
    if (this.statisticsPass) return this.statisticsPass;
    const idle = () => !this.closed && !this.busy && !this.running && !this.reconciling
      && !['starting', 'running', 'stopping'].includes(this.state);
    if (!idle()) return Promise.resolve();
    this.statisticsPass = (async () => {
      // Historical reads only run while paused, on a separate RPC client. A
      // new start takes priority before every next request. Never sign or send.
      for (let i = 0; i < 5 && idle(); i++) {
        const row = this.store.nextReceiptBackfill(); if (!row) break;
        const config = this.getConfig();
        try {
          const chain = this.getChain({ ...config, assetType: row.asset_type || 'TRC20', tokenId: row.token, tokenContract: row.token, rpcUrl: row.rpc || config.rpcUrl }, 'statistics');
          const info = row.asset_type === 'TRC10' ? await chain.deliveryReceipt(row, true) : await chain.receipt(row.txid);
          if (this.captureReceipt(row, info)) continue;
        } catch (error) {
          if (isRateLimitError(error)) { this.store.deferReceiptBackfill(row); break; }
          // Keep incomplete statistics and retry later, without pausing.
        }
        this.store.deferReceiptBackfill(row);
      }
    })().finally(() => { this.statisticsPass = null; });
    return this.statisticsPass;
  }
  confirmExecuted() {
    if (this.confirmationPass) return this.confirmationPass;
    if (this.closed || this.reconciling || this.state === 'starting') return Promise.resolve();
    this.confirmationPass = (async () => {
      await this.syncEnergyOrders();
      const rows = this.store.pending().filter(row => row.id !== this.activeDeliveryId && !this.store.requiresAllAttemptReview(row));
      if (!rows.length) return;
      // Rotate a bounded batch so a delayed receipt cannot starve newer entries
      // or occupy the shared RPC queue for an unbounded amount of time.
      const start = this.confirmationOffset % rows.length;
      const batch = rows.slice(start).concat(rows.slice(0, start)).slice(0, 5);
      this.confirmationOffset = start + batch.length;
      for (const row of batch) {
        if (row.id === this.activeDeliveryId) continue;
        this.confirmingIds.add(row.id);
        const config = this.getConfig();
        const chain = this.chain && row.rpc === this.config?.rpcUrl && row.asset_type === this.config?.assetType ? this.chain
          : this.getChain({ ...config, assetType: row.asset_type || 'TRC20', tokenId: row.token, tokenContract: row.token, rpcUrl: row.rpc || config.rpcUrl });
        try {
          const settled = await this.settle(row, false, true, chain);
          if (settled && this.outcomes.has(row.id)) this.noteOutcome(row, true);
          if (!settled && row.asset_type === 'TRC10' && row.status !== 'executed' && this.store.retryInfo(row).exhausted) {
            const attempt = this.store.attempt(row.txid);
            if (attempt?.expiration && Date.now() > attempt.expiration && await chain.replacementReady(row.txid, attempt.expiration)) {
              this.store.attemptStatus(row.txid, 'expired', '已确认过期且原交易未上链');
              this.store.update(row.id, 'failed', { detail: '原交易已确认过期未上链，补试已结束；释放投放钱包，保留地址去重' });
            }
          }
          this.confirmationErrors = 0;
        }
        catch (error) {
          if (error.halt) { this.fail(error); break; }
          if (isRateLimitError(error)) break;
          if (error.deliveryFailure) {
            if (this.outcomes.get(row.id) === true) { this.outcomes.set(row.id, null); this.refreshSent(); }
            if (this.store.retryInfo(row).attempts >= MAX_ATTEMPTS) { this.store.exhaustRetry(row); if (this.outcomes.has(row.id)) this.noteOutcome(row, false); }
            continue;
          }
          this.confirmationErrors++;
          if (this.confirmationErrors === 1 || this.confirmationErrors % 5 === 0) this.log('warn', `后台最终确认暂不可用，稍后继续核查，不重发：${error.message}`);
        } finally { this.confirmingIds.delete(row.id); }
      }
    })().finally(() => { this.confirmationPass = null; });
    return this.confirmationPass;
  }
  async resetCursor(mode) {
    if (this.busy) throw new Error('请先暂停任务');
    const config = effectiveConfig(validate(this.getConfig(), 'simulate'));
    const height = await this.getChain(config).head();
    this.store.setMeta('cursor:' + fingerprint(config, mode), height);
    this.log('warn', `${mode === 'live' ? '正式' : '模拟'}监听起点已设为 ${height}，跳过离线期间区块；已入队记录仍保留`);
    return height;
  }
  async scanOne(height) {
    const block = await this.chain.block(height);
    const found = decodeCandidates(block, this.config);
    const candidates = [];
    for (const item of found) {
      if (!this.running) return false;
      if (this.config.blacklist.includes(item.to) || item.to === walletAddress(this.config) || item.to === this.preflightResult?.token?.issuer
        || this.pool?.ownAddress(item.to) || this.store.hasRecipient(this.mode, item.to, item.txid, this.config)) { this.metrics.skipped++; continue; }
      if (item.asset === 'USDT' && !await this.chain.verifyTrigger(item)) { this.metrics.skipped++; continue; }
      candidates.push(item);
    }
    if (!this.running) return false;
    if (this.config.assetType === 'TRC10') {
      const cutoff = new Date(Date.now() - this.config.queueTtlMinutes * 60000).toISOString();
      this.store.db.prepare("UPDATE deliveries SET status='skipped_restart',dedupe_cleared_at=?,updated_at=?,detail='等待资源超过有效期，已略过' WHERE asset_type='TRC10' AND source_kind='scan' AND status='queued' AND created_at<? AND txid IS NULL").run(new Date().toISOString(), new Date().toISOString(), cutoff);
      const queued = this.store.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE asset_type='TRC10' AND source_kind='scan' AND status='queued'").get().n;
      if (queued + candidates.length > this.config.maxQueue) { this.resourceWait = '等待队列已满，保留当前区块进度'; return false; }
    }
    if (this.config.assetType === 'TRC20' && this.energyPolicy?.linked()) {
      const queued = this.store.db.prepare("SELECT COUNT(*) n FROM deliveries WHERE mode=? AND asset_type='TRC20' AND token=? AND source_kind='scan' AND status='queued'").get(this.mode, this.config.tokenContract).n;
      if (queued + candidates.length > this.config.maxQueue) { this.resourceWait = '平台等待队列已满，保留当前区块进度'; return false; }
    }
    let offered = 0;
    const scan = { at: new Date().toISOString(), height, mode: this.mode,
      scope: fingerprint(this.config, 'runtime'), wallet: walletAddress(this.config) };
    this.store.transaction(() => {
      for (const item of candidates) if (this.store.offer(this.mode, item, this.config, height)) offered++;
      this.store.setMeta(this.cursorKey, height);
      this.store.setMeta('runtime:last-scan', scan);
    });
    this.height = height; this.metrics.scanned++; this.metrics.matched += offered;
    if (offered) this.log('info', `区块 ${height}：${offered} 个新地址进入${this.mode === 'live' ? '投放' : '模拟'}队列`);
    if (offered) this.queueWaiter?.();
    return true;
  }
  scanProgress() {
    const scan = this.store.getMeta('runtime:last-scan'), config = effectiveConfig(this.getConfig());
    return scan && scan.scope === fingerprint(config, 'runtime') && scan.wallet === walletAddress(config)
      && Number.isFinite(Date.parse(scan.at)) && Number.isSafeInteger(scan.height) ? scan : null;
  }
  async settle(row, wait = true, final = true, chain = this.chain) {
    // Once manual review has inspected the complete attempt history, a single
    // current-hash receipt cannot settle it or erase another unresolved attempt.
    if (this.store.requiresAllAttemptReview(this.store.get(row.id))) return false;
    const deadline = Date.now() + (wait ? (final ? 75000 : this.timing.executionWaitMs) : 0);
    do {
      const info = row.asset_type === 'TRC10' ? await chain.deliveryReceipt(row, final) : await (final ? chain.receipt(row.txid) : chain.executionReceipt(row.txid));
      if (info?.id) {
        const halt = message => Object.assign(new Error(message), { halt: true });
        if (info.id.toLowerCase() !== row.txid.toLowerCase()) {
          this.store.update(row.id, 'uncertain', { detail: '节点返回的交易哈希不匹配，需要核查' });
          throw halt('节点返回的交易哈希不匹配，请稍后重新核查');
        }
        if (typeof info.receipt?.result !== 'string' || ['UNKNOWN', 'DEFAULT', ''].includes(info.receipt.result)) throw new Error('节点返回的执行回执不完整，稍后继续核查');
        this.store.retryInfo(row);
        if (final) this.captureReceipt(row, info);
        if (info.receipt?.result !== 'SUCCESS') {
          if (!REVIEW_FAILURES.has(info.receipt.result)) throw new Error('节点返回了未知执行结果，保留原交易等待核查');
          const detail = `链上执行失败：${info.receipt?.result || info.result || 'UNKNOWN'}`;
          const retry = this.store.retryInfo(row);
          this.store.attemptStatus(row.txid, final ? 'failed_final' : 'failed_pending', detail);
          this.store.update(row.id, final && (retry.exhausted || retry.attempts >= MAX_ATTEMPTS) ? 'failed' : 'uncertain', { detail });
          throw Object.assign(new Error(detail), { deliveryFailure: true, final });
        }
        if (row.asset_type === 'TRC10' ? !info.nativeValidated : !transferEvents(info, row.token, row.wallet, row.address, row.raw_amount)) {
          this.store.update(row.id, 'uncertain', { detail: '回执成功，但 Transfer 事件中的收款人或金额未核对通过' });
          throw halt('交易到账核对未通过，需要人工核查');
        }
        this.store.attemptStatus(row.txid, final ? 'confirmed' : 'executed');
        this.store.update(row.id, final ? 'confirmed' : 'executed', { detail: final
          ? `已最终确认到账；实际链上手续费 ${Number(info.fee || 0) / 1e6} TRX`
          : '普通节点执行成功且交易金额已核对；最终确认由后台继续核查，不会重发' });
        this.log(final ? 'success' : 'info', `${final ? '已最终确认到账' : '执行成功，后台等待最终确认'} ${row.amount} → ${row.address}；交易 ${row.txid}`);
        return true;
      }
      if (Date.now() >= deadline) break;
      if (!final && wait && !this.running) break;
      if (!final && wait) await this.wait(this.timing.receiptPollMs); else await sleep(3000);
    } while (Date.now() < deadline);
    if (!final && this.store.get(row.id)?.status === 'prepared') this.store.update(row.id, 'pending', { detail: '尚未取得执行结果；按同一交易重试，已保存次数和哈希' });
    return false;
  }
  failureStreak() {
    let count = 0;
    for (const outcome of [...this.outcomes.values()].reverse()) {
      if (outcome === true) break;
      if (outcome === false) count++;
    }
    return count;
  }
  noteOutcome(row, success) {
    const previous = this.outcomes.get(row.id);
    this.outcomes.set(row.id, success);
    this.refreshSent();
    if (previous === success) return;
    const streak = this.failureStreak();
    if (!success) {
      this.log('warn', `本笔重试已结束；连续未成功 ${streak}/${FAILURE_LIMIT}：${row.address}；交易 ${row.txid || '未广播'}${streak < FAILURE_LIMIT ? '；继续后续地址' : ''}`);
      if (this.running && streak >= FAILURE_LIMIT) this.fail(new Error(`连续 ${FAILURE_LIMIT} 笔投放在重试后仍未成功，已暂停；记录和交易哈希保留`));
    }
  }
  refreshSent() { this.metrics.sent = [...this.outcomes.values()].filter(value => value === true).length; }
  async sendNext() {
    if (this.runLimitReached()) return false;
    if (this.mode === 'live' && this.energyPolicy?.linked()) {
      try {
        const energyMode = await this.energyPolicy.refreshForSend();
        if (this.store.unresolvedEnergyOrders().length) { this.resourceWait = '平台原订单仍在核对；暂停新发送，保留扫描和队列'; return false; }
        if (this.config.assetType !== 'TRC10' && energyMode === 'seamless' && this.store.pending().length) { this.resourceWait = '等待原交易最终确认，再评估下一笔资源'; return false; }
        this.resourceWait = null;
      } catch (error) { if (!error.policyWait) throw error; this.resourceWait = error.message; return false; }
    }
    if (this.config.assetType === 'TRC10') {
      const cutoff = new Date(Date.now() - this.config.queueTtlMinutes * 60000).toISOString();
      this.store.db.prepare("UPDATE deliveries SET status='skipped_restart',dedupe_cleared_at=?,detail='超过等待有效期' WHERE mode=? AND asset_type='TRC10' AND source_kind='scan' AND status='queued' AND created_at<? AND txid IS NULL").run(new Date().toISOString(), this.mode, cutoff);
    }
    const queued = this.store.next(this.mode, this.config);
    const retry = this.mode === 'live' ? this.store.nextRetry(this.config, this.chain.wallet, Date.now(), [...this.confirmingIds]) : null;
    const row = queued?.source_kind === 'manual' && retry?.source_kind !== 'manual' ? queued : retry || queued;
    if (!row || !this.running) return false;
    if (this.config.blacklist.includes(row.address) || row.address === walletAddress(this.config) || this.pool?.ownAddress(row.address)) {
      if (row.txid) this.store.deferRetry(row, Date.now() + 60000);
      else this.store.update(row.id, 'skipped', { detail: '收款地址在黑名单中或是投放钱包本身' });
      this.metrics.skipped++; return true;
    }
    if (row.token !== this.config.tokenContract || row.amount !== this.config.sendAmount || row.rpc !== this.config.rpcUrl) throw new Error('等待队列与当前设置不一致');
    if (this.mode === 'simulate') {
      this.store.update(row.id, 'simulated', { detail: '仅模拟命中，未签名、未广播' });
      this.metrics.simulated++; this.log('info', `模拟命中 ${row.address}，拟投放 ${row.amount}`); return true;
    }
    this.activeDeliveryId = row.id;
    try { return this.config.assetType !== 'TRC10' && this.energyPolicy?.requireMode() === 'seamless' ? await this.deliverSeamless(row) : await this.deliver(row); }
    catch (error) { if (!error.policyWait) throw error; this.resourceWait = error.message; return false; }
    finally { this.activeDeliveryId = null; }
  }
  async deliverSeamless(original) {
    if (original.txid) {
      // A previously local transaction must finish by its original route before switching.
      this.resourceWait = '旧交易仍在核查，等待确认后再使用无感模式'; return false;
    }
    const token = this.preflightResult.token, policy = this.energyPolicy.value;
    const resources = await this.chain.resources(); this.wallet = resources; this.lastResourceAt = Date.now();
    this.checkFunds(resources, { ...token, rawBalance: await this.chain.tokenBalance() }, this.config, decimalUnits(original.amount, token.decimals));
    let saved = this.store.energyIntent(original, this.getConfig());
    if (saved.submitted) return false;
    const client = this.energyPolicy.client();
    try {
      const admitted = await client.admit({ intent_id: saved.intent_id, policy_revision: policy.revision,
        contract_address: original.token, recipient_address: original.address, amount_raw: decimalUnits(original.amount, token.decimals).toString() });
      if (!admitted.admission_id) { this.resourceWait = '等待平台发送容量，尚未签名或广播'; return false; }
      if (!Number.isFinite(Date.parse(admitted.expires_at)) || Date.parse(admitted.expires_at) <= Date.now() || !/^\d+$/.test(String(admitted.price_sun))) throw new Error('平台准入许可无效或已过期');
      this.store.updateEnergyOrder(original.id, { admission_id: admitted.admission_id, price_sun: String(admitted.price_sun) });
      if (!this.running || this.energyPolicy.requireMode() !== 'seamless' || this.energyPolicy.value.revision !== policy.revision) return false;
      if (!/^\d+$/.test(String(policy.max_fee_limit_sun)) || BigInt(policy.max_fee_limit_sun) <= 0n) throw new Error('平台未提供有效执行费用上限');
      const localCap = decimalUnits(this.config.feeLimitTrx, 6), platformCap = BigInt(policy.max_fee_limit_sun);
      const signingConfig = { ...this.config, feeLimitTrx: formatUnits(platformCap < localCap ? platformCap : localCap, 6) };
      const prepared = await this.getChain(signingConfig).buildAndSign(original, token.decimals);
      if (!this.running) return false;
      if (prepared.signed.raw_data.expiration < Date.now() + 30000 || Date.parse(admitted.expires_at) <= Date.now()) throw new Error('准入或交易有效期不足，尚未提交，请等待重新准入');
      this.energyPolicy.requireMode();
      if (this.energyPolicy.value.revision !== policy.revision) return false;
      this.store.transaction(() => {
        this.store.prepareAttempt(original, prepared, false);
        const row = this.store.get(original.id);
        this.store.exhaustRetry(row);
        this.store.updateEnergyOrder(row.id, { submitted: 1, txid: prepared.txid, detail: '已记录单次提交；无论响应如何都只查询原订单' });
        this.store.update(row.id, 'uncertain', { detail: '签名交易提交平台，结果待核对；不会本地重发' });
      });
      const row = this.store.get(original.id);
      if (!this.outcomes.has(row.id)) this.outcomes.set(row.id, null);
      try {
        const order = await this.submitGateway(client, { admission_id: admitted.admission_id, txid: prepared.txid, signed_transaction: prepared.signed }, admitted.expires_at, policy.revision);
        this.acceptEnergyOrder(row.id, order);
      } catch (error) {
        this.recordEnergySubmitError(row.id, error);
        if (error.status === 409 && error.code === 'energy_trx_paused' && error.broadcastStarted === false
          && error.admissionId === admitted.admission_id && error.intentId === saved.intent_id) {
          // The gateway durably latched low TRX before reserving or forwarding.
          // Keep the business intent but retire this provably unsubmitted payload.
          this.store.transaction(() => {
            this.store.attemptStatus(row.txid, 'not_broadcast', '平台确认 TRX 保护暂停，本签名从未广播');
            this.store.update(row.id, 'queued', { txid: null, raw_amount: null, wallet: null, detail: '平台 TRX 余额保护已暂停；等待平台恢复后继续原任务' });
            this.store.db.prepare('UPDATE delivery_retry SET attempts=0,exhausted=0,retry_after=0 WHERE delivery_id=?').run(row.id);
            this.store.updateEnergyOrder(row.id, { submitted: 0, txid: null, admission_id: null, order_id: null, route: null,
              transaction_status: 'not_broadcast', billing_status: 'not_reserved', service_status: 'not_delivered', customer_fee_sun: null,
              detail: '原签名明确未转发；保留同一 intent 等待平台 TRX 恢复策略' });
          });
          this.energyPolicy.value = { ...this.energyPolicy.value, enabled: false, low_trx_latched: true, paused_reason: error.message };
          this.resourceWait = error.message;
          return false;
        }
        this.store.updateEnergyOrder(row.id, { detail: redact(error.message, this.getConfig()) + '；仅查询原 intent，不重新提交' });
        this.log('warn', `平台提交结果未确定，保留原订单并后台核查：${prepared.txid}`);
      }
      return true;
    } catch (error) {
      this.resourceWait = redact(error.message, this.getConfig());
      // Admission/build failures did not reach the broadcast gateway and do not consume retries.
      return false;
    }
  }
  async submitGateway(client, payload, expiresAt, revision) {
    const current = () => {
      try { return this.running && this.energyPolicy.requireMode() === 'seamless' && this.energyPolicy.value.revision === revision
        && Date.parse(expiresAt) > Date.now() && payload.signed_transaction.raw_data.expiration >= Date.now() + 30000; }
      catch { return false; }
    };
    for (let calls = 1; ; calls++) {
      try { return await client.submit(payload); }
      catch (error) {
        // This exact platform response proves no reservation/forwarding marker
        // exists. A generic 429, network failure or unknown response cannot retry.
        if (error.status !== 429 || error.code !== 'energy_capacity_wait' || error.broadcastStarted !== false || calls >= 12 || !current()) throw error;
        const delay = this.timing.gatewayRetryMs + Math.floor(Math.random() * this.timing.gatewayJitterMs);
        if (Date.parse(expiresAt) <= Date.now() + delay || payload.signed_transaction.raw_data.expiration < Date.now() + delay + 30000) throw error;
        this.resourceWait = '平台广播容量不足，本笔明确尚未转发；等待后提交同一签名交易';
        await this.wait(delay);
        if (!current()) throw error;
      }
    }
  }
  recordEnergySubmitError(id, error) {
    const key = 'delivery-platform-submit-error:' + id;
    if (this.store.getMeta(key)) return;
    const message = redact(error.message || String(error), this.getConfig()).slice(0, 500);
    this.store.setMeta(key, { message, at: new Date().toISOString() });
  }
  acceptEnergyOrder(deliveryId, result) {
    const order = result?.order || result, saved = this.store.energyOrder(deliveryId);
    if (!order || !saved || typeof order.id !== 'string' || !order.id || order.intent_id !== saved.intent_id
      || (saved.order_id && order.id !== saved.order_id) || (order.txid && order.txid.toLowerCase() !== saved.txid?.toLowerCase())
      || (!order.txid && ['complete', 'forwarding', 'pending', 'review'].includes(order.status))) throw new Error('平台返回的订单与原交易不匹配');
    const fee = order.billing_status === 'charged' ? String(order.charge_sun)
      : ['free', 'released'].includes(order.billing_status) ? '0' : null;
    if (fee !== null && !/^\d+$/.test(fee)) throw new Error('平台服务费不是整数 SUN');
    const resolved = ['complete', 'cancelled'].includes(order.status) && ['charged', 'free', 'released'].includes(order.billing_status)
      && ['not_needed', 'delivered', 'not_delivered'].includes(order.service_status);
    const expiredUnconfirmed = resolved && order.status === 'complete' && order.tx_status === 'expired_unconfirmed'
      && order.service_status === 'not_delivered' && order.billing_status === 'released';
    if (expiredUnconfirmed && this.store.get(deliveryId).status === 'confirmed') throw new Error('平台过期结论与本机已确认到账记录冲突，请核对原交易');
    this.store.updateEnergyOrder(deliveryId, { order_id: order.id == null ? saved.order_id : String(order.id), route: order.route ?? null,
      service_status: order.service_status ?? null, transaction_status: order.tx_status ?? null, billing_status: order.billing_status ?? null,
      customer_fee_sun: fee, resolved: resolved ? 1 : 0, detail: String(order.reason || '').slice(0, 500) });
    if (expiredUnconfirmed) {
      const row = this.store.get(deliveryId);
      this.store.exhaustRetry(row);
      this.store.update(deliveryId, 'expired_unconfirmed', { detail: '已过期未确认，预留款已释放；平台人工核对后关闭，保留原交易与地址去重，不再补发' });
      this.store.attemptStatus(row.txid, 'expired_unconfirmed', '已过期未确认，原任务结束；不代表链上执行失败');
      if (this.outcomes.has(deliveryId)) this.noteOutcome(row, false);
    }
    if (resolved && order.status === 'cancelled' && order.tx_status === 'not_broadcast' && order.broadcast_started === false) {
      const row = this.store.get(deliveryId);
      this.store.update(deliveryId, 'failed', { detail: '平台已确认原许可取消且从未广播；不会自动补发，可重新检查人工补发资格' });
      this.store.attemptStatus(row.txid, 'cancelled', '平台已确认从未广播');
      if (this.outcomes.has(deliveryId)) this.noteOutcome(row, false);
    }
  }
  async syncEnergyOrders() {
    if (!this.energyPolicy?.linked()) return;
    const config = this.getConfig();
    for (const saved of this.store.unresolvedEnergyOrders().slice(0, 5)) {
      if (saved.delivery_id === this.activeDeliveryId || saved.platform_origin !== config.platformUrl || saved.device_id !== config.platformDeviceId) continue;
      try {
        const client = this.energyPolicy.client();
        this.acceptEnergyOrder(saved.delivery_id, saved.order_id ? await client.order(saved.order_id) : await client.byIntent(saved.intent_id));
      } catch (error) { this.store.updateEnergyOrder(saved.delivery_id, { detail: redact(error.message, config) + '；继续查询原订单' }); }
    }
  }
  async deliver(original) {
    if (this.store.energyOrder(original.id)?.submitted) return false;
    let lastReason = '', knownFailed = false;
    while (this.running) {
      let row = this.store.get(original.id), retry = this.store.retryInfo(row), prepared = null;
      if (['confirmed', 'executed'].includes(row.status)) { this.noteOutcome(row, true); return true; }
      if (row.txid) {
        // Look up before every replay. A lost broadcast response may already
        // have executed. Only an identical signed payload can be replayed early.
        try {
          if (await this.settle(row, false, true)) { this.noteOutcome(row, true); return true; }
          if (await this.settle(row, false, false)) { this.noteOutcome(row, true); return true; }
        } catch (error) {
          if (error.halt) throw error;
          if (isRateLimitError(error)) return this.waitForCapacity(error, row);
          lastReason = redact(nodeReason(error), this.getConfig());
        }
        row = this.store.get(row.id);
        const attempt = this.store.attempt(row.txid);
        knownFailed = attempt?.status === 'failed_final';
        if (retry.attempts < MAX_ATTEMPTS) {
          if (attempt?.signed_json && attempt.expiration > Date.now() && !['failed_pending', 'failed_final'].includes(attempt.status)) {
            prepared = this.config.assetType === 'TRC10' ? this.chain.restoreNative(row, attempt) : this.chain.restoreAttempt(row, attempt);
          } else {
            let replace = knownFailed;
            try { if (!replace) replace = await this.chain.replacementReady(row.txid, attempt?.expiration); }
            catch (error) {
              if (isRateLimitError(error)) return this.waitForCapacity(error, row);
              lastReason = redact(nodeReason(error), this.getConfig());
            }
            if (!replace) {
              this.store.deferRetry(row, Date.now() + 60000);
              const legacy = !attempt?.signed_json ? '旧版未保存签名和有效期，按最长 24 小时有效期核查。' : '';
              this.store.update(row.id, 'uncertain', { detail: `${legacy}原交易尚未满足安全重建条件，稍后核查；后续地址继续。${lastReason}` });
              return false;
            }
            this.store.attemptStatus(row.txid, knownFailed ? 'failed_final' : 'expired', lastReason || '已确认链超过有效期，原交易不存在');
          }
        }
      }
      if (retry.attempts >= MAX_ATTEMPTS) {
        this.store.exhaustRetry(row);
        this.store.update(row.id, !row.txid || knownFailed ? 'failed' : 'uncertain', {
          detail: `首次尝试后最多补试 3 次，次数已用完；保留去重，继续其他地址。${lastReason || row.detail}` });
        this.noteOutcome(row, false); return true;
      }
      if (!this.running) return false;
      if (!this.outcomes.has(row.id)) this.outcomes.set(row.id, null);
      let counted = false;
      try {
        const token = this.preflightResult.token;
        if (this.config.assetType === 'TRC10') {
          const wasPrepared = Boolean(prepared);
          prepared = await this.pool.prepareDelivery(row, this.chain, token.decimals, prepared, () => this.running);
          if (!this.running) return false;
          if (!wasPrepared) { this.store.prepareAttempt(row, prepared); row = this.store.get(row.id); }
          this.resourceWait = null;
        } else {
          const resources = await this.chain.resources(); this.wallet = resources; this.lastResourceAt = Date.now();
          const balance = { ...token, rawBalance: await this.chain.tokenBalance() };
          try { this.checkFunds(resources, balance, this.config, decimalUnits(row.amount, token.decimals)); }
          catch (error) { if (!error.policyWait) error.halt = true; throw error; }
          if (!this.running) return false;
          if (!prepared) {
            const revision = this.energyPolicy?.value?.revision;
            prepared = await this.chain.buildAndSign(row, token.decimals);
            if (!this.running) return false;
            if (this.energyPolicy?.linked() && (this.energyPolicy.requireMode() !== 'local' || this.energyPolicy.value.revision !== revision)) throw Object.assign(new Error('本地签名期间平台策略发生变化，等待新模式生效'), { policyWait: true });
            this.store.prepareAttempt(row, prepared); row = this.store.get(row.id);
          }
        }
        if (!this.running) return false;
        if (this.energyPolicy?.linked()) {
          const mode = this.energyPolicy.requireMode();
          if (this.config.assetType !== 'TRC10' && mode !== 'local') throw Object.assign(new Error('平台模式已变化，原本地交易仅继续核查'), { policyWait: true });
        }
        const number = this.store.beginAttempt(row); counted = true;
        if (number > 1) this.log('warn', `补试 ${number - 1}/3：${row.address}；交易 ${prepared.txid}`);
        let response;
        try { response = await this.chain.broadcast(prepared.signed); }
        catch (error) {
          if (isRateLimitError(error)) {
            // Reserve before sending for crash recovery, but an explicit rate
            // rejection did not use a delivery attempt. Retain the signed hash.
            this.store.refundAttempt(row); counted = false; throw error;
          }
          lastReason = redact(nodeReason(error), this.getConfig());
        }
        const accepted = response?.result === true;
        if (!accepted && response) lastReason = redact(nodeReason(response), this.getConfig());
        const detail = accepted ? '广播已接受，等待执行结果' : `广播未明确接受：${lastReason || '未知结果'}；将先核查再补试`;
        this.store.update(row.id, accepted ? 'pending' : 'uncertain', { detail });
        this.store.attemptStatus(row.txid, accepted ? 'pending' : 'uncertain', detail);
        if (!accepted) this.log('warn', `${detail}；地址 ${row.address}；交易 ${row.txid}`);
        if (await this.settle(row, true, false)) { this.noteOutcome(row, true); return true; }
      } catch (error) {
        if (error.cancelled) return false;
        if (error.policyWait) { this.resourceWait = error.message; return false; }
        if (error.resourceWait) {
          this.resourceWait = error.message;
          if (row.txid) this.store.deferRetry(row, Date.now() + 60000);
          return false;
        }
        if (error.skipTarget && !row.txid) { this.store.update(row.id, 'skipped', { detail: error.message }); this.metrics.skipped++; return true; }
        if (error.halt) throw error;
        if (isRateLimitError(error)) return this.waitForCapacity(error, row);
        lastReason = redact(nodeReason(error), this.getConfig());
        if (!counted && this.running) this.store.beginAttempt(row);
        this.log('warn', `本笔暂未成功：${lastReason}；地址 ${row.address}；交易 ${row.txid || '未广播'}`);
      }
      if (this.config.assetType === 'TRC10') {
        // Keep an unknown transaction bound to its original sender and signed
        // payload. Other wallets continue while this one waits for lookup.
        this.store.deferRetry(this.store.get(row.id), Date.now() + 60000);
        return true;
      }
      if (this.running) await this.wait(this.timing.retryDelayMs);
    }
    return false;
  }
  async scanLoop() {
    let consecutiveErrors = 0, capacityDelayed = false, backlogNoted = false;
    while (this.running) {
        try {
          this.headHeight = await this.chain.head();
          // Public node replicas may lag slightly after switching. Keep the
          // cursor and retry; never rewind it or treat this as a send failure.
          if (this.headHeight < this.height) throw new Error('节点已确认高度暂时落后，等待追平');
          if (this.headHeight - this.height > this.config.maxCatchUpBlocks) {
            if (!capacityDelayed) throw Object.assign(new Error('积压区块超过补扫上限，请暂停后调整设置'), { halt: true });
            if (!backlogNoted) { backlogNoted = true; this.log('warn', '节点限流期间区块积压，正在按高度逐块补扫，不跳过进度'); }
          }
          // Always read EVERY height after the cursor, even when multiple blocks
          // arrived between polls. Commit a height only with its queued matches.
          const target = Math.min(this.headHeight, this.height + 10);
          for (let h = this.height + 1; h <= target && this.running; h++) { if (await this.scanOne(h)) consecutiveErrors = 0; else break; }
          consecutiveErrors = 0;
          if (this.height === this.headHeight) { capacityDelayed = false; backlogNoted = false; }
        } catch (error) {
          if (error.halt) throw error;
          if (isRateLimitError(error)) { capacityDelayed = true; await this.waitForCapacity(error); continue; }
          consecutiveErrors++;
          if (consecutiveErrors <= 3 || consecutiveErrors % 5 === 0) this.log('warn', `扫描暂不可用（第 ${consecutiveErrors} 次）：${error.message}。保留原进度后重试`);
          await this.wait(Math.min(30000, consecutiveErrors * 3000)); continue;
        }
        if (this.running) await this.wait((this.height < this.headHeight && !this.resourceWait ? 0 : this.config.pollSeconds) * 1000);
    }
  }
  async sendLoop() {
    while (this.running) {
        const processed = await this.sendNext();
        if (this.config.maxPerRun > 0 && this.metrics.sent + this.metrics.simulated >= this.config.maxPerRun) {
          this.log('info', `已达到本次 ${this.config.maxPerRun} 个地址上限，自动暂停`); this.running = false; this.wakeAll(); break;
        }
        if (Date.now() - this.lastResourceAt > 15000 && this.chain.wallet) {
          try { this.wallet = await this.chain.resources(); this.lastResourceAt = Date.now(); }
          catch (error) { this.log('warn', `资源刷新失败：${error.message}`); }
        }
        if (this.running) await this.wait((processed ? this.config.sendIntervalSeconds : this.config.pollSeconds) * 1000, !processed);
    }
  }
  async loop() {
    const guard = promise => promise.catch(error => this.fail(error));
    // Await both workers even after an error: an already-broadcast send must finish
    // reconciliation before the app can unlock settings or close its database.
    await Promise.all([guard(this.scanLoop()), guard(this.sendLoop())]);
    if (!this.closed) await this.confirmExecuted();
    if (this.failure) { this.state = 'fault'; this.lastError = redact(this.failure.message || String(this.failure), this.config); }
    else { this.state = 'stopped'; this.log('info', '任务已暂停；进度已保存，已发送交易继续在后台核查最终确认'); }
  }
  async inspectReviewAttempt(row, attempt, chain) {
    const evidence = { txid: attempt.txid, kind: 'unknown', reason: '', expiration: null, source: null };
    const messages = [], target = { ...row, txid: attempt.txid, wallet: attempt.wallet || row.wallet };
    if (!/^[a-f\d]{64}$/i.test(attempt.txid)) return { ...evidence, kind: 'conflict', reason: '交易哈希格式异常，需人工核对原始记录' };
    for (const final of [true, false]) {
      try {
        const info = row.asset_type === 'TRC10' ? await chain.deliveryReceipt(target, final)
          : await (final ? chain.receipt(attempt.txid) : chain.executionReceipt(attempt.txid));
        if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('交易回执返回异常');
        if (!Object.keys(info).length) continue;
        if (typeof info.id !== 'string' || info.id.toLowerCase() !== attempt.txid.toLowerCase()) return { ...evidence, kind: 'conflict', reason: '节点返回的回执哈希不匹配或不完整' };
        const result = info.receipt?.result;
        if (result === 'SUCCESS') {
          let matches = false;
          try { matches = row.asset_type === 'TRC10' ? info.nativeValidated : target.wallet && target.raw_amount && transferEvents(info, row.token, target.wallet, row.address, row.raw_amount); } catch { /* Invalid original parameters are a conflict, not an absent receipt. */ }
          if (!matches) {
            return { ...evidence, kind: 'conflict', reason: '回执显示成功，但收款人、金额或钱包参数未核对通过，不能结束核查' };
          }
          return { ...evidence, kind: final ? 'success' : 'executed', reason: final ? '已核实最终到账' : '已执行成功，等待最终确认', info };
        }
        if (!REVIEW_FAILURES.has(result)) return { ...evidence, kind: 'conflict', reason: '节点返回的执行结果未知或不完整，不能认定失败' };
        if (final) return ['confirmed', 'executed'].includes(attempt.status)
          ? { ...evidence, kind: 'conflict', reason: '本次失败回执与已保存的成功执行证据冲突，需人工核对' }
          : { ...evidence, kind: 'failed', reason: '已核实最终执行失败：' + result, info };
        messages.push('普通节点显示执行失败，尚未最终确认');
      } catch (error) {
        if (error.halt || error.reviewConflict) return { ...evidence, kind: 'conflict', reason: redact(error.message, this.getConfig()) };
        messages.push(redact(error.message, this.getConfig()));
      }
    }
    if (['confirmed', 'executed'].includes(attempt.status)) return { ...evidence, kind: 'executed', reason: '原记录已有成功执行证据，当前回执暂不可用，不能归档为结果未知' };
    if (attempt.status === 'review_conflict') return { ...evidence, kind: 'conflict', reason: '原核查存在参数或结果冲突，尚未取得有效回执消除冲突，不能结束核查' };
    if (attempt.signed_json) {
      try {
        const signed = JSON.parse(attempt.signed_json), expiration = checkedTransactionExpiration(attempt.txid, signed);
        if (row.asset_type === 'TRC10') validateNative(target, signed, target.raw_amount, target.wallet);
        else Chain.prototype.validateTransaction.call({ wallet: target.wallet, config: { feeLimitTrx: formatUnits(String(signed.raw_data.fee_limit), 6) } }, target, signed, target.raw_amount);
        if (attempt.expiration !== null && attempt.expiration !== expiration) throw new Error('保存的有效期与原签名交易不一致');
        evidence.expiration = expiration; evidence.source = 'signed_transaction';
      } catch (error) { return { ...evidence, kind: 'conflict', reason: '原签名交易校验未通过：' + redact(error.message, this.getConfig()) }; }
    }
    try {
      const known = await chain.transactionExpiration(attempt.txid);
      if (known) {
        if (evidence.expiration !== null && evidence.expiration !== known.expiration) return { ...evidence, kind: 'conflict', reason: '链上交易与本地签名有效期不一致' };
        evidence.expiration = known.expiration; evidence.source = 'chain';
        const results = Object.values(known.execution_results || {});
        if (results.includes('SUCCESS')) return { ...evidence, kind: 'executed', reason: '节点交易显示执行成功，完整回执暂不可用，不能结束核查' };
        if (results.some(value => value !== null && !REVIEW_FAILURES.has(value))) return { ...evidence, kind: 'conflict', reason: '节点交易执行结果未知或不完整，不能结束核查' };
        messages.push('节点仍保留原交易，尚未取得可核实的最终回执');
      }
      if (evidence.expiration !== null && await chain.replacementReady(attempt.txid, evidence.expiration)) {
        return { ...evidence, kind: 'expired', reason: '原始有效期已过，最新固化区块已越过安全余量，四个交易及回执查询均为空；未确认到账' };
      }
    } catch (error) {
      if (Object.values(error.observed_execution_results || {}).includes('SUCCESS')) return { ...evidence, kind: 'executed', reason: '节点交易曾显示执行成功，后续查询暂不可用，不能结束核查' };
      if (Object.values(error.observed_execution_results || {}).some(value => value !== null && !REVIEW_FAILURES.has(value))) return { ...evidence, kind: 'conflict', reason: '节点交易执行结果未知，后续查询失败不能消除原冲突' };
      if (error.transaction_found && !Object.values(error.observed_execution_results || {}).some(value => REVIEW_FAILURES.has(value))) return { ...evidence, kind: 'conflict', reason: '节点已发现原交易，但执行结果尚未核实，不能结束核查' };
      if (error.halt || error.reviewConflict) return { ...evidence, kind: 'conflict', reason: redact(error.message, this.getConfig()) };
      messages.push(redact(error.message, this.getConfig()));
    }
    if (evidence.expiration === null) messages.unshift('旧版未保存可验证的原始有效期，不能根据记录日期推定链上过期');
    evidence.reason = messages.join('；') || '尚不满足安全结束核查条件';
    return evidence;
  }
  async reviewRecord(id, input = {}) {
    if (this.busy || this.running || this.activeDeliveryId) throw new Error('请先暂停任务，等待当前交易处理完成');
    const close = input.close === true, note = typeof input.note === 'string' ? input.note.trim() : '';
    if (close && (input.confirmed !== true || !note || note.length > 500 || !['expire', 'fail', 'archive'].includes(input.expected_action))) throw new Error('请填写 1 至 500 字处理说明，并确认本次结束核查的方式');
    this.busy = true; this.reconciling = true;
    try {
      await this.confirmationPass; await this.statisticsPass;
      let row = this.store.get(id);
      if (!row) throw new Error('未找到这条投放记录');
      if (row.mode !== 'live' || ![...REVIEW_PENDING, 'archived_unconfirmed'].includes(row.status)) return this.store.record(id);
      const previousReview = this.store.getMeta('delivery-review:' + id), platform = this.store.energyOrder(id);
      if (platform) {
        const config = this.getConfig();
        if (this.energyPolicy?.linked() && platform.platform_origin === config.platformUrl && platform.device_id === config.platformDeviceId) {
          try {
            const client = this.energyPolicy.client();
            this.acceptEnergyOrder(id, platform.order_id ? await client.order(platform.order_id) : await client.byIntent(platform.intent_id));
          } catch (error) { this.store.updateEnergyOrder(id, { detail: redact(error.message, config) + '；保留原平台订单继续核查' }); }
          row = this.store.get(id);
          if (![...REVIEW_PENDING, 'archived_unconfirmed'].includes(row.status)) return this.store.record(id);
        }
        this.store.setMeta('delivery-review:' + id, { fingerprint: this.store.reviewFingerprint(row), checked_at: new Date().toISOString(),
          can_close: false, close_action: null, reason: '此记录关联平台订单，只能查询原平台结论；服务或费用未核实前不能在本地结束核查',
          closed_at: previousReview?.closed_at || null, note: previousReview?.note || null });
        return this.store.record(id);
      }
      this.store.ensureReviewAttempt(row);
      this.store.transaction(() => {
        this.store.exhaustRetry(row);
        this.store.setMeta('delivery-review:' + id, { ...previousReview, all_attempts: true, can_close: false, close_action: null,
          reason: '已转为逐笔核查全部原交易，不再自动重试；请在记录详情完成核查' });
      });
      const attempts = this.store.deliveryAttempts(id), fingerprint = this.store.reviewFingerprint(row), config = this.getConfig();
      const chain = this.getChain({ ...config, assetType: row.asset_type || 'TRC20', tokenId: row.token, tokenContract: row.token, rpcUrl: row.rpc || config.rpcUrl });
      const evidence = [];
      for (const attempt of attempts) evidence.push(await this.inspectReviewAttempt(row, attempt, chain));
      if (this.store.reviewFingerprint(this.store.get(id)) !== fingerprint) throw new Error('核查期间记录已变化，请重新核查最新记录');
      // A later RPC outage must never erase previously observed success or a
      // parameter conflict. These markers survive restarts and manual retries.
      for (const item of evidence.filter(item => ['success', 'executed', 'conflict'].includes(item.kind))) {
        this.store.exhaustRetry(row);
        const previousStatus = this.store.attempt(item.txid)?.status;
        const status = item.kind === 'success' ? 'confirmed' : ['confirmed', 'executed'].includes(previousStatus) ? previousStatus
          : item.kind === 'executed' ? 'executed' : 'review_conflict';
        this.store.attemptStatus(item.txid, status, item.reason);
        if (item.info) this.captureReceipt({ ...row, txid: item.txid }, item.info);
      }
      let canClose = false, action = null, reason;
      const success = evidence.filter(item => item.kind === 'success'), conflict = evidence.find(item => item.kind === 'conflict'), executed = evidence.find(item => item.kind === 'executed');
      const unresolved = evidence.filter(item => !['success', 'failed', 'expired'].includes(item.kind));
      if (success.length === 1 && !unresolved.length) {
        // An archived task can still acquire its actual result on explicit
        // recheck. Every signed attempt remains stored and retries stay off.
        const result = success[0], attempt = attempts.find(item => item.txid === result.txid);
        this.store.transaction(() => {
          this.store.exhaustRetry(row);
          this.store.update(id, 'confirmed', { txid: result.txid, wallet: attempt.wallet || row.wallet, detail: '手动核查已核实最终到账；原交易和全部尝试保留，不再补发' });
          for (const item of evidence) {
            if (item.info) this.captureReceipt({ ...row, txid: item.txid }, item.info);
            this.store.attemptStatus(item.txid, item.kind === 'success' ? 'confirmed' : item.kind === 'failed' ? 'failed_final' : 'expired_unconfirmed', item.reason);
          }
        });
        reason = '已核实最终到账，保留全部历史交易，不再补发';
      } else if (success.length || conflict || executed || row.status === 'executed') {
        reason = conflict?.reason || executed?.reason || (success.length ? '历史尝试存在已到账交易，其他尝试仍需逐笔核对，不能归档或补发' : '原记录已有执行成功证据，需等待最终确认');
      } else if (platform) {
        reason = '此记录关联平台订单，只能查询原平台结论；服务或费用未核实前不能在本地结束核查';
      } else if (!attempts.length || !row.txid) {
        reason = '缺少原始交易哈希，不能自动结束核查，请保留数据核对';
      } else if (row.status === 'archived_unconfirmed') {
        reason = '已停止自动核查和重试；本次仍未确认最终结果。' + evidence.map(item => item.reason).join('；');
      } else if (evidence.every(item => ['failed', 'expired'].includes(item.kind))) {
        canClose = true; action = evidence.every(item => item.kind === 'failed') ? 'fail' : 'expire';
        reason = action === 'fail' ? '已逐一核实所有尝试最终执行失败；结束后永久停止此记录重试，保留实际费用与去重'
          : '所有尝试均已核查：有原始有效期及固化区块、四处空结果证据的交易可标为已过期未确认；保留历史、去重和已知费用，不再补发';
      } else {
        const at = Date.now(), oldEnough = [row.created_at, row.updated_at, ...attempts.map(item => item.created_at)]
          .every(value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= at - REVIEW_ARCHIVE_WAIT_MS);
        canClose = row.asset_type === 'TRC20' && oldEnough;
        action = canClose ? 'archive' : null;
        reason = evidence.map(item => item.reason).join('；') + (canClose
          ? '。记录已超过 24 小时人工处理等待期，可选择结束核查并保留结果未知；这不是链上过期或失败证明，费用未知，停止自动核查和重试，保留全部历史与去重'
          : '。暂不能结束：结果未知记录仅允许本地 TRC20 且全部尝试保存超过 24 小时后人工归档；24 小时仅为处理等待政策');
      }
      let closedAt = previousReview?.closed_at || null, reviewNote = previousReview?.note || null;
      if (close && canClose && action === input.expected_action) {
        this.store.transaction(() => {
          const latest = this.store.get(id);
          if (this.store.reviewFingerprint(latest) !== fingerprint || !REVIEW_PENDING.includes(latest.status) || this.store.energyOrder(id)) throw new Error('记录状态已变化，未结束核查，请重新核对');
          const status = action === 'archive' ? 'archived_unconfirmed' : action === 'fail' ? 'failed' : 'expired_unconfirmed';
          this.store.exhaustRetry(latest);
          for (const item of evidence) {
            if (item.info) this.captureReceipt({ ...row, txid: item.txid }, item.info);
            this.store.attemptStatus(item.txid, item.kind === 'failed' ? 'failed_final' : action === 'archive' ? 'archived_unconfirmed' : 'expired_unconfirmed', item.reason);
          }
          this.store.update(id, status, { detail: (action === 'archive' ? '人工结束核查，结果仍未知；不代表失败或过期，费用未知'
            : action === 'fail' ? '原交易均已最终确认执行失败，人工结束重试' : '原有效期已过且核查未确认到账，人工结束核查；不代表链上执行失败') + '；保留全部交易与地址去重，不再补发。处理说明：' + note });
          closedAt = new Date().toISOString(); reviewNote = note;
        });
        canClose = false; reason = this.store.get(id).detail;
        this.log('warn', `已结束记录 ${id} 的自动核查和重试；状态 ${this.store.get(id).status}，保留全部交易与去重`);
      } else if (close && canClose && action !== input.expected_action) {
        reason = '本次核查条件已变化，请按新的处理方式重新确认。' + reason;
      }
      row = this.store.get(id);
      if (REVIEW_PENDING.includes(row.status)) reason += '；已停止自动重试和单笔后台结案，请继续在记录详情点击“重新核查”，逐笔核对全部历史尝试';
      this.store.setMeta('delivery-review:' + id, { fingerprint: this.store.reviewFingerprint(row), checked_at: new Date().toISOString(),
        all_attempts: true, can_close: canClose, close_action: canClose ? action : null, reason, closed_at: closedAt, note: reviewNote,
        evidence: evidence.map(({ info, ...item }) => item) });
      return this.store.record(id);
    } finally { this.busy = false; this.reconciling = false; }
  }
  async reconcile() {
    if (this.busy) throw new Error('请先暂停任务');
    this.busy = true; this.reconciling = true;
    try {
      await this.confirmationPass;
      await this.syncEnergyOrders();
      const results = [];
      for (const row of this.store.pending()) {
        if (this.store.requiresAllAttemptReview(row)) { results.push({ id: row.id, confirmed: false, error: '这条记录已进入逐笔人工核查，请打开记录详情重新核查全部历史尝试' }); continue; }
        const config = this.getConfig();
        const chain = this.getChain({ ...config, assetType: row.asset_type || 'TRC20', tokenId: row.token, tokenContract: row.token, rpcUrl: row.rpc || config.rpcUrl });
        try { results.push({ id: row.id, confirmed: await this.settle(row, false, true, chain) }); }
        catch (error) { results.push({ id: row.id, error: redact(error.message, this.getConfig()) }); }
      }
      if (results.length && results.every(row => row.confirmed)) { this.lastError = ''; this.state = 'stopped'; }
      return results;
    } finally { this.busy = false; this.reconciling = false; }
  }
}
module.exports = { Engine };
