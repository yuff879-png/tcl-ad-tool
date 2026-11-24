'use strict';
const { TronWeb, utils } = require('tronweb');
const { decimalUnits, formatUnits, walletAddress } = require('./config');
const { nodeReason, FINALITY_MARGIN_MS } = require('./delivery-retry');
const { NodeAccess, RequestQueue, PUBLIC_RPC, isPublicRpc, isRateLimitError } = require('./node-access');
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizedHex(value) { return String(value || '').replace(/^0x/i, '').replace(/^41(?=[a-f\d]{40}$)/i, '').toLowerCase(); }
function checkedTransactionExpiration(txid, transaction) {
  const invalid = () => Object.assign(new Error('原交易哈希、原始数据或有效期不匹配，继续保留待核查'), { reviewConflict: true });
  const raw = transaction?.raw_data;
  if (!/^[a-f\d]{64}$/i.test(txid || '') || !transaction || typeof transaction !== 'object' || Array.isArray(transaction)
    || typeof transaction.txID !== 'string' || transaction.txID.toLowerCase() !== txid.toLowerCase()
    || !raw || typeof raw !== 'object' || Array.isArray(raw)
    || !Number.isSafeInteger(raw.timestamp) || raw.timestamp <= 0
    || !Number.isSafeInteger(raw.expiration) || raw.expiration <= raw.timestamp || raw.expiration - raw.timestamp > 86400000
    || !Array.isArray(raw.contract) || raw.contract.length !== 1
    || typeof transaction.raw_data_hex !== 'string' || !/^(?:[a-f\d]{2})+$/i.test(transaction.raw_data_hex)) throw invalid();
  try { if (!utils.transaction.txCheck(transaction)) throw invalid(); }
  catch { throw invalid(); }
  return raw.expiration;
}
function transferEvents(info, token, wallet, recipient, amount) {
  const contract = normalizedHex(TronWeb.address.toHex(token));
  const from = normalizedHex(TronWeb.address.toHex(wallet));
  const to = normalizedHex(TronWeb.address.toHex(recipient));
  let delivered = 0n;
  for (const entry of info.log || []) {
    if (normalizedHex(entry.address) !== contract || entry.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (entry.topics[1]?.slice(-40).toLowerCase() !== from || entry.topics[2]?.slice(-40).toLowerCase() !== to) continue;
    if (!/^[a-f\d]{64}$/i.test(entry.data || '')) continue;
    delivered += BigInt('0x' + entry.data);
  }
  return delivered === BigInt(amount) && delivered > 0n;
}
function decodeCandidates(block, config) {
  const watch = new Set(config.watchedAddresses), output = [];
  for (const tx of block.transactions || []) {
    if (!/^[a-f\d]{64}$/i.test(tx.txID || '') || !tx.ret?.length || tx.ret.some(r => r.contractRet !== 'SUCCESS')) continue;
    for (const entry of tx.raw_data?.contract || []) {
      const value = entry.parameter?.value;
      if (!value) continue;
      try {
        let from, to, raw, asset, threshold;
        if (entry.type === 'TransferContract' && config.watchTrx) {
          from = TronWeb.address.fromHex(value.owner_address); to = TronWeb.address.fromHex(value.to_address);
          // JSON numbers beyond the safe integer range cannot be recovered accurately.
          if (typeof value.amount === 'number' && !Number.isSafeInteger(value.amount)) continue;
          raw = BigInt(value.amount); asset = 'TRX'; threshold = config.minTrx;
        } else if (entry.type === 'TriggerSmartContract' && config.watchUsdt) {
          if (TronWeb.address.fromHex(value.contract_address) !== config.usdtContract) continue;
          const data = value.data || '';
          if (!/^a9059cbb[0-9a-f]{128}$/i.test(data) || !/^0{24}$/i.test(data.slice(8, 32))) continue;
          from = TronWeb.address.fromHex(value.owner_address);
          to = TronWeb.address.fromHex('41' + data.slice(32, 72));
          raw = BigInt('0x' + data.slice(72, 136)); asset = 'USDT'; threshold = config.minUsdt;
        } else continue;
        if (!TronWeb.isAddress(from) || !TronWeb.isAddress(to)) continue;
        if ((watch.has(from) || watch.has(to)) && raw >= decimalUnits(threshold, 6)) {
          output.push({ from, to, txid: tx.txID, asset, amount: formatUnits(raw, 6), raw: raw.toString() });
        }
      } catch { /* A malformed chain entry cannot stop the rest of the block. */ }
    }
  }
  return output;
}
class Chain {
  constructor(config, { createClient = options => new TronWeb(options), ...accessOptions } = {}) {
    this.config = structuredClone(config);
    this.access = new NodeAccess(config, accessOptions);
    // A private key is deliberately not attached to the RPC client.
    this.primaryTron = createClient({ fullHost: config.rpcUrl, headers: config.apiKey ? { 'TRON-PRO-API-KEY': config.apiKey } : {}, timeout: 15000 });
    this.publicTron = isPublicRpc(config.rpcUrl) && config.apiKey
      ? createClient({ fullHost: PUBLIC_RPC, headers: {}, timeout: 15000 }) : this.primaryTron;
    this.wallet = walletAddress(config);
    for (const client of new Set([this.primaryTron, this.publicTron])) {
      if (this.wallet) client.setAddress(this.wallet);
      else if (TronWeb.isAddress(config.tokenContract)) client.setAddress(config.tokenContract);
    }
    // A constant call still needs owner_address. The public contract is only a
    // read-only caller when no wallet is configured; no private key is attached.
    this.queue = this.access.queue;
    this.contracts = new WeakMap();
  }
  get tron() { return this.access.source === 'public' ? this.publicTron : this.primaryTron; }
  nodeStatus() { return this.access.snapshot(); }
  request(fn) { return this.access.run(fn); }
  async head() {
    const block = await this.request(() => this.tron.trx.getConfirmedCurrentBlock());
    const height = block?.block_header?.raw_data?.number;
    if (!Number.isSafeInteger(height)) throw new Error('节点未返回有效的已确认区块高度');
    return height;
  }
  async block(height) {
    const block = await this.request(() => this.tron.solidityNode.request('walletsolidity/getblockbynum', { num: height }, 'post'));
    if (block?.block_header?.raw_data?.number !== height) throw new Error(`区块 ${height} 返回异常，未推进扫描进度`);
    return block;
  }
  async resources() {
    if (!this.wallet) return null;
    const balance = await this.request(() => this.tron.trx.getBalance(this.wallet));
    const resource = await this.request(() => this.tron.trx.getAccountResources(this.wallet));
    if (!Number.isSafeInteger(balance) || !resource || typeof resource !== 'object' || resource.Error) throw new Error('钱包资源查询异常');
    return { wallet: this.wallet, balanceSun: String(balance), trx: formatUnits(balance, 6),
      energy: Math.max(0, (resource.EnergyLimit || 0) - (resource.EnergyUsed || 0)),
      bandwidth: Math.max(0, (resource.NetLimit || 0) - (resource.NetUsed || 0)) + Math.max(0, (resource.freeNetLimit || 0) - (resource.freeNetUsed || 0)),
      checkedAt: new Date().toISOString() };
  }
  tokenCall(address, method, ...args) {
    return this.request(async () => {
      const client = this.tron;
      if (!this.contracts.has(client)) this.contracts.set(client, new Map());
      const contracts = this.contracts.get(client);
      if (!contracts.has(address)) contracts.set(address, await client.contract().at(address));
      return contracts.get(address)[method](...args).call();
    });
  }
  async tokenBalance(address = this.config.tokenContract) {
    if (!this.wallet) return null;
    return (await this.tokenCall(address, 'balanceOf', this.wallet)).toString();
  }
  async tokenInfo(address = this.config.tokenContract) {
    const decimals = Number((await this.tokenCall(address, 'decimals')).toString());
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('代币精度无效');
    let symbol = 'TOKEN';
    try { symbol = String(await this.tokenCall(address, 'symbol')).slice(0, 48); }
    catch (error) { if (isRateLimitError(error)) throw error; /* Symbol is display-only. */ }
    const balance = await this.tokenBalance(address);
    return { contract: address, decimals, symbol, rawBalance: balance, balance: balance === null ? null : formatUnits(balance, decimals) };
  }
  async preflight() {
    const height = await this.head();
    const token = await this.tokenInfo();
    const amount = decimalUnits(this.config.sendAmount, token.decimals).toString();
    if (this.config.watchUsdt) {
      const usdt = await this.tokenInfo(this.config.usdtContract);
      if (usdt.decimals !== 6) throw new Error('USDT 监听合约必须为 6 位精度，请核对合约地址');
    }
    const resources = await this.resources();
    const warnings = [];
    if (!this.config.apiKey) warnings.push('未设置 TronGrid API Key，公共节点可能限流');
    if (!resources) warnings.push('未配置钱包，只能模拟监听');
    if (resources && resources.energy < this.config.minEnergy) warnings.push('钱包能量低于设置门槛，正式投放会停止');
    if (resources && BigInt(resources.balanceSun) < decimalUnits(this.config.feeLimitTrx, 6) + decimalUnits(this.config.reserveTrx, 6)) warnings.push('TRX 不足以覆盖单笔能量费上限与保留余额');
    if (token.rawBalance !== null && BigInt(token.rawBalance) < BigInt(amount)) warnings.push('广告代币余额不足一次投放');
    return { height, token, resources, amount, warnings, checkedAt: new Date().toISOString() };
  }
  async verifyTrigger(candidate) {
    if (candidate.asset !== 'USDT' && candidate.source_asset !== 'USDT') return true;
    const id = candidate.txid || candidate.source_tx;
    const info = await this.receipt(id);
    if (!info?.id) throw new Error('触发交易的已确认回执暂不可用');
    if (info.id.toLowerCase() !== id.toLowerCase()) throw new Error('节点返回了其他触发交易的回执');
    return info.receipt?.result === 'SUCCESS' && transferEvents(info, this.config.usdtContract,
      candidate.from, candidate.to, candidate.raw);
  }
  signBindingChallenge(message) { return this.tron.trx.signMessageV2(message, this.config.privateKey); }
  async buildAndSign(row, decimals, { beforeSign = () => {} } = {}) {
    const rawAmount = decimalUnits(row.amount, decimals).toString();
    const built = await this.request(() => this.tron.transactionBuilder.triggerSmartContract(row.token, 'transfer(address,uint256)',
      { feeLimit: Number(decimalUnits(this.config.feeLimitTrx, 6)), callValue: 0 },
      [{ type: 'address', value: row.address }, { type: 'uint256', value: rawAmount }], this.wallet));
    if (!built.result?.result || !built.transaction) throw new Error('合约构建失败：' + nodeReason(built.result || built));
    const tx = built.transaction;
    this.validateTransaction(row, tx, rawAmount);
    if (!Number.isSafeInteger(tx.raw_data.expiration) || tx.raw_data.expiration <= Date.now()
      || tx.raw_data.expiration > Date.now() + 86400000) throw new Error('节点构建的交易有效期异常');
    beforeSign();
    const signed = await this.tron.trx.sign(tx, this.config.privateKey);
    return { signed, txid: signed.txID, rawAmount, wallet: this.wallet };
  }
  validateTransaction(row, tx, rawAmount) {
    const contracts = tx.raw_data?.contract;
    const actual = contracts?.[0]?.parameter?.value;
    const expectedData = 'a9059cbb' + normalizedHex(TronWeb.address.toHex(row.address)).padStart(64, '0') + BigInt(rawAmount).toString(16).padStart(64, '0');
    if (contracts?.length !== 1 || contracts[0].type !== 'TriggerSmartContract' || contracts[0].Permission_id
      || !actual || normalizedHex(actual.owner_address) !== normalizedHex(TronWeb.address.toHex(this.wallet))
      || normalizedHex(actual.contract_address) !== normalizedHex(TronWeb.address.toHex(row.token))
      || String(actual.data).toLowerCase() !== expectedData || (actual.call_value || 0) !== 0
      || actual.call_token_value || actual.token_id || tx.raw_data.fee_limit !== Number(decimalUnits(this.config.feeLimitTrx, 6))) {
      throw Object.assign(new Error('构建出的交易与投放参数不一致，已拦截'), { halt: true });
    }
  }
  restoreAttempt(row, attempt) {
    try {
      const signed = JSON.parse(attempt.signed_json);
      this.validateTransaction(row, signed, row.raw_amount);
      if (signed.txID?.toLowerCase() !== row.txid.toLowerCase() || signed.raw_data.expiration !== attempt.expiration
        || this.tron.trx.ecRecover(signed) !== this.wallet) throw new Error('签名或哈希校验不符');
      return { signed, txid: row.txid, rawAmount: row.raw_amount, wallet: row.wallet };
    } catch {
      throw Object.assign(new Error('保存的交易与投放记录不一致，已拦截重试，请保留数据并核查'), { halt: true });
    }
  }
  broadcast(signed) { return this.access.run(() => this.tron.trx.sendRawTransaction(signed), false); }
  async checkedReceipt(request) {
    const info = await this.request(request);
    if (!info || typeof info !== 'object' || Array.isArray(info) || info.Error || info.error || (info.code && !info.id)) throw new Error(nodeReason(info));
    return info;
  }
  executionReceipt(txid) { return this.checkedReceipt(() => this.tron.trx.getUnconfirmedTransactionInfo(txid)); }
  receipt(txid) { return this.checkedReceipt(() => this.tron.trx.getTransactionInfo(txid)); }
  async transactionExpiration(txid) {
    if (!/^[a-f\d]{64}$/i.test(txid || '')) throw Object.assign(new Error('原交易哈希无效'), { reviewConflict: true });
    let expiration = null;
    const execution_results = { full: null, confirmed: null };
    let transaction_found = false;
    try {
      for (const [node, endpoint] of [['fullNode', 'wallet/gettransactionbyid'],
        ['solidityNode', 'walletsolidity/gettransactionbyid']]) {
        const transaction = await this.request(() => this.tron[node].request(endpoint, { value: txid }, 'post'));
        if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) throw Object.assign(new Error('交易有效期查询返回异常'), { reviewConflict: true });
        if (!Object.keys(transaction).length) continue;
        if (transaction.Error || transaction.error || transaction.code) throw new Error(nodeReason(transaction));
        transaction_found = true;
        const found = checkedTransactionExpiration(txid, transaction);
        if (!Array.isArray(transaction.ret) || transaction.ret.length !== 1
          || typeof transaction.ret[0]?.contractRet !== 'string' || !transaction.ret[0].contractRet) {
          throw Object.assign(new Error('节点发现原交易，但执行结果不完整，继续保留待核查'), { reviewConflict: true });
        }
        execution_results[node === 'fullNode' ? 'full' : 'confirmed'] = transaction.ret[0].contractRet;
        if (expiration !== null && expiration !== found) throw Object.assign(new Error('节点返回的原交易有效期不一致，继续核查'), { reviewConflict: true });
        expiration = found;
      }
    } catch (error) {
      // A later provider error must not erase earlier success evidence. The
      // caller must reject unknown archival when any execution was observed.
      const failure = error instanceof Error ? error : new Error(nodeReason(error));
      throw Object.assign(failure, { observed_execution_results: { ...execution_results }, transaction_found });
    }
    return expiration === null ? null : { expiration, source: 'chain', execution_results };
  }
  async replacementReady(txid, expiration) {
    if (!/^[a-f\d]{64}$/i.test(txid || '') || !Number.isSafeInteger(expiration) || expiration <= 0) return false;
    // A local clock or one empty receipt is insufficient. The confirmed chain
    // must be past expiration, and all full/confirmed lookups must be empty.
    const block = await this.request(() => this.tron.trx.getConfirmedCurrentBlock());
    const timestamp = block?.block_header?.raw_data?.timestamp;
    const number = block?.block_header?.raw_data?.number, now = Date.now();
    if (!Number.isSafeInteger(number) || number <= 0 || !Number.isSafeInteger(timestamp)
      || timestamp < now - 300000 || timestamp > now + 15000 || timestamp <= expiration + FINALITY_MARGIN_MS) return false;
    for (const [node, endpoint] of [['fullNode', 'wallet/gettransactionbyid'],
      ['fullNode', 'wallet/gettransactioninfobyid'], ['solidityNode', 'walletsolidity/gettransactionbyid'],
      ['solidityNode', 'walletsolidity/gettransactioninfobyid']]) {
      const found = await this.request(() => this.tron[node].request(endpoint, { value: txid }, 'post'));
      if (!found || typeof found !== 'object' || Array.isArray(found)) throw new Error('过期核查返回异常');
      if (Object.keys(found).length) return false;
    }
    return true;
  }
}
module.exports = { Chain, RequestQueue, decodeCandidates, transferEvents, normalizedHex, checkedTransactionExpiration, TRANSFER_TOPIC, sleep };
