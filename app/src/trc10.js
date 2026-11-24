'use strict';
const { TronWeb, utils } = require('tronweb');
const { Chain, normalizedHex } = require('./chain');
const { decimalUnits, formatUnits, walletAddress } = require('./config');

const waitError = message => Object.assign(new Error(message), { resourceWait: true });
function natural(value, fallback = 0) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('节点返回的资源数值无效或超出安全整数范围');
  return value;
}
function rawUnits(value, decimals) {
  const amount = decimalUnits(value, decimals);
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('TRC10 最小单位数量须为正数且不超过 9007199254740991，请减少数量');
  return amount.toString();
}
function validateNative(row, tx, rawAmount, sender) {
  const contracts = tx?.raw_data?.contract, c = contracts?.[0], v = c?.parameter?.value;
  const hex = address => normalizedHex(TronWeb.address.toHex(address));
  if (contracts?.length !== 1 || c.type !== 'TransferAssetContract' || c.Permission_id
    || !v || normalizedHex(v.owner_address) !== hex(sender) || normalizedHex(v.to_address) !== hex(row.address)
    || String(v.asset_name).toLowerCase() !== Buffer.from(String(row.token), 'utf8').toString('hex')
    || !Number.isSafeInteger(v.amount) || String(v.amount) !== String(rawAmount)
    || tx.raw_data.data || tx.raw_data.fee_limit || !utils.transaction.txCheck(tx)) {
    throw Object.assign(new Error('TRC10 交易与代币、钱包、收款地址或数量不一致，已拦截'), { halt: true });
  }
}
function bandwidthSize(signed) {
  // txJsonToPb excludes signatures; protobuf signature tag + length + 65 bytes.
  // TRON reserves MAX_RESULT_SIZE_IN_TX (64) in addition to serialized bytes.
  if (signed.signature?.length !== 1 || !/^[a-f\d]{130}$/i.test(signed.signature[0])) throw new Error('只支持单签名 TRC10 投放钱包');
  return utils.transaction.txJsonToPb(signed).serializeBinary().length + 67 + 64;
}
class Trc10Chain extends Chain {
  constructor(config, options) {
    super({ ...config, privateKey: '' }, options);
    this.config = { ...config, privateKey: '' };
    for (const client of new Set([this.primaryTron, this.publicTron])) client.setAddress(config.usdtContract);
    this.fundingWallet = walletAddress({ privateKey: config.poolFundingKey });
  }
  async account(address) {
    const value = await this.request(() => this.tron.trx.getAccount(address));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.Error || value.error) throw new Error('账户查询未返回有效结果');
    if (!value.address) { if (Object.keys(value).length) throw new Error('账户响应异常'); return null; }
    if (normalizedHex(value.address) !== normalizedHex(TronWeb.address.toHex(address))) throw new Error('节点返回的账户地址不符');
    return value;
  }
  async tokenInfo(token = this.config.tokenId) {
    if (!/^[1-9]\d{0,18}$/.test(String(token))) return super.tokenInfo(token);
    const info = await this.request(() => this.tron.fullNode.request('wallet/getassetissuebyid', { value: String(token) }, 'post'));
    if (String(info?.id) !== String(token) || !Number.isInteger(info.precision ?? 0) || (info.precision ?? 0) < 0 || (info.precision ?? 0) > 6) throw new Error('未查询到有效的 TRC10 Token ID 或精度');
    if (natural(info.free_asset_net_limit) > 0 || natural(info.public_free_asset_net_limit) > 0) throw new Error('该代币启用了发行者带宽补贴，不符合只使用子钱包免费带宽的模式，请在发行端核对设置');
    const decode = value => /^[a-f\d]+$/i.test(value || '') ? Buffer.from(value, 'hex').toString('utf8').slice(0, 48) : String(value || '').slice(0, 48);
    return { contract: String(token), tokenId: String(token), assetType: 'TRC10', decimals: info.precision ?? 0,
      symbol: decode(info.abbr || info.name) || 'TRC10', name: decode(info.name), issuer: TronWeb.address.fromHex(info.owner_address), rawBalance: null, balance: null };
  }
  async inspectWallet(address, token = this.config.tokenId) {
    const account = await this.account(address);
    if (!account) return { wallet: address, activated: false, balanceSun: '0', rawBalance: '0', freeBandwidth: 0, stakedBandwidth: 0, checkedAt: new Date().toISOString() };
    const resource = await this.request(() => this.tron.trx.getAccountResources(address));
    if (!resource || typeof resource !== 'object' || resource.Error || resource.error) throw new Error('带宽查询失败');
    const asset = account.assetV2?.find(a => String(a.key) === String(token));
    const value = asset?.value ?? 0;
    if (!(typeof value === 'string' && /^\d+$/.test(value)) && (!Number.isSafeInteger(value) || value < 0)) throw new Error('代币余额超出节点安全精度，无法自动投放');
    const permissions = [account.owner_permission, ...(account.active_permission || [])].filter(Boolean);
    const standardPermission = permissions.every(p => Number(p.threshold) === 1 && p.keys?.length === 1
      && Number(p.keys[0].weight) === 1 && normalizedHex(p.keys[0].address) === normalizedHex(TronWeb.address.toHex(address)));
    return { wallet: address, activated: true, standardPermission, rawBalance: String(value), balanceSun: String(natural(account.balance)),
      freeBandwidth: Math.max(0, natural(resource.freeNetLimit) - natural(resource.freeNetUsed)),
      freeLimit: natural(resource.freeNetLimit), stakedBandwidth: natural(resource.NetLimit),
      checkedAt: new Date().toISOString() };
  }
  async preflight() {
    const height = await this.head(), token = await this.tokenInfo();
    const amount = rawUnits(this.config.sendAmount, token.decimals);
    if (this.config.watchUsdt && (await super.tokenInfo(this.config.usdtContract)).decimals !== 6) throw new Error('USDT 合约精度不正确');
    return { height, token, amount, resources: null, warnings: this.config.apiKey ? [] : ['公共节点可能限流，资源不足时会等待'], checkedAt: new Date().toISOString() };
  }
  async buildNative(row, decimals, key) {
    const sender = walletAddress({ privateKey: key }), rawAmount = rawUnits(row.amount, decimals);
    if (!sender) throw new Error('钱包库未解锁或密钥无效');
    const tx = await this.request(() => this.tron.transactionBuilder.sendToken(row.address, Number(rawAmount), row.token, sender));
    validateNative(row, tx, rawAmount, sender);
    if (!Number.isSafeInteger(tx.raw_data.expiration) || tx.raw_data.expiration <= Date.now() || tx.raw_data.expiration > Date.now() + 86400000) throw new Error('TRC10 交易有效期异常');
    const signed = await this.tron.trx.sign(tx, key);
    return { signed, txid: signed.txID, wallet: sender, rawAmount, bandwidth: bandwidthSize(signed) };
  }
  restoreNative(row, attempt) {
    const signed = JSON.parse(attempt.signed_json);
    validateNative(row, signed, row.raw_amount, row.wallet);
    if (signed.txID !== row.txid || signed.raw_data.expiration !== attempt.expiration || this.tron.trx.ecRecover(signed) !== row.wallet) throw Object.assign(new Error('TRC10 保存的签名或有效期不符'), { halt: true });
    return { signed, txid: row.txid, wallet: row.wallet, rawAmount: row.raw_amount, bandwidth: bandwidthSize(signed) };
  }
  async deliveryReceipt(row, final) {
    const info = await (final ? this.receipt(row.txid) : this.executionReceipt(row.txid));
    if (!info?.id) return info;
    const node = final ? 'solidityNode' : 'fullNode', endpoint = final ? 'walletsolidity/gettransactionbyid' : 'wallet/gettransactionbyid';
    const tx = await this.request(() => this.tron[node].request(endpoint, { value: row.txid }, 'post'));
    if (!tx?.txID || !tx.ret?.length) throw new Error('原生交易执行结果暂不可用');
    if (tx.txID !== row.txid) throw Object.assign(new Error('TRC10 回执哈希不匹配'), { halt: true });
    validateNative(row, tx, row.raw_amount, row.wallet);
    const result = tx.ret[0].contractRet;
    if (typeof result !== 'string' || !result || tx.ret.length !== 1) throw new Error('原生交易执行结果不完整');
    return { ...info, receipt: { ...info.receipt, result }, nativeValidated: true };
  }
  async checkFree(address, amount, bandwidth, token = this.config.tokenId) {
    const r = await this.inspectWallet(address, token);
    if (!r.activated || !r.standardPermission || r.balanceSun !== '0' || r.stakedBandwidth > 0) throw waitError('钱包未激活、权限异常或存在 TRX / 质押带宽，已暂时移出免费候选');
    if (BigInt(r.rawBalance) < BigInt(amount)) throw waitError('钱包代币余额不足');
    if (r.freeBandwidth < bandwidth + this.config.bandwidthMargin) throw waitError('钱包免费带宽不足，等待恢复');
    return r;
  }
}
module.exports = { Trc10Chain, rawUnits, validateNative, bandwidthSize, waitError };
