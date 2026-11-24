'use strict';
// Pure receipt parsing and local reporting. No RPC, signing or wallet access.
const DAY = 86400000;
const ZONES = { 'Asia/Shanghai': { offset: 480, label: '北京时间 UTC+8' }, 'UTC': { offset: 0, label: 'UTC' } };
const dateAt = (timestamp, offset) => new Date(timestamp + offset * 60000).toISOString().slice(0, 10);
function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && /^\d{1,80}$/.test(value) ? BigInt(value).toString() : null;
}
function receiptMetrics(row, info) {
  if (!/^[a-f\d]{64}$/i.test(row.txid || '') || typeof info?.id !== 'string'
    || info.id.toLowerCase() !== row.txid.toLowerCase() || !info.receipt?.result) return null;
  const timestamp = Number(info.blockTimeStamp);
  const blockTime = Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp < 8640000000000000 ? timestamp : null;
  const native = row.asset_type === 'TRC10';
  const energy = native ? '0' : integer(info.receipt.energy_usage_total);
  const bandwidth = integer(info.receipt.net_usage ?? (native && blockTime !== null && info.nativeValidated ? 0 : undefined));
  // TRON omits zero protobuf fee fields. Only accept this default with a usable
  // on-chain timestamp and energy receipt, never for an empty/error response.
  const fee = info.fee === undefined ? (blockTime !== null && energy !== null ? '0' : null) : integer(info.fee);
  return native ? { blockTime, energy, bandwidth, feeSun: fee } : { blockTime, energy, feeSun: fee };
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function statisticsOptions(input = {}, now = Date.now()) {
  const timeZone = input.timeZone || 'Asia/Shanghai', zone = ZONES[timeZone];
  if (!zone) throw new Error('统计时区无效');
  const period = input.period || '15';
  if (!['15', '30', '90', 'all', 'custom'].includes(period)) throw new Error('统计日期范围无效');
  const today = dateAt(now, zone.offset);
  let start = '', end = today;
  if (period === 'custom') {
    start = input.start; end = input.end;
    if (!validDate(start) || !validDate(end) || start > end) throw new Error('请选择有效的起止日期，开始日期不能晚于结束日期');
  } else if (period !== 'all') start = dateAt(Date.parse(today + 'T00:00:00Z') - (Number(period) - 1) * DAY, 0);
  const token = String(input.token || '');
  if (token.length > 100) throw new Error('代币筛选无效');
  const page = Number(input.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new Error('统计页码无效');
  return { period, start, end, timeZone, offset: zone.offset, zoneLabel: zone.label, token, page, pageSize: 15 };
}
function units(value, precision) {
  const digits = value.toString().padStart(precision + 1, '0');
  const tail = precision ? digits.slice(-precision).replace(/0+$/, '') : '';
  return (precision ? digits.slice(0, -precision) : digits) + (tail ? '.' + tail : '');
}
function amountUnits(amount) {
  if (typeof amount !== 'string' || !/^\d{1,80}(?:\.\d{1,36})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole + fraction.padEnd(36, '0'));
}
function bucket() {
  return { count: 0, transactions: 0, otherCount: 0, amounts: new Map(), energy: 0n, bandwidth: 0n, feeSun: 0n, missingBandwidth: 0,
    missingEnergy: 0, missingFee: 0, missingAmount: 0, serviceFeeSun: 0n, missingServiceFee: 0 };
}
function add(row, result) {
  result.transactions++;
  if (row.status === 'confirmed') {
    result.count++;
    const amount = amountUnits(row.amount);
    if (amount === null) result.missingAmount++;
    else result.amounts.set(row.token, (result.amounts.get(row.token) || 0n) + amount);
  } else result.otherCount++;
  if (row.energy === null) result.missingEnergy++; else result.energy += BigInt(row.energy);
  if (row.asset_type === 'TRC10') { if (row.bandwidth === null) result.missingBandwidth++; else result.bandwidth += BigInt(row.bandwidth); }
  if (row.fee_sun === null) result.missingFee++; else result.feeSun += BigInt(row.fee_sun);
  if (row.service_fee_sun === null) result.missingServiceFee++; else result.serviceFeeSun += BigInt(row.service_fee_sun);
}
function output(result) {
  return { ...result, amounts: [...result.amounts].sort(([a], [b]) => a.localeCompare(b)).map(([token, amount]) => ({ token, amount: units(amount, 36) })),
    energy: result.energy.toString(), bandwidth: result.bandwidth.toString(), feeSun: result.feeSun.toString(), feeTrx: units(result.feeSun, 6), serviceFeeSun: result.serviceFeeSun.toString(), serviceFeeTrx: units(result.serviceFeeSun, 6) };
}
function queryStatistics(db, input = {}, now = Date.now()) {
  const options = statisticsOptions(input, now), days = new Map(), total = bucket();
  const pending = { undated: 0, awaitingFinal: 0 };
  // Iterate in the reporting worker, keeping only daily aggregates in memory.
  // Use receipt time, never candidate creation or later reconciliation time.
  const rows = db.prepare(`SELECT d.status,d.token,d.amount,r.block_time,r.energy,r.fee_sun,d.asset_type,r.bandwidth,
      CASE WHEN e.submitted=1 THEN e.customer_fee_sun ELSE '0' END AS service_fee_sun
    FROM deliveries d LEFT JOIN delivery_receipts r ON r.delivery_id=d.id AND r.txid=d.txid COLLATE NOCASE
    LEFT JOIN energy_orders e ON e.delivery_id=d.id
    WHERE d.mode='live' AND d.status IN ('confirmed','failed','uncertain','executed','pending','prepared','archived_unconfirmed','expired_unconfirmed')
      AND (d.status!='expired_unconfirmed' OR r.txid IS NOT NULL)
      AND NOT (COALESCE(e.resolved,0)=1 AND e.transaction_status='not_broadcast')
      ${options.token ? 'AND d.token=?' : ''}
    UNION ALL SELECT 'failed',d.token,d.amount,a.block_time,a.energy,a.fee_sun,d.asset_type,a.bandwidth,'0'
      FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
      WHERE d.mode='live' AND a.status='failed_final' AND a.txid!=d.txid COLLATE NOCASE
        ${options.token ? 'AND d.token=?' : ''}`);
  for (const row of rows.iterate(...(options.token ? [options.token, options.token] : []))) {
    if (['executed', 'pending', 'prepared'].includes(row.status)) { pending.awaitingFinal++; continue; }
    if (row.block_time === null) { pending.undated++; continue; }
    const date = dateAt(row.block_time, options.offset);
    if ((options.start && date < options.start) || date > options.end) continue;
    if (!days.has(date)) days.set(date, bucket());
    add(row, days.get(date)); add(row, total);
  }
  const items = [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, value]) => ({ date, ...output(value) }));
  const pages = Math.max(1, Math.ceil(items.length / options.pageSize)), page = Math.min(options.page, pages);
  const tokens = db.prepare("SELECT DISTINCT token FROM deliveries WHERE mode='live' AND status IN ('confirmed','failed','uncertain','executed','pending','prepared','archived_unconfirmed','expired_unconfirmed') ORDER BY token").all().map(r => r.token);
  return { range: options, page, pageSize: options.pageSize, pages, totalDays: items.length,
    items: input.export === true ? items : items.slice((page - 1) * options.pageSize, page * options.pageSize), totals: output(total),
    pending, tokens, legacyAddresses: db.prepare('SELECT COUNT(*) AS n FROM legacy_addresses').get().n, generatedAt: new Date(now).toISOString() };
}
function statisticsCsv(result) {
  const cell = value => '"' + String(value ?? '').replace(/^[=+\-@\t\r]/, c => "'" + c).replace(/"/g, '""') + '"';
  const amounts = item => item.amounts.map(a => `${a.amount} [${a.token}]`).join('；') || (item.missingAmount ? '待补齐' : '0');
  const consumption = (item, key, missing) => item[missing] ? `${item.transactions > item[missing] ? item[key] + ' + ' : ''}待补齐 ${item[missing]} 笔` : item[key];
  const values = item => [item.date || '所选范围合计', item.count, amounts(item), consumption(item, 'energy', 'missingEnergy'), consumption(item, 'bandwidth', 'missingBandwidth'), consumption(item, 'feeTrx', 'missingFee'), item.otherCount, consumption(item, 'serviceFeeTrx', 'missingServiceFee')];
  const lines = [['日期', '投放笔数', '投放数量（按合约分别合计）', '消耗能量', '消耗带宽（TRC10）', '消耗 TRX', '含失败或异常消耗笔数', '平台服务费 TRX'],
    ...result.items.map(values), values(result.totals), ['统计时区', result.range.zoneLabel],
    ['日期范围', result.range.start || '全部', result.range.end],
    ['日期待补齐（未计入日报，不限日期）', result.pending.undated], ['待最终确认（未计入日报，不限日期）', result.pending.awaitingFinal],
    ['口径', '正式成功投放计笔数和数量；链上费用与平台服务费分列，按原交易链上日期统计；不含其他外部租能量付款；无数据日期不展示']];
  return '\uFEFF' + lines.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
module.exports = { receiptMetrics, statisticsOptions, queryStatistics, statisticsCsv };
