'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
// Use Electron's native caption buttons; browsers retain the regular page layout.
const windowControls = navigator.windowControlsOverlay;
const syncWindowControls = () => document.documentElement.classList.toggle('desktop-window', Boolean(windowControls?.visible));
syncWindowControls();
windowControls?.addEventListener('geometrychange', syncWindowControls);
const text = (selector, value) => { $(selector).textContent = value; };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = value => Number(value || 0).toLocaleString('zh-CN');
const wholeToken = value => {
  const match = String(value).match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return '—';
  return (BigInt(match[1]) + (Number(match[2]?.[0] || 0) >= 5 ? 1n : 0n)).toLocaleString('zh-CN');
};
const short = value => value ? (value.length <= 20 ? value : value.slice(0, 9) + '…' + value.slice(-7)) : '—';
const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
let snapshot, dirty = false, selectedMode = 'simulate', currentPage = 'overview', logAfter = 0, recordPage = 1, recordTotal = 0, pendingAction = false, exited = false;
let toastTimer, polling = false, refreshRecordsAt = 0;
let updateRelease = null, updateChecking = false, updateInstalling = false;
let updateDownloadStarting = false, updatePromptVersion = null, updateProgressPolling = false;
let statisticsAssetType = 'TRC20';
let statisticsPage = 1, statisticsRequest = 0, statisticsRefreshAt = 0;
let statisticsFilter = { period: '15', timeZone: 'Asia/Shanghai', token: 'current' };
let recordDialog = null, recordDialogSequence = 0;
let backendConnected = false;
let settingsGroup = 'strategy', addressGroup = 'watch';
const pageEyebrows = { batches: 'MANUAL DELIVERY', pool: 'WALLET POOL', overview: 'WORKSPACE OVERVIEW', statistics: 'CAMPAIGN ANALYTICS', settings: 'CAMPAIGN SETTINGS', addresses: 'AUDIENCE MANAGEMENT', records: 'DELIVERY HISTORY', guide: 'SUPPORT & MAINTENANCE' };
const titles = { batches: ['批量投放', '手动名单优先发送，链上扫描照常运行。'], pool: ['投放钱包池', '数量自定义、分批准备，只使用免费带宽轮换投放。'], overview: ['投放总览', '从链上转账发现目标地址，按规则完成代币触达。'], settings: ['投放参数', '把投放策略、钱包和资源条件放在同一个地方。'],
  statistics: ['投放统计', '按日查看投放数量与实际消耗，掌握每一次触达的成本。'],
  addresses: ['地址管理', '明确监听谁、跳过谁，让每次投放符合你的规则。'], records: ['投放记录', '从触发交易到链上到账，每个地址都有完整记录。'], guide: ['使用与迁移', '一次准备，随文件夹带走你的运行环境和投放进度。'] };
const statuses = { queued: ['等待投放', 'neutral'], prepared: ['已准备 / 待核查', 'warning'], pending: ['等待链上确认', 'warning'], uncertain: ['需核查', 'error'],
  expired_unconfirmed: ['已过期未确认 · 核查已结束', 'warning'],
  archived_unconfirmed: ['已结束核查 · 结果未知', 'warning'],
  executed: ['执行成功 · 待最终确认', 'blue'], skipped_restart: ['重启已略过', 'neutral'],
  confirmed: ['已最终确认到账', 'success'], failed: ['投放失败', 'error'], simulated: ['模拟命中', 'purple'], cancelled: ['已取消', 'neutral'], skipped: ['已跳过', 'neutral'] };
