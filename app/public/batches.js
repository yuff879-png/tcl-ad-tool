'use strict';
let batchPage = 1, batchTotal = 0, batchRequest = 0, batchRefreshedAt = 0;
function batchControls() {
  if (!$('#batch-preview')) return;
  const active = snapshot?.state === 'running';
  const blocked = !backendConnected || pendingAction || exited || dirty || snapshot?.energyRecovery || snapshot?.pool?.running
    || ['starting', 'stopping'].includes(snapshot?.state);
  for (const selector of ['#batch-addresses', '#batch-file', '#batch-clear', '#batch-preview']) $(selector).disabled = Boolean(blocked);
  $('#batch-mode').disabled = Boolean(blocked || active);
  if (active) $('#batch-mode').value = snapshot.mode;
  const c = snapshot?.config;
  if (c) {
    text('#batch-token', `${c.assetType} · ${snapshot.preflight?.token?.symbol || '当前投放代币'}`);
    text('#batch-contract', c.assetType === 'TRC10' ? c.tokenId || '请先设置 Token ID' : c.tokenContract || '请先设置广告代币合约');
    text('#batch-amount', c.assetType === 'TRC10' ? c.trc10SendAmount : c.sendAmount);
    text('#batch-interval', `${c.sendIntervalSeconds} 秒`);
  }
  text('#batch-state-note', dirty ? '请先保存或放弃参数修改，再预览名单。' : snapshot?.energyRecovery ? '请先取消自动恢复，再添加批量投放。'
    : active ? `当前为${snapshot.mode === 'live' ? '正式投放' : '模拟监听'}。确认后加入优先队列，当前一笔处理完后接续发送。`
      : '当前已暂停。确认批次后，将按所选模式启动扫描并优先处理这批地址。');
  $$('[data-cancel-manual-batch]').forEach(button => { button.disabled = Boolean(blocked); });
}
async function loadManualBatches() {
  const sequence = ++batchRequest;
  const result = await api('manual-batches?' + new URLSearchParams({ page: batchPage, mode: $('#batch-mode').value }));
  if (sequence !== batchRequest) return;
  batchTotal = result.total;
  const pages = Math.max(1, Math.ceil(batchTotal / result.limit));
  if (batchPage > pages) { batchPage = pages; return loadManualBatches(); }
  text('#batch-queue-manual', num(result.queue.manual)); text('#batch-queue-scan', num(result.queue.scan));
  text('#batch-page-number', `${batchPage} / ${pages}`); text('#batch-total', `共 ${num(batchTotal)} 个批次`);
  $('#batch-prev').disabled = batchPage <= 1; $('#batch-next').disabled = batchPage >= pages;
  $('#batch-empty').hidden = Boolean(result.items.length); $('#batch-table-wrap').hidden = !result.items.length;
  $('#batch-rows').innerHTML = result.items.map(batch => {
    const c = batch.counts, successful = (c.executed || 0) + (c.confirmed || 0) + (c.simulated || 0);
    const pending = (c.prepared || 0) + (c.pending || 0) + (c.uncertain || 0);
    const ended = batch.total - (c.queued || 0) - successful - pending;
    const percent = Math.round((batch.total - (c.queued || 0)) / Math.max(batch.total, 1) * 100);
    return `<tr><td><strong>${escapeHtml(time(batch.created_at))}</strong><small>${batch.mode === 'live' ? '正式投放' : '模拟'} · ${escapeHtml(batch.asset_type)}</small><code title="${escapeHtml(batch.token)}">${escapeHtml(short(batch.token))}</code></td>
      <td><b>${num(batch.total)} 个</b><small>每地址 ${escapeHtml(batch.amount)}</small></td>
      <td><span>${num(successful)} ${batch.mode === 'live' ? '执行成功' : '模拟完成'} · ${num(c.queued)} 等待</span><progress max="100" value="${percent}" aria-label="批次处理进度"></progress><small>${num(pending)} 核查中 · ${num(ended)} 失败或已略过</small></td>
      <td><div class="batch-row-actions"><button class="text-button" data-manual-records="${escapeHtml(batch.id)}">查看记录</button>${c.queued ? `<button class="text-button danger-quiet" data-cancel-manual-batch="${escapeHtml(batch.id)}">取消剩余</button>` : ''}</div></td></tr>`;
  }).join('');
  batchRefreshedAt = Date.now(); batchControls();
}
function batchPreviewHtml(p) {
  const c = p.counts, excluded = c.input - p.eligible;
  return `<div class="batch-confirm-summary"><strong>${num(p.eligible)} 个地址</strong><span>${p.mode === 'live' ? '即将优先投放' : '仅模拟，不发送代币'}</span></div>`
    + details([['投放类型', p.assetType], ['广告代币', `${p.symbol} · ${p.token}`], ['每个地址', p.amount], ['本批代币总量', p.totalAmount],
      ['投放间隔', `${p.intervalSeconds} 秒，沿用当前设置`], ['队列处理', p.running ? '当前一笔结束后优先处理；扫描继续入队' : '确认后启动扫描，并优先处理本批'],
      ['中断后重启', p.restartPolicy === 'skip' ? '未发送地址按原设置略过' : '按原设置继续未发送队列']])
    + `<p class="batch-preview-note">新加入 ${num(c.added)} 个 · 扫描队列提升优先级 ${num(c.promoted)} 个。跳过 ${num(excluded)} 条：无效 ${num(c.invalid)}、名单重复 ${num(c.duplicate)}、黑名单或自身地址 ${num(c.blocked)}、已有记录或正在处理 ${num(c.existing)}。</p>`
    + (p.remainingLimit !== null ? `<p class="batch-preview-note warning">本次剩余地址上限 ${num(p.remainingLimit)} 个，手动和扫描投放共同计入；达到上限仍会暂停。</p>` : '')
    + '<p class="batch-preview-note">不会等待整批最终确认再发下一笔；最终确认继续在后台核查。等待期间已处理的地址会在入队时再次排除。</p>'
    + (p.addresses.length ? `<details class="batch-address-preview" open><summary>核对收款地址${p.eligible > 100 ? '（展示前 100 个）' : ''}</summary><ol>${p.addresses.map(item => `<li><code>${escapeHtml(item.address)}</code>${item.promoted ? '<small>由扫描队列转入</small>' : ''}</li>`).join('')}</ol></details>` : '')
    + (p.skipped.length ? `<details class="batch-address-preview"><summary>查看已跳过的地址（最多展示 50 条）</summary><ul>${p.skipped.map(item => `<li><code>${escapeHtml(item.address)}</code><small>${escapeHtml(item.reason)}</small></li>`).join('')}</ul></details>` : '');
}
$('#batch-preview').addEventListener('click', () => act(async () => {
  const originalText = $('#batch-addresses').value;
  const preview = await api('manual-batches/prepare', { text: originalText, mode: $('#batch-mode').value });
  const label = preview.eligible ? preview.running ? '确认加入优先队列' : preview.mode === 'live' ? '确认启动并投放' : '确认启动模拟' : '';
  const confirmed = await modal(preview.eligible ? '确认这批收款地址' : '没有可加入的地址', batchPreviewHtml(preview), label,
    preview.eligible && preview.mode === 'live' ? '我已核对本批收款地址、当前代币与数量，确认真实投放。' : false);
  if (!confirmed || !preview.eligible) return;
  const result = await api('manual-batches/submit', { confirmationToken: preview.confirmationToken, confirmed: true });
  if ($('#batch-addresses').value === originalText) $('#batch-addresses').value = '';
  text('#batch-input-count', '粘贴地址，或选择名单文件');
  toast(`已加入 ${num(result.count)} 个优先投放地址，发送间隔保持不变`);
  batchPage = 1; await loadManualBatches();
}));
function batchInputCount() {
  const count = $('#batch-addresses').value.split(/[\s,，;；]+/).filter(Boolean).length;
  text('#batch-input-count', count ? `已填写约 ${num(count)} 条，预览时校验并去重` : '粘贴地址，或选择名单文件');
}
$('#batch-addresses').addEventListener('input', batchInputCount);
$('#batch-clear').addEventListener('click', () => { $('#batch-addresses').value = ''; batchInputCount(); });
$('#batch-mode').addEventListener('change', () => { batchControls(); loadManualBatches().catch(error => toast(error.message, true)); });
$('#batch-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('请使用不超过 1 MB 的 UTF-8 TXT 或单列 CSV');
    $('#batch-addresses').value = await file.text(); batchInputCount();
    toast('名单已读取，请预览校验后确认投放');
  } catch (error) { toast(error.message, true); }
  finally { event.target.value = ''; }
});
$('#batch-rows').addEventListener('click', event => {
  const records = event.target.closest('[data-manual-records]');
  if (records) {
    $('#search-records').value = records.dataset.manualRecords; $('#filter-mode').value = ''; $('#filter-status').value = ''; recordPage = 1; go('records'); return;
  }
  const cancel = event.target.closest('[data-cancel-manual-batch]');
  if (cancel) act(async () => {
    if (!await modal('取消这批剩余地址？', '<p>取消本批尚未开始处理的地址。正在处理的一笔继续核查，扫描等待队列按原间隔接续发送。历史记录和地址去重保留。</p>', '确认取消剩余')) return;
    const result = await api('manual-batches/cancel', { id: cancel.dataset.cancelManualBatch }); toast(`已取消 ${num(result.count)} 个等待地址`); await loadManualBatches();
  });
});
$('#batch-prev').addEventListener('click', () => { batchPage--; loadManualBatches().catch(error => toast(error.message, true)); });
$('#batch-next').addEventListener('click', () => { batchPage++; loadManualBatches().catch(error => toast(error.message, true)); });
batchControls();
