'use strict';
const { app, BrowserWindow, Menu, dialog, shell, screen, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { localUrl, externalUrl, startupFile, windowOptions } = require('./policy');
const { responsivenessGuard } = require('./responsiveness');
const ROOT = path.resolve(__dirname, '../..');
const VERSION = require('../../package.json').version;
const dataDir = path.resolve(process.env.TCL_DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
app.setName('TCL 广告投放工作台');
nativeTheme.themeSource = 'light';
app.setAppUserModelId('com.tcl.adstudio');
app.setPath('userData', path.join(dataDir, 'desktop-profile'));
app.commandLine.appendSwitch('lang', 'zh-CN');
app.commandLine.appendSwitch('disable-features', 'Translate');
const statuses = new Set([process.env.TCL_STARTUP_STATUS].filter(startupFile));
const pending = new Map();
let backend, window, endpoint, origin, ready = false, quitting = false, updating = false, exited = false, recovering = false;
function logError(error) {
  const message = String(error?.stack || error).replace(/token=[^\s&]+/g, 'token=[redacted]');
  try { fs.appendFileSync(path.join(dataDir, 'desktop-error.log'), new Date().toISOString() + ' ' + message + '\n'); } catch {}
}
function report(value) { for (const file of statuses) { try { fs.writeFileSync(file, value); } catch {} } statuses.clear(); }
function focus() { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
function notify(message) { if (backend?.connected) backend.send(message, () => {}); }
function finish() {
  quitting = true;
  // The backend has acknowledged closing its database/server, or has exited.
  // app.quit() can leave Chromium's main process alive after an update closed
  // its last window. The update worker independently waits for the Node PID.
  backend?.unref();
  app.releaseSingleInstanceLock();
  app.exit(0);
  // On Windows, Electron can remain alive while its descendant updater runs,
  // even after the quit event. Break that wait cycle only during installation,
  // after the backend acknowledged saving/closing. Never terminate the backend.
  if (process.platform === 'win32' && updating) process.kill(process.pid, 'SIGKILL');
}
function quit() {
  if (!backend || exited) { finish(); return; }
  if (quitting) return;
  quitting = true;
  notify({ type: 'shutdown' });
}
function requestPause() {
  if (!backend?.connected || exited) return Promise.reject(new Error('投放后台已停止'));
  return new Promise((resolve, reject) => {
    const id = require('node:crypto').randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('暂停仍在处理，请稍后重新打开')); }, 30000);
    pending.set(id, { resolve, reject, timer }); notify({ type: 'pause', id });
  });
}
async function recoverRenderer() {
  if (quitting || updating || recovering) return;
  recovering = true;
  try {
    await requestPause();
    const result = await dialog.showMessageBox({ type: 'warning', title: '界面已暂停',
      message: '界面暂不可用，已暂停后续投放。', detail: '已保存的记录保留。重新打开界面后，需要手动确认才能继续投放。',
      buttons: ['重新打开界面', '退出程序'], defaultId: 0, cancelId: 1 });
    if (result.response === 0 && !exited && !quitting && window && !window.isDestroyed()) { await window.loadURL(endpoint); focus(); }
    else quit();
  } catch { dialog.showErrorBox('无法恢复界面', '请退出后重新打开；启动后保持暂停，原记录保留。'); quit(); }
  finally { recovering = false; }
}
async function createWindow() {
  window = new BrowserWindow(windowOptions(ROOT, screen.getPrimaryDisplay().workAreaSize));
  window.setMenu(null);
  const contents = window.webContents, session = contents.session;
  const responsiveness = responsivenessGuard(() => {
    logError('Renderer remained unresponsive outside a native dialog');
    recoverRenderer();
  });
  session.setPermissionRequestHandler((wc, permission, callback) => callback(wc === contents && permission === 'clipboard-sanitized-write' && localUrl(wc.getURL(), origin)));
  session.setPermissionCheckHandler((wc, permission, requestingOrigin) => wc === contents && permission === 'clipboard-sanitized-write' && localUrl(requestingOrigin, origin));
  contents.setWindowOpenHandler(({ url }) => { if (externalUrl(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
  contents.on('will-navigate', (event, url) => {
    if (!localUrl(url, origin)) { event.preventDefault(); if (externalUrl(url)) shell.openExternal(url).catch(() => {}); }
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-prevent-unload', event => {
    const answer = responsiveness.duringDialog(() => dialog.showMessageBoxSync(window, { type: 'question', title: '尚未保存修改', message: '有尚未保存的参数，仍要关闭吗？',
      buttons: ['返回检查', '放弃修改并关闭'], defaultId: 0, cancelId: 0 }));
    if (answer === 1) event.preventDefault();
  });
  session.on('will-download', (event, item) => {
    const url = new URL(item.getURL());
    if (!localUrl(url.href, origin) || !['/api/export', '/api/statistics/export'].includes(url.pathname)) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
  contents.on('render-process-gone', (_event, details) => {
    logError('Renderer exited: ' + details.reason); recoverRenderer();
  });
  window.on('unresponsive', responsiveness.unresponsive);
  window.on('responsive', responsiveness.responsive);
  window.on('closed', () => { responsiveness.dispose(); window = null; if (!updating) quit(); });
  await window.loadURL(endpoint);
  ready = true; focus(); report('ready');
}
async function start() {
  await app.whenReady(); Menu.setApplicationMenu(null); app.setAccessibilitySupportEnabled(true);
  const env = { ...process.env, TCL_DATA_DIR: dataDir, TCL_DESKTOP_PID: String(process.pid) };
  delete env.TCL_STARTUP_STATUS; delete env.ELECTRON_RUN_AS_NODE;
  backend = fork(path.join(ROOT, 'src/server.js'), ['--desktop-backend'], {
    execPath: path.join(ROOT, 'runtime/node.exe'), execArgv: ['--disable-warning=ExperimentalWarning'],
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const startupTimer = setTimeout(() => {
    report('error\n投放后台启动超时，请查看 startup-error.log'); quit();
  }, 120000);
  backend.on('message', message => {
    if (message?.type === 'ready') {
      if (quitting) { notify({ type: 'shutdown' }); return; }
      if (window) return;
      if (message.version !== VERSION) { report('error\n后台版本与桌面不一致，请退出后重新打开'); quit(); return; }
      endpoint = message.url; origin = new URL(endpoint).origin; clearTimeout(startupTimer);
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) { quit(); return; }
      createWindow().catch(error => { logError(error); report('error\n桌面界面加载失败，请查看 data/desktop-error.log'); dialog.showErrorBox('启动失败', error.message); quit(); });
    } else if (message?.type === 'paused' || message?.type === 'control-error') {
      const request = pending.get(message.id); if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      message.type === 'paused' ? request.resolve() : request.reject(new Error('后台暂停失败'));
    } else if (message?.type === 'installing' || message?.type === 'exit-requested') {
      updating = message.type === 'installing'; quitting = true;
      if (window && !window.isDestroyed()) window.destroy();
    } else if (message?.type === 'closed') {
      finish();
    }
  });
  backend.on('error', () => { clearTimeout(startupTimer); exited = true; report('error\n无法启动自带 Node.js 后台，请修复运行环境'); quit(); });
  backend.on('exit', () => {
    clearTimeout(startupTimer); exited = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('后台已退出')); } pending.clear();
    if (!quitting) {
      report('error\n投放后台未能启动，请查看 startup-error.log');
      dialog.showErrorBox('投放后台已停止', '请重新打开程序。已保存的记录保留，重新启动后保持暂停。');
    }
    finish();
  });
}
if (!app.requestSingleInstanceLock({ status: process.env.TCL_STARTUP_STATUS, version: VERSION })) app.quit();
else {
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    if (additionalData?.version && additionalData.version !== VERSION) {
      if (startupFile(additionalData.status)) { try { fs.writeFileSync(additionalData.status, 'error\n旧版窗口仍在运行，请先保存并退出旧窗口，再打开新版'); } catch {} }
      return;
    }
    if (startupFile(additionalData?.status)) statuses.add(additionalData.status);
    if (quitting) { report('error\n程序正在退出，请稍后重新打开'); return; }
    focus(); if (ready && !quitting) report('ready');
  });
  app.on('before-quit', event => {
    if (exited || !backend) return;
    event.preventDefault();
    if (window && !window.isDestroyed() && !quitting) window.close(); else quit();
  });
  app.on('window-all-closed', () => { if (!updating) quit(); });
  start().catch(error => { logError(error); report('error\n桌面启动失败：' + error.message); dialog.showErrorBox('启动失败', error.message); quit(); });
}
