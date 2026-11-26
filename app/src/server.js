'use strict';
// Every released updater enters here. Opening the desktop must not load the
// blockchain/database application before the update lock has been released.
if (require.main === module && process.argv.includes('--open')) {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(__dirname, '..');
  require('./desktop-launch').launchDesktop(root).catch(error => {
    fs.appendFileSync(path.join(root, 'startup-error.log'), `${new Date().toISOString()} ${error.message}\n`);
    try { if (process.env.TCL_STARTUP_STATUS) fs.writeFileSync(process.env.TCL_STARTUP_STATUS, 'error\n' + error.message); } catch {}
    process.exitCode = 1;
  });
  return;
}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { backup } = require('node:sqlite');
const { Store } = require('./store');
const { Engine } = require('./engine');
const { EnergyPolicy } = require('./energy-policy');
const { DeliveryReporter } = require('./delivery-reporter');
const { RuntimeControl } = require('./runtime-control');
const { RentalClient, platformOrigin } = require('./rental-client');
const { WalletPool } = require('./pool');
const { acquireInstance } = require('./instance');
const { PresenceMonitor, windowPresent, closePreviousWindows } = require('./presence');
const { Updater } = require('./updater');
const { StatisticsService } = require('./statistics-service');
const { version: VERSION } = require('../package.json');
const { DEFAULTS, normalize, validate, publicConfig, atomicJson, redact, effectiveConfig, walletAddress } = require('./config');

