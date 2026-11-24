'use strict';
// Run only against an explicitly supplied legacy folder. Never execute legacy scripts.
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { DatabaseSync } = require('node:sqlite');
const { TronWeb } = require('tronweb');
const { Store } = require('../src/store');
const { DEFAULTS, normalize, atomicJson, addressList } = require('../src/config');

function migrate(source, destination) {
  const configPath = path.join(destination, 'config.json');
  if (fs.existsSync(configPath)) throw new Error('目标已有配置，为避免覆盖，迁移已停止');
  const env = dotenv.parse(fs.readFileSync(path.join(source, '.env')));
  const report = { createdAt: new Date().toISOString(), invalidAddresses: [], sources: {}, notes: [] };
  const valid = (values, label) => addressList(values).filter(address => {
    if (TronWeb.isAddress(address)) return true;
    report.invalidAddresses.push({ source: label, address }); return false;
  });
  const config = normalize({ ...DEFAULTS, privateKey: env.PRIVATE_KEY || '', apiKey: env.TRONGRID_KEY || env.TRONGRID_API_KEY || '',
    tokenContract: env.MY_TOKEN_CONTRACT || '', usdtContract: env.USDT_CONTRACT || DEFAULTS.usdtContract,
    watchedAddresses: valid(env.WATCHED_ADDRESSES, '监听名单'), blacklist: valid([...(addressList(env.BLACKLIST)), ...addressList(env.BLACKLIST_ADDRESSES)], '.env 黑名单'),
    sendAmount: env.SEND_AMOUNT || DEFAULTS.sendAmount, minUsdt: env.MIN_USDT || DEFAULTS.minUsdt,
    minTrx: env.MIN_TRX || DEFAULTS.minTrx, minEnergy: env.MIN_ENERGY || DEFAULTS.minEnergy });
  if (env.TRONSCAN_API_KEY && !config.apiKey) report.notes.push('原文件仅提供 TRONSCAN_API_KEY。TronScan 与 TronGrid 的密钥不能直接互换；TronGrid API Key 留空，请自行填写。');
  const store = new Store(destination);
  try {
    store.transaction(() => {
      const addAddress = store.db.prepare('INSERT OR IGNORE INTO legacy_addresses VALUES(?)');
      const addTx = store.db.prepare('INSERT OR IGNORE INTO legacy_transactions VALUES(?)');
      if (fs.existsSync(path.join(source, 'sentData.json'))) {
        const json = JSON.parse(fs.readFileSync(path.join(source, 'sentData.json'), 'utf8'));
        valid(json.sentAddresses, 'sentData.json').forEach(a => addAddress.run(a));
        for (const id of json.sentTxs || []) if (/^[a-f\d]{64}$/i.test(id)) addTx.run(id);
        report.sources['sentData.json'] = { addresses: json.sentAddresses?.length || 0, transactions: json.sentTxs?.length || 0 };
      }
      for (const file of ['db.sqlite', 'txlog.sqlite']) {
        if (!fs.existsSync(path.join(source, file))) continue;
        const db = new DatabaseSync(path.join(source, file), { readOnly: true });
        try {
          for (const table of ['sent', 'sent_addresses', 'sent_tx', 'blacklist']) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
            const rows = db.prepare(`SELECT * FROM ${table}`).all();
            report.sources[file + '/' + table] = rows.length;
            for (const row of rows) {
              for (const a of valid([row.address || ''], file + '/' + table)) {
                if (table === 'blacklist') config.blacklist.push(a); else addAddress.run(a);
              }
              if (row.txid && /^[a-f\d]{64}$/i.test(row.txid)) addTx.run(row.txid);
            }
          }
        } finally { db.close(); }
      }
      config.blacklist = addressList(config.blacklist);
      report.uniqueSentAddresses = store.counts().legacy;
      report.watchedAddresses = config.watchedAddresses.length;
      report.blacklistAddresses = config.blacklist.length;
      report.notes.push('旧记录只证明旧脚本曾记录该地址，不代表本次核验了链上到账；新版继续拦截这些地址。');
      report.notes.push('rocke 是独立的 Telegram 资源告警脚本。新版在运行面板显示资源；未启用或迁移 Telegram 消息发送。');
      store.setMeta('migration', report);
    });
    atomicJson(configPath, config);
    atomicJson(path.join(destination, 'migration-report.json'), report);
    store.log('info', `已导入 ${report.watchedAddresses} 个监听地址、${report.blacklistAddresses} 个黑名单地址、${report.uniqueSentAddresses} 个历史投放地址`);
    return report;
  } finally { store.close(); }
}
if (require.main === module) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('用法：node scripts/migrate.js 原目录 数据目录');
  console.log(JSON.stringify(migrate(path.resolve(process.argv[2]), path.resolve(process.argv[3])), null, 2));
}
module.exports = { migrate };
