'use strict';
const { TronWeb } = require('tronweb');
const { DEFAULTS, normalize, decimalUnits, walletAddress } = require('../src/config');
const { TRANSFER_TOPIC, normalizedHex } = require('../src/chain');
const key = n => n.toString(16).padStart(64, '0');
const address = n => TronWeb.address.fromPrivateKey(key(n));
const config = extra => normalize({ ...DEFAULTS, privateKey: key(1), tokenContract: address(9),
  watchedAddresses: [address(2)], blacklist: [], maxPerRun: 1, ...extra });
function trxBlock(height = 11, to = address(3), id = 'a'.repeat(64)) {
  return { block_header: { raw_data: { number: height } }, transactions: [{ txID: id, ret: [{ contractRet: 'SUCCESS' }],
    raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: TronWeb.address.toHex(address(2)), to_address: TronWeb.address.toHex(to), amount: 150000000 } } }] } }] };
}
function usdtBlock(c = config()) {
  const block = trxBlock();
  block.transactions[0].raw_data.contract = [{ type: 'TriggerSmartContract', parameter: { value: {
    owner_address: TronWeb.address.toHex(address(2)), contract_address: TronWeb.address.toHex(c.usdtContract),
    data: 'a9059cbb' + normalizedHex(TronWeb.address.toHex(address(3))).padStart(64, '0') + decimalUnits('50', 6).toString(16).padStart(64, '0'),
  } } }];
  return block;
}
function receipt(token, from, to, raw, id = 'b'.repeat(64)) {
  return { id, receipt: { result: 'SUCCESS' }, fee: 123000, log: [{ address: normalizedHex(TronWeb.address.toHex(token)),
    topics: [TRANSFER_TOPIC, normalizedHex(TronWeb.address.toHex(from)).padStart(64, '0'), normalizedHex(TronWeb.address.toHex(to)).padStart(64, '0')], data: BigInt(raw).toString(16).padStart(64, '0') }] };
}
class FakeChain {
  constructor(c) { this.config = c; this.wallet = walletAddress(c); this.signed = 0; this.broadcasts = 0; this.headValue = 11; this.headCalls = 0; this.transfers = new Map(); }
  async resources() { return { wallet: this.wallet, balanceSun: '1000000000', trx: '1000', energy: 999999, bandwidth: 5000, checkedAt: new Date().toISOString() }; }
  async tokenInfo() { return { contract: this.config.tokenContract, decimals: 18, symbol: 'DEMO', rawBalance: '1000000000000000000000000', balance: '1000000' }; }
  async tokenBalance() { return (await this.tokenInfo()).rawBalance; }
  async preflight() { return { height: 10, resources: await this.resources(), token: await this.tokenInfo(), amount: decimalUnits(this.config.sendAmount, 18).toString(), warnings: [], checkedAt: new Date().toISOString() }; }
  async head() { return this.headCalls++ === 0 ? 10 : this.headValue; }
  async block(h) { return trxBlock(h); }
  async verifyTrigger() { return true; }
  async buildAndSign(row, decimals) {
    this.signed++; const txid = this.signed === 1 ? 'b'.repeat(64) : this.signed.toString(16).padStart(64, 'b');
    const rawAmount = decimalUnits(row.amount, decimals).toString(); this.transfers.set(txid, { ...row, rawAmount });
    return { signed: { fake: true, txid, raw_data: { expiration: Date.now() + 60000 } }, txid, rawAmount, wallet: this.wallet };
  }
  restoreAttempt(row, attempt) { return { signed: JSON.parse(attempt.signed_json), txid: row.txid, rawAmount: row.raw_amount, wallet: row.wallet }; }
  async replacementReady() { return false; }
  async broadcast() { this.broadcasts++; return { result: true }; }
  async receipt(id) { const row = this.transfers.get(id); return receipt(row?.token || this.config.tokenContract, this.wallet, row?.address || address(3), row?.rawAmount || decimalUnits(this.config.sendAmount, 18), id); }
  async executionReceipt(id) { return this.receipt(id); }
}
module.exports = { config, key, address, trxBlock, usdtBlock, receipt, FakeChain };