const ROOT = path.resolve(__dirname, '..');
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
async function openWindow(url, dataDir, { replacePrevious = false } = {}) {
  const candidates = [process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  const browser = candidates.find(file => fs.existsSync(file));
  if (!browser) throw new Error('没有找到 Microsoft Edge 或 Chrome，请安装其中一个浏览器');
  let previousWindows = null;
  if (replacePrevious) {
    // The caller already owns the new server lock. Older updater versions also
    // reach this startup path, so the very first upgrade gets window cleanup.
    try { previousWindows = await closePreviousWindows(dataDir); }
    catch { previousWindows = { error: true }; }
  }
  const width = Math.min(1600, Math.max(800, Number(process.env.TCL_WINDOW_WIDTH) || 1280));
  const height = Math.min(1100, Math.max(600, Number(process.env.TCL_WINDOW_HEIGHT) || 820));
  const child = spawn(browser, ['--app=' + url, '--new-window', `--window-size=${width},${height}`,
    '--user-data-dir=' + path.join(dataDir, 'browser-profile'), '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-features=msImplicitSignin'],
  { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { pid: child.pid, previousWindows };
}
async function createApp({ dataDir = process.env.TCL_DATA_DIR || path.join(ROOT, 'data'), chainFactory, rentalFactory = (origin, token) => new RentalClient(origin, token), port = 0, idleExit = false, windowProbe = () => windowPresent(dataDir), updater = new Updater(), automaticUpdates = true, automaticRuntime = true, desktop = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  // A corrupt config is a startup error; never overwrite it with defaults.
  let config = fs.existsSync(configPath) ? normalize(JSON.parse(fs.readFileSync(configPath, 'utf8'))) : structuredClone(DEFAULTS);
  if (!fs.existsSync(configPath)) atomicJson(configPath, config);
  const store = new Store(dataDir);
  const statistics = new StatisticsService(path.join(dataDir, 'records.sqlite'));
  function statisticsInput(params) {
    const input = Object.fromEntries(params);
    const usesCurrent = input.token === undefined || input.token === 'current';
    if (usesCurrent) input.token = effectiveConfig(config).tokenContract || '__unconfigured__';
    return { input, currentToken: effectiveConfig(config).tokenContract, requiresToken: usesCurrent && !effectiveConfig(config).tokenContract };
  }
  const engine = new Engine(store, () => config, chainFactory);
  const energyPolicy = new EnergyPolicy(() => config, { factory: rentalFactory,
    boundary: () => { const pending = store.pending(); return { ready: !engine.activeDeliveryId && !pending.length && !store.unresolvedEnergyOrders().length, pending_txid: pending[0]?.txid || null }; },
    onChange: () => engine.queueWaiter?.() });
  engine.energyPolicy = energyPolicy;
  const pool = new WalletPool(store, dataDir, () => config, (c, group) => engine.getChain(c, group || 'pool'));
  engine.pool = pool;
  const deliveryReporter = new DeliveryReporter(store, () => config, { factory: rentalFactory,
    authorizeOwner: async (client, binding, owner) => {
      const marker = 'delivery-report-wallet:' + JSON.stringify([binding.origin, binding.device, binding.wallet, owner]);
      if (store.getMeta(marker) === true) return true;
      const wallet = store.db.prepare('SELECT id FROM pool_wallets WHERE address=?').get(owner);
      if (!wallet) return null;
      if (!pool.vault.unlocked) return false;
      const key = pool.vault.get(wallet.id).key;
      if (walletAddress({ privateKey: key }) !== owner) return false;
      const message = `TCL delivery statistics wallet\nv1\n${binding.origin}\n${binding.device}\n${owner}`;
      const signature = require('tronweb').Trx.signMessageV2(message, key);
      const result = await client.registerDeliveryWallet({ owner_address: owner, signature });
      if (result?.registered !== true || result.owner_address !== owner) throw new Error('平台未确认投放钱包归属，保留待补报记录');
      store.setMeta(marker, true); return true;
    } });
  engine.deliveryReporter = deliveryReporter;
  engine.startBackgroundConfirmation();
  const token = crypto.randomBytes(32).toString('hex'), instanceId = crypto.randomUUID();
  let confirmation = null, closed = false, closing = false, idleTimer, presence, operation = false, installing = false, closePromise, startPromise;
  let boundPort;
  function assertIdle(allowEnergyRecovery = false) { if (installing) throw new Error('正在安装更新，请等待新窗口打开'); if (operation || pool.running || engine.busy || (!allowEnergyRecovery && engine.energyRecovery) || ['running', 'starting', 'stopping'].includes(engine.state)) throw new Error('请先暂停任务或取消自动恢复，等待当前处理完成后再操作'); }
  async function exclusive(fn, allowEnergyRecovery = false) { assertIdle(allowEnergyRecovery); operation = true; try { return await fn(); } finally { operation = false; } }
  async function batchOperation(fn) {
    if (operation || installing || closing || closed || pool.running) throw new Error('其他操作正在进行，请稍后添加批量投放');
    operation = true; try { return await fn(); } finally { operation = false; }
  }
  const runtimeControl = new RuntimeControl(store, () => config, engine, { factory: rentalFactory, instanceId,
    idleReason: () => closing || closed ? '程序正在退出' : installing ? '正在安装更新' : operation || pool.running ? '本机操作正在进行' : '',
    startLive: assertCurrent => exclusive(async () => {
      assertCurrent();
      if (store.pending().length || store.unresolvedEnergyOrders().length) throw new Error('存在待确认交易，请先完成核查');
      engine.manualRetry.cancel(); confirmation = null;
      startPromise = engine.start('live', undefined, null, { assertCurrent });
      try { await startPromise; } finally { startPromise = null; }
    }) });
  engine.onManualStop = () => runtimeControl.invalidate();
  async function createBackup(prefix = '') {
    const folder = path.join(dataDir, 'backups', prefix + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
    fs.mkdirSync(folder, { recursive: true });
    await backup(store.db, path.join(folder, 'records.sqlite'));
    atomicJson(path.join(folder, 'config.json'), config);
    if (pool.vault.exists) { fs.copyFileSync(pool.vault.file, path.join(folder, 'pool-vault.json')); pool.noteBackup(folder); }
    if (store.getMeta('migration')) atomicJson(path.join(folder, 'migration-report.json'), store.getMeta('migration'));
    return folder;
  }
  function send(res, code, data, type = 'application/json; charset=utf-8') {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('请求必须为 JSON');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('提交内容超过 2 MB'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  async function pause(reason) {
    runtimeControl.invalidate();
    if (engine.state === 'starting') engine.fail(new Error(reason || '程序正在关闭，已取消启动'));
    else engine.stop();
    await pool.stop();
    await startPromise?.catch(() => {});
    await engine.stopAndWait();
  }
  function close() {
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const remoteClosed = runtimeControl.close();
      presence?.stop(); clearInterval(idleTimer); updater.stopAutomaticChecks?.();
      // Stop immediately, then let any in-flight preflight/config/backup finish.
      await pause();
      while (operation) await new Promise(resolve => setTimeout(resolve, 25));
      await remoteClosed;
      await updater.stopDownload?.();
      await deliveryReporter.close();
      await pool.close();
      await energyPolicy.close();
      await engine.close();
      await statistics.close();
      await new Promise(resolve => {
        server.close(resolve);
        // Chromium may keep preconnected sockets that have never sent HTTP.
        // All business work has finished; close those too so updates can exit.
        server.closeAllConnections();
      });
      clearInterval(idleTimer); store.close(); closed = true;
      desktop?.onClosed?.();
    })().finally(() => { closing = false; });
    return closePromise;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const expectedHost = `127.0.0.1:${boundPort}`;
      if (req.headers.host !== expectedHost) return send(res, 403, { error: '仅接受本机访问' });
      const url = new URL(req.url, 'http://' + expectedHost);
      if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { app: 'tcl-ad-studio', version: VERSION, instanceId });
      if (url.pathname === '/' && url.searchParams.get('token') === token) {
        res.writeHead(303, { Location: '/', 'Set-Cookie': `tcl_session=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      const authenticated = (req.headers.cookie || '').split(';').some(v => v.trim() === 'tcl_session=' + token);
      if (!authenticated) return send(res, 401, { error: '会话已过期，请双击启动程序重新打开界面' });
      const mutating = req.method !== 'GET';
      if (mutating && (req.headers.origin !== 'http://' + expectedHost || req.headers['x-tcl-request'] !== '1')) return send(res, 403, { error: '请求来源无效' });
      if (url.pathname.startsWith('/api/')) {
        if (closing) return send(res, 409, { error: '程序正在退出' });
        const input = mutating ? await body(req) : {};
        if (closing || closed) return send(res, 409, { error: '程序正在退出' });
        let result;
        const route = req.method + ' ' + url.pathname;
        // Local control takes priority over any not-yet-started remote command.
        // Background UI heartbeats and read-only sync/update checks do not
        // invalidate the configuration the customer is reviewing on the web.
        if (mutating && !['/api/heartbeat', '/api/energy/sync', '/api/update/check', '/api/update/download'].includes(url.pathname)) runtimeControl.invalidate();
        switch (route) {
          case 'POST /api/energy/pair': {
            result = await exclusive(async () => {
              if (energyPolicy.linked()) throw new Error('已绑定平台，请先安全恢复独立本地模式');
              if (store.unresolvedEnergyOrders().length) throw new Error('原平台订单仍待核查，请先处理费用收尾再重新绑定');
              const wallet = walletAddress(config);
              if (!wallet || config.assetType !== 'TRC20') throw new Error('请先保存 TRC20 投放钱包');
              const origin = platformOrigin(String(input.platformUrl || ''));
              const code = String(input.code || '').trim();
              if (!code || code.length > 200) throw new Error('请填写平台一次性绑定码');
              const data = { code, wallet_address: wallet, device_name: 'TCL Ad', client_version: VERSION };
              const client = rentalFactory(origin, '');
              const challenge = await client.challenge(data);
              if (typeof challenge.message !== 'string' || !challenge.message.startsWith('Energy Desk device binding\n') || !challenge.message.includes(wallet) || challenge.message.length > 4096) throw new Error('平台绑定证明格式无效');
              const signature = await engine.getChain(config).signBindingChallenge(challenge.message);
              const paired = await client.pair({ ...data, signature });
              if (typeof paired.device_token !== 'string' || !paired.device_token || !paired.device_id) throw new Error('平台未返回设备凭据');
              const next = validate(normalize({ energyTransport: 'platform', platformUrl: origin, platformToken: paired.device_token, platformDeviceId: String(paired.device_id), platformWallet: wallet }, config));
              atomicJson(configPath, next); config = next; confirmation = null; energyPolicy.reset();
              await energyPolicy.sync();
              engine.log('info', store.pending().length ? '已绑定能量平台；原交易仍待核查，切换能量模式会等待核查完成，任务保持暂停' : '已绑定能量平台；私钥保留本地，任务保持暂停');
              return energyPolicy.snapshot();
            }); break;
          }
          case 'POST /api/energy/sync': result = await energyPolicy.sync(); break;
          case 'POST /api/energy/disconnect': {
            result = await exclusive(async () => {
              if (!energyPolicy.linked()) return energyPolicy.snapshot();
              if (store.pending().length) throw new Error('原交易仍待链上核查，不能断开');
              const unfinished = store.unresolvedEnergyOrders();
              if (unfinished.some(row => row.platform_origin !== config.platformUrl || row.device_id !== config.platformDeviceId) || unfinished.length > 20) throw new Error('存在其他绑定的未决平台订单，请联系管理员核对');
              // The server atomically checks local mode and no active service.
              // Its idempotent endpoint also handles a previously revoked token
              // when the first successful disconnect response was lost.
              const response = await energyPolicy.client().disconnect(unfinished.map(row => row.intent_id));
              if (response.disconnected !== true) throw new Error('平台未确认设备解绑，保留原连接');
              for (const order of response.orders || []) {
                const saved = unfinished.find(row => row.intent_id === order.intent_id);
                if (saved) engine.acceptEnergyOrder(saved.delivery_id, order);
              }
              if (store.unresolvedEnergyOrders().length) throw new Error('平台费用收尾数据尚未完整取得，保留凭据；可再次恢复本地');
              config = { ...config, energyTransport: 'local', platformUrl: '', platformToken: '', platformDeviceId: '', platformWallet: '' };
              atomicJson(configPath, config); confirmation = null; energyPolicy.reset();
              engine.log('info', '已安全恢复独立本地模式；后续需手动启动'); return energyPolicy.snapshot();
            }); break;
          }
          case 'GET /api/state': result = { ...engine.snapshot(), config: publicConfig(config), migration: store.getMeta('migration'), lastAddressReset: store.getMeta('lastAddressReset'), version: VERSION, uiConnection: presence?.snapshot(), update: updater.snapshot() }; break;
          case 'GET /api/logs': result = store.logs(Math.max(0, Number(url.searchParams.get('after')) || 0)); break;
          case 'GET /api/pool': result = { ...pool.snapshot(), wallets: pool.wallets(Object.fromEntries(url.searchParams)), batches: pool.batches() }; break;
          case 'POST /api/pool/unlock': result = await exclusive(() => pool.unlock(input.password, input.initialize === true)); break;
          case 'POST /api/pool/lock': result = await exclusive(() => { pool.vault.lock(); return pool.snapshot(); }); break;
          case 'POST /api/pool/generate': result = await exclusive(() => pool.generate(input.count)); break;
          case 'POST /api/pool/verify-backup': result = await exclusive(() => pool.verifyBackup(input.password)); break;
          case 'POST /api/pool/token': result = await exclusive(() => pool.tokenInfo()); break;
          case 'POST /api/pool/refresh': result = await exclusive(() => pool.refresh()); break;
          case 'POST /api/pool/enabled': result = await exclusive(() => pool.setEnabled(input.ids, input.enabled)); break;
          case 'POST /api/pool/plan': result = await exclusive(() => pool.plan(input)); break;
          case 'POST /api/pool/start': result = await exclusive(() => pool.startPlanned(input.confirmation)); break;
          case 'POST /api/pool/resume': result = await exclusive(() => { pool.resume(String(input.id)); return pool.snapshot(); }); break;
          case 'POST /api/pool/stop': await pool.stop(); result = pool.snapshot(); break;
          case 'POST /api/heartbeat': presence?.heartbeat(); result = { ok: true }; break;
          case 'GET /api/update': {
            let lastResult = null;
            try { lastResult = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-result.json'), 'utf8')); } catch { /* No previous update. */ }
            result = { ...updater.snapshot(), lastResult }; break;
          }
          case 'POST /api/update/check': if (installing) throw new Error('正在安装更新，请等待新窗口打开'); result = await updater.check(); break;
          case 'POST /api/update/download': {
            if (installing) throw new Error('正在安装更新，请等待新窗口打开');
            result = updater.startDownload(input.version); break;
          }
          case 'POST /api/update/install': {
            result = await exclusive(async () => {
              if (input.confirmed !== true) throw new Error('请确认安装更新');
              if (path.resolve(dataDir) !== path.join(path.resolve(updater.root || ROOT), 'data')) throw new Error('测试或自定义数据目录不支持在线安装');
              engine.cancelEnergyRecovery('准备安装更新，已取消自动恢复；更新后保持暂停');
              const directory = await updater.readyDirectory(input.version);
              await updater.launch(directory, dataDir, process.pid, desktop?.pid || 0);
              installing = true;
              desktop?.onInstalling?.();
              engine.log('info', '已验证更新包，即将退出并安装；更新后保持暂停');
              setTimeout(() => close().catch(() => {}), 200);
              return { ok: true, version: input.version };
            }, true); break;
          }
          case 'POST /api/config': {
            if (['energyTransport', 'platformUrl', 'platformToken', 'platformDeviceId', 'platformWallet'].some(k => Object.hasOwn(input, k)) || input.clearSecrets?.includes('platformToken')) throw new Error('请使用平台连接面板绑定或安全断开');
            assertIdle(true); const next = validate(normalize(input, config)); engine.manualRetry.cancel(); engine.manualBatches.cancelPreview();
            engine.cancelEnergyRecovery('设置已修改，已取消自动恢复；请重新预检并手动启动');
            if (next.assetType !== config.assetType || effectiveConfig(next).tokenContract !== effectiveConfig(config).tokenContract) {
              // Changing campaigns never turns an old unknown broadcast into a
              // fresh transfer when the user later switches back.
              store.transaction(() => {
                for (const row of store.pending()) {
                  if (row.status === 'executed') continue;
                  store.exhaustRetry(row);
                  store.update(row.id, row.status, { detail: '已切换投放类型或代币；只核查原交易，不再自动补发' });
                }
              });
            }
            atomicJson(configPath, next); config = next; confirmation = null; engine.preflightResult = null; engine.wallet = null;
            engine.log('info', '设置已保存；正式启动前会重新预检'); result = publicConfig(config); break;
          }
          case 'POST /api/preflight': result = await exclusive(() => engine.preflight('simulate')); break;
          case 'POST /api/prepare': {
            result = await exclusive(async () => { const checked = await engine.preflight('live');
            engine.checkFunds(checked.resources, checked.token, effectiveConfig(config), checked.amount);
            confirmation = { token: crypto.randomBytes(24).toString('hex'), expires: Date.now() + 120000, checked, config: JSON.stringify(config) };
            return { confirmationToken: confirmation.token, ...checked, config: publicConfig(config) }; }); break;
          }
          case 'POST /api/start': {
            assertIdle();
            engine.manualRetry.cancel();
            let checked;
            if (input.mode === 'live') {
              if (!confirmation || confirmation.expires < Date.now() || confirmation.token !== input.confirmationToken || confirmation.config !== JSON.stringify(config)) throw new Error('正式投放确认已过期，请重新预检确认');
              checked = confirmation.checked; confirmation = null;
            }
            startPromise = engine.start(input.mode, checked);
            try { await startPromise; } finally { startPromise = null; }
            result = engine.snapshot(); break;
          }
          case 'POST /api/stop':
            if ((runtimeControl.execution || engine.manualBatches.starting) && engine.state === 'starting') engine.fail(new Error('本机已暂停，取消本次启动'));
            else engine.stop();
            await pool.stop(); result = engine.snapshot(); break;
          case 'GET /api/manual-batches': result = { ...engine.manualBatches.list(url.searchParams.get('page')),
            queue: store.queueSummary(engine.running ? engine.mode : (url.searchParams.get('mode') === 'simulate' ? 'simulate' : 'live'), effectiveConfig(config)) }; break;
          case 'POST /api/manual-batches/prepare': result = await batchOperation(() => engine.manualBatches.prepare(input)); break;
          case 'POST /api/manual-batches/submit': result = await batchOperation(() => engine.manualBatches.submit(input)); break;
          case 'POST /api/manual-batches/cancel': result = await batchOperation(() => engine.manualBatches.cancel(String(input.id || ''))); break;
          case 'POST /api/reconcile': result = await exclusive(() => engine.reconcile()); break;
          case 'POST /api/records/recheck': result = await exclusive(() => engine.reviewRecord(String(input.id || ''))); break;
          case 'POST /api/records/prepare-retry': result = await exclusive(() => engine.manualRetry.prepare(String(input.id || ''))); break;
          case 'POST /api/records/retry': result = await exclusive(() => engine.manualRetry.retry(String(input.id || ''), input)); break;
          case 'POST /api/records/close-review': result = await exclusive(async () => {
            const row = await engine.reviewRecord(String(input.id || ''), { close: true, confirmed: input.confirmed, note: input.note, expected_action: input.expected_action });
            confirmation = null; return row;
          }); break;
          case 'POST /api/reset-cursor': {
            assertIdle(); if (!['live', 'simulate'].includes(input.mode)) throw new Error('请选择模式');
            result = await exclusive(async () => ({ height: await engine.resetCursor(input.mode) })); break;
          }
          case 'POST /api/cancel-queued': {
            assertIdle(); const rows = store.db.prepare("SELECT id FROM deliveries WHERE status='queued'").all();
            store.transaction(() => rows.forEach(row => store.update(row.id, 'cancelled', { detail: '用户取消等待队列；仍保留去重记录' })));
            engine.log('warn', `已取消 ${rows.length} 条等待投放，保留地址去重记录`); result = { count: rows.length }; break;
          }
          case 'POST /api/clear-delivered': {
            result = await exclusive(async () => {
              if (!['live', 'simulate'].includes(input.mode) || input.confirmed !== true) throw new Error('请选择清空范围，并确认允许这些地址再次命中');
              if (store.pending().length) throw new Error('还有待确认交易，请先核查完成后再清空');
              const count = store.deliveredCounts()[input.mode];
              if (!count) return { count: 0, backupPath: null };
              const backupPath = await createBackup('清空地址前-');
              const cleared = store.clearDeliveredAddresses(input.mode, backupPath);
              confirmation = null;
              engine.log('warn', `已清空${input.mode === 'live' ? '正式已投放' : '模拟命中'}地址去重 ${cleared.count} 个；历史明细与交易去重保留，已自动备份`);
              return { ...cleared, backupPath };
            }); break;
          }
          case 'GET /api/records': {
            const page = Math.max(1, Math.min(1000000, Math.floor(Number(url.searchParams.get('page')) || 1)));
            result = store.records({ search: (url.searchParams.get('search') || '').slice(0, 200), mode: url.searchParams.get('mode') || '', status: url.searchParams.get('status') || '', page }); break;
          }
          case 'GET /api/statistics': {
            const { input, currentToken, requiresToken } = statisticsInput(url.searchParams);
            result = { ...await statistics.query(input), currentToken, requiresToken }; break;
          }
          case 'GET /api/statistics/export': {
            const { input } = statisticsInput(url.searchParams);
            const csv = await statistics.query({ ...input, export: true });
            res.setHeader('Content-Disposition', 'attachment; filename="tcl-daily-statistics.csv"');
            return send(res, 200, csv, 'text/csv; charset=utf-8');
          }
          case 'POST /api/backup': {
            result = await exclusive(async () => ({ path: await createBackup() })); break;
          }
          case 'GET /api/environment': result = { '程序版本': VERSION, 'Node.js': process.version, '系统架构': process.platform + ' / ' + process.arch,
            '窗口类型': desktop ? 'Electron 独立桌面窗口' : '本地服务', 'TronWeb': '6.0.3', '数据库检查': store.db.prepare('PRAGMA quick_check').get().quick_check, '数据目录': dataDir, '无需系统安装': '使用自带 Node.js 和 Electron' }; break;
          case 'GET /api/export': {
            res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tcl-records.csv"', 'Cache-Control': 'no-store' });
            res.write('\uFEFF' + ['时间', '模式', '收款地址', '触发币种', '触发金额', '广告合约', '投放数量', '状态', '触发交易', '投放交易', '备注', '地址去重清空时间', '平台订单', '广播路线', '平台服务费 SUN', '计费状态'].map(csvCell).join(',') + '\r\n');
            for (const row of store.db.prepare('SELECT * FROM deliveries ORDER BY created_at DESC').iterate()) {
              const energy = store.energyOrder(row.id);
              const values = [row.created_at, row.mode, row.address, row.source_asset, row.source_amount, row.token, row.amount, row.status, row.source_tx, row.txid, row.detail, row.dedupe_cleared_at, energy?.order_id, energy?.route, energy?.submitted ? energy.customer_fee_sun ?? '待核对' : '0', energy?.billing_status];
              if (!res.write(values.map(csvCell).join(',') + '\r\n')) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
              if (res.destroyed) break;
            }
            return res.end();
          }
          case 'POST /api/exit': if (operation || (engine.state === 'starting' && !engine.energyRecovery)) throw new Error('操作正在进行，请完成后退出'); engine.stop(); result = { ok: true }; desktop?.onExit?.(); setTimeout(() => close().catch(() => {}), 100); break;
          default: return send(res, 404, { error: '接口不存在' });
        }
        return send(res, 200, result);
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/pool.js': ['pool.js', 'text/javascript; charset=utf-8'],
        '/batches.js': ['batches.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
      if (req.method !== 'GET' || !files[url.pathname]) return send(res, 404, 'Not found', 'text/plain');
      const [file, type] = files[url.pathname]; return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), type);
    } catch (error) {
      if (!res.headersSent) send(res, 400, { error: redact(error.message || String(error), config) }); else res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  boundPort = server.address().port;
  if (automaticUpdates) updater.startAutomaticChecks();
  energyPolicy.start();
  deliveryReporter.start();
  if (automaticRuntime) runtimeControl.start();
  if (idleExit) {
    presence = new PresenceMonitor({ probe: windowProbe, engine, pool, close, canClose: () => !engine.busy && !pool.running && !operation });
    idleTimer = setInterval(() => presence.tick(), 10000);
  }
  engine.log('info', '投放工作台已就绪。默认暂停，正式投放需要在本机或已绑定平台确认');
  return { server, store, engine, energyPolicy, deliveryReporter, runtimeControl, pool, close, pause, port: boundPort, token, instanceId, url: `http://127.0.0.1:${boundPort}/?token=${token}` };
}
async function main() {
  const isDesktop = process.argv.includes('--desktop-backend') && Boolean(process.send);
  const notifyDesktop = message => { if (process.connected) process.send(message, () => {}); };
  const dataDir = process.env.TCL_DATA_DIR || path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const instanceFile = path.join(dataDir, 'instance.json');
  const { existing, lock } = await acquireInstance(dataDir);
  if (existing) {
    if (isDesktop) { process.disconnect(); throw new Error('已有后台正在运行，请退出原工具后再打开桌面版'); }
    reportStartup('ready'); return;
  }
  let app;
  const cleanup = () => {
    try { if (app && JSON.parse(fs.readFileSync(instanceFile, 'utf8')).instanceId === app.instanceId) fs.unlinkSync(instanceFile); } catch { /* Stale metadata is harmless; the OS lock is authoritative. */ }
    lock.release();
  };
  process.once('exit', cleanup);
  try {
    const desktop = isDesktop ? { pid: Number(process.env.TCL_DESKTOP_PID) || 0,
      onInstalling: () => notifyDesktop({ type: 'installing' }), onExit: () => notifyDesktop({ type: 'exit-requested' }),
      onClosed: () => { notifyDesktop({ type: 'closed' }); if (process.connected) process.disconnect(); } } : null;
    app = await createApp({ dataDir, idleExit: !isDesktop, desktop });
    atomicJson(instanceFile, { pid: process.pid, port: app.port, token: app.token, instanceId: app.instanceId,
      version: VERSION, desktopPid: desktop?.pid || 0 });
    if (isDesktop) {
      require('./desktop-control').attachDesktopControl(app);
      // Run only on first desktop launch after a browser-based installation.
      const marker = path.join(dataDir, 'desktop-migrated.json');
      if (!fs.existsSync(marker)) {
        if (fs.existsSync(path.join(dataDir, 'browser-profile'))) {
          try { await closePreviousWindows(dataDir); }
          catch { app.engine.log('warn', '旧浏览器窗口未能自动关闭，可手动关闭；桌面版已正常启动'); }
        }
        atomicJson(marker, { version: VERSION, time: new Date().toISOString() });
      }
      notifyDesktop({ type: 'ready', url: app.url, version: VERSION });
    }
    reportStartup('ready');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().catch(() => {}));
  } catch (error) { if (app) await app.close(); cleanup(); throw error; }
}
function reportStartup(status) { if (process.env.TCL_STARTUP_STATUS) fs.writeFileSync(process.env.TCL_STARTUP_STATUS, status, 'utf8'); }
if (require.main === module) main().catch(error => {
  fs.appendFileSync(path.join(ROOT, 'startup-error.log'), `${new Date().toISOString()} ${error.message}\n`);
  try { reportStartup('error\n' + error.message); } catch { /* Launcher also checks process exit. */ }
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
module.exports = { createApp, csvCell, openWindow };
