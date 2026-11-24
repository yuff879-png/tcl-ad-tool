'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const { PoolVault } = require('./pool-vault');
const { rawUnits, waitError } = require('./trc10');
const { decimalUnits, formatUnits, walletAddress, effectiveConfig, redact } = require('./config');
const { sleep } = require('./chain');
const { isRateLimitError } = require('./node-access');

function count(value, max = 100000) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`数量须为 1～${max} 的整数`);
  return n;
}
class WalletPool {
  constructor(store, directory, getConfig, getChain) {
    this.store = store; this.db = store.db; this.directory = directory; this.getConfig = getConfig; this.getChain = getChain;
    this.vault = new PoolVault(directory); this.running = false; this.work = null; this.checking = null; this.closed = false; this.progress = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS pool_wallets(
      id TEXT PRIMARY KEY,address TEXT NOT NULL UNIQUE,batch_id TEXT NOT NULL,created_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'inactive',
      token_id TEXT NOT NULL DEFAULT '',raw_balance TEXT NOT NULL DEFAULT '0',free_bandwidth INTEGER NOT NULL DEFAULT 0,
      free_limit INTEGER NOT NULL DEFAULT 600,checked_at TEXT,next_check INTEGER NOT NULL DEFAULT 0,last_used INTEGER NOT NULL DEFAULT 0,detail TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS pool_candidates ON pool_wallets(enabled,next_check,last_used);
      CREATE TABLE IF NOT EXISTS pool_batches(
        id TEXT PRIMARY KEY,kind TEXT NOT NULL,token_id TEXT NOT NULL,rpc TEXT NOT NULL,owner TEXT NOT NULL,decimals INTEGER NOT NULL,
        amount TEXT NOT NULL,total INTEGER NOT NULL,group_size INTEGER NOT NULL,budget_sun TEXT NOT NULL,
        status TEXT NOT NULL,created_at TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS pool_jobs(
        id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,wallet_id TEXT NOT NULL,address TEXT NOT NULL,
        token TEXT NOT NULL,amount TEXT NOT NULL,raw_amount TEXT NOT NULL,wallet TEXT NOT NULL,rpc TEXT NOT NULL,
        asset_type TEXT NOT NULL DEFAULT 'TRC10',status TEXT NOT NULL DEFAULT 'queued',
        txid TEXT,signed_json TEXT,expiration INTEGER,reserved_fee TEXT NOT NULL DEFAULT '0',fee_sun TEXT,
        bandwidth TEXT,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pool_jobs_pending ON pool_jobs(status,wallet_id);
      CREATE INDEX IF NOT EXISTS pool_jobs_recipient ON pool_jobs(address,status);
      CREATE INDEX IF NOT EXISTS pool_jobs_funding ON pool_jobs(wallet,rpc,status);`);
    this.db.prepare("UPDATE pool_batches SET status='paused',detail='程序重新打开，请核查进度后继续' WHERE status='running'").run();
    this.timer = setInterval(() => this.reconcile().catch(() => {}), 5000); this.timer.unref();
  }
  config() { return effectiveConfig(this.getConfig()); }
  chain(config = this.config()) { return this.getChain({ ...config, assetType: 'TRC10', tokenContract: config.tokenId }); }
  log(level, message) { this.store.log(level, redact(message, this.getConfig())); }
  ownAddress(address) { return Boolean(this.db.prepare('SELECT 1 FROM pool_wallets WHERE address=?').get(address)) || address === walletAddress({ privateKey: this.getConfig().poolFundingKey }); }
  locked(address) {
    return Boolean(this.db.prepare("SELECT 1 FROM deliveries WHERE wallet=? AND status IN ('prepared','pending','uncertain','executed')").get(address)
      || this.db.prepare("SELECT 1 FROM pool_jobs WHERE address=? AND status IN ('prepared','pending','uncertain')").get(address));
  }
  backedUp() { return this.vault.exists && this.store.getMeta('poolBackupVerified') === this.vault.fingerprint(); }
  rememberToken(token) { this.store.setMeta('poolToken:' + token.contract, { decimals: token.decimals, symbol: token.symbol }); return token; }
  async tokenInfo() { return this.rememberToken(await this.chain().tokenInfo(this.config().tokenId)); }
  snapshot() {
    const totals = this.db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(active),0) active,
      COALESCE(SUM(active=0),0) inactive,COALESCE(SUM(enabled=1 AND active=1),0) enabled,
      COALESCE(SUM(enabled=1 AND active=1 AND token_id=? AND state='ready'),0) ready,
      COALESCE(SUM(enabled=1 AND active=1 AND token_id=? AND state='recovering'),0) recovering FROM pool_wallets`).get(this.config().tokenId, this.config().tokenId);
    return { ...totals, exists: this.vault.exists, unlocked: this.vault.unlocked, backedUp: this.backedUp(), running: this.running,
      progress: this.progress, referenceCapacity: totals.enabled * 2 };
  }
  wallets({ page = 1, search = '', state = '' } = {}) {
    const params = [], filters = [];
    if (search) { filters.push('(instr(address,?)>0 OR instr(id,?)>0 OR instr(batch_id,?)>0)'); params.push(String(search).slice(0, 100), String(search).slice(0, 100), String(search).slice(0, 100)); }
    if (state) { filters.push('state=?'); params.push(String(state)); }
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const total = this.db.prepare('SELECT COUNT(*) n FROM pool_wallets' + where).get(...params).n;
    page = Math.min(count(page, 1000000), Math.max(1, Math.ceil(total / 20)));
    const items = this.db.prepare('SELECT * FROM pool_wallets' + where + ' ORDER BY created_at,id LIMIT 20 OFFSET ?').all(...params, (page - 1) * 20);
    return { page, pages: Math.max(1, Math.ceil(total / 20)), total, items: items.map(w => {
      const token = this.store.getMeta('poolToken:' + w.token_id);
      return { ...w, balance: token ? formatUnits(w.raw_balance, token.decimals) : null, symbol: token?.symbol || '' };
    }) };
  }
  batches() {
    return this.db.prepare(`SELECT b.*,
      (SELECT COUNT(*) FROM pool_jobs j WHERE j.batch_id=b.id AND j.status='confirmed') confirmed,
      (SELECT COUNT(*) FROM pool_jobs j WHERE j.batch_id=b.id AND j.status IN ('prepared','pending','uncertain')) pending,
      (SELECT COUNT(*) FROM pool_jobs j WHERE j.batch_id=b.id AND j.status IN ('failed','expired')) failed
      FROM pool_batches b ORDER BY created_at DESC LIMIT 100`).all().map(b => {
        const fees = this.db.prepare('SELECT fee_sun FROM pool_jobs WHERE batch_id=?').all(b.id);
        return { ...b, feeTrx: formatUnits(fees.reduce((sum, r) => sum + BigInt(r.fee_sun || 0), 0n), 6), missingFees: fees.filter(r => r.fee_sun === null).length };
      });
  }
  unlock(password, initialize = false) {
    if (initialize) {
      if (this.snapshot().total) throw new Error('数据库已有钱包，请恢复原钱包库，不能新建覆盖');
      this.vault.initialize(password);
    } else this.vault.unlock(password);
    // A crash between the atomic encrypted save and the SQL commit leaves only
    // unfunded addresses. Recover their public metadata from the verified vault.
    this.store.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO pool_wallets(id,address,batch_id,created_at) VALUES(?,?,?,?)');
      for (const w of this.vault.require().data.wallets) insert.run(w.id, w.address, w.batchId, w.createdAt);
    });
    const saved = new Map(this.vault.require().data.wallets.map(w => [w.id, w.address]));
    for (const w of this.db.prepare('SELECT id,address FROM pool_wallets').all()) if (saved.get(w.id) !== w.address) { this.vault.lock(); throw new Error('密钥库与钱包数据库不完整匹配，请恢复同一套备份'); }
    return this.snapshot();
  }
  noteBackup(folder) { if (this.vault.exists) this.store.setMeta('poolBackupCandidate', folder); }
  verifyBackup(password) {
    const folder = this.store.getMeta('poolBackupCandidate');
    if (!folder) throw new Error('请先创建完整数据备份');
    const n = this.vault.verifyCopy(path.join(folder, 'pool-vault.json'), password);
    if (n !== this.snapshot().total) throw new Error('备份钱包数量不符');
    this.store.setMeta('poolBackupVerified', this.vault.fingerprint()); return { count: n, verified: true };
  }
  async generate(total) {
    total = count(total); const session = this.vault.require();
    if (this.running) throw new Error('钱包任务正在处理');
    this.running = true;
    const batchId = crypto.randomUUID(), now = new Date().toISOString(), wallets = [], seen = new Set(session.data.wallets.map(w => w.address));
    this.progress = { kind: 'generate', completed: 0, total };
    this.work = (async () => {
      for (let i = 0; i < total && this.running; i++) {
        let key, address;
        do { key = crypto.randomBytes(32).toString('hex'); address = walletAddress({ privateKey: key }); } while (!address || seen.has(address));
        seen.add(address); wallets.push({ id: crypto.randomUUID(), address, key, batchId, createdAt: now });
        this.progress.completed = i + 1; if (i % 25 === 0) await yieldTurn();
      }
      if (!wallets.length) return;
      session.data.wallets.push(...wallets);
      try { this.vault.save(); } catch (error) { session.data.wallets.splice(-wallets.length); throw error; }
      this.store.transaction(() => {
        const insert = this.db.prepare('INSERT INTO pool_wallets(id,address,batch_id,created_at) VALUES(?,?,?,?)');
        wallets.forEach(w => insert.run(w.id, w.address, w.batchId, w.createdAt));
      });
      this.log('info', `已本地生成 ${wallets.length} 个钱包，尚未激活；请先创建并验证完整备份`);
    })().catch(error => { this.progress.error = redact(error.message, this.getConfig()); this.log('error', '钱包生成未完成：' + this.progress.error); }).finally(() => { this.running = false; });
    return { batchId, total };
  }
  cache(wallet, resource, rawAmount = '1') {
    const eligible = resource.activated && resource.standardPermission && resource.balanceSun === '0' && !resource.stakedBandwidth;
    const state = !resource.activated ? 'inactive' : !eligible ? 'blocked' : BigInt(resource.rawBalance) < BigInt(rawAmount) ? 'low' : resource.freeBandwidth < 282 + this.config().bandwidthMargin ? 'recovering' : 'ready';
    const delay = state === 'recovering' ? Math.max(30000, Math.min(3600000, (282 + this.config().bandwidthMargin - resource.freeBandwidth) * 144000)) : state === 'ready' ? 0 : 300000;
    this.db.prepare(`UPDATE pool_wallets SET active=?,state=?,token_id=?,raw_balance=?,free_bandwidth=?,free_limit=?,checked_at=?,next_check=?,detail=? WHERE id=?`)
      .run(resource.activated ? 1 : 0, state, this.config().tokenId, resource.rawBalance, resource.freeBandwidth, resource.freeLimit || 600, resource.checkedAt, Date.now() + delay, state === 'blocked' ? '存在 TRX / 质押带宽或非标准权限，请复核' : '', wallet.id);
    return state;
  }
  async refresh(limit = 5) {
    const c = this.config(), chain = this.chain(c), token = this.rememberToken(await chain.tokenInfo());
    const amount = rawUnits(c.sendAmount, token.decimals);
    const wallets = this.db.prepare('SELECT * FROM pool_wallets ORDER BY checked_at,id LIMIT ?').all(Math.min(10, count(limit, 10)));
    for (const wallet of wallets) this.cache(wallet, await chain.inspectWallet(wallet.address), amount);
    return this.snapshot();
  }
  setEnabled(ids, enabled) {
    if (!Array.isArray(ids) || ids.length > 1000 || typeof enabled !== 'boolean') throw new Error('请选择有效的钱包');
    const update = this.db.prepare('UPDATE pool_wallets SET enabled=? WHERE id=?');
    this.store.transaction(() => ids.forEach(id => update.run(enabled ? 1 : 0, id))); return this.snapshot();
  }
  assertReady() {
    this.vault.require();
    if (!this.backedUp()) throw new Error('钱包库有未验证的备份，请先创建完整备份并验证密码');
    if (!this.snapshot().enabled) throw new Error('没有已启用的激活钱包，请先完成钱包准备');
  }
  async prepareDelivery(row, chain, decimals, existing, canSend = () => true) {
    this.vault.require();
    this.rememberToken(await chain.tokenInfo(row.token));
    if (existing) {
      await chain.checkFree(existing.wallet, existing.rawAmount, existing.bandwidth, row.token); return existing;
    }
    if (!await chain.account(row.address)) throw Object.assign(new Error('收款地址未激活，免费模式不代付激活费用'), { skipTarget: true });
    const amount = rawUnits(row.amount, decimals);
    const wallets = this.db.prepare(`SELECT * FROM pool_wallets w WHERE enabled=1 AND active=1 AND (next_check<=? OR token_id!=?)
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.wallet=w.address AND d.status IN ('prepared','pending','uncertain','executed'))
      AND NOT EXISTS(SELECT 1 FROM pool_jobs j WHERE j.address=w.address AND j.status IN ('prepared','pending','uncertain'))
      ORDER BY last_used,checked_at,id LIMIT 20`).all(Date.now(), row.token);
    let checked = 0;
    for (const wallet of wallets) {
      if (this.locked(wallet.address)) continue;
      if (++checked > 5) break;
      const r = await chain.inspectWallet(wallet.address, row.token);
      if (this.cache(wallet, r, amount) !== 'ready') continue;
      if (!canSend()) throw Object.assign(new Error('任务已暂停'), { cancelled: true });
      const prepared = await chain.buildNative(row, decimals, this.vault.get(wallet.id).key);
      // Re-read after building/signing; no signed transaction has been broadcast.
      try { this.cache(wallet, await chain.checkFree(wallet.address, amount, prepared.bandwidth, row.token), amount); }
      catch (error) { if (!error.resourceWait) throw error; this.db.prepare('UPDATE pool_wallets SET next_check=?,state=? WHERE id=?').run(Date.now() + 60000, 'recovering', wallet.id); continue; }
      this.db.prepare('UPDATE pool_wallets SET last_used=? WHERE id=?').run(Date.now(), wallet.id);
      return prepared;
    }
    throw waitError('暂无符合免费带宽和代币条件的钱包，继续监听并等待资源恢复');
  }
  async costs(chain) {
    const response = await chain.request(() => chain.tron.trx.getChainParameters());
    const params = new Map(response.map(p => [p.key, p.value]));
    const values = ['getCreateNewAccountFeeInSystemContract', 'getCreateAccountFee', 'getTransactionFee'].map(k => params.get(k));
    if (values.some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error('无法取得有效的激活和带宽费用参数');
    return { create: BigInt(values[0]), createBandwidth: BigInt(values[1]), perByte: BigInt(values[2]) };
  }
  async plan(input) {
    this.vault.require(); if (!this.backedUp()) throw new Error('请先创建完整备份并验证密码');
    const c = this.config(), chain = this.chain(c), owner = walletAddress({ privateKey: c.poolFundingKey });
    if (!owner || this.db.prepare('SELECT 1 FROM pool_wallets WHERE address=?').get(owner)) throw new Error('请配置独立的准备资金钱包，不能使用投放子钱包');
    if (!['activate', 'fund'].includes(input.kind)) throw new Error('准备类型无效');
    const total = count(input.count), groupSize = count(input.groupSize || 10, 50), token = this.rememberToken(await chain.tokenInfo());
    const rawAmount = rawUnits(String(input.amount), token.decimals), fees = await this.costs(chain);
    const wallets = this.db.prepare(`SELECT w.* FROM pool_wallets w WHERE active=? ${input.batchId ? 'AND batch_id=?' : ''}
      AND NOT EXISTS(SELECT 1 FROM pool_jobs j WHERE j.wallet_id=w.id AND j.status IN ('queued','prepared','pending','uncertain'))
      ORDER BY created_at,id LIMIT ?`).all(input.kind === 'activate' ? 0 : 1, ...(input.batchId ? [String(input.batchId)] : []), total);
    if (wallets.length !== total) throw new Error(`可供本次${input.kind === 'activate' ? '激活' : '补币'}的钱包只有 ${wallets.length} 个，请减少数量或先核查已有批次`);
    const estimated = BigInt(total) * (input.kind === 'activate' ? fees.create + fees.createBandwidth : fees.perByte * 350n);
    const budget = decimalUnits(String(input.budgetTrx), 6);
    if (budget < estimated) throw new Error(`总预算不能低于本批保守估算 ${formatUnits(estimated, 6)} TRX`);
    const funding = await chain.inspectWallet(owner, c.tokenId);
    if (!funding.activated || !funding.standardPermission) throw new Error('准备资金钱包未激活或不是标准单签名权限');
    if (BigInt(funding.rawBalance) < BigInt(rawAmount) * BigInt(total)) throw new Error('准备资金钱包代币余额不足本批总量');
    if (BigInt(funding.balanceSun) < budget) throw new Error('准备资金钱包 TRX 不足本次预算');
    this.planned = { id: crypto.randomUUID(), kind: input.kind, token, owner, wallets, total, groupSize, amount: String(input.amount), rawAmount,
      budget: budget.toString(), rpc: c.rpcUrl, confirmation: crypto.randomBytes(24).toString('hex'), expires: Date.now() + 120000, config: JSON.stringify(this.getConfig()) };
    return { ...this.planned, config: undefined, wallets: undefined, budgetTrx: formatUnits(budget, 6), estimatedTrx: formatUnits(estimated, 6), totalAmount: formatUnits(BigInt(rawAmount) * BigInt(total), token.decimals) };
  }
  startPlanned(confirmation) {
    const p = this.planned;
    if (!p || p.confirmation !== confirmation || p.expires < Date.now() || p.config !== JSON.stringify(this.getConfig())) throw new Error('准备确认已过期，请重新预检');
    this.planned = null;
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.db.prepare('INSERT INTO pool_batches(id,kind,token_id,rpc,owner,decimals,amount,total,group_size,budget_sun,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(p.id, p.kind, p.token.contract, p.rpc, p.owner, p.token.decimals, p.amount, p.total, p.groupSize, p.budget, 'paused', now);
      const insert = this.db.prepare('INSERT INTO pool_jobs(id,batch_id,wallet_id,address,token,amount,raw_amount,wallet,rpc,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const wallet of p.wallets) insert.run(crypto.randomUUID(), p.id, wallet.id, wallet.address, p.token.contract, p.amount, p.rawAmount, p.owner, p.rpc, now);
    });
    this.resume(p.id); return { id: p.id };
  }
  resume(id) {
    if (this.running) throw new Error('已有钱包准备任务');
    this.vault.require(); if (!this.backedUp()) throw new Error('请先验证完整备份');
    const batch = this.db.prepare('SELECT * FROM pool_batches WHERE id=?').get(id), c = this.config();
    if (!batch || batch.rpc !== c.rpcUrl || batch.token_id !== c.tokenId || batch.owner !== walletAddress({ privateKey: c.poolFundingKey })) throw new Error('批次与当前代币、节点或资金钱包不一致，请恢复原设置');
    this.running = true; this.progress = { kind: batch.kind, batchId: id, total: batch.total, completed: 0 };
    this.db.prepare("UPDATE pool_batches SET status='running',detail='' WHERE id=?").run(id);
    this.work = this.runBatch(batch).catch(error => {
      const message = redact(error.message, c); this.db.prepare("UPDATE pool_batches SET status='paused',detail=? WHERE id=?").run(message, id); this.progress.error = message; this.log('warn', '准备批次已暂停：' + message);
    }).finally(() => { this.running = false; this.db.prepare("UPDATE pool_batches SET status='paused' WHERE id=? AND status='running'").run(id); });
  }
  async runBatch(batch) {
    const c = this.config(), chain = this.chain(c);
    await chain.tokenInfo(batch.token_id);
    while (this.running) {
      const pending = this.db.prepare("SELECT COUNT(*) n FROM pool_jobs WHERE batch_id=? AND status IN ('prepared','pending','uncertain')").get(batch.id).n;
      if (pending >= batch.group_size) { await this.reconcile(); if (this.running) await sleep(1000); continue; }
      const row = this.db.prepare("SELECT * FROM pool_jobs WHERE batch_id=? AND status='queued' ORDER BY created_at,id LIMIT 1").get(batch.id);
      if (!row) { this.db.prepare('UPDATE pool_batches SET status=? WHERE id=?').run(pending ? 'confirming' : 'completed', batch.id); break; }
      const recipient = await chain.account(row.address), funding = await chain.inspectWallet(batch.owner, batch.token_id);
      if (!funding.activated || !funding.standardPermission) throw new Error('资金钱包权限或激活状态发生变化');
      if (!recipient && batch.kind !== 'activate') throw new Error('补币目标未激活，请先使用激活流程');
      const prepared = await chain.buildNative(row, batch.decimals, c.poolFundingKey), fees = await this.costs(chain);
      const reserve = !recipient ? fees.create + fees.createBandwidth : fees.perByte * BigInt(prepared.bandwidth);
      const jobs = this.db.prepare('SELECT fee_sun,reserved_fee,status,raw_amount FROM pool_jobs WHERE batch_id=?').all(batch.id);
      const used = jobs.reduce((sum, j) => sum + BigInt(j.fee_sun ?? j.reserved_fee), 0n);
      const held = this.db.prepare("SELECT token,raw_amount,reserved_fee FROM pool_jobs WHERE wallet=? AND rpc=? AND status IN ('prepared','pending','uncertain')").all(batch.owner, batch.rpc);
      const reservedTokens = held.filter(j => j.token === row.token).reduce((sum, j) => sum + BigInt(j.raw_amount), 0n);
      const reservedFees = held.reduce((sum, j) => sum + BigInt(j.reserved_fee), 0n);
      if (used + reserve > BigInt(batch.budget_sun)) throw new Error('继续发送将超过本批总预算，已保留进度');
      if (BigInt(funding.balanceSun) < reserve + reservedFees || BigInt(funding.rawBalance) < BigInt(row.raw_amount) + reservedTokens) throw new Error('资金钱包余额不足或已有待确认占用，已保留进度');
      if (!this.running) break;
      this.db.prepare("UPDATE pool_jobs SET status='prepared',txid=?,signed_json=?,expiration=?,reserved_fee=? WHERE id=?")
        .run(prepared.txid, JSON.stringify(prepared.signed), prepared.signed.raw_data.expiration, reserve.toString(), row.id);
      if (!this.running) break;
      let accepted = false, detail = '';
      try { accepted = (await chain.broadcast(prepared.signed))?.result === true; }
      catch (error) { detail = redact(error.message, c); }
      this.db.prepare('UPDATE pool_jobs SET status=?,detail=? WHERE id=?').run(accepted ? 'pending' : 'uncertain', accepted ? '已广播，后台核查' : '广播结果不明，只核查原交易。' + detail, row.id);
      this.progress.completed++;
      await this.reconcile();
      if (this.running) await sleep(1000);
    }
  }
  reconcile() {
    if (this.checking || this.closed) return this.checking || Promise.resolve();
    this.checking = (async () => {
      const rows = this.db.prepare("SELECT * FROM pool_jobs WHERE status IN ('prepared','pending','uncertain') ORDER BY created_at,id").all();
      const offset = (this.checkOffset || 0) % Math.max(1, rows.length), batch = rows.slice(offset).concat(rows.slice(0, offset)).slice(0, 3); this.checkOffset = offset + batch.length;
      for (const row of batch) {
        const chain = this.chain({ ...this.config(), tokenId: row.token, rpcUrl: row.rpc });
        try {
          const info = await chain.deliveryReceipt(row, true);
          if (!info?.id) {
            if (Date.now() > row.expiration && await chain.replacementReady(row.txid, row.expiration)) this.db.prepare("UPDATE pool_jobs SET status='expired',reserved_fee='0',fee_sun='0',detail='已确认过期未上链，可重新规划此钱包' WHERE id=?").run(row.id);
            continue;
          }
          const fee = info.fee ?? 0;
          if (!Number.isSafeInteger(fee) || fee < 0) throw new Error('准备交易费用未明确');
          const success = info.receipt.result === 'SUCCESS';
          this.store.transaction(() => {
            this.db.prepare('UPDATE pool_jobs SET status=?,fee_sun=?,bandwidth=?,detail=? WHERE id=?')
              .run(success ? 'confirmed' : 'failed', String(fee), String(info.receipt.net_usage ?? 0), info.receipt.result, row.id);
            if (success) this.db.prepare("UPDATE pool_wallets SET active=1,enabled=1,state='checking',next_check=0 WHERE id=?").run(row.wallet_id);
          });
        } catch (error) { this.db.prepare('UPDATE pool_jobs SET detail=? WHERE id=?').run(redact(error.message, this.getConfig()), row.id); if (isRateLimitError(error)) break; }
      }
      this.db.prepare(`UPDATE pool_batches SET status='completed' WHERE status IN ('confirming','paused')
        AND NOT EXISTS(SELECT 1 FROM pool_jobs j WHERE j.batch_id=pool_batches.id AND j.status NOT IN ('confirmed','failed','expired'))`).run();
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  async stop() { this.running = false; await this.work; }
  async close() { this.closed = true; clearInterval(this.timer); await this.stop(); await this.checking; this.vault.lock(); }
}
module.exports = { WalletPool, count };
