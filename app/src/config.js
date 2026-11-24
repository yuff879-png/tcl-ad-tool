'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TronWeb } = require('tronweb');

const DEFAULTS = {
  rpcUrl: 'https://api.trongrid.io', privateKey: '', apiKey: '',
  tokenContract: '', usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  watchedAddresses: [], blacklist: [], sendAmount: '168', minUsdt: '50', minTrx: '150',
  watchTrx: true, watchUsdt: true, minEnergy: 100000, feeLimitTrx: '30', reserveTrx: '5',
  pollSeconds: 3, sendIntervalSeconds: 2, maxPerRun: 0, maxCatchUpBlocks: 2000,
  restartScanMode: 'latest', unfinishedPolicy: 'skip',
  autoResumeEnergy: false, energyRecoverySeconds: 120,
  assetType: 'TRC20', tokenId: '', trc10SendAmount: '168', poolFundingKey: '',
  bandwidthMargin: 20, queueTtlMinutes: 30, maxQueue: 10000,
  energyTransport: 'local', platformUrl: '', platformToken: '', platformDeviceId: '', platformWallet: '',
};
const SECRET_FIELDS = ['privateKey', 'apiKey', 'poolFundingKey', 'platformToken'];
function addressList(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\s,，;；]+/))
    .map(v => String(v).trim()).filter(Boolean))];
}
function decimalUnits(value, decimals) {
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('金额必须为非负普通十进制数字');
  }
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`金额小数位超过代币精度 ${decimals}`);
  const n = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (n >= 2n ** 256n) throw new Error('金额过大');
  return n;
}
function formatUnits(value, decimals) {
  const n = BigInt(value).toString().padStart(decimals + 1, '0');
  if (!decimals) return n;
  const fraction = n.slice(-decimals).replace(/0+$/, '');
  return n.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function normalize(input, previous = DEFAULTS) {
  const c = { ...DEFAULTS, ...previous };
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.hasOwn(input, key)) continue;
    if (SECRET_FIELDS.includes(key) && input[key] === '') continue;
    c[key] = input[key];
  }
  for (const key of input.clearSecrets || []) if (SECRET_FIELDS.includes(key)) c[key] = '';
  for (const key of ['watchedAddresses', 'blacklist']) c[key] = addressList(c[key]);
  for (const key of ['sendAmount', 'trc10SendAmount', 'minUsdt', 'minTrx', 'feeLimitTrx', 'reserveTrx']) c[key] = String(c[key]).trim();
  for (const key of ['rpcUrl', 'tokenContract', 'tokenId', 'usdtContract', ...SECRET_FIELDS]) c[key] = String(c[key]).trim();
  for (const key of ['minEnergy', 'pollSeconds', 'sendIntervalSeconds', 'maxPerRun', 'maxCatchUpBlocks', 'energyRecoverySeconds', 'bandwidthMargin', 'queueTtlMinutes', 'maxQueue']) c[key] = Number(c[key]);
  return c;
}
function validate(c, mode = 'save') {
  const errors = [];
  if (!['local', 'platform'].includes(c.energyTransport)) errors.push('平台连接模式无效');
  if (c.energyTransport === 'platform') {
    try { require('./rental-client').platformOrigin(c.platformUrl); } catch (error) { errors.push(error.message); }
    if (!c.platformToken || !c.platformDeviceId || c.platformWallet !== walletAddress(c)) errors.push('平台绑定与当前投放钱包不一致');
    if (c.assetType !== 'TRC20') errors.push('平台模式目前仅支持 TRC20；请先安全断开平台再切换');
  }
  if (!['TRC20', 'TRC10'].includes(c.assetType)) errors.push('投放类型无效');
  if ((c.assetType === 'TRC10' && mode !== 'save') || c.tokenId) {
    if (!/^[1-9]\d{0,18}$/.test(c.tokenId)) errors.push('请填写有效的数字 TRC10 Token ID');
  }
  try {
    const url = new URL(c.rpcUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { errors.push('节点地址必须为 HTTPS 地址，不能包含用户名、密码或查询参数'); }
  for (const [key, label] of [['tokenContract', '广告代币合约'], ['usdtContract', 'USDT 合约']]) {
    if (key === 'tokenContract' && c.assetType === 'TRC10') continue;
    if ((mode !== 'save' || c[key]) && !TronWeb.isAddress(c[key])) errors.push(`${label}地址不正确`);
  }
  for (const [key, label] of [['watchedAddresses', '监听名单'], ['blacklist', '黑名单']]) {
    if (c[key].length > 10000) errors.push(`${label}最多 10000 个地址`);
    for (const address of c[key]) if (!TronWeb.isAddress(address)) errors.push(`${label}存在无效地址：${address}`);
  }
  if (mode !== 'save' && !c.watchedAddresses.length) errors.push('请先添加至少一个监听地址');
  if (typeof c.watchTrx !== 'boolean' || typeof c.watchUsdt !== 'boolean' || (!c.watchTrx && !c.watchUsdt)) errors.push('至少启用一种转账监听');
  for (const [key, precision] of [['sendAmount', 36], ['trc10SendAmount', 6], ['minUsdt', 6], ['minTrx', 6], ['feeLimitTrx', 6], ['reserveTrx', 6]]) {
    try { if (decimalUnits(c[key], precision) <= 0n && ['sendAmount', 'trc10SendAmount', 'feeLimitTrx'].includes(key)) throw new Error(); }
    catch { errors.push(`${key} 金额格式或精度不正确`); }
  }
  if (Number(c.feeLimitTrx) > 15000) errors.push('单笔能量费上限不能超过 15000 TRX');
  for (const [key, min, max] of [['minEnergy', 0, 1e10], ['pollSeconds', 2, 60], ['sendIntervalSeconds', 1, 3600], ['maxPerRun', 0, 100000], ['maxCatchUpBlocks', 1, 10000]]) {
    if (!Number.isSafeInteger(c[key]) || c[key] < min || c[key] > max) errors.push(`${key} 必须是 ${min} 至 ${max} 的整数`);
  }
  if (!['latest', 'resume'].includes(c.restartScanMode)) errors.push('重新启动扫描起点无效');
  if (!['skip', 'resend'].includes(c.unfinishedPolicy)) errors.push('中断后等待队列处理方式无效');
  if (typeof c.autoResumeEnergy !== 'boolean') errors.push('能量恢复后自动继续必须为开关值');
  if (!Number.isSafeInteger(c.energyRecoverySeconds) || c.energyRecoverySeconds < 10 || c.energyRecoverySeconds > 86400) errors.push('能量检查间隔必须是 10 至 86400 秒的整数');
  for (const [key, min, max] of [['bandwidthMargin', 0, 1000], ['queueTtlMinutes', 1, 10080], ['maxQueue', 100, 100000]]) {
    if (!Number.isSafeInteger(c[key]) || c[key] < min || c[key] > max) errors.push(`${key} 必须是 ${min} 至 ${max} 的整数`);
  }
  if (c.poolFundingKey && (!/^[a-f\d]{64}$/i.test(c.poolFundingKey) || !walletAddress({ privateKey: c.poolFundingKey }))) errors.push('准备资金钱包私钥格式不正确');
  if (c.privateKey && (!/^[0-9a-fA-F]{64}$/.test(c.privateKey) || !walletAddress(c))) errors.push('私钥格式不正确');
  if (mode === 'live' && c.assetType !== 'TRC10' && !c.privateKey) errors.push('正式投放需要配置钱包私钥');
  if (errors.length) throw new Error(errors.slice(0, 8).join('；'));
  return c;
}
function walletAddress(c) {
  try { return c.privateKey ? TronWeb.address.fromPrivateKey(c.privateKey) || '' : ''; } catch { return ''; }
}
function publicConfig(c) {
  const result = { ...c, walletAddress: walletAddress(c), hasPrivateKey: Boolean(c.privateKey), hasApiKey: Boolean(c.apiKey), hasPoolFundingKey: Boolean(c.poolFundingKey), poolFundingAddress: walletAddress({ privateKey: c.poolFundingKey }) };
  SECRET_FIELDS.forEach(k => delete result[k]);
  return result;
}
function fingerprint(c, mode) {
  return crypto.createHash('sha256').update(JSON.stringify([c.rpcUrl, c.tokenContract, c.usdtContract,
    c.watchedAddresses, c.blacklist, c.minUsdt, c.minTrx, c.watchTrx, c.watchUsdt, mode])).digest('hex');
}
function effectiveConfig(c) {
  return c.assetType === 'TRC10' ? { ...c, tokenContract: c.tokenId, sendAmount: c.trc10SendAmount } : { ...c };
}
function redact(message, c = {}) {
  let text = String(message);
  for (const key of SECRET_FIELDS) if (c[key]) text = text.split(c[key]).join('[已隐藏]');
  return text.replace(/(TRON-PRO-API-KEY|privateKey|poolFundingKey|platformToken|device_token|password)["'\s:=]+[^\s,}]+/gi, '$1=[已隐藏]');
}
module.exports = { DEFAULTS, SECRET_FIELDS, addressList, decimalUnits, formatUnits, atomicJson, normalize, validate, walletAddress, publicConfig, fingerprint, redact, effectiveConfig };