const limitText = value => Number(value) > 0 ? `${num(value)} 个地址` : '无上限';
const sunTrx = value => { if (value == null || !/^\d+$/.test(String(value))) return '待核对'; const s = BigInt(value).toString().padStart(7, '0'); return s.slice(0, -6) + (s.slice(-6).replace(/0+$/, '') ? '.' + s.slice(-6).replace(/0+$/, '') : ''); };
function renderEnergyPlatform(state) {
  const platform = state.energyPlatform || {}, p = platform.policy;
  $('#energy-runtime-status').hidden = !platform.linked;
  text('#energy-runtime-status', platform.linked ? (state.resourceWait || (p ? '平台模式：' + (p.effective_mode === 'seamless' ? '无感能量，已有资源优先' : '普通租赁，本地广播') + (p.desired_mode !== p.effective_mode ? ' · 切换中' : '') : '等待同步平台模式')) : '');
  text('#energy-connection-state', platform.linked ? `已连接平台 · ${platform.wallet}` : '独立本地模式');
  text('#energy-policy-state', platform.linked ? (platform.error ? platform.error + ' · ' : '') + (p ? `${p.effective_mode === 'seamless' ? '无感能量' : '普通租赁 / 本地广播'} · ${p.desired_mode !== p.effective_mode ? '切换中' : platform.fresh ? '策略有效' : '策略过期，暂停新发送'} · 无感售价 ${sunTrx(p.price_sun)} TRX / 笔 · TRX 停止线 ${sunTrx(p.trx_stop_sun)} / 恢复线 ${sunTrx(p.trx_resume_sun)} · ${p.auto_resume ? '自动恢复开启' : '需平台手动恢复'}${p.low_trx_latched ? ' · 余额保护等待中' : ''} · 版本 ${p.revision}` : '等待平台策略') : '查询、签名与广播均按原本地设置运行，无需平台连接。');
  $('#energy-pair-fields').hidden = Boolean(platform.linked);
  $('#energy-pair').hidden = Boolean(platform.linked); $('#energy-sync').hidden = !platform.linked; $('#energy-disconnect').hidden = !platform.linked;
  $('#energy-pending-guide').hidden = !state.pending;
  const reporting = state.deliveryReporting;
  text('#delivery-report-state', reporting?.linked
    ? `投放统计：平台已接收 ${num(reporting.accepted)} 笔（平台核验后计入） · 待补报 ${num(reporting.queued)} 笔`
      + (reporting.unreportable ? ` · 历史凭据待补齐 ${num(reporting.unreportable)} 笔` : '')
      + (reporting.rejected ? ` · 未通过接收 ${num(reporting.rejected)} 笔` : '')
      + (reporting.unlockRequired ? ' · 请解锁原投放钱包库，自动补报钱包池记录' : '')
      + (reporting.error ? ' · 平台暂未接收，已保存在本机自动重试，不影响投放' : '')
    : '连接平台后自动同步已最终确认的投放记录；独立本地模式的记录保留在本机。');
}
async function api(route, body) {
  const response = await fetch('/api/' + route, { signal: AbortSignal.timeout(route === 'update/install' ? 180000 : route.startsWith('pool/') || ['records/prepare-retry', 'records/retry'].includes(route) ? 120000 : 30000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TCL-Request': '1' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function toast(message, error = false) {
  text('#toast', message); $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 4500);
}
async function act(fn) {
  if (pendingAction) return;
  if (fn === save && !validateSettings()) return;
  pendingAction = true; updateControls();
  try { await fn(); }
  catch (error) { toast(error.message, true); }
  finally { pendingAction = false; updateControls(); if (!exited) await refresh().catch(() => {}); }
}
function go(page) {
  if (!titles[page]) return;
  currentPage = page;
  $$('[data-section]').forEach(el => { el.hidden = el.dataset.section !== page; });
  $$('.nav').forEach(el => { const selected = el.dataset.page === page; el.classList.toggle('active', selected); if (selected) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  text('#breadcrumb', titles[page][0]); text('#page-title', titles[page][0]); text('#page-description', titles[page][1]);
  text('#page-eyebrow', pageEyebrows[page]);
  $$('[data-heading]').forEach(el => { el.hidden = !el.dataset.heading.split(' ').includes(page); });
  document.title = titles[page][0] + ' · TCL 广告投放工作台';
  (windowControls?.visible ? document.body : window).scrollTo({ top: 0 });
  if (page === 'batches') loadManualBatches().catch(error => toast(error.message, true));
  if (page === 'pool') loadPool().catch(error => toast(error.message, true));
  if (page === 'records') loadRecords().catch(error => toast(error.message, true));
  if (page === 'statistics') loadStatistics();
  if (page === 'guide') loadUpdate().catch(error => toast(error.message, true));
}
$$('.nav').forEach(el => el.addEventListener('click', () => go(el.dataset.page)));
$$('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
function list(value) { return [...new Set(value.split(/[\s,，;；]+/).map(v => v.trim()).filter(Boolean))]; }
function updateAddressCounts() {
  const watched = list($('#watched-addresses').value).length, blocked = list($('#blacklist').value).length;
  text('#watched-count', watched); text('#blacklist-count', blocked);
  text('#watch-count-card', num(watched)); text('#black-count-card', num(blocked));
  for (const [selector, lineId] of [['#watched-addresses', '#watch-lines'], ['#blacklist', '#black-lines']]) {
    text(lineId, Array.from({ length: Math.max(8, $(selector).value.split('\n').length) }, (_, i) => i + 1).join('\n'));
  }
  const source = $(addressGroup === 'watch' ? '#watched-addresses' : '#blacklist').value;
  const entries = source.split(/[\s,，;；]+/).filter(Boolean), unique = list(source).length;
  text('#address-validation', `${num(unique)} 个地址${entries.length > unique ? ` · ${entries.length - unique} 条重复，保存时去重` : ' · 无重复'}；保存时校验格式`);
}
function renderDirty() {
  $('#dirty-banner').hidden = !dirty;
  text('#settings-save-status', dirty ? '有未保存的修改' : '配置已保存');
  $('#settings-save-status').classList.toggle('dirty', dirty);
  text('#addresses-dirty', dirty ? '有未保存的修改，保存地址时会一并保存参数' : '名单已保存；新增或导入后请再次保存');
}
function syncLimitChoices() {
  $$('[name=limitMode]').forEach(el => { el.checked = el.value === ($('#limit-enabled').checked ? 'custom' : 'unlimited'); });
  $('#limit-number').hidden = !$('#limit-enabled').checked;
}
function markDirty() { dirty = true; renderDirty(); updateAddressCounts(); updateControls(); }
function fillConfig(config) {
  for (const input of $$('#settings-form [name]')) {
    if (input.name === 'limitMode') continue;
    if (input.type === 'checkbox') input.checked = Boolean(config[input.name]);
    else if (input.type === 'radio') input.checked = input.value === config[input.name];
    else input.value = config[input.name] ?? '';
  }
  $('#watched-addresses').value = config.watchedAddresses.join('\n'); $('#blacklist').value = config.blacklist.join('\n');
  $('#clear-private').checked = false; $('#clear-api').checked = false; $('#clear-pool-funding').checked = false;
  text('#pool-funding-status', config.hasPoolFundingKey ? '已保存：' + config.poolFundingAddress + '；留空保留。' : '未配置；只在激活、分币和补币时使用。');
  text('#key-status', config.hasPrivateKey ? '已保存私钥。留空保留原值，输入新值替换；清除请勾选下方选项。' : '尚未配置私钥。模拟监听无需私钥；正式投放时必须填写。');
  $('[name=apiKey]').placeholder = config.hasApiKey ? '已有 API Key，留空保留' : '尚未配置，可填写 TronGrid API Key';
  $('#limit-enabled').checked = config.maxPerRun > 0;
  $('[name=maxPerRun]').value = config.maxPerRun > 0 ? config.maxPerRun : '';
  $('#private-key').type = 'password'; text('#show-key', '显示');
  dirty = false; renderDirty(); syncLimitChoices(); updateAddressCounts(); if (typeof syncAssetFields === 'function') syncAssetFields();
}
function configInput() {
  const result = {};
  for (const input of $$('#settings-form [name]')) {
    if (input.name === 'limitMode' || (input.type === 'radio' && !input.checked)) continue;
    result[input.name] = input.type === 'checkbox' ? input.checked : input.value;
  }
  const limit = $('[name=maxPerRun]').value.trim();
  if ($('#limit-enabled').checked && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100000)) {
    throw new Error('自定义地址上限请填写 1～100000 的整数；如需无上限，请关闭自定义上限。');
  }
  result.maxPerRun = $('#limit-enabled').checked ? Number(limit) : 0;
  result.watchedAddresses = list($('#watched-addresses').value); result.blacklist = list($('#blacklist').value);
  result.clearSecrets = [$('#clear-private').checked ? 'privateKey' : '', $('#clear-api').checked ? 'apiKey' : '', $('#clear-pool-funding').checked ? 'poolFundingKey' : ''].filter(Boolean);
  return result;
}
function validateSettings() {
  const invalid = $$('#settings-form input, #settings-form select').find(el => !el.disabled && !el.checkValidity());
  if (invalid) { go('settings'); const panel = invalid.closest('[data-settings-panel]'); if (panel) selectSettingsGroup(panel.dataset.settingsPanel); invalid.reportValidity(); toast('请检查标出的参数后再保存', true); return false; }
  return true;
}
async function save() {
  const input = configInput();
  if (snapshot && input.assetType !== snapshot.config.assetType && !await modal('切换到 ' + input.assetType + '？', '<p>一次只运行一种投放类型。当前已广播交易继续后台核查，不自动补发；切换后请重新预检并手动启动。</p>', '确认切换并保存')) return;
  const config = await api('config', input); fillConfig(config); toast('设置已保存');
}
$('#settings-form').addEventListener('input', markDirty);
$('#limit-enabled').addEventListener('change', () => {
  if ($('#limit-enabled').checked && !$('[name=maxPerRun]').value) $('[name=maxPerRun]').value = '100';
  syncLimitChoices(); markDirty();
});
$('#settings-form').addEventListener('submit', event => { event.preventDefault(); act(save); });
$('#watched-addresses').addEventListener('input', markDirty); $('#blacklist').addEventListener('input', markDirty);
$('#save-top').addEventListener('click', () => act(save)); $('#save-addresses').addEventListener('click', () => act(save));
$('#discard').addEventListener('click', () => { if (snapshot) fillConfig(snapshot.config); updateControls(); });
$('#show-key').addEventListener('click', () => { const input = $('#private-key'); input.type = input.type === 'password' ? 'text' : 'password'; text('#show-key', input.type === 'password' ? '显示' : '隐藏'); });
for (const [selector, target] of [['#import-watch', '#watched-addresses'], ['#import-black', '#blacklist']]) {
  $(selector).addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('请使用小于 2 MB 的名单文件');
      const source = await file.text();
      const addresses = source.match(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g) || [];
      if (!addresses.length) throw new Error('文件中未找到 T 开头的地址，请使用 UTF-8 TXT 或 CSV');
      const old = list($(target).value); $(target).value = [...new Set([...old, ...addresses])].join('\n');
      markDirty(); toast(`已读取 ${addresses.length} 个地址，合并去重后 ${list($(target).value).length} 个；请保存`);
    } catch (error) { toast(error.message, true); }
    finally { event.target.value = ''; }
  });
}
function updateControls() {
  const recovering = Boolean(snapshot?.energyRecovery);
  const active = snapshot && (['running', 'starting', 'stopping'].includes(snapshot.state) || recovering || snapshot.pool?.running);
  for (const selector of ['#energy-pair', '#energy-disconnect', '#energy-platform-url', '#energy-pair-code']) $(selector).disabled = Boolean(active || pendingAction || dirty || exited);
  $('#energy-sync').disabled = Boolean(pendingAction || exited);
  $('#start').disabled = pendingAction || active || dirty || exited;
  $('#stop').disabled = pendingAction || exited || (snapshot?.state !== 'running' && !recovering && !snapshot?.pool?.running);
  $('#stop').innerHTML = uiIcon('pause') + (recovering ? '取消自动恢复' : '暂停任务');
  $('#cancel-energy-recovery').disabled = pendingAction || exited || !recovering;
  $('#preflight').disabled = pendingAction || active || dirty || exited;
  for (const el of $$('#settings-form input, #settings-form select, #watched-addresses, #blacklist, .save-button, #save-top, #import-watch, #import-black, #discard')) el.disabled = Boolean(active || pendingAction || exited);
  for (const el of $$('#discard-settings, #show-key, #import-active, [data-click=preflight]')) el.disabled = Boolean(active || pendingAction || exited || (el.dataset.click === 'preflight' && dirty));
  $('#settings-lock').hidden = !active;
  text('#settings-lock b', recovering ? '正在等待能量恢复，参数已锁定' : '任务运行中，参数已锁定');
  text('#settings-lock span', recovering ? '点击上方「取消自动恢复」后即可修改开关和参数。' : '返回投放总览暂停后即可编辑。');
  $('[name=maxPerRun]').disabled = Boolean(active || pendingAction || exited || !$('#limit-enabled').checked);
  $('[name=maxPerRun]').required = $('#limit-enabled').checked;
  $('[name=energyRecoverySeconds]').disabled = Boolean(active || pendingAction || exited || !$('[name=autoResumeEnergy]').checked);
  text('#limit-badge', $('#limit-enabled').checked ? `本次上限 ${$('[name=maxPerRun]').value || '待填写'} 个` : '无上限');
  for (const selector of ['#mode-simulate', '#mode-live', '#reconcile', '#cancel-queued', '#reset-cursor', '#backup']) $(selector).disabled = Boolean(active || pendingAction || exited);
  const reviewExpired = Boolean(recordDialog?.row.recovery?.can_close && !recordReviewFresh(recordDialog.row));
  const retryExpired = Boolean(recordDialog?.retry?.eligible && !recordRetryFresh(recordDialog.retry));
  for (const el of $$('[data-record-action]')) el.disabled = Boolean(!snapshot || active || pendingAction || exited || el.dataset.blocked === 'true' || (reviewExpired && ['close', 'submit-close'].includes(el.dataset.recordAction))
    || (['prepare-retry', 'submit-retry'].includes(el.dataset.recordAction) && (!backendConnected || dirty))
    || (el.dataset.recordAction === 'submit-retry' && (retryExpired || recordDialog?.retryAttempted)));
  if ($('#record-review-expired')) $('#record-review-expired').hidden = !reviewExpired;
  if ($('#record-retry-expired')) $('#record-retry-expired').hidden = !retryExpired;
  if ($('#record-retry-offline')) $('#record-retry-offline').hidden = backendConnected;
  if ($('#record-retry-idle')) $('#record-retry-idle').hidden = !active;
  if ($('#record-retry-progress')) {
    $('#record-retry-progress').hidden = !recordDialog?.retryWorking;
    text('#record-retry-progress-text', recordDialog?.retryCancelRequested ? '已请求停止后续操作，正在等待当前请求结束。' : recordDialog?.retryWorking === 'send' ? '正在处理本笔补发；已提交的交易仍会继续核查。' : '正在检查原交易和相关历史记录…');
    $('#record-retry-stop').disabled = Boolean(recordDialog?.retryCancelRequested || exited);
  }
  for (const el of $$('#record-close-note, #record-close-confirmed, #record-retry-confirmed')) el.disabled = Boolean(active || pendingAction || exited || (el.id === 'record-retry-confirmed' && (!backendConnected || retryExpired)));
  if (recordDialog) $('#modal-cancel').disabled = pendingAction;
  const downloading = ['downloading', 'verifying'].includes(updateRelease?.download?.phase);
  const ready = updateRelease?.download?.phase === 'ready';
  for (const selector of ['#check-update', '#sidebar-check-update']) $(selector).disabled = Boolean(updateChecking || updateRelease?.checking || downloading || updateDownloadStarting || pendingAction || exited);
  $('#version-update').disabled = exited;
  for (const selector of ['#download-update', '#sidebar-download-update']) $(selector).disabled = Boolean(!updateRelease?.available || updateChecking || updateRelease?.checking || downloading || updateDownloadStarting || pendingAction || exited);
  for (const selector of ['#install-update', '#sidebar-install-update']) $(selector).disabled = Boolean(!ready || pendingAction || exited || dirty || snapshot?.state === 'starting' || snapshot?.state === 'stopping');
  $('#update-action-hint').hidden = !updateRelease?.available || downloading || updateInstalling;
  text('#update-hint-title', dirty ? '安装前请先保存或放弃未保存的设置' : active ? '安装更新前需要暂停投放' : ready ? '下载校验完成，等待你确认安装' : '先下载新版本，完成后再确认安装');
  text('#update-hint-detail', active ? '检查与下载可以正常进行。下载完成后确认安装，会先暂停投放并自动备份。' : dirty ? '你可以先下载更新包，设置处理完成后再安装。' : snapshot?.pending ? `还有 ${num(snapshot.pending)} 笔待核查记录，会随数据保留，更新后继续核查。` : '保留钱包、参数和投放记录；安装后重新打开，保持暂停。');
  for (const mode of ['live', 'simulate']) $('#clear-delivered-' + mode).disabled = Boolean(!snapshot || active || pendingAction || exited || dirty || snapshot.pending || !snapshot.counts.delivered[mode]);
  const label = pendingAction ? '处理中…' : selectedMode === 'live' ? '开始正式投放' : '开始模拟监听';
  $('#start').innerHTML = uiIcon('play') + label;
  $('#start').hidden = Boolean(active); $('#stop').hidden = !active;
  if (typeof batchControls === 'function') batchControls();
}
function selectMode(mode) {
  selectedMode = mode;
  for (const m of ['simulate', 'live']) { $('#mode-' + m).classList.toggle('selected', mode === m); $('#mode-' + m).setAttribute('aria-pressed', String(mode === m)); }
  text('#mode-description', mode === 'simulate' ? '仅记录命中，不发送代币' : '将发送真实代币，启动前需确认参数'); updateControls();
}
$('#mode-simulate').addEventListener('click', () => selectMode('simulate')); $('#mode-live').addEventListener('click', () => selectMode('live'));
function modal(title, html, confirmLabel = '确认', requireCheck = false) {
  text('#modal-title', title); $('#modal-body').innerHTML = html;
  text('#modal-confirm', confirmLabel); $('#modal-confirm').hidden = !confirmLabel; $('#modal-confirm').disabled = requireCheck;
  $('.modal-actions').hidden = !confirmLabel;
  $('#modal-cancel').disabled = false;
  if (requireCheck) {
    const label = document.createElement('label'); label.className = 'confirm-check';
    const check = document.createElement('input'); check.type = 'checkbox'; check.id = 'confirm-real';
    check.addEventListener('change', () => { $('#modal-confirm').disabled = !check.checked; });
    label.append(check, document.createTextNode(typeof requireCheck === 'string' ? requireCheck : '我已核对完整合约与数量，确认开始真实代币投放。')); $('#modal-body').append(label);
  }
  $('#modal').showModal();
  return new Promise(resolve => {
    let result = false;
    $('#modal-confirm').onclick = () => { result = true; $('#modal').close(); };
    $('#modal-cancel').onclick = dismissModal;
    $('#modal').onclose = () => resolve(result);
  });
}
function details(rows) { return rows.map(([key, value]) => `<div class="detail-row"><span>${escapeHtml(key)}</span><b>${escapeHtml(value)}</b></div>`).join(''); }
function dismissModal() {
  if ($('#modal-cancel').disabled || (recordDialog && pendingAction)) return;
  $('#modal').close();
}
$('#modal').addEventListener('cancel', event => { if ($('#modal-cancel').disabled || (recordDialog && pendingAction)) event.preventDefault(); });
// Only a pointer gesture wholly on the backdrop dismisses the dialog.
// Selecting text inside and releasing outside must not discard a confirmation.
let modalBackdropPointer = null;
function onModalBackdrop(event) {
  if (event.target !== $('#modal')) return false;
  const rect = $('#modal').getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}
$('#modal').addEventListener('pointerdown', event => {
  modalBackdropPointer = event.button === 0 && onModalBackdrop(event) ? event.pointerId : null;
});
$('#modal').addEventListener('pointerup', event => {
  const dismiss = modalBackdropPointer === event.pointerId && onModalBackdrop(event);
  modalBackdropPointer = null;
  if (dismiss) dismissModal();
});
$('#modal').addEventListener('pointercancel', () => { modalBackdropPointer = null; });
$('#modal').addEventListener('close', () => { modalBackdropPointer = null; });
function recordReviewFresh(row) {
  const age = Date.now() - Date.parse(row.recovery?.checked_at);
  return Number.isFinite(age) && age >= -5000 && age < 60000;
}
function recordRetryFresh(retry) {
  const expiresAt = Date.parse(retry?.expiresAt);
  return retry?.eligible === true && typeof retry.confirmationToken === 'string' && retry.confirmationToken.length > 0
    && Number.isFinite(expiresAt) && expiresAt > Date.now();
}
function recordRetryProgress() {
  return '<div id="record-retry-progress" class="record-retry-progress" role="status" hidden><p id="record-retry-progress-text"></p><button type="button" class="button" id="record-retry-stop">停止后续操作</button><small>停止不会撤回已经提交的交易，原交易仍会继续核查。</small></div>';
}
async function stopRecordRetry() {
  if (!recordDialog?.retryWorking || recordDialog.retryCancelRequested) return;
  const target = recordDialog;
  target.retryCancelRequested = true; target.retry = null; updateControls();
  try { await api('stop', {}); }
  catch (error) { toast('停止请求未确认：' + error.message + '。请继续核对原交易结果。', true); }
}
function recordDetails(row) {
  const state = statuses[row.status] || [row.status, 'neutral'];
  return details([['状态', state[0]], ['收款地址', row.address], ['广告合约', row.token], ['投放数量', row.amount], ['来源', row.source_kind === 'manual' ? '手动批量投放 · ' + row.manual_batch_id : '链上扫描'], ['触发交易哈希', row.source_asset === 'MANUAL' ? '手动添加，无触发交易' : row.source_tx], ['投放交易哈希', row.txid || '未广播'],
    ['发送尝试', row.energyOrder?.submitted ? '平台提交；不在本地重发' : row.retry ? `${row.retry.attempts} / 4 次（首次 + 最多补试 3 次）${row.retry.exhausted ? '；已停止重试' : ''}` : '旧版记录，首次处理时补齐'],
    ['地址去重', row.dedupe_cleared_at ? `已于 ${time(row.dedupe_cleared_at)} 解除，历史明细保留` : '保留'], ['记录说明', row.detail], ['更新时间', time(row.updated_at)]])
    + (row.energyOrder?.submitted ? details([['平台订单', row.energyOrder.order_id || row.energyOrder.intent_id], ['广播路线', row.energyOrder.route === 'catfee' ? '无感补能' : row.energyOrder.route === 'local' ? '已有资源直发' : '待确认'],
      ['平台服务费', sunTrx(row.energyOrder.customer_fee_sun) + ' TRX'], ['计费状态', ({ frozen: '预留中', charged: '已扣款', released: '已释放预留', free: '免费直发' })[row.energyOrder.billing_status] || '待核对'], ['平台说明', row.energyOrder.detail]]) : '')
    + (row.energyOrder?.first_submit_error ? details([['首次提交失败原因', row.energyOrder.first_submit_error.message], ['首次提交失败时间', time(row.energyOrder.first_submit_error.at)]]) : '')
    + (row.recovery?.closed_at ? details([['结束核查时间', time(row.recovery.closed_at)], ['结束说明', row.recovery.note || '—']]) : '')
    + recordTimeline(row)
    + (row.attempts?.length ? '<h3 class="record-attempt-heading">交易尝试记录</h3>' + row.attempts.map(attempt => details([['交易哈希', attempt.txid], ['状态', ({ prepared: '已准备', pending: '等待回执', uncertain: '需核查', executed: '执行成功', confirmed: '最终确认', failed_pending: '执行失败，待最终确认', failed_final: '已确认失败', expired: '已核实过期且未上链', expired_unconfirmed: '已过期未确认，原任务已结束', archived_unconfirmed: '已结束核查，结果仍未知', not_broadcast: '平台明确未广播' })[attempt.status] || attempt.status], ['说明', attempt.detail]])).join('') : '');
}
function renderRecordDetail(row) {
  if (!recordDialog || recordDialog.id !== row.id || !$('#modal').open) return;
  recordDialog.row = row;
  recordDialog.retry = null;
  text('#modal-title', '投放记录详情');
  $('#modal-body').innerHTML = '<div id="record-action-error" class="banner error" role="alert" hidden></div>' + recordRetryProgress()
    + (row.manualRetry && row.energyOrder ? `<section class="record-recovery record-retry"><div><strong>失败补发</strong><p>${escapeHtml(row.manualRetry.reason || '先检查原交易与历史记录，符合条件后可单独补发本笔。')}</p></div><div class="record-recovery-actions"><button type="button" class="button primary" data-record-action="prepare-retry" data-blocked="${row.manualRetry.canPrepare !== true}">${uiIcon('refresh')}检查补发</button></div><p class="record-recovery-note">仅处理当前这一笔，原数量、历史和去重记录保留。每轮重新检查，通过后仍需确认发送。</p><p id="record-retry-idle" class="record-retry-status" role="status" hidden>请先回投放总览暂停任务，并取消自动恢复，再检查补发。</p><p id="record-retry-offline" class="record-retry-status" role="status" hidden>本机服务连接中断，恢复后重新检查。</p></section>` : '')
    + (row.recovery ? `<section class="record-recovery"><div><strong>处理本笔核查</strong><p>${escapeHtml(row.recovery.reason || '先重新核查，符合条件后可结束本笔核查。')}</p>${row.recovery.checked_at ? `<small>最近核查 ${escapeHtml(time(row.recovery.checked_at))}</small>` : ''}</div><div class="record-recovery-actions"><button type="button" class="button" data-record-action="recheck" data-blocked="${row.recovery.can_recheck !== true}">${uiIcon('refresh')}重新核查</button><button type="button" class="button danger-quiet" data-record-action="close" data-blocked="${row.recovery.can_close !== true}">${row.recovery.close_action === 'archive' ? '结束核查（结果未知）' : '结束核查'}</button></div><p class="record-recovery-note">请先暂停投放。结束核查保留交易与去重记录，不会重新投放；平台订单需由原平台处理。</p></section>` : '')
    + '<div id="record-review-expired" class="banner warning" role="status" hidden>本次核查资格已过期，请重新核查后再结束。</div>'
    + recordDetails(row);
  $('[data-record-action=recheck]')?.addEventListener('click', () => runRecordAction('recheck'));
  $('[data-record-action=close]')?.addEventListener('click', () => showRecordClosure(row));
  $('[data-record-action=prepare-retry]')?.addEventListener('click', prepareRecordRetry);
  $('#record-retry-stop').addEventListener('click', stopRecordRetry);
  updateControls();
}
function retryHistories(histories) {
  if (!Array.isArray(histories) || !histories.length) return '';
  return `<details class="record-retry-history"><summary>相关历史记录（${histories.length} 条）</summary>${histories.map(item =>
    `<article>${details([['状态', statuses[item.status]?.[0] || item.status || '待核对'], ['数量', item.amount ?? '—'], ['记录时间', item.created_at ? time(item.created_at) : '—'], ['交易哈希', item.txid || '未保存交易哈希'], ['核查说明', item.reason || '请核对历史记录']])}</article>`).join('')}</details>`;
}
function renderRecordRetry(result) {
  if (!recordDialog || !$('#modal').open) return;
  const retry = result.retry;
  recordDialog.row = result.record; recordDialog.retry = retry;
  text('#modal-title', retry.eligible ? '确认补发本笔' : '本笔暂不能补发');
  $('#modal-body').innerHTML = '<div id="record-action-error" class="banner error" role="alert" hidden></div>' + recordRetryProgress()
    + `<div class="record-retry-intro ${retry.eligible ? '' : 'blocked'}"><strong>${retry.eligible ? '检查通过，等待你确认' : '检查未通过'}</strong><p>${escapeHtml(retry.reason || '请查看核查结果。')}</p></div>`
    + details([['发送钱包', retry.sender || result.record.wallet || '待核对'], ['收款地址', retry.recipient || result.record.address], ['广告合约', retry.contract || result.record.token], ['本笔数量', retry.amount || result.record.amount], ['平台服务费上限', retry.serviceFeeSun == null ? '待核对' : sunTrx(retry.serviceFeeSun) + ' TRX'], ['链上执行费用上限', retry.feeLimitSun == null ? '待核对' : sunTrx(retry.feeLimitSun) + ' TRX']])
    + '<p class="record-recovery-note">链上带宽费另从发送钱包支付，实际费用以链上回执为准。平台仍按原规则核对到账后结算。</p>'
    + retryHistories(retry.histories)
    + '<div id="record-retry-expired" class="banner warning" role="status" hidden>本次确认已过期，请返回重新检查补发。</div>'
    + '<div id="record-retry-offline" class="banner warning" role="status" hidden>本机服务连接中断，本次确认已失效，请恢复后重新检查。</div>'
    + (retry.eligible ? `<form id="record-retry-form"><label class="confirm-check"><input type="checkbox" id="record-retry-confirmed">我已核对地址、代币和数量，确认只补发这一笔真实代币。</label><p class="record-recovery-note">不会启动扫描或其他投放。原交易与本次尝试都会保留；提交结果不明时只核查原单。</p><div class="record-recovery-actions"><button type="button" class="button" data-record-action="back">返回详情</button><button type="submit" class="button primary" data-record-action="submit-retry" data-blocked="true">确认补发本笔</button></div></form>`
      : '<div class="record-recovery-actions"><button type="button" class="button" data-record-action="back">返回详情</button></div>');
  $('[data-record-action=back]').addEventListener('click', () => renderRecordDetail(recordDialog.row));
  $('#record-retry-stop').addEventListener('click', stopRecordRetry);
  $('#record-retry-confirmed')?.addEventListener('change', () => { $('[data-record-action=submit-retry]').dataset.blocked = String(!$('#record-retry-confirmed').checked); updateControls(); });
  $('#record-retry-form')?.addEventListener('submit', event => { event.preventDefault(); submitRecordRetry(); });
  updateControls();
}
async function prepareRecordRetry() {
  if (!recordDialog || pendingAction || !backendConnected || dirty || recordDialog.row.manualRetry?.canPrepare !== true) return;
  const target = recordDialog;
  target.retryWorking = 'check'; target.retryCancelRequested = false;
  await act(async () => {
    try {
      const result = await api('records/prepare-retry', { id: target.id });
      if (target.retryCancelRequested) throw new Error('已停止本次补发检查');
      if (!result?.record || result.record.id !== target.id || typeof result.retry?.eligible !== 'boolean') throw new Error('补发检查结果不匹配，请重新检查');
      if (result.retry.eligible && !recordRetryFresh(result.retry)) throw new Error('补发确认已过期，请重新检查');
      if (recordDialog?.sequence === target.sequence) {
        // Only a new, validated preview can unlock a new confirmation. Never
        // reuse a consumed token after a lost response or a second click.
        if (result.retry.eligible) target.retryAttempted = false;
        renderRecordRetry(result);
      }
    } catch (error) {
      target.retry = null;
      if (recordDialog?.sequence === target.sequence && $('#record-action-error')) { text('#record-action-error', error.message + '；本次检查没有发送交易。'); $('#record-action-error').hidden = false; }
      throw error;
    } finally { target.retryWorking = null; }
  });
}
async function submitRecordRetry() {
  if (!recordDialog || pendingAction || !backendConnected || dirty || recordDialog.retryAttempted || !recordRetryFresh(recordDialog.retry) || !$('#record-retry-confirmed')?.checked) return;
  const target = recordDialog, confirmationToken = target.retry.confirmationToken;
  // Consume this UI confirmation before the request. A lost reply must never
  // turn a second click into another signing/submission request.
  target.retryAttempted = true; target.retry = null; target.retryWorking = 'send'; target.retryCancelRequested = false;
  await act(async () => {
    try {
      const row = await api('records/retry', { id: target.id, confirmationToken, confirmed: true });
      if (!row || row.id !== target.id) throw new Error('返回记录不匹配');
      if (recordDialog?.sequence === target.sequence) renderRecordDetail(row);
      toast(row.status === 'confirmed' ? '本笔补发已确认到账，历史与费用已保留。' : row.manualRetry?.reason || '本笔补发请求已处理，正在核查原单结果。');
      await loadRecords();
    } catch (error) {
      if (recordDialog?.sequence === target.sequence) {
        renderRecordDetail(target.row);
        text('#record-action-error', error.message + '；补发结果尚未核实，请重新核查原记录，不要重复发送。'); $('#record-action-error').hidden = false;
      }
      throw error;
    } finally { target.retryWorking = null; }
  });
}
async function showRecordDetail(row) {
  const sequence = ++recordDialogSequence;
  recordDialog = { id: row.id, row, sequence };
  const closed = modal('投放记录详情', '', '');
  renderRecordDetail(row);
  await closed;
  if (recordDialog?.sequence === sequence) recordDialog = null;
}
function showRecordClosure(row) {
  if (!recordDialog || pendingAction || row.recovery?.can_close !== true || !recordReviewFresh(row)) return;
  const archive = row.recovery.close_action === 'archive', failed = row.recovery.close_action === 'fail';
  text('#modal-title', archive ? '结束核查，保留结果未知' : '结束本笔核查');
  const explanation = archive
    ? '这是历史本地 TRC20 记录，原始有效期缺失或节点无法完成核查；保存超过 24 小时只是允许人工处理的等待条件，不能证明交易过期或失败。确认后标记“已结束核查·结果未知”，停止自动核查和重试；历史、未知费用与地址去重保留。以后仍可手动重新核查，绝不补发。'
    : failed ? '已查到原交易的最终失败结果。结束前会再次核查；确认后结束原任务并停止重试，保留实际费用、历史、交易哈希和地址去重，不再补发。'
      : '结束前会再次查询原交易。只有已过期且符合核查条件的本地记录才能按过期结束；节点无记录仍不能证明交易绝对未执行。结束后标记为“已过期未确认”，不计成功、不再补发，历史、交易哈希与地址去重全部保留。';
  const confirmation = archive
    ? '我确认结果仍未知，停止自动核查和重试；保留历史、未知费用和去重，不代表交易失败或过期。'
    : '我已核对，确认按本次核查结果结束原任务；保留历史与去重，原任务不再补发。';
  $('#modal-body').innerHTML = '<div id="record-action-error" class="banner error" role="alert" hidden></div>'
    + details([['收款地址', row.address], ['投放交易哈希', row.txid || '未广播']])
    + `<div class="modal-warning">${escapeHtml(explanation)}</div>`
    + '<div id="record-review-expired" class="banner warning" role="status" hidden>本次核查资格已过期，请返回详情重新核查。填写的说明暂时保留。</div>'
    + `<form id="record-close-form"><label class="record-close-note" for="record-close-note">处理说明<textarea id="record-close-note" rows="3" maxlength="500" placeholder="填写核对经过或结束原因" required></textarea></label><label class="confirm-check"><input type="checkbox" id="record-close-confirmed">${escapeHtml(confirmation)}</label><div class="record-recovery-actions"><button type="button" class="button" data-record-action="back">返回详情</button><button type="submit" class="button danger-quiet" data-record-action="submit-close" data-blocked="true">${archive ? '确认结束，保留结果未知' : '确认结束核查'}</button></div></form>`;
  const sync = () => { $('[data-record-action=submit-close]').dataset.blocked = String(!$('#record-close-confirmed').checked || !$('#record-close-note').value.trim()); updateControls(); };
  $('#record-close-note').addEventListener('input', sync);
  $('#record-close-confirmed').addEventListener('change', sync);
  $('[data-record-action=back]').addEventListener('click', () => renderRecordDetail(recordDialog.row));
  $('#record-close-form').addEventListener('submit', event => { event.preventDefault(); if (recordReviewFresh(row) && $('#record-close-confirmed').checked && $('#record-close-note').value.trim()) runRecordAction('close-review', { confirmed: true, note: $('#record-close-note').value.trim(), expected_action: row.recovery.close_action }); });
  updateControls();
}
async function runRecordAction(action, input = {}) {
  if (!recordDialog || pendingAction) return;
  const target = recordDialog;
  await act(async () => {
    try {
      const row = await api('records/' + action, { id: target.id, ...input });
      if (!row || row.id !== target.id) throw new Error('返回记录不匹配，请重新核查当前记录');
      if (recordDialog?.sequence === target.sequence) renderRecordDetail(row);
      await loadRecords();
      toast(action === 'close-review' && ['expired_unconfirmed', 'archived_unconfirmed', 'failed'].includes(row.status) ? row.status === 'archived_unconfirmed' ? '已结束核查，结果仍未知；历史与去重保留，不再自动核查或补发。' : '本笔核查已结束，历史与去重已保留，原任务不会补发。' : row.recovery?.reason || '已重新核查，请查看最新状态。');
    } catch (error) {
      if (recordDialog?.sequence === target.sequence && $('#record-action-error')) { text('#record-action-error', error.message + '；请重新核查确认当前状态。'); $('#record-action-error').hidden = false; }
      throw error;
    }
  });
}
$('#preflight').addEventListener('click', () => act(async () => {
  const p = await api('preflight', {});
  await modal('只读预检完成', details([['广告代币', p.token.symbol], ['完整合约', p.token.contract], ['链上精度', p.token.decimals], ['钱包地址', p.resources?.wallet || '未配置'], ['代币余额', p.token.balance ?? '—'], [p.token.assetType === 'TRC10' ? '已激活启用钱包' : '剩余能量', p.token.assetType === 'TRC10' ? p.resources?.pool?.enabled || 0 : p.resources?.energy ?? '—'], ['已确认高度', p.height]])
    + (p.warnings.length ? '<div class="modal-warning">' + p.warnings.map(escapeHtml).join('<br>') + '</div>' : '<p>读取正常。正式启动时仍会检查资源条件。</p>'), '');
}));
$('#start').addEventListener('click', () => act(async () => {
  let confirmationToken;
  if (selectedMode === 'live') {
    const p = await api('prepare', {}); confirmationToken = p.confirmationToken;
    const yes = await modal('确认开始正式投放', details([['投放钱包', p.config.assetType === 'TRC10' ? 'TRC10 钱包池' : p.resources.wallet], ['广告合约', p.token.contract], ['代币 / 精度', `${p.token.symbol} / ${p.token.decimals}`],
      ['每地址数量', p.config.assetType === 'TRC10' ? p.config.trc10SendAmount : p.config.sendAmount], ['本次地址上限', limitText(p.config.maxPerRun)], ['重新启动扫描', p.config.restartScanMode === 'latest' ? '最新已确认区块' : '接着上次区块扫描'], ['中断前未发送地址', p.config.unfinishedPolicy === 'skip' ? '不补发，略过旧等待队列' : '补发等待队列'], [p.config.assetType === 'TRC10' ? '投放资源' : '能量费上限', p.config.assetType === 'TRC10' ? '只用免费带宽，不足等待' : `${p.config.feeLimitTrx} TRX / 笔`], ['投放类型', p.config.assetType], ['监听节点', p.config.rpcUrl]])
      + (p.config.assetType === 'TRC20' ? details([['能量恢复后自动继续', p.config.autoResumeEnergy ? `已开启 · 每 ${p.config.energyRecoverySeconds} 秒检查；恢复后扫最新区块，旧交易不补发` : '未开启']]) : '')
      + '<div class="modal-warning">启动后会根据监听规则自动发送真实代币。执行成功后按间隔继续，最终确认由后台核查；自定义上限包含本次补发的等待队列。手续费以链上实际扣费为准。此确认 2 分钟内有效。</div>', '确认并开始投放', true);
    if (!yes) return;
  }
  await api('start', { mode: selectedMode, confirmationToken }); toast(selectedMode === 'live' ? '正式投放已启动' : '模拟监听已启动');
}));
function pauseDelivery() { return act(async () => { const recovering = Boolean(snapshot?.energyRecovery); await api('stop', {}); toast(recovering ? '已取消自动恢复，后续需手动启动' : '已请求暂停，等待当前处理完成'); }); }
$('#stop').addEventListener('click', pauseDelivery);
$('#cancel-energy-recovery').addEventListener('click', pauseDelivery);
$('#reconcile').addEventListener('click', () => act(async () => { const results = await api('reconcile', {}); toast(results.length ? `已核查 ${results.length} 笔，确认到账 ${results.filter(r => r.confirmed).length} 笔` : '没有待确认交易'); }));
$('#cancel-queued').addEventListener('click', () => act(async () => {
  if (await modal('取消全部等待投放', '<p>这会取消正式与模拟模式中尚未广播的全部等待记录。地址去重仍保留，不会自动重新投放。已广播交易不受影响。</p>', '确认取消')) {
    const result = await api('cancel-queued', {}); toast(`已取消 ${result.count} 条`); await loadRecords();
  }
}));
for (const mode of ['live', 'simulate']) $('#clear-delivered-' + mode).addEventListener('click', () => act(async () => {
  if (dirty) throw new Error('请先保存设置');
  const current = await api('state');
  const count = current.counts.delivered[mode];
  if (!count) { toast('当前没有可清空的地址'); return; }
  const title = mode === 'live' ? '清空已投放地址' : '清空模拟命中地址';
  const scope = mode === 'live' ? '旧版历史地址 + 已确认到账的正式投放地址' : '模拟命中地址';
  const yes = await modal(title, details([['清空范围', scope], ['地址数量', `${num(count)} 个`]])
    + '<p>清空前自动备份配置和数据库，历史明细继续保留。等待、失败、取消、跳过的记录及已处理交易仍保留去重。</p><div class="modal-warning">清空后，这些地址在新的达标转账中可以再次命中。清空本身不会发出代币，也不会重扫已处理的交易。</div>', '备份并清空',
    mode === 'live' ? '我确认清空地址去重，允许这些地址在新交易触发后再次接收投放。' : '我确认清空模拟地址去重，允许这些地址在新交易触发后再次模拟命中。');
  if (!yes) return;
  const result = await api('clear-delivered', { mode, confirmed: true });
  $('#dedupe-result').hidden = false;
  text('#dedupe-result', `已清空 ${num(result.count)} 个${mode === 'live' ? '已投放' : '模拟命中'}地址，历史明细保留。${result.backupPath ? '\n清空前备份：' + result.backupPath : ''}`);
  toast(`已清空 ${num(result.count)} 个地址，历史明细保留`);
}));
$('#reset-cursor').addEventListener('click', () => act(async () => {
  if (dirty) throw new Error('请先保存设置');
  const mode = selectedMode === 'live' ? '正式投放' : '模拟监听';
  if (await modal('从最新区块开始', `<p>将重设「${mode}」模式的扫描起点，跳过离线期间尚未扫描的区块。已进入等待队列的记录仍保留；如不再需要，请在投放记录中取消。</p>`, '确认跳过旧区块')) {
    const result = await api('reset-cursor', { mode: selectedMode }); toast(`起点已设为 ${result.height}`);
  }
}));
$('#backup').addEventListener('click', () => act(async () => {
  const result = await api('backup', {}); $('#utility-result').hidden = false; text('#utility-result', `备份完成\n${result.path}\n包含私钥与历史记录，请仅用于个人迁移。`); toast('数据备份完成');
}));
$('#environment').addEventListener('click', () => act(async () => {
  const result = await api('environment'); $('#utility-result').hidden = false; text('#utility-result', Object.entries(result).map(([key, value]) => `${key}：${value}`).join('\n')); toast('运行环境检查完成');
}));
$('#exit').addEventListener('click', () => act(async () => {
  if (await modal('退出投放工作台', `<p>${dirty ? '尚未保存的修改将丢失。' : ''}退出将暂停后续投放并保存交易状态；已广播交易在下次打开后继续核查。</p>`, '退出程序')) {
    await api('exit', {}); exited = true; text('#connection', '正在退出，可关闭此窗口'); $('#connection-dot').classList.add('offline'); toast('已请求退出，正在保存并关闭服务'); updateControls();
  }
}));
function renderState(state) {
  const first = !snapshot; snapshot = state;
  renderEnergyPlatform(state);
  if (first) fillConfig(state.config);
  const c = state.config;
  const node = state.node || { source: c.hasApiKey ? 'primary' : 'public', state: 'ready' };
  const cooling = node.state === 'cooldown';
  const nodeName = node.source === 'public' ? '公共节点' : node.source === 'custom' ? '配置节点' : 'TronGrid API';
  const retrySeconds = Math.max(0, Math.ceil((node.retryAt - Date.now()) / 1000));
  text('#connection', `已连接本机服务 · ${cooling ? '节点限流等待中' : nodeName}`);
  $('#connection-dot').classList.toggle('capacity-wait', cooling);
  $('#node-banner').hidden = !cooling && !node.fallback;
  text('#node-banner', cooling
    ? `${nodeName}暂时限流，${retrySeconds > 0 ? `约 ${retrySeconds} 秒后重试` : '等待下一次请求恢复'}。扫描进度及交易哈希已保留，不计入投放失败；运行中的任务恢复后自动继续。`
    : 'TronGrid API 限流或额度耗尽，当前已使用公共节点；原 API Key 保留。公共节点也有限额，若再次限流会等待后自动继续。');
  const recovery = state.energyRecovery;
  $('#energy-recovery-banner').hidden = !recovery;
  if (recovery) {
    const seconds = Math.max(0, Math.ceil((recovery.nextCheckAt - Date.now()) / 1000));
    text('#energy-recovery-title', recovery.checking ? '正在检查能量与启动条件' : '投放已暂停 · 等待能量恢复');
    text('#energy-recovery-detail', `可用能量 ${num(recovery.energy)} / 门槛 ${num(recovery.minEnergy)} · ${recovery.checking ? '正在查询钱包，请稍候' : `约 ${seconds} 秒后再次检查`}。达标后从最新已确认区块开始，旧交易不补发。${recovery.message ? ' ' + recovery.message : ''}`);
  }
  const running = { stopped: ['已暂停', 'neutral'], starting: ['启动预检中', 'warning'], running: [state.mode === 'live' ? '正式投放中' : '模拟监听中', 'success'], stopping: ['正在暂停', 'warning'], fault: ['已停止 · 需处理', 'error'], energy_wait: [recovery?.checking ? '正在检查能量' : '等待能量恢复', 'warning'] }[state.state];
  text('#run-status', running[0]); $('#run-status').className = 'badge ' + running[1];
  text('#run-title', state.state === 'running' ? (state.mode === 'live' ? '正式投放正在运行' : '先观察命中，再决定投放') : state.state === 'stopping' ? '正在完成当前处理…' : '准备好，开始下一次触达');
  $('#run-panel').classList.toggle('running', state.state === 'running');
  $('#run-panel').classList.toggle('warning', state.state === 'fault');
  text('#run-description', state.state === 'fault' ? '任务已停止，请查看下方原因；处理后预检并重新启动。' : state.state === 'running' ? '按规则监听，执行成功后按间隔继续；最终确认和消耗统计由后台补齐。' : '按已保存的规则发现目标地址，清晰掌握每一笔投放。');
  if (recovery) {
    text('#run-title', recovery.checking ? '正在检查，达标后自动继续' : '等待能量恢复，达标后自动继续');
    text('#run-description', `每 ${recovery.intervalSeconds} 秒检查投放钱包。恢复后只扫描新区块、处理新触发；本次地址上限继续累计。`);
  }
  if (cooling && state.state === 'running') {
    text('#run-status', '节点限流 · 等待恢复'); $('#run-status').className = 'badge warning';
    text('#run-description', '任务保持运行，恢复后接着当前区块和队列继续；不会消耗投放重试次数或触发连续失败暂停。');
  }
  if ((state.state === 'running' || recovery) && selectedMode !== state.mode) selectMode(state.mode);
  text('#metric-scanned', num(state.metrics.scanned)); text('#metric-matched', num(state.metrics.matched)); text('#metric-skipped', `已自动跳过 ${num(state.metrics.skipped)} 条`);
  const count = (mode, status) => state.counts.rows.filter(r => r.mode === mode && r.status === status).reduce((a, r) => a + r.count, 0);
  text('#metric-confirmed', num(count('live', 'confirmed'))); text('#metric-pending', num(state.pending));
  text('#confirmation-summary', `执行成功待最终确认 ${num(count('live', 'executed'))} · 发送结果待核查 ${num(state.pending - count('live', 'executed'))}`);
  text('#scan-height', state.height === null ? '等待启动监听' : `扫描至 ${num(state.height)} / ${num(state.headHeight)}`);
  text('#queue-summary', `等待队列 ${num(count('live', 'queued') + count('simulate', 'queued'))} · 模拟记录 ${num(count('simulate', 'simulated'))} · 旧版去重地址 ${num(state.counts.legacy)}`);
  text('#app-version', 'v' + state.version);
  if (state.update) renderUpdate(state.update);
  text('#delivered-live-count', num(state.counts.delivered.live)); text('#delivered-simulate-count', num(state.counts.delivered.simulate));
  text('#delivered-live-card', num(state.counts.delivered.live));
  text('#delivered-live-note', `包含 ${num(state.counts.delivered.legacy)} 个旧版历史地址及已确认到账地址`);
  text('#dedupe-hint', state.pending ? `还有 ${num(state.pending)} 笔待确认交易，请先在总览核查完成后再清空。` : '请先暂停任务。等待、失败、取消、跳过的记录仍保留去重；已处理的同一笔交易不会重复触发。');
  $('#dedupe-last').hidden = !state.lastAddressReset;
  if (state.lastAddressReset) text('#dedupe-last', `最近清空：${time(state.lastAddressReset.at)} · ${state.lastAddressReset.mode === 'live' ? '正式已投放' : '模拟命中'} ${num(state.lastAddressReset.count)} 个地址`);
  text('#wallet-address', c.walletAddress || '请在投放参数中配置钱包');
  text('#wallet-trx', state.wallet ? num(state.wallet.trx) : '—'); text('#wallet-energy', state.wallet ? num(state.wallet.energy) : '—');
  const token = state.preflight?.token;
  text('#run-token', token?.symbol || '广告代币'); text('#run-interval', `投放间隔 ${c.sendIntervalSeconds} 秒`);
  text('#configured-token', token?.symbol || '待预检'); text('#configured-decimals', token ? `${token.decimals} 位精度 · ${short(token.contract)}` : '保存后预检，读取代币名称与精度');
  $$('[data-token-symbol]').forEach(el => { el.textContent = token?.symbol || '代币'; });
  text('#wallet-token', token?.balance != null ? wholeToken(token.balance) : '—'); text('#token-label', token ? token.symbol + ' 余额（预检时）' : '广告代币余额');
  text('#wallet-tag', state.wallet ? '已读取资源' : '未预检'); $('#wallet-tag').className = 'badge ' + (state.wallet ? 'success' : 'neutral');
  const energyLow = state.wallet && Number(state.wallet.energy) < c.minEnergy;
  if (energyLow) { text('#wallet-tag', '能量不足'); $('#wallet-tag').className = 'badge warning'; }
  // The display compares available energy with the configured minimum; it is not a guessed capacity.
  const energyRatio = state.wallet ? Math.min(100, Number(state.wallet.energy) / Math.max(c.minEnergy, 1) * 100) : 0;
  $('#energy-progress').style.width = energyRatio + '%'; $('#energy-progress').classList.toggle('low', Boolean(energyLow));
  text('#energy-threshold', `最低要求 ${num(c.minEnergy)} 能量${state.wallet ? energyLow ? ' · 需补充资源' : ' · 已满足' : ' · 尚未预检'}`);
  text('#wallet-note', state.wallet ? `资源更新：${time(state.wallet.checkedAt)} · 可用带宽 ${num(state.wallet.bandwidth)}` : '点击「只读预检」读取余额、资源和代币精度');
  text('#rule-threshold', [c.watchTrx ? `TRX ≥ ${c.minTrx}` : '', c.watchUsdt ? `USDT ≥ ${c.minUsdt}` : ''].filter(Boolean).join(' / '));
  text('#rule-amount', `${c.assetType === 'TRC10' ? c.trc10SendAmount : c.sendAmount} ${token?.symbol || '代币'}`); text('#rule-addresses', `${c.watchedAddresses.length} / ${c.blacklist.length} 个地址`); text('#rule-limit', limitText(c.maxPerRun));
  text('#overview-limit', limitText(c.maxPerRun));
  text('#overview-restart', c.restartScanMode === 'latest' ? '最新已确认区块' : '接着上次区块扫描');
  text('#overview-unfinished', c.unfinishedPolicy === 'skip' ? '不补发' : '补发等待队列');
  text('#rule-cadence', `执行成功后等待 ${c.sendIntervalSeconds} 秒继续；最终确认与消耗统计在后台补齐。单笔最多补试 3 次，连续未成功 ${num(state.consecutiveFailures || 0)}/3。`);
  const counts = state.counts.rows;
  const totalFor = status => counts.filter(r => !status || r.status === status).reduce((sum, r) => sum + r.count, 0);
  text('#records-all-count', num(totalFor(''))); text('#records-confirmed-count', num(totalFor('confirmed'))); text('#records-executed-count', num(totalFor('executed')));
  text('[data-record-summary=uncertain] b', num(totalFor('uncertain'))); text('#queue-count', num(totalFor('queued')));
  $('#error-banner').hidden = !state.lastError || Boolean(recovery); text('#error-banner', state.lastError || '');
  if (state.migration) {
    text('#migration-summary', `已迁移 ${state.migration.watchedAddresses} 个监听地址、${state.migration.blacklistAddresses} 个黑名单地址、${state.migration.uniqueSentAddresses} 个历史投放地址。`);
    const notes = [...state.migration.notes];
    if (state.migration.invalidAddresses.length) notes.push(`另有 ${state.migration.invalidAddresses.length} 条无效地址未导入，详见 data/migration-report.json。`);
    text('#migration-notes', notes.join('\n'));
  }
  if (typeof renderPoolUI === 'function') renderPoolUI(state);
  if (currentPage === 'batches' && Date.now() - batchRefreshedAt > 2000) loadManualBatches().catch(error => toast(error.message, true));
  updateControls();
}
async function loadLogs() {
  const rows = await api('logs?after=' + logAfter);
  if (!rows.length) return;
  $('.empty-log')?.remove();
  for (const row of rows) {
    const el = document.createElement('div'); el.className = 'log-row';
    const level = { info: '信息', warn: '提醒', error: '异常', success: '到账' }[row.level] || row.level;
    el.innerHTML = `<span class="log-time">${escapeHtml(new Date(row.time).toLocaleTimeString('zh-CN', { hour12: false }))}</span><span class="log-level ${escapeHtml(row.level)}">${escapeHtml(level)}</span><span class="log-message">${escapeHtml(row.message)}</span>`;
    $('#logs').append(el); logAfter = Math.max(logAfter, row.id);
  }
  while ($('#logs').children.length > 500) $('#logs').firstElementChild.remove();
  if ($('#auto-scroll').checked) $('#logs').scrollTop = $('#logs').scrollHeight;
}
$('#clear-view').addEventListener('click', () => { $('#logs').replaceChildren(); toast('已清空当前显示，数据库日志仍保留'); });
let recordRequest = 0;
async function loadRecords() {
  const sequence = ++recordRequest;
  const params = new URLSearchParams({ search: $('#search-records').value, mode: $('#filter-mode').value, status: $('#filter-status').value, page: recordPage });
  const result = await api('records?' + params); if (sequence !== recordRequest) return;
  recordTotal = result.total; const pages = Math.max(1, Math.ceil(result.total / result.limit));
  if (recordPage > pages) { recordPage = pages; return loadRecords(); }
  text('#record-total', `共 ${num(result.total)} 条记录`); text('#page-number', `${recordPage} / ${pages}`);
  $('#prev-page').disabled = recordPage <= 1; $('#next-page').disabled = recordPage >= pages; $('#records-empty').hidden = result.items.length > 0;
  $('.records-table').hidden = !result.items.length;
  const filtered = Boolean($('#search-records').value || $('#filter-mode').value || $('#filter-status').value);
  text('#records-empty h3', filtered ? '没有找到匹配的记录' : '每一次触达，都会留在这里');
  text('#records-empty p', filtered ? '换一个地址，或清除筛选后再试。' : '先启动模拟监听，观察规则命中情况。');
  text('#reset-record-filters', filtered ? '清除筛选' : '返回投放总览');
  $$('[data-record-summary]').forEach(el => { const selected = el.dataset.recordSummary === $('#filter-status').value; el.classList.toggle('selected', selected); el.setAttribute('aria-pressed', String(selected)); });
  $('#records-body').replaceChildren();
  for (const row of result.items) {
    const state = statuses[row.status] || [row.status, 'neutral'];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="record-time">${escapeHtml(time(row.created_at))}<small>${row.mode === 'live' ? '正式投放' : '模拟监听'} · 本机时间</small></span></td><td title="${escapeHtml(row.address)}"><code class="address-value">${escapeHtml(short(row.address))}</code></td><td class="number">${row.source_kind === 'manual' ? '<span class="badge purple">手动批量</span>' : escapeHtml(row.source_amount) + '<span class="cell-unit">' + escapeHtml(row.source_asset) + '</span>'}</td><td class="number quantity-cell">${escapeHtml(row.amount)}<small class="record-token" title="${escapeHtml(row.token)}">${escapeHtml(short(row.token))}</small></td><td><span class="badge ${state[1]}"><span class="dot"></span>${escapeHtml(state[0])}</span></td><td class="align-right"><button class="text-button">${row.manualRetry?.canPrepare ? '补发 / 查看' : row.recovery?.can_recheck ? '核查 / 处理' : '查看'} ${uiIcon('chevron-right')}</button></td>`;
    tr.querySelector('button').addEventListener('click', () => showRecordDetail(row));
    $('#records-body').append(tr);
  }
  if (recordDialog && !pendingAction && !recordDialog.retryWorking && !recordDialog.retry
    && $('#modal-title').textContent === '投放记录详情') {
    const fresh = result.items.find(row => row.id === recordDialog.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(recordDialog.row)) {
      const scroll = $('#modal-body').scrollTop;
      renderRecordDetail(fresh); $('#modal-body').scrollTop = scroll;
    }
  }
  refreshRecordsAt = Date.now();
}
let searchTimer;
$('#search-records').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { recordPage = 1; loadRecords().catch(e => toast(e.message, true)); }, 300); });
for (const selector of ['#filter-mode', '#filter-status']) $(selector).addEventListener('change', () => { recordPage = 1; loadRecords().catch(e => toast(e.message, true)); });
$('#prev-page').addEventListener('click', () => { recordPage--; loadRecords().catch(e => toast(e.message, true)); });
$('#next-page').addEventListener('click', () => { recordPage++; loadRecords().catch(e => toast(e.message, true)); });
// Decimal strings stay strings so large token quantities retain all digits.
const precise = value => {
  const [whole, fraction] = String(value).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
};
function statisticsAmounts(item) {
  const values = item.amounts.map(a => `<span class="statistics-quantity${String(a.amount).length > 28 ? " quantity-very-long" : String(a.amount).length > 18 ? " quantity-long" : ""}">${escapeHtml(precise(a.amount))}<small title="${escapeHtml(a.token)}">${escapeHtml(short(a.token))}</small></span>`);
  if (item.missingAmount) values.push('<small class="statistics-incomplete">数量待补齐</small>');
  return values.join('') || '0';
}
function statisticsCost(item, field, missing) {
  const waiting = item[missing];
  const value = waiting === item.transactions && waiting > 0 ? '统计中' : precise(item[field]);
  return { value, note: waiting ? `${item.transactions > waiting ? '另有 ' : ''}${num(waiting)} 笔待补齐` : '', html: `${escapeHtml(value)}${waiting ? `<small class="statistics-incomplete">${item.transactions > waiting ? '另有 ' : ''}${num(waiting)} 笔待补齐</small>` : ''}` };
}
function statisticsRow(item, total = false) {
  const energy = statisticsCost(item, statisticsAssetType === 'TRC10' ? 'bandwidth' : 'energy', statisticsAssetType === 'TRC10' ? 'missingBandwidth' : 'missingEnergy'), trx = statisticsCost(item, 'feeTrx', 'missingFee');
  return `<td>${total ? '所选范围合计' : escapeHtml(item.date)}${item.otherCount ? `<small>含 ${num(item.otherCount)} 笔失败或异常消耗</small>` : ''}</td><td class="number">${num(item.count)}</td><td class="number quantity-cell">${statisticsAmounts(item)}</td><td class="number">${energy.html}${statisticsAssetType === 'ALL' ? '<small>带宽 ' + statisticsCost(item, 'bandwidth', 'missingBandwidth').html + '</small>' : ''}</td><td class="number">${trx.html}<small>平台 ${statisticsCost(item, 'serviceFeeTrx', 'missingServiceFee').html} TRX</small></td>`;
}
async function loadStatistics() {
  const sequence = ++statisticsRequest;
  const params = new URLSearchParams({ ...statisticsFilter, page: statisticsPage });
  statisticsRefreshAt = Date.now();
  $('#statistics-prev').disabled = true; $('#statistics-next').disabled = true;
  text('#statistics-updated', '正在读取统计…');
  try {
    const result = await api('statistics?' + params); if (sequence !== statisticsRequest) return;
    $('#statistics-error').hidden = true;
    statisticsPage = result.page; statisticsAssetType = result.range.token ? (/^[1-9]\d*$/.test(result.range.token) ? 'TRC10' : 'TRC20') : 'ALL';
    const totals = result.totals, energy = statisticsCost(totals, statisticsAssetType === 'TRC10' ? 'bandwidth' : 'energy', statisticsAssetType === 'TRC10' ? 'missingBandwidth' : 'missingEnergy'), trx = statisticsCost(totals, 'feeTrx', 'missingFee');
    text('#statistics-count', num(totals.count)); $('#statistics-amount').innerHTML = statisticsAmounts(totals);
    $('#statistics-energy').closest('.metric').querySelector('.metric-label').firstChild.textContent = statisticsAssetType === 'TRC10' ? '已获取消耗带宽' : statisticsAssetType === 'ALL' ? '能量 / TRC10 带宽' : '已获取消耗能量';
    const resourceHeader = document.querySelector('.stats-table thead th:nth-child(4)'); if (resourceHeader) resourceHeader.textContent = statisticsAssetType === 'TRC10' ? '消耗带宽' : statisticsAssetType === 'ALL' ? '能量 / TRC10 带宽' : '消耗能量';
    text('#statistics-energy', statisticsAssetType === 'ALL' ? energy.value + ' / ' + statisticsCost(totals, 'bandwidth', 'missingBandwidth').value : energy.value); text('#statistics-trx', trx.value);
    text('#statistics-energy-note', energy.note || '实际链上消耗'); text('#statistics-trx-note', (trx.note || '实际链上手续费') + '；平台服务费 ' + (totals.serviceFeeTrx || '0') + ' TRX' + (totals.missingServiceFee ? '，另有 ' + totals.missingServiceFee + ' 笔待核对' : ''));
    text('#statistics-range', `${result.range.start || '全部历史'} 至 ${result.range.end} · ${result.range.zoneLabel}`);
    text('#statistics-updated', '每 15 秒自动刷新');
    if (statisticsFilter.period !== 'custom') {
      $('#statistics-start').value = result.range.start || result.range.end; $('#statistics-end').value = result.range.end;
    }
    const tokenSelect = $('#statistics-token');
    const currentTokenOption = new Option(result.currentToken ? `当前投放代币 · ${short(result.currentToken)}` : '当前投放代币（未设置）', 'current');
    currentTokenOption.title = result.currentToken || '请在投放参数中设置广告代币合约';
    tokenSelect.replaceChildren(currentTokenOption, new Option('全部代币（分别统计）', ''));
    for (const token of new Set([...result.tokens, result.currentToken, statisticsFilter.token].filter(t => t && t !== 'current'))) {
      const option = new Option(short(token), token); option.title = token; tokenSelect.add(option);
    }
    tokenSelect.value = statisticsFilter.token;
    $('#statistics-body').innerHTML = result.items.map(row => '<tr>' + statisticsRow(row) + '</tr>').join('');
    renderStatisticsTrend(result.items);
    text('#statistics-day-badge', `${num(result.totalDays)} 个日期`);
    $('#statistics-total-row').innerHTML = '<tr>' + statisticsRow(totals, true) + '</tr>';
    $('#statistics-total-row').hidden = !result.items.length;
    $('#statistics-empty').hidden = result.items.length > 0;
    $('.stats-table').hidden = !result.items.length;
    text('#statistics-total-days', `共 ${num(result.totalDays)} 个有数据的日期 · 每页最多 15 天`);
    text('#statistics-page', `${result.page} / ${result.pages}`);
    $('#statistics-prev').disabled = result.page <= 1; $('#statistics-next').disabled = result.page >= result.pages;
    const notes = [];
    if (result.requiresToken) notes.push('尚未设置当前投放代币，请在投放参数中填写广告代币合约，或选择一个历史代币查看');
    if (result.pending.awaitingFinal) notes.push(`${num(result.pending.awaitingFinal)} 笔待最终确认，确认后计入交易发生当天`);
    if (result.pending.undated) notes.push(`${num(result.pending.undated)} 笔交易日期待补齐，尚未计入日报；可在投放记录查看核查状态`);
    if (totals.missingEnergy || totals.missingBandwidth || totals.missingFee) notes.push('部分消耗待补齐，当前显示已知消耗');
    $('#statistics-progress').hidden = !notes.length;
    text('#statistics-progress', notes.join('。') + (result.pending.undated || result.pending.awaitingFinal ? '。（待补齐与待确认笔数不限所选日期）' : ''));
    $('#statistics-legacy').hidden = !result.legacyAddresses;
    $('#statistics-export').href = '/api/statistics/export?' + new URLSearchParams(statisticsFilter);
    $('#statistics-export').setAttribute('aria-disabled', String(result.requiresToken));
  } catch (error) {
    if (sequence !== statisticsRequest) return;
    $('#statistics-error').hidden = false; text('#statistics-error', '统计暂未更新：' + error.message);
    text('#statistics-updated', '数据未刷新，可点击查询重试');
    $('#statistics-export').removeAttribute('href'); $('#statistics-export').setAttribute('aria-disabled', 'true');
  }
}
$('#statistics-filters').addEventListener('submit', event => {
  event.preventDefault();
  statisticsFilter = { period: $('#statistics-period').value, timeZone: $('#statistics-zone').value, token: $('#statistics-token').value };
  if (statisticsFilter.period === 'custom') { statisticsFilter.start = $('#statistics-start').value; statisticsFilter.end = $('#statistics-end').value; }
  statisticsPage = 1; loadStatistics();
});
for (const selector of ['#statistics-period', '#statistics-zone', '#statistics-token']) $(selector).addEventListener('change', () => {
  $('#statistics-custom').hidden = $('#statistics-period').value !== 'custom';
  $('#statistics-filters').requestSubmit();
});
$('#statistics-prev').addEventListener('click', () => { statisticsPage--; loadStatistics(); });
$('#statistics-next').addEventListener('click', () => { statisticsPage++; loadStatistics(); });
$('#statistics-export').addEventListener('click', event => { if (event.currentTarget.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
async function refresh() {
  if (polling || exited) return; polling = true;
  try {
    const state = await api('state'); backendConnected = true; renderState(state); await loadLogs();
    if (currentPage === 'records' && Date.now() - refreshRecordsAt > 5000) await loadRecords();
    if (currentPage === 'statistics' && Date.now() - statisticsRefreshAt > 15000) loadStatistics();
    $('#connection-dot').classList.remove('offline');
  } catch (error) {
    backendConnected = false;
    if (recordDialog?.retry) recordDialog.retry.expiresAt = new Date(0).toISOString();
    text('#connection', '服务连接中断，请重新打开'); $('#connection-dot').classList.add('offline'); if (!snapshot) toast(error.message, true);
  }
  finally { polling = false; updateControls(); }
}
window.addEventListener('beforeunload', event => { if (dirty && !exited) { event.preventDefault(); event.returnValue = ''; } });
// Heartbeats describe UI freshness only; native window presence controls lifetime.
let pinging = false;
async function heartbeat() {
  if (pinging || exited) return; pinging = true;
  try { await api('heartbeat', {}); } catch { /* refresh displays connection errors. */ }
  finally { pinging = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); refresh(); } });
heartbeat(); setInterval(heartbeat, 10000);
refresh(); setInterval(refresh, 2500);

function updateDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function updateStages(phase) {
  const current = phase === 'downloading' ? 0 : phase === 'verifying' ? 1 : phase === 'ready' ? 2 : -1;
  $('#update-preparation-steps').hidden = current < 0;
  $$('#update-preparation-steps li').forEach((item, index) => {
    item.classList.toggle('complete', index < current);
    item.classList.toggle('current', index === current);
    if (index === current) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
}
function renderInstallPreparation(label, startedAt) {
  updateStages('ready');
  $('#update-action-hint').hidden = true;
  for (const prefix of ['download', 'sidebar']) {
    $(prefix === 'download' ? '#download-progress' : '#sidebar-download-progress').hidden = false;
    text(`#${prefix}-progress-label`, label);
    text(`#${prefix}-progress-percent`, '请稍候');
    $(`#${prefix}-progress-bar`).removeAttribute('value');
    $(`#${prefix}-progress-bar`).setAttribute('aria-label', label);
  }
  text('#update-status', label);
  text('#sidebar-update-status', '正在准备安装');
  text('#download-progress-size', `已用时 ${updateDuration(Date.now() - startedAt)} · 随后将在独立窗口显示安装进度`);
  text('#download-progress-note', '请等待进度窗口打开，避免重复点击启动。');
}
function renderUpdate(result) {
  updateRelease = result;
  const entry = $('#version-update');
  $('#sidebar-update').classList.toggle('has-update', Boolean(result.available));
  text('#version-prompt', result.available ? '发现新版本' : '软件更新');
  const label = result.available ? `发现新版本 ${result.latestVersion}，点击前往软件更新` : `当前版本 ${result.currentVersion}，点击打开软件更新`;
  entry.title = label; entry.setAttribute('aria-label', label);
  if (updateInstalling) return;
  const transfer = result.download || { phase: 'idle' }, downloading = ['downloading', 'verifying'].includes(transfer.phase), ready = transfer.phase === 'ready';
  const verifying = transfer.phase === 'verifying', failed = transfer.phase === 'error';
  const checking = updateChecking || result.checking;
  text('#sidebar-update-status', ready ? `v${transfer.version} 已就绪` : downloading ? `正在准备 v${transfer.version}` : checking ? '正在检查…' : result.lastError ? '检查失败，可重试' : result.available ? `可更新至 v${result.latestVersion}` : result.checkedAt ? '当前已是最新版本' : '启动后自动检查');
  text('#update-status', updateChecking || result.checking ? '正在连接 GitHub 检查更新…' : result.available ? `发现新版本 ${result.latestVersion}（当前 ${result.currentVersion}）` : result.lastError || (result.checkedAt ? `当前 ${result.currentVersion} 已是最新版本` : `当前版本 ${result.currentVersion}，点击检查更新`));
  text('#update-notes', result.notes || '更新来源：GitHub 程序发布仓库。先下载并校验，再确认安装；待核查交易会保留。');
  for (const selector of ['#install-update', '#sidebar-install-update']) $(selector).hidden = !ready;
  for (const selector of ['#download-update', '#sidebar-download-update']) $(selector).hidden = !result.available || ready;
  text('#download-update', verifying ? '正在校验…' : downloading ? '正在下载…' : failed ? '重新下载' : '下载新版本');
  $('#sidebar-download-update .update-button-label').textContent = verifying ? '正在校验…' : downloading ? '正在下载…' : failed ? '重新下载' : '下载新版本';
  updateStages(transfer.phase);
  for (const prefix of ['download', 'sidebar']) {
    const panel = prefix === 'download' ? '#download-progress' : '#sidebar-download-progress';
    $(panel).hidden = !downloading && !ready && !failed;
    $(panel).classList.toggle('failed', failed);
    text(`#${prefix}-progress-label`, ready ? '下载及校验完成' : verifying ? '正在校验文件' : failed ? '准备未完成' : '正在下载');
    text(`#${prefix}-progress-percent`, verifying ? '校验中' : `${transfer.percent || 0}%`);
    const bar = $(`#${prefix}-progress-bar`);
    bar.setAttribute('aria-label', ready ? '下载及校验完成' : verifying ? '正在校验文件' : '更新包下载进度');
    if (verifying) bar.removeAttribute('value'); else bar.value = transfer.percent || 0;
  }
  const size = `${((transfer.received || 0) / 1048576).toFixed(1)} / ${((transfer.total || 0) / 1048576).toFixed(1)} MB`;
  const speed = transfer.bytesPerSecond > 0 ? ` · 平均 ${(transfer.bytesPerSecond / 1048576).toFixed(2)} MB/s` : '';
  text('#download-progress-size', `${size}${transfer.phase === 'downloading' ? speed : ''} · 已用时 ${updateDuration(transfer.elapsedMs)}`);
  text('#download-progress-note', ready ? '准备完成。确认安装后，独立进度窗口会显示备份、安装和打开新版的过程。'
    : verifying ? '下载已完成，正在检查文件完整性；校验通过后才能安装。'
      : failed ? '本次准备未完成，可重新下载。' : transfer.stalledMs >= 15000 ? `已 ${updateDuration(transfer.stalledMs)} 未收到新数据，正在等待网络响应…` : '正在接收更新文件，可继续使用其他页面。');
  $('#update-download-error').hidden = transfer.phase !== 'error'; text('#update-download-error', transfer.error || '');
  if (transfer.phase === 'error') { text('#sidebar-update-status', '下载失败，点击重试'); $('#sidebar-update-status').title = transfer.error || ''; }
  else $('#sidebar-update-status').removeAttribute('title');
  if (result.lastResult) {
    const last = result.lastResult;
    text('#update-result', last.ok ? last.reopened === true ? `上次更新完成：${last.version}` : `上次已安装：${last.version}${last.message ? '；' + last.message : '；自动打开状态尚未确认'}`
      : `上次更新未完成：${last.message}。请按提示处理后再更新。`);
  }
  updateControls();
  if (ready && updatePromptVersion === transfer.version && !pendingAction && !dirty && !$('#modal').open && !['starting', 'stopping'].includes(snapshot?.state)) {
    updatePromptVersion = null; void confirmUpdate();
  }
}
async function loadUpdate() { renderUpdate(await api('update')); }
$('#version-update').addEventListener('click', () => {
  go('guide');
  $('#software-update').scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#software-update').focus({ preventScroll: true });
});
async function checkUpdate() {
  if (updateChecking || exited) return;
  updateChecking = true; updateControls(); text('#update-status', '正在连接 GitHub 检查更新…');
  try { updateRelease = await api('update/check', {}); }
  catch (error) { toast(error.message, true); if (updateRelease) updateRelease = { ...updateRelease, checking: false, lastError: '暂时无法检查更新，请检查网络后重试' }; }
  finally { updateChecking = false; if (updateRelease) renderUpdate(updateRelease); updateControls(); }
}
for (const selector of ['#check-update', '#sidebar-check-update']) $(selector).addEventListener('click', checkUpdate);
async function downloadUpdate() {
  if (!updateRelease?.available || updateDownloadStarting || exited) return;
  updateDownloadStarting = true; updateControls();
  const version = updateRelease.latestVersion;
  try {
    const state = await api('update/download', { version });
    updatePromptVersion = version; renderUpdate(state);
  } catch (error) { toast(error.message, true); }
  finally { updateDownloadStarting = false; updateControls(); }
}
for (const selector of ['#download-update', '#sidebar-download-update']) $(selector).addEventListener('click', downloadUpdate);
// Poll the tiny update snapshot while bytes arrive; other pages stay usable.
setInterval(async () => {
  if (exited || updateProgressPolling || !['downloading', 'verifying'].includes(updateRelease?.download?.phase)) return;
  updateProgressPolling = true;
  try { renderUpdate(await api('update')); } catch { /* The normal refresh reports connection loss. */ }
  finally { updateProgressPolling = false; }
}, 600);
function confirmUpdate() { return act(async () => {
  if (updateRelease?.download?.phase !== 'ready' || dirty) return;
  const version = updateRelease.download.version;
  updatePromptVersion = null;
  const active = snapshot?.state === 'running' || snapshot?.energyRecovery || snapshot?.pool?.running;
  const approved = await modal('下载完成，安装 v' + version + '？',
    '<p>更新包已下载并通过校验。</p><p>' + (active ? '<strong>确认后会先暂停投放</strong>，不再开始新交易；已广播交易和待核查记录会保留。' : '确认后将自动备份并安装，随后重新打开程序。') + '</p><p>安装时会显示独立进度窗口，持续展示当前步骤和已用时间。</p><p>钱包、参数和历史记录保留，更新后保持暂停。</p>', active ? '暂停并安装更新' : '确认安装更新');
  if (!approved) return;
  updateInstalling = true;
  const startedAt = Date.now();
  let stageLabel = active ? '正在暂停并保存投放' : '正在打开安装进度窗口';
  renderInstallPreparation(stageLabel, startedAt);
  const preparationTimer = setInterval(() => renderInstallPreparation(stageLabel, startedAt), 500);
  try {
    if (active) {
      await api('stop', {});
      const deadline = Date.now() + 120000;
      for (;;) {
        const state = await api('state'); renderState(state);
        if (!['running', 'starting', 'stopping'].includes(state.state) && !state.pool?.running) break;
        if (Date.now() >= deadline) throw new Error('暂停尚未完成，下载包已保留，稍后可再次确认安装');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    stageLabel = '正在打开安装进度窗口'; renderInstallPreparation(stageLabel, startedAt);
    await api('update/install', { confirmed: true, version });
    exited = true; updateControls();
    stageLabel = '更新进度窗口已打开'; renderInstallPreparation(stageLabel, startedAt);
    text('#download-progress-note', '请查看独立更新窗口。安装完成后会自动打开新版。');
    text('#connection', '正在安装更新');
  } catch (error) {
    updateInstalling = false; if (updateRelease) renderUpdate(updateRelease);
    text('#update-status', '更新未完成：' + error.message); throw error;
  } finally { clearInterval(preparationTimer); }
}); }
for (const selector of ['#install-update', '#sidebar-install-update']) $(selector).addEventListener('click', confirmUpdate);

// Presentation helpers. Campaign execution and reporting still use the existing APIs.
function uiIcon(name) {
  const paths = { play: '<path d="m8 5 11 7-11 7Z"/>', pause: '<path d="M8 5v14M16 5v14"/>', 'chevron-right': '<path d="m9 5 7 7-7 7"/>',
    check: '<path d="m5 12 4 4L19 6"/>', clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    'chevron-up': '<path d="m5 15 7-7 7 7"/>', 'chevron-down': '<path d="m5 9 7 7 7-7"/>' };
  return `<i class="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.clock}</svg></i>`;
}
function selectSettingsGroup(group) {
  settingsGroup = group;
  $$('[data-settings]').forEach(el => { const selected = el.dataset.settings === group; el.setAttribute('aria-selected', String(selected)); el.tabIndex = selected ? 0 : -1; });
  $$('[data-settings-panel]').forEach(el => { el.hidden = el.dataset.settingsPanel !== group; });
}
function selectAddressGroup(group) {
  addressGroup = group;
  $$('[data-address-tab]').forEach(el => { const selected = el.dataset.addressTab === group; el.setAttribute('aria-selected', String(selected)); el.tabIndex = selected ? 0 : -1; });
  $$('[data-address-panel]').forEach(el => { el.hidden = el.dataset.addressPanel !== group; });
  text('#address-editor-title', group === 'watch' ? '监听名单' : '黑名单');
  text('#address-editor-description', group === 'watch' ? '地址参与转入或转出时检查金额，达标后向原交易收款人投放。' : '黑名单中的收款地址不会接收广告代币；同时自动跳过自身和历史地址。');
  updateAddressCounts();
}
function renderStatisticsTrend(items) {
  const rows = [...items].reverse();
  const max = Math.max(1, ...rows.map(row => row.count));
  $('#trend').innerHTML = rows.map(row => {
    const height = Math.max(1, Math.round(row.count / max * 72));
    return `<div class="trend-column" tabindex="0" title="${escapeHtml(row.date)}：${num(row.count)} 笔"><span class="bar-value">${num(row.count)}</span><svg class="trend-bar" viewBox="0 0 48 76" aria-hidden="true"><rect x="4" y="${76 - height}" width="40" height="${height}" rx="3" fill="currentColor"/></svg><small>${escapeHtml(row.date.slice(5).replace('-', '.'))}</small></div>`;
  }).join('');
  $('#toggle-trend').disabled = !items.length;
  $('#trend').classList.toggle('no-data', !items.length);
}
function recordTimeline(row) {
  const stages = [{ label: row.source_kind === 'manual' ? '手动批次已确认，进入优先队列' : '规则命中，已生成投放记录', done: true }];
  if (row.txid) stages.push({ label: '已准备交易哈希；发送状态以回执为准', done: true });
  if (['executed', 'confirmed'].includes(row.status)) stages.push({ label: '执行成功，已核对到账金额', done: true });
  const final = { confirmed: ['已最终确认到账', true], executed: ['后台核查最终确认及实际消耗', false],
    queued: ['等待投放', false], prepared: ['已准备交易，等待核查', false], pending: ['等待链上回执', false], uncertain: [row.retry?.exhausted ? '重试次数已用完，后台继续核查' : '等待核查或有限重试，其他地址可继续', false],
    failed: ['投放失败，保留重试记录与实际消耗', false], expired_unconfirmed: ['已过期未确认，核查已结束；历史与去重保留，不再补发', true], archived_unconfirmed: ['核查已结束，结果仍未知；保留历史与去重，可手动重新核查，不再补发', true], simulated: ['模拟命中，未发送代币', true],
    skipped: ['已按规则跳过', true], skipped_restart: ['重启时略过旧等待记录', true], cancelled: ['已取消，地址去重保留', true] }[row.status] || ['请查看记录说明', false];
  stages.push({ label: final[0], done: final[1] });
  return '<ol class="delivery-timeline">' + stages.map(stage => `<li class="${stage.done ? 'done' : 'waiting'}">${uiIcon(stage.done ? 'check' : 'clock')}<span>${escapeHtml(stage.label)}</span></li>`).join('') + '</ol>';
}
$$('[data-settings]').forEach(el => el.addEventListener('click', () => selectSettingsGroup(el.dataset.settings)));
$$('[data-address-tab]').forEach(el => el.addEventListener('click', () => selectAddressGroup(el.dataset.addressTab)));
$$('[name=limitMode]').forEach(el => el.addEventListener('change', () => {
  if (!el.checked) return;
  $('#limit-enabled').checked = el.value === 'custom';
  if ($('#limit-enabled').checked && !$('[name=maxPerRun]').value) $('[name=maxPerRun]').value = '100';
  syncLimitChoices(); markDirty();
}));
$('#discard-settings').addEventListener('click', () => $('#discard').click());
$('#import-active').addEventListener('click', () => $(addressGroup === 'watch' ? '#import-watch' : '#import-black').click());
for (const [selector, lines] of [['#watched-addresses', '#watch-lines'], ['#blacklist', '#black-lines']]) {
  $(selector).addEventListener('scroll', () => { $(lines).scrollTop = $(selector).scrollTop; });
}
$$('[data-click]').forEach(el => el.addEventListener('click', () => { const target = $('#' + el.dataset.click); if (!target.disabled) target.click(); }));
$('#copy-wallet').addEventListener('click', async () => {
  if (!snapshot?.config.walletAddress) return toast('请先配置钱包');
  try { await navigator.clipboard.writeText(snapshot.config.walletAddress); toast('钱包地址已复制'); }
  catch { await modal('投放钱包地址', details([['钱包地址', snapshot.config.walletAddress]]), ''); }
});
$('#refresh-records').addEventListener('click', () => loadRecords().catch(error => toast(error.message, true)));
$$('[data-record-summary]').forEach(el => el.addEventListener('click', () => { $('#filter-status').value = el.dataset.recordSummary; recordPage = 1; loadRecords().catch(error => toast(error.message, true)); }));
$('#reset-record-filters').addEventListener('click', () => {
  if (!$('#search-records').value && !$('#filter-mode').value && !$('#filter-status').value) return go('overview');
  $('#search-records').value = ''; $('#filter-mode').value = ''; $('#filter-status').value = ''; recordPage = 1;
  loadRecords().catch(error => toast(error.message, true));
});
$('#statistics-all').addEventListener('click', () => { $('#statistics-period').value = 'all'; $('#statistics-custom').hidden = true; $('#statistics-filters').requestSubmit(); });
$('#toggle-trend').addEventListener('click', () => {
  $('#trend').hidden = !$('#trend').hidden; const expanded = !$('#trend').hidden;
  $('#toggle-trend').setAttribute('aria-expanded', String(expanded)); $('#toggle-trend').setAttribute('aria-label', expanded ? '收起趋势' : '展开趋势');
  $('#toggle-trend').innerHTML = uiIcon(expanded ? 'chevron-up' : 'chevron-down');
});
for (const selector of ['#statistics-start', '#statistics-end']) $(selector).addEventListener('change', () => $('#statistics-filters').requestSubmit());
document.addEventListener('keydown', event => {
  const tab = event.target.closest('[role=tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const tabs = [...tab.closest('[role=tablist]').querySelectorAll('[role=tab]')]; const index = tabs.indexOf(tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click(); tabs[next].focus();
});
selectSettingsGroup('strategy'); selectAddressGroup('watch'); go('overview');

$('#energy-pair').addEventListener('click', () => act(async () => { await api('energy/pair', { platformUrl: $('#energy-platform-url').value.trim(), code: $('#energy-pair-code').value.trim() }); $('#energy-pair-code').value = ''; toast('平台已绑定，任务保持暂停'); }));
$('#energy-sync').addEventListener('click', () => act(async () => { await api('energy/sync', {}); }));
$('#energy-disconnect').addEventListener('click', () => act(async () => { await api('energy/disconnect', {}); toast('已安全恢复独立本地模式'); }));
