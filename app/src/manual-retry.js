'use strict';
const crypto = require('node:crypto');
const { Trx } = require('tronweb');
const { Chain, checkedTransactionExpiration } = require('./chain');
const { decimalUnits, formatUnits, walletAddress, redact } = require('./config');
const key = id => 'delivery-manual-retry:' + id;
const reviewKey = id => 'delivery-manual-retry-review:' + id;
const historyKey = id => 'delivery-manual-retry-history:' + id;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const sun = value => /^(0|[1-9]\d*)$/.test(String(value));

function markerCanRecheck(store, row, marker) {
  if (marker == null) return true;
  if (typeof marker !== 'object' || Array.isArray(marker)) return false;
  const saved = store.energyOrder(row.id);
  if (!['uncertain', 'stopped'].includes(marker.phase) || row.status !== 'failed'
    || !saved || saved.resolved !== 1 || saved.transaction_status !== 'not_broadcast' || saved.billing_status !== 'released') return false;
  if (marker.txid != null) {
    const latest = store.deliveryAttempts(row.id).at(-1), txid = marker.txid;
    if (typeof txid !== 'string' || !/^[a-f\d]{64}$/i.test(txid)
      || txid.toLowerCase() !== row.txid?.toLowerCase() || txid.toLowerCase() !== saved.txid?.toLowerCase()
      || txid.toLowerCase() !== latest?.txid?.toLowerCase()) return false;
  }
  return true;
}

function manualRetryState(store, row) {
  const marker = store.getMeta(key(row.id)), review = store.getMeta(reviewKey(row.id));
  const candidate = row.mode === 'live' && row.asset_type === 'TRC20' && row.status === 'failed' && Boolean(store.energyOrder(row.id));
  const canPrepare = candidate && markerCanRecheck(store, row, marker);
  return { canPrepare, phase: marker?.phase || (candidate ? 'unreviewed' : 'unavailable'),
    reason: canPrepare && marker ? review?.reason || '上轮补发已停止且平台记录为未广播；请重新检查全部旧签名，再单独确认本轮补发'
      : marker?.reason || review?.reason || (candidate ? '可核查本笔补发资格；核查通过后需单独确认' : '仅支持平台明确取消且从未广播的失败记录'),
    checkedAt: review?.checkedAt || null };
}

