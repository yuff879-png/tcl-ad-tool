'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJson, walletAddress } = require('./config');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function derive(password, salt) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 1024) throw new Error('钱包库密码请使用 10～1024 个字符，并妥善保存');
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function decrypt(file, password) {
  let key;
  try {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (envelope.format !== 'tcl-wallet-pool-v1' || !/^[a-f\d]{32}$/.test(envelope.salt) || !/^[a-f\d]{24}$/.test(envelope.iv) || !/^[a-f\d]{32}$/.test(envelope.tag)) throw new Error();
    key = derive(password, Buffer.from(envelope.salt, 'hex'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(Buffer.from(envelope.format)); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    const clear = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    let data; try { data = JSON.parse(clear.toString('utf8')); } finally { clear.fill(0); }
    if (!Array.isArray(data.wallets)) throw new Error();
    const addresses = new Set();
    for (const w of data.wallets) {
      if (!/^[a-f\d]{64}$/i.test(w.key) || walletAddress({ privateKey: w.key }) !== w.address || addresses.has(w.address) || typeof w.id !== 'string' || typeof w.batchId !== 'string') throw new Error();
      addresses.add(w.address);
    }
    return { key, data, salt: envelope.salt };
  } catch { key?.fill(0); throw new Error('钱包库密码不正确、文件损坏或格式不支持；未改动原文件'); }
}
class PoolVault {
  constructor(directory) { this.file = path.join(directory, 'pool-vault.json'); this.session = null; }
  get exists() { return fs.existsSync(this.file); }
  get unlocked() { return Boolean(this.session); }
  initialize(password) {
    if (this.exists) throw new Error('钱包库已存在，请解锁');
    const salt = crypto.randomBytes(16).toString('hex');
    this.session = { salt, key: derive(password, Buffer.from(salt, 'hex')), data: { wallets: [] } };
    try { this.save(); } catch (error) { this.lock(); throw error; }
  }
  unlock(password) { const next = decrypt(this.file, password); this.lock(); this.session = next; }
  lock() { this.session?.key.fill(0); this.session = null; }
  require() { if (!this.session) throw new Error('请先解锁投放钱包库'); return this.session; }
  get(id) { const w = this.require().data.wallets.find(item => item.id === id); if (!w) throw new Error('钱包不在密钥库内，请核对备份'); return w; }
  save() {
    const { key, salt, data } = this.require(), iv = crypto.randomBytes(12), format = 'tcl-wallet-pool-v1';
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(format));
    const clear = Buffer.from(JSON.stringify(data));
    let encrypted; try { encrypted = Buffer.concat([cipher.update(clear), cipher.final()]); } finally { clear.fill(0); }
    atomicJson(this.file, { format, salt, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('base64') });
  }
  fingerprint() {
    if (!this.exists) return '';
    const stat = fs.statSync(this.file, { bigint: true }), stamp = `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    if (this.cachedHash?.stamp !== stamp) this.cachedHash = { stamp, value: hash(fs.readFileSync(this.file)) };
    return this.cachedHash.value;
  }
  verifyCopy(file, password) {
    if (hash(fs.readFileSync(file)) !== this.fingerprint()) throw new Error('备份与当前钱包库不一致，请先重新创建完整备份');
    const checked = decrypt(file, password); checked.key.fill(0); return checked.data.wallets.length;
  }
}
module.exports = { PoolVault };
