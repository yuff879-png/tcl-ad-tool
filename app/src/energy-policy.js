'use strict';
const { RentalClient } = require('./rental-client');
const { walletAddress, redact } = require('./config');
const waitError = message => Object.assign(new Error(message), { policyWait: true });
const integerSun = value => typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 : typeof value === 'string' && /^\d{1,20}$/.test(value);
function checkedPolicy(policy) {
  if (!policy || !['local', 'seamless'].includes(policy.desired_mode) || !['local', 'seamless'].includes(policy.effective_mode)
    || !Number.isSafeInteger(policy.revision) || policy.revision < 0 || !Number.isFinite(Date.parse(policy.valid_until))
    || !integerSun(policy.price_sun) || !integerSun(policy.trx_stop_sun) || !integerSun(policy.trx_resume_sun)
    || typeof policy.auto_resume !== 'boolean' || typeof policy.low_trx_latched !== 'boolean'
    || !integerSun(policy.max_fee_limit_sun)) throw new Error('平台策略不完整，请升级客户端或联系管理员');
  return policy;
}
class EnergyPolicy {
  constructor(getConfig, { factory = (origin, token) => new RentalClient(origin, token), boundary = () => ({ ready: true, pending_txid: null }), onChange = () => {} } = {}) {
    this.getConfig = getConfig; this.factory = factory; this.boundary = boundary; this.onChange = onChange;
    this.value = null; this.lastError = ''; this.lastSync = null; this.timer = null; this.pass = null; this.closed = false;
  }
  linked() { return this.getConfig().energyTransport === 'platform'; }
  client() {
    const c = this.getConfig();
    if (!this.linked() || !c.platformToken || c.platformWallet !== walletAddress(c)) throw waitError('平台绑定与当前钱包不一致，请先重新绑定');
    return this.factory(c.platformUrl, c.platformToken);
  }
  snapshot() {
    const c = this.getConfig(), p = this.value;
    return { transport: c.energyTransport || 'local', linked: this.linked(), platformUrl: c.platformUrl || '', deviceId: c.platformDeviceId || '', wallet: c.platformWallet || '',
      policy: p ? { desired_mode: p.desired_mode, effective_mode: p.effective_mode, revision: p.revision, price_sun: String(p.price_sun), valid_until: p.valid_until,
        transition_state: p.transition_state, max_fee_limit_sun: p.max_fee_limit_sun, min_trx_sun: p.min_trx_sun,
        trx_stop_sun: p.trx_stop_sun, trx_resume_sun: p.trx_resume_sun, auto_resume: p.auto_resume, low_trx_latched: p.low_trx_latched } : null,
      fresh: Boolean(p && Date.parse(p.valid_until) > Date.now()), lastSync: this.lastSync, error: this.lastError };
  }
  accept(policy) {
    checkedPolicy(policy);
    const c = this.getConfig();
    if (policy.wallet_address !== c.platformWallet || String(policy.device_id) !== c.platformDeviceId) throw new Error('平台策略不属于当前设备或钱包');
    if (this.value && policy.revision < this.value.revision) throw new Error('平台策略版本倒退，等待重新同步');
    this.value = policy; this.lastSync = new Date().toISOString(); this.lastError = ''; this.onChange();
  }
  sync() {
    if (this.pass) return this.pass;
    if (!this.linked() || this.closed) return Promise.resolve(this.snapshot());
    this.pass = (async () => {
      try {
        const client = this.client(); this.accept(await client.policy());
        const boundary = this.boundary();
        // Even a stopped client can acknowledge a safe mode change, but never starts work.
        const result = await client.ack({ revision: this.value.revision, mode: this.value.desired_mode, ready: boundary.ready, pending_txid: boundary.pending_txid || null });
        if (result?.policy) this.accept(result.policy);
        else if (result?.revision !== undefined) this.accept(result);
      } catch (error) { this.lastError = redact(error.message, this.getConfig()); if ([401, 403].includes(error.status)) this.value = null; }
      return this.snapshot();
    })().finally(() => { this.pass = null; });
    return this.pass;
  }
  requireMode() {
    if (!this.linked()) return 'local';
    this.client();
    const p = this.value;
    if (!p || Date.parse(p.valid_until) <= Date.now()) throw waitError('平台策略已过期，暂停新发送，继续核查原交易');
    if (p.enabled !== true || p.low_trx_latched) throw waitError(p.paused_reason || '平台已暂停此地址的新发送');
    if (p.desired_mode !== p.effective_mode || (p.transition_state && !['stable', 'active', 'applied'].includes(p.transition_state))) throw waitError('正在切换能量模式，等待在途交易和平台确认');
    return p.effective_mode;
  }
  async refreshForSend() { if (this.linked()) await this.sync(); return this.requireMode(); }
  start() {
    if (this.closed || this.timer) return;
    const tick = async () => { await this.sync(); if (!this.closed) { this.timer = setTimeout(tick, 4500 + Math.floor(Math.random() * 1000)); this.timer.unref(); } };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  reset() { this.value = null; this.lastSync = null; this.lastError = ''; }
  async close() { this.closed = true; clearTimeout(this.timer); await this.pass; }
}
module.exports = { EnergyPolicy, checkedPolicy, waitError };