class ManualRetry {
  constructor(engine) { this.engine = engine; this.store = engine.store; this.generation = 0; this.preview = null; }
  cancel() { this.generation++; this.preview = null; }
  context() { return { generation: this.generation, config: JSON.stringify(this.engine.getConfig()) }; }
  current(context) {
    check(!this.engine.closed && context.generation === this.generation && context.config === JSON.stringify(this.engine.getConfig()),
      '操作已暂停、设置已改变或窗口正在退出，请重新核查；不会继续签名或提交');
  }
  async guarded(fn) {
    const e = this.engine;
    check(!e.closed && !e.running && !e.busy && !e.activeDeliveryId && !e.energyRecovery
      && !['starting', 'running', 'stopping'].includes(e.state), '请先暂停投放并取消自动恢复，等待当前处理完成');
    const context = this.context(); e.busy = true; e.reconciling = true;
    try { await e.confirmationPass; await e.statisticsPass; this.current(context); return await fn(context); }
    finally { e.activeDeliveryId = null; e.busy = false; e.reconciling = false; }
  }
  history(row) {
    return this.store.db.prepare("SELECT * FROM deliveries WHERE mode='live' AND address=? AND token=? ORDER BY created_at,id").all(row.address, row.token);
  }
  markerSnapshot(id) {
    return JSON.stringify({ marker: this.store.getMeta(key(id)), history: this.store.getMeta(historyKey(id)) });
  }
  checkMarkerSnapshot(id, snapshot) {
    check(this.markerSnapshot(id) === snapshot, '本笔补发轮次或历史已变化，请重新核查');
  }
  fingerprint(row) {
    return crypto.createHash('sha256').update(JSON.stringify({ rows: this.history(row).map(r => ({ row: r,
      energy: this.store.energyOrder(r.id), attempts: this.store.deliveryAttempts(r.id), review: this.store.getMeta('delivery-review:' + r.id),
      receipt: this.store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(r.id),
      skippedRetry: ['skipped', 'skipped_restart'].includes(r.status) ? this.store.db.prepare('SELECT attempts FROM delivery_retry WHERE delivery_id=?').get(r.id) : null,
      otherManual: r.id === row.id ? null : this.store.getMeta(key(r.id)),
      otherManualHistory: r.id === row.id ? null : this.store.getMeta(historyKey(r.id)) })),
      legacyAddress: this.store.db.prepare('SELECT 1 FROM legacy_addresses WHERE address=?').get(row.address),
      legacyCleared: this.store.getMeta('legacyAddressesClearedAt'),
      legacyTrigger: this.store.db.prepare('SELECT 1 FROM legacy_transactions WHERE txid=?').get(row.source_tx) })).digest('hex');
  }
  summary(row, selected) {
    return { id: row.id, status: row.status, amount: row.amount, txid: row.txid, source_tx: row.source_tx,
      created_at: row.created_at, dedupe_cleared_at: row.dedupe_cleared_at,
      intent_id: this.store.energyOrder(row.id)?.intent_id || null,
      relation: row.id === selected.id ? 'selected' : 'same_recipient', outcome: 'unchecked', reason: '' };
  }
  validateOrder(order, row, saved) {
    check(order && order.id && (!saved.order_id || order.id === saved.order_id) && order.intent_id === saved.intent_id
      && order.address === row.wallet && order.contract === row.token && order.recipient === row.address
      && order.amount_raw === row.raw_amount, '平台原订单的钱包、收款人、合约、金额或请求号不一致');
    check(order.status === 'cancelled' && order.tx_status === 'not_broadcast' && order.broadcast_started === false
      && order.txid == null && order.service_status === 'not_delivered' && order.billing_status === 'released',
    '平台未证明原单已取消、从未广播且已释放费用，只能继续查询原交易');
    check(sun(order.charge_sun), '平台原订单价格无效');
    return order;
  }
  async oldRecord(row, config, context) {
    const saved = this.store.energyOrder(row.id), attempts = this.store.deliveryAttempts(row.id);
    check(row.status === 'failed', '同地址历史存在成功、执行中或未知记录，不能补发');
    check(saved && saved.platform_origin === config.platformUrl && saved.device_id === config.platformDeviceId
      && saved.resolved === 1 && saved.transaction_status === 'not_broadcast' && saved.billing_status === 'released',
    '失败记录缺少同平台已释放且从未广播的证据，不能补发');
    check(!this.store.getMeta('delivery-review:' + row.id)?.evidence?.some(e => ['success', 'executed', 'conflict'].includes(e.kind)),
      '历史核查保留了成功或冲突证据，不能补发');
    const hashes = new Set(attempts.map(a => a.txid?.toLowerCase()));
    const receipt = this.store.db.prepare('SELECT * FROM delivery_receipts WHERE delivery_id=?').get(row.id);
    // Empty/failed statistics lookups persist scheduling rows in this table.
    // Only their known shape is a placeholder; even an all-null real receipt
    // has checked_at, and zero resource usage is still on-chain evidence.
    const backfillOnly = receipt && receipt.checked_at === null
      && ['block_time', 'energy', 'fee_sun', 'bandwidth'].every(field => receipt[field] === null)
      && Number.isSafeInteger(receipt.attempts) && receipt.attempts > 0
      && Number.isSafeInteger(receipt.retry_after) && receipt.retry_after > 0
      && /^[a-f\d]{64}$/i.test(receipt.txid) && hashes.has(receipt.txid.toLowerCase());
    check((!receipt || backfillOnly)
      && !attempts.some(a => a.block_time != null || a.energy != null || a.fee_sun != null || a.bandwidth != null),
    '本机已保存链上回执或消耗证据，与从未广播结论冲突，不能补发');
    check((!row.txid && !attempts.length) || (row.txid && hashes.has(row.txid.toLowerCase())), '原签名历史缺失，不能按未广播处理');
    const marker = this.store.getMeta(key(row.id)), archived = this.store.getMeta(historyKey(row.id));
    check(archived == null || Array.isArray(archived), '本笔补发历史无效，保留原记录');
    for (const previous of archived || []) {
      check(previous && typeof previous === 'object' && !Array.isArray(previous)
        && ['uncertain', 'stopped'].includes(previous.phase), '历史补发轮次仍在处理中或阶段不明，不能补发');
    }
    // Version 1.3.2 had no run_id and only recorded txid after persisting
    // a new signature. Keep those shapes valid, but never lose a signature
    // already referenced by the current marker or an archived round.
    for (const previous of [...(archived || []), ...(marker == null ? [] : [marker])]) {
      check(previous && typeof previous === 'object' && !Array.isArray(previous), '本笔补发标记无效，保留原记录');
      for (const field of ['txid', 'original_txid']) {
        const txid = previous[field];
        if (txid == null || txid === '') continue;
        check(typeof txid === 'string' && /^[a-f\d]{64}$/i.test(txid) && hashes.has(txid.toLowerCase()),
          '补发轮次记载的旧签名历史缺失或无效，不能补发');
      }
    }
    const order = this.validateOrder(await this.engine.energyPolicy.client().byIntent(saved.intent_id), row, saved); this.current(context);
    const chain = this.engine.getChain({ ...config, tokenContract: row.token, rpcUrl: row.rpc || config.rpcUrl });
    for (const attempt of attempts) {
      check(['cancelled', 'not_broadcast', 'expired'].includes(attempt.status), '旧尝试包含成功、执行失败或未知状态，不能补发');
      check(attempt.signed_json && (!attempt.wallet || attempt.wallet === row.wallet), '旧签名或发送钱包记录缺失/冲突');
      let signed, expiration;
      try {
        signed = JSON.parse(attempt.signed_json); expiration = checkedTransactionExpiration(attempt.txid, signed);
        check(expiration === attempt.expiration && Trx.ecRecover(signed) === row.wallet, '旧签名或有效期不一致');
        Chain.prototype.validateTransaction.call({ wallet: row.wallet, config: { feeLimitTrx: formatUnits(String(signed.raw_data.fee_limit), 6) } }, row, signed, row.raw_amount);
      } catch { throw new Error('旧签名参数、哈希或钱包验证失败，保留原记录'); }
      check(await chain.replacementReady(attempt.txid, expiration), '旧交易尚未确认过期未上链，或节点仍有交易记录'); this.current(context);
    }
    return order;
  }
  async inspect(id, context) {
    const row = this.store.get(id); check(row, '未找到这条投放记录');
    const markerSnapshot = this.markerSnapshot(id);
    const config = this.engine.getConfig(), histories = this.history(row).map(r => this.summary(r, row));
    const result = { eligible: false, reason: '', sender: row.wallet, recipient: row.address, contract: row.token,
      amount: row.amount, serviceFeeSun: null, feeLimitSun: null, histories };
    try {
      check(markerCanRecheck(this.store, row, this.store.getMeta(key(id))),
        '上轮补发仍在处理中、结果未核实或签名历史不匹配；只能核查原结果');
      check(row.mode === 'live' && row.asset_type === 'TRC20' && row.status === 'failed' && !row.dedupe_cleared_at,
        '仅允许保留去重的正式 TRC20 平台未广播失败记录');
      check(config.assetType === 'TRC20' && this.engine.energyPolicy?.linked() && config.tokenContract === row.token
        && walletAddress(config) === row.wallet && config.platformWallet === row.wallet, '当前钱包、合约或平台绑定与原记录不符');
      check(!config.blacklist.includes(row.address) && row.address !== row.wallet, '收款人在黑名单中或等于发送钱包');
      check(!this.store.pending().length && !this.store.unresolvedEnergyOrders().length, '仍有待核查交易或平台订单，请先处理原单');
      check(!this.store.db.prepare('SELECT 1 FROM legacy_addresses WHERE address=?').get(row.address)
        || this.store.getMeta('legacyAddressesClearedAt'), '旧版地址去重仍保留，不能忽略旧投放记录');
      check(!this.store.db.prepare('SELECT 1 FROM legacy_transactions WHERE txid=?').get(row.source_tx), '原触发交易有旧版去重记录，需人工核对');
      const before = this.fingerprint(row), records = this.history(row);
      let selectedOrder;
      for (let i = 0; i < records.length; i++) {
        const r = records[i], summary = histories[i];
        try {
          if (r.id !== id && ['skipped', 'skipped_restart'].includes(r.status)) {
            const retry = this.store.db.prepare('SELECT attempts FROM delivery_retry WHERE delivery_id=?').get(r.id);
            check(!r.txid && r.dedupe_cleared_at && !this.store.deliveryAttempts(r.id).length
              && !this.store.db.prepare('SELECT 1 FROM delivery_receipts WHERE delivery_id=?').get(r.id)
              && !this.store.energyOrder(r.id) && (retry?.attempts ?? 0) === 0
              && !this.store.getMeta(key(r.id)) && !this.store.getMeta(historyKey(r.id))
              && !this.store.getMeta('delivery-review:' + r.id)?.evidence?.length,
            '已略过历史仍有关联签名、回执、订单或去重证据，不能按未发送处理');
            summary.outcome = 'never_signed'; summary.reason = '旧记录重启时已略过且去重已解除；无签名、交易、回执或平台订单'; continue;
          }
          check(r.wallet === row.wallet && r.asset_type === 'TRC20' && r.raw_amount, '同地址历史的钱包或原始金额未知，需人工核对');
          const order = await this.oldRecord(r, config, context);
          summary.outcome = 'not_broadcast_expired'; summary.reason = '平台明确未广播且旧签名均已过期未上链';
          if (r.id === id) selectedOrder = order;
        } catch (error) { summary.outcome = 'blocked'; summary.reason = redact(error.message, config); throw error; }
      }
      check(selectedOrder, '原订单未完整核对');
      const chain = this.engine.getChain(config), token = await chain.tokenInfo(); this.current(context);
      check(token.contract === row.token && decimalUnits(row.amount, token.decimals).toString() === row.raw_amount,
        '原数量与链上代币精度不一致');
      check(token.rawBalance != null && BigInt(token.rawBalance) >= BigInt(row.raw_amount), '广告代币余额不足本笔补发');
      const client = this.engine.energyPolicy.client();
      this.engine.energyPolicy.accept(await client.policy()); this.current(context);
      check(this.engine.energyPolicy.requireMode() === 'seamless', '当前未处于稳定的无感能量模式');
      const policy = this.engine.energyPolicy.value;
      check(sun(policy.max_fee_limit_sun) && BigInt(policy.max_fee_limit_sun) > 0n, '平台执行费用上限无效');
      const localCap = decimalUnits(config.feeLimitTrx, 6), remoteCap = BigInt(policy.max_fee_limit_sun);
      check(localCap > 0n, '本地执行费用上限无效');
      check(this.fingerprint(this.store.get(id)) === before, '核查期间历史发生变化，请重新核查');
      this.checkMarkerSnapshot(id, markerSnapshot);
      result.eligible = true; result.reason = '已核实原单取消且从未广播，旧签名已过期；仅补发本笔，历史与去重保留';
      result.serviceFeeSun = String(selectedOrder.charge_sun); result.feeLimitSun = String(localCap < remoteCap ? localCap : remoteCap);
      return { result, row, fingerprint: before, markerSnapshot, decimals: token.decimals, revision: policy.revision, order: selectedOrder };
    } catch (error) { result.reason = redact(error.message, config); return { result, row }; }
  }
  prepare(id) {
    return this.guarded(async context => {
      this.preview = null;
      const inspected = await this.inspect(id, context); this.current(context);
      const { result } = inspected;
      if (result.eligible) {
        this.checkMarkerSnapshot(id, inspected.markerSnapshot);
        result.confirmationToken = crypto.randomBytes(24).toString('hex'); result.expiresAt = new Date(Date.now() + 60000).toISOString();
        this.preview = { ...inspected, context, token: result.confirmationToken, expires: Date.parse(result.expiresAt) };
      }
      this.store.setMeta(reviewKey(id), { checkedAt: new Date().toISOString(), reason: result.reason });
      return { record: this.store.record(id), retry: result };
    });
  }
  retry(id, input) {
    return this.guarded(async context => {
      const preview = this.preview; this.preview = null;
      check(input.confirmed === true && preview && preview.row.id === id && input.confirmationToken === preview.token
        && preview.expires > Date.now(), '补发确认已过期或已使用，请重新核查');
      this.current(preview.context);
      this.checkMarkerSnapshot(id, preview.markerSnapshot);
      check(this.fingerprint(this.store.get(id)) === preview.fingerprint, '原记录或同地址历史已变化，请重新核查');
      const inspected = await this.inspect(id, context); this.current(context);
      check(preview.expires > Date.now(), '补发确认已过期，请重新核查');
      check(inspected.result.eligible, inspected.result.reason);
      check(inspected.markerSnapshot === preview.markerSnapshot, '本笔补发轮次已变化，请重新核查并确认');
      check(inspected.revision === preview.revision && inspected.result.serviceFeeSun === preview.result.serviceFeeSun
        && inspected.result.feeLimitSun === preview.result.feeLimitSun, '模式、价格或执行费用上限已变化，请重新核查并确认');
      const row = inspected.row, config = this.engine.getConfig(), client = this.engine.energyPolicy.client();
      const marker = { run_id: crypto.randomUUID(), phase: 'admission_started', at: new Date().toISOString(), reason: '本轮手动补发已开始，单次签名和提交；中断后仅核查原结果', original_txid: row.txid };
      this.store.transaction(() => {
        this.checkMarkerSnapshot(id, inspected.markerSnapshot);
        check(this.fingerprint(this.store.get(id)) === inspected.fingerprint, '本笔原记录已变化，请重新核查');
        const previous = this.store.getMeta(key(id)), history = this.store.getMeta(historyKey(id));
        check(history == null || Array.isArray(history), '本笔补发历史无效，保留原记录');
        check(markerCanRecheck(this.store, this.store.get(id), previous), '本笔上轮补发尚未完成核对');
        if (previous) this.store.setMeta(historyKey(id), [...(history || []), previous]);
        this.store.setMeta(key(id), marker); this.store.exhaustRetry(row);
      });
      // The selected marker is excluded from the delivery fingerprint because
      // its phase changes during this round. Guard it separately, including
      // the archived rounds, so another process cannot replace this round.
      let activeMarkerSnapshot = this.markerSnapshot(id);
      const saveMarker = () => {
        this.checkMarkerSnapshot(id, activeMarkerSnapshot);
        check(this.store.getMeta(key(id))?.run_id === marker.run_id, '本轮补发标记已变化，停止后续处理');
        this.store.setMeta(key(id), marker); activeMarkerSnapshot = this.markerSnapshot(id);
      };
      this.engine.activeDeliveryId = id;
      let prepared;
      try {
        const admission = await client.admit({ intent_id: inspected.order.intent_id, policy_revision: inspected.revision,
          contract_address: row.token, recipient_address: row.address, amount_raw: row.raw_amount }); this.current(context);
        check(admission.intent_id === inspected.order.intent_id && admission.order_id === inspected.order.id && admission.status === 'admitted'
          && admission.policy_revision === inspected.revision && admission.admission_id && Date.parse(admission.expires_at) > Date.now()
          && String(admission.price_sun) === inspected.result.serviceFeeSun, '平台准入参数、价格或有效期变化，未签名');
        marker.phase = 'signing_started'; saveMarker();
        const signing = this.engine.getChain({ ...config, tokenContract: row.token, feeLimitTrx: formatUnits(inspected.result.feeLimitSun, 6) });
        prepared = await signing.buildAndSign(row, inspected.decimals, { beforeSign: () => {
          this.current(context);
          this.checkMarkerSnapshot(id, activeMarkerSnapshot);
          check(preview.expires > Date.now() && Date.parse(admission.expires_at) > Date.now()
            && this.engine.energyPolicy.requireMode() === 'seamless' && this.engine.energyPolicy.value.revision === inspected.revision,
          '确认或准入已过期、策略已变化，尚未签名');
        } });
        // Persist the only new signature even if stop arrived during signing.
        check(prepared.wallet === row.wallet && prepared.rawAmount === row.raw_amount
          && checkedTransactionExpiration(prepared.txid, prepared.signed) === prepared.signed.raw_data.expiration
          && Trx.ecRecover(prepared.signed) === row.wallet, '新签名交易验证失败，不提交');
        Chain.prototype.validateTransaction.call(signing, row, prepared.signed, row.raw_amount);
        this.store.transaction(() => {
          this.checkMarkerSnapshot(id, activeMarkerSnapshot);
          check(this.fingerprint(this.store.get(id)) === inspected.fingerprint, '签名期间原记录已变化，不提交');
          this.store.beginAttempt(row); this.store.prepareAttempt(row, prepared, false); this.store.exhaustRetry(this.store.get(id));
          this.store.updateEnergyOrder(id, { admission_id: admission.admission_id, order_id: inspected.order.id,
            price_sun: inspected.result.serviceFeeSun, submitted: 1, resolved: 0, txid: prepared.txid,
            transaction_status: 'unknown', billing_status: 'not_reserved', service_status: 'unknown', customer_fee_sun: null,
            detail: '手动单笔补发已保存唯一签名；只查询原订单，不重发' });
          this.store.update(id, 'uncertain', { detail: '手动补发签名已保存，提交结果待核对；不会自动重发' });
          marker.phase = 'prepared'; marker.txid = prepared.txid; saveMarker();
        });
        this.current(context);
        check(Date.parse(admission.expires_at) > Date.now() && prepared.signed.raw_data.expiration >= Date.now() + 30000
          && this.engine.energyPolicy.requireMode() === 'seamless' && this.engine.energyPolicy.value.revision === inspected.revision,
        '签名或准入已过期、策略已变化，保留交易只核查，不提交');
        marker.phase = 'submit_started'; saveMarker();
        // No gateway retry loop, including explicit capacity waits.
        let order;
        try { order = await client.submit({ admission_id: admission.admission_id, txid: prepared.txid, signed_transaction: prepared.signed }); }
        catch (error) { this.engine.recordEnergySubmitError(id, error); throw error; }
        this.engine.acceptEnergyOrder(id, order);
        marker.phase = 'submitted'; marker.reason = '本笔已提交，等待链上确认及费用核对；不会再次签名或提交';
      } catch (error) {
        marker.phase = prepared ? 'uncertain' : 'stopped'; marker.reason = redact(error.message, config) + '；补发流程已停止，不自动重试';
      }
      saveMarker();
      this.engine.log('info', '手动补发记录 ' + id + '：' + marker.reason);
      return this.store.record(id);
    });
  }
}
module.exports = { ManualRetry, manualRetryState };
