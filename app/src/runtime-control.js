'use strict';
const crypto = require('node:crypto');
const { RentalClient, platformOrigin } = require('./rental-client');
const { effectiveConfig, walletAddress, redact, validate } = require('./config');
const VERSION = require('../package.json').version;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'fault', 'energy_wait']);
const integerOrNull = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Runtime reports never contain keys, signed transactions or watched addresses.
// A remote command is an expiring, one-shot permission for this exact process
// and configuration; a reconnect or restart cannot turn it into a schedule.
class RuntimeControl {
  constructor(store, getConfig, engine, { factory = (origin, token) => new RentalClient(origin, token),
    startLive, idleReason = () => '', instanceId = crypto.randomUUID(), monotonic = () => performance.now() } = {}) {
    this.store = store; this.getConfig = getConfig; this.engine = engine; this.factory = factory;
    this.startLive = startLive; this.idleReason = idleReason; this.instanceId = instanceId; this.monotonic = monotonic;
    this.salt = crypto.randomBytes(32); this.generation = 0; this.sequence = 0; this.bindingKey = null; this.pendingReport = null;
    this.closed = false; this.timer = null; this.pass = null; this.execution = null;
    this.results = new Map(); this.error = ''; this.lastSync = null;
  }
  binding() {
    const c = this.getConfig();
    if (c.energyTransport !== 'platform' || !c.platformToken || !c.platformDeviceId || c.platformWallet !== walletAddress(c)) return null;
    return { origin: platformOrigin(c.platformUrl), device: String(c.platformDeviceId), wallet: c.platformWallet, token: c.platformToken };
  }
  unchanged(binding) {
    const current = this.binding();
    return current && ['origin', 'device', 'wallet', 'token'].every(key => current[key] === binding[key]);
  }
  configFingerprint() {
    // The process-local HMAC also covers secret changes without exposing a
    // stable digest of credentials to the server or an offline dictionary.
    return crypto.createHmac('sha256', this.salt).update(JSON.stringify([this.getConfig(), this.generation])).digest('hex');
  }
  invalidate() { this.generation++; }
  pendingCount() {
    return new Set([...this.store.pending().map(row => row.id), ...this.store.unresolvedEnergyOrders().map(row => row.delivery_id)]).size;
  }
  startBlockReason() {
    if (this.closed) return '程序正在退出';
    const reason = this.idleReason();
    if (reason) return reason;
    if (this.engine.busy || ['starting', 'running', 'stopping'].includes(this.engine.state)) return '任务正在运行或停止中';
    if (this.engine.energyRecovery) return '正在等待自动恢复，请先在 TCL 取消自动恢复';
    if (this.pendingCount()) return '存在待确认交易，请先完成核查';
    try { validate(this.getConfig(), 'live'); this.engine.energyPolicy?.requireMode(); }
    catch (error) { return redact(error.message, this.getConfig()).slice(0, 500); }
    return '';
  }
  report() {
    const config = effectiveConfig(this.getConfig()), scan = this.engine.scanProgress?.();
    return { protocol_version: 1, client_version: VERSION, instance_id: this.instanceId, sequence: ++this.sequence,
      state: STATES.has(this.engine.state) ? this.engine.state : 'stopped', mode: this.engine.mode === 'simulate' ? 'simulate' : 'live',
      last_scan_at: scan?.at || null, scan_height: integerOrNull(scan?.height), head_height: integerOrNull(this.engine.headHeight),
      pending_count: this.pendingCount(), config_fingerprint: this.configFingerprint(),
      last_error: redact(this.engine.lastError || this.engine.resourceWait || '', this.getConfig()).slice(0, 500),
      start_block_reason: this.startBlockReason(),
      start_config: { asset_type: config.assetType, token: String(config.tokenContract || '').slice(0, 80),
        amount: String(config.sendAmount).slice(0, 100), send_interval_seconds: config.sendIntervalSeconds,
        max_per_run: config.maxPerRun, restart_scan_mode: config.restartScanMode, unfinished_policy: config.unfinishedPolicy } };
  }
  commandKey(binding, command) { return 'runtime-command:' + JSON.stringify([binding.origin, binding.device, command.id]); }
  validateCommand(command, serverTime, requestedAt) {
    const created = Date.parse(command?.created_at), expires = Date.parse(command?.expires_at), server = Date.parse(serverTime);
    if (!command || !UUID.test(command.id) || command.action !== 'start_live' || command.instance_id !== this.instanceId
      || command.config_fingerprint !== this.configFingerprint() || !Number.isSafeInteger(command.policy_revision)
      || command.policy_revision < 0 || !Number.isFinite(created) || !Number.isFinite(expires) || !Number.isFinite(server)
      || expires <= created || expires - created > 60000 || server < created || expires <= server) throw new Error('启动指令无效或已过期');
    return requestedAt + Math.min(60000, expires - server);
  }
  assertCurrent(binding, command, deadline) {
    if (this.closed || !this.unchanged(binding) || command.instance_id !== this.instanceId
      || command.config_fingerprint !== this.configFingerprint()) throw new Error('设备、参数或本机操作已变化，请重新确认启动');
    if (this.monotonic() >= deadline) throw new Error('启动指令已过期，请重新确认启动');
    const policy = this.engine.energyPolicy;
    if (!policy || policy.value?.revision !== command.policy_revision) throw new Error('平台策略已变化，请重新确认启动');
    policy.requireMode();
  }
  rememberResult(binding, command, status, detail) {
    const result = { instance_id: command.instance_id, status, detail: redact(detail, this.getConfig()).slice(0, 500) };
    const key = this.commandKey(binding, command);
    this.store.setMeta(key, { result, id: command.id, instance_id: command.instance_id });
    this.results.set(command.id, { binding, result, key });
  }
  async flushResults() {
    for (const [id, saved] of this.results) {
      if (!this.unchanged(saved.binding)) { this.results.delete(id); continue; }
      try {
        await this.factory(saved.binding.origin, saved.binding.token).commandResult(id, saved.result);
        this.results.delete(id);
      } catch (error) {
        if ([401, 403, 404, 409, 410].includes(error.status)) this.results.delete(id);
        else this.error = redact(error.message, this.getConfig()).slice(0, 500);
      }
    }
  }
  async execute(binding, command, serverTime, requestedAt) {
    const key = this.commandKey(binding, command), previous = this.store.getMeta(key);
    if (previous) {
      if (previous.result) this.results.set(command.id, { binding, result: previous.result, key });
      return;
    }
    try {
      let deadline = this.validateCommand(command, serverTime, requestedAt);
      this.assertCurrent(binding, command, deadline);
      const blocked = this.startBlockReason();
      if (blocked) throw new Error(blocked);
      // Durably burn the command before attempting the claim. If its response
      // is lost, this process must not retry a start using a later response.
      this.store.setMeta(key, { instance_id: this.instanceId, state: 'claiming' });
      const client = this.factory(binding.origin, binding.token), claimAt = this.monotonic();
      const claim = await client.claimCommand(command.id, { instance_id: this.instanceId, config_fingerprint: command.config_fingerprint });
      if (claim?.execute !== true) throw new Error('平台未授权执行此指令，未启动投放');
      if (!['id', 'action', 'instance_id', 'config_fingerprint', 'policy_revision', 'expires_at'].every(field => claim.command?.[field] === command[field])) throw new Error('平台领取应答与原指令不一致，未启动投放');
      deadline = Math.min(deadline, this.validateCommand(claim.command, claim.server_time, claimAt));
      this.assertCurrent(binding, command, deadline);
      await this.startLive(() => this.assertCurrent(binding, command, deadline));
      if (this.engine.state !== 'running' || this.engine.mode !== 'live' || this.engine.running !== true) throw new Error('启动后任务未处于正式投放状态，请查看 TCL 日志');
      this.rememberResult(binding, command, 'succeeded', '正式投放已启动');
      this.engine.log('info', '已按平台确认启动正式投放；使用本机当前投放参数');
    } catch (error) {
      this.rememberResult(binding, command, 'failed', error.message || String(error));
      this.engine.log('warn', '远程启动未完成：' + redact(error.message || String(error), this.getConfig()));
    }
    await this.flushResults();
  }
  sync() {
    if (this.pass) return this.pass;
    if (this.closed) return Promise.resolve();
    this.pass = (async () => {
      try {
        const binding = this.binding();
        if (!binding) return;
        const key = JSON.stringify([binding.origin, binding.device, binding.wallet, binding.token]);
        if (key !== this.bindingKey) {
          if (this.bindingKey !== null) { this.instanceId = crypto.randomUUID(); this.invalidate(); }
          this.bindingKey = key; this.sequence = 0; this.pendingReport = null;
        }
        const requestedAt = this.monotonic();
        // A newly launched instance must establish sequence 1. Reuse that
        // exact report after a lost response instead of getting stuck at 2.
        this.pendingReport ||= this.report();
        const response = await this.factory(binding.origin, binding.token).runtime(this.pendingReport);
        if (!this.unchanged(binding) || this.closed) return;
        this.pendingReport = null;
        this.lastSync = new Date().toISOString(); this.error = '';
        await this.flushResults();
        if (response?.command && !this.execution) {
          this.execution = this.execute(binding, response.command, response.server_time, requestedAt)
            .catch(error => { this.error = redact(error.message, this.getConfig()).slice(0, 500); })
            .finally(() => { this.execution = null; });
        }
      } catch (error) { this.error = redact(error.message || String(error), this.getConfig()).slice(0, 500); }
    })().finally(() => { this.pass = null; });
    return this.pass;
  }
  start() {
    if (this.closed || this.timer) return;
    const tick = async () => { await this.sync(); if (!this.closed) { this.timer = setTimeout(tick, 5000); this.timer.unref(); } };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  async close() { this.closed = true; this.invalidate(); clearTimeout(this.timer); await this.pass; await this.execution; }
}
module.exports = { RuntimeControl };
