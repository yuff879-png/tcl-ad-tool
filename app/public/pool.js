'use strict';
let poolPage = 1, poolTab = 'wallets', poolLoading = false, poolRefreshAt = 0, poolData;
const poolSelection = new Set();
const poolStatus = { inactive: '未激活', checking: '待复核', ready: '可发送', recovering: '恢复中', low: '代币不足', blocked: '需检查' };
function syncAssetFields() {
  const native = $('[name=assetType]:checked')?.value === 'TRC10';
  $$('[data-asset-only]').forEach(el => { el.hidden = el.dataset.assetOnly !== (native ? 'TRC10' : 'TRC20'); });
  for (const name of ['tokenContract', 'sendAmount', 'minEnergy', 'feeLimitTrx', 'reserveTrx']) $('[name=' + name + ']').closest('.field').hidden = native;
  $('#private-key').closest('.setting-section').hidden = native;
}
function renderPoolUI(state) {
  const p = state.pool || {}, native = state.config.assetType === 'TRC10';
  $('[data-page=pool]').hidden = !native;
  $('#pool-overview').hidden = !native;
  $('#wallet-energy').closest('.wallet-card').hidden = native;
  if (currentPage === 'pool' && !native) go('settings');
  if (!dirty) syncAssetFields();
  text('#pool-overview-count', num(p.enabled)); text('#pool-overview-capacity', '≈ ' + num(p.referenceCapacity));
  text('#pool-overview-ready', num(p.ready)); text('#pool-overview-recovering', num(p.recovering));
  text('#pool-overview-note', state.resourceWait || (p.unlocked ? '仅使用免费带宽；不足换钱包，全部不足等待。' : '钱包库已锁定，正式投放前请解锁。'));
  if (native && state.state === 'running' && state.resourceWait) { text('#run-status', '等待免费资源'); text('#run-description', state.resourceWait); }
  if (currentPage === 'pool' && Date.now() - poolRefreshAt > 3000) loadPool().catch(error => toast(error.message, true));
}
function showPoolTab(tab) {
  poolTab = tab; $$('[data-pool-panel]').forEach(el => { el.hidden = el.dataset.poolPanel !== tab; });
  $$('[data-pool-tab]').forEach(el => { el.classList.toggle('selected', el.dataset.poolTab === tab); el.setAttribute('aria-selected', String(el.dataset.poolTab === tab)); });
}
async function loadPool() {
  if (poolLoading) return; poolLoading = true;
  try {
    const p = await api('pool?' + new URLSearchParams({ page: poolPage, search: $('#pool-search').value, state: $('#pool-filter').value })); poolData = p; poolRefreshAt = Date.now(); poolPage = p.wallets.page;
    text('#pool-vault-state', !p.exists ? '尚未创建钱包库' : p.unlocked ? '钱包库已解锁' : '钱包库已锁定');
    text('#pool-backup-state', p.backedUp ? '当前钱包库备份已验证' : '激活或投放前，请先创建并验证完整备份');
    text('#pool-total', num(p.total)); text('#pool-enabled', num(p.enabled)); text('#pool-ready', num(p.ready)); text('#pool-capacity', '≈ ' + num(p.referenceCapacity));
    $('#pool-unlock').hidden = p.unlocked; $('#pool-lock').hidden = !p.unlocked;
    $('#pool-password').hidden = p.unlocked; text('#pool-unlock', p.exists ? '解锁钱包库' : '创建加密钱包库');
    $('#pool-stop').hidden = !p.running;
    text('#pool-progress', p.running ? `${p.progress?.kind === 'generate' ? '正在生成' : '正在准备'} ${num(p.progress?.completed)} / ${num(p.progress?.total)}` : p.progress?.error || (p.progress?.kind === 'generate' ? `已生成 ${num(p.progress.completed)} 个钱包${p.backedUp ? '，备份已验证' : '，请创建并验证备份'}` : '当前没有进行中的准备任务；已广播交易继续后台核查'));
    const active = ['running', 'starting', 'stopping'].includes(snapshot?.state) || p.running;
    $$('[data-pool-idle]').forEach(b => { b.disabled = Boolean(active || pendingAction || dirty); });
    $('#pool-rows').innerHTML = p.wallets.items.map(w => `<tr><td><input type="checkbox" aria-label="选择钱包 ${escapeHtml(w.address)}" data-pool-wallet="${escapeHtml(w.id)}" ${poolSelection.has(w.id) ? 'checked' : ''}></td><td><b>${escapeHtml(w.address)}</b><small>批次 <button class="text-button" data-copy-pool-batch="${escapeHtml(w.batch_id)}" title="复制完整批次 ID">${escapeHtml(w.batch_id.slice(0, 8))} · 复制</button></small></td><td>${escapeHtml(poolStatus[w.state] || w.state)}${w.enabled ? '' : ' · 停用'}<small>${escapeHtml(w.detail)}</small></td><td>${num(w.free_bandwidth)} / ${num(w.free_limit)}</td><td>${escapeHtml(w.balance ?? w.raw_balance)}<small>Token ID ${escapeHtml(w.token_id || '待复核')} · ${w.balance === null ? '最小单位' : escapeHtml(w.symbol)}</small></td><td>${w.checked_at ? escapeHtml(time(w.checked_at)) : '待复核'}</td></tr>`).join('') || '<tr><td colspan="6">还没有匹配的钱包，打开“批量准备”开始。</td></tr>';
    text('#pool-page-info', `${p.wallets.page} / ${p.wallets.pages} · 共 ${num(p.wallets.total)} 个`); $('#pool-prev').disabled = poolPage <= 1; $('#pool-next').disabled = poolPage >= p.wallets.pages;
    $('#pool-batches').innerHTML = p.batches.map(b => `<tr><td>${escapeHtml(b.id.slice(0, 8))}<small>${escapeHtml(time(b.created_at))}</small></td><td>${b.kind === 'activate' ? '激活并分币' : '补充代币'}<small>Token ID ${escapeHtml(b.token_id)}</small></td><td>${b.confirmed} / ${b.total}<small>核查 ${b.pending} · 失败/过期 ${b.failed}</small></td><td>${escapeHtml(b.feeTrx)} TRX<small>${b.missingFees} 笔费用待补齐</small></td><td>${escapeHtml({ running: '处理中', paused: '已暂停', confirming: '后台核查中', completed: '已结束' }[b.status] || b.status)}<small>${escapeHtml(b.detail)}</small></td><td>${b.status === 'paused' ? `<button class="button small" data-resume-pool="${escapeHtml(b.id)}" ${active || pendingAction || dirty ? 'disabled' : ''}>继续本批</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6">暂无准备批次</td></tr>';
  } finally { poolLoading = false; }
}
$$('[data-pool-tab]').forEach(b => b.addEventListener('click', () => showPoolTab(b.dataset.poolTab)));
$('#pool-new').addEventListener('click', () => { showPoolTab('prepare'); $('#pool-generate-count').focus(); });
$('#pool-search-button').addEventListener('click', () => { poolPage = 1; loadPool().catch(e => toast(e.message, true)); });
$('#pool-filter').addEventListener('change', () => { poolPage = 1; loadPool().catch(e => toast(e.message, true)); });
$('#pool-prev').addEventListener('click', () => { poolPage--; loadPool(); }); $('#pool-next').addEventListener('click', () => { poolPage++; loadPool(); });
async function poolAct(fn) { await act(fn); await loadPool(); }
$('#pool-unlock').addEventListener('click', () => poolAct(async () => {
  const password = $('#pool-password').value; $('#pool-password').value = '';
  await api('pool/unlock', { password, initialize: !poolData?.exists }); toast('钱包库已解锁');
}));
$('#pool-lock').addEventListener('click', () => poolAct(async () => { await api('pool/lock', {}); toast('钱包库已锁定'); }));
$('#pool-generate').addEventListener('click', () => poolAct(async () => {
  const count = Number($('#pool-generate-count').value);
  await api('pool/generate', { count }); toast('开始本地生成钱包，请等待完成后备份');
}));
$('#pool-backup').addEventListener('click', () => poolAct(async () => {
  const result = await api('backup', {}); text('#pool-backup-path', '完整备份：' + result.path); toast('备份完成，请验证备份密码');
}));
$('#pool-verify').addEventListener('click', () => poolAct(async () => {
  const password = $('#pool-verify-password').value; $('#pool-verify-password').value = '';
  const result = await api('pool/verify-backup', { password }); toast(`备份验证通过，包含 ${result.count} 个钱包`);
}));
$('#pool-token-check').addEventListener('click', () => poolAct(async () => {
  if (dirty) throw new Error('请先保存参数');
  const token = await api('pool/token', {}); text('#pool-token-info', `${token.symbol} · Token ID ${token.contract} · 精度 ${token.decimals} · 发行者 ${token.issuer}`);
}));
$('#pool-refresh').addEventListener('click', () => poolAct(async () => { await api('pool/refresh', {}); toast('已复核一小批钱包，发送前会再次核验'); }));
for (const [id, enabled] of [['pool-enable', true], ['pool-disable', false]]) $('#' + id).addEventListener('click', () => poolAct(async () => {
  const ids = [...poolSelection]; if (!ids.length) throw new Error('请先选择钱包');
  await api('pool/enabled', { ids, enabled }); poolSelection.clear();
}));
$('#pool-plan').addEventListener('click', () => poolAct(async () => {
  const p = await api('pool/plan', { kind: $('#pool-kind').value, count: $('#pool-activate-count').value, amount: $('#pool-fund-amount').value,
    budgetTrx: $('#pool-budget').value, groupSize: $('#pool-group-size').value, batchId: $('#pool-batch-id').value.trim() });
  const yes = await modal('确认钱包激活 / 分币', details([['代币', `${p.token.symbol} / ${p.token.contract}`], ['资金钱包', p.owner], ['钱包数量', p.total],
    ['每钱包数量', p.amount], ['总代币量', p.totalAmount], ['基础费用估算', p.estimatedTrx + ' TRX'], ['本批预算上限', p.budgetTrx + ' TRX']])
    + '<div class="modal-warning">将由资金钱包发送真实 TRC10。新地址同时激活，费用由资金钱包承担；子钱包不充值 TRX。结果不明的交易只核查，不重复转账。</div>', '确认开始本批', '我已核对代币、数量与总预算，并已保存钱包备份。');
  if (yes) { await api('pool/start', { confirmation: p.confirmation }); showPoolTab('batches'); }
}));
$('#pool-stop').addEventListener('click', () => poolAct(async () => { await api('pool/stop', {}); toast('已暂停准备，原交易继续核查'); }));
$('#pool-batches').addEventListener('click', e => { const b = e.target.closest('[data-resume-pool]'); if (b) poolAct(async () => { await api('pool/resume', { id: b.dataset.resumePool }); }); });
$('#pool-activate-count').addEventListener('input', () => { const n = Number($('#pool-activate-count').value); text('#pool-estimate', Number.isSafeInteger(n) && n > 0 ? `参考容量增加约 ${num(n * 2)} 笔；激活基础费用参考 ${num(n * 1.1)} TRX。执行前读取链参数核实。` : '填写本次处理数量'); });
$$('[name=assetType]').forEach(input => input.addEventListener('change', syncAssetFields));
showPoolTab('wallets');

$('#pool-rows').addEventListener('change', event => { const id = event.target.dataset.poolWallet; if (id) { if (event.target.checked) poolSelection.add(id); else poolSelection.delete(id); } });
$('#pool-rows').addEventListener('click', event => { const button = event.target.closest('[data-copy-pool-batch]'); if (button) navigator.clipboard.writeText(button.dataset.copyPoolBatch).then(() => toast('已复制完整生成批次 ID')).catch(() => toast('复制失败，请重试', true)); });
