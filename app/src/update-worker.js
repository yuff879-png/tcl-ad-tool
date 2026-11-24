'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const { tryLock, tryUpdateLock, liveInstance } = require('./instance');
const { verifyManifest, compareVersions, sha256 } = require('./updater');
const { startApplication } = require('./startup');
const { createProgress, openProgress, atomicJson } = require('./update-progress');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Progress is observational after the visible-window handoff. Display/storage
// errors must never skip backups, rollback, or misclassify a healthy install.
function observedProgress(progress, errors) {
  const record = error => { errors.push(String(error?.message || error)); };
  return {
    ...progress,
    warning(error) { record(error); },
    set(...args) { try { return progress.set(...args); } catch (error) { record(error); } },
    fail(...args) { try { return progress.fail(...args); } catch (error) { record(error); } },
    succeed(...args) {
      try { return progress.succeed(...args); }
      catch (error) {
        record(error);
        try { progress.fail('更新已完成且新版已打开，但进度窗口未能同步完成状态。可关闭此窗口，继续使用新版。',
          { reopened: true, runningVersion: args[0]?.runningVersion, instanceId: args[0]?.instanceId }); }
        catch (displayError) { record(displayError); }
      }
    },
  };
}
async function installFiles({ root, dataDir, directory, ownerPid = 0, desktopPid = 0, progress }) {
  root = path.resolve(root); dataDir = path.resolve(dataDir); directory = path.resolve(directory);
  if (!fs.existsSync(path.join(root, 'package.json')) || dataDir !== path.join(root, 'data')) throw new Error('更新目标不是有效的工具目录');
  progress.set('verifying', { detail: '重新核对更新签名、版本和文件完整性。' });
  const release = verifyManifest(JSON.parse(fs.readFileSync(path.join(directory, 'update.json'), 'utf8')));
  if (compareVersions(release.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version) <= 0) throw new Error('拒绝重复安装或降级');
  const zip = path.join(directory, 'package.zip'), bytes = fs.readFileSync(zip);
  if (bytes.length !== release.size || sha256(bytes) !== release.sha256) throw new Error('更新包再次校验失败');
  const stage = path.join(directory, 'unpacked');
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  progress.set('extracting', { version: release.version, detail: '将更新包解压到临时目录，原程序文件尚未替换。' });
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'scripts/unpack-update.ps1'),
    '-Archive', zip, '-Destination', stage, '-ProgressFile', progress.extractFile, '-RunId', progress.runId], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
  try {
    const warning = JSON.parse(fs.readFileSync(path.join(path.dirname(progress.extractFile), 'extract-progress-warning.json'), 'utf8'));
    if (warning.runId === progress.runId && warning.phase === 'extracting') progress.warning(warning.message);
  } catch { /* Extraction progress is observational; real extraction errors throw above. */ }
  if (JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).version !== release.version) throw new Error('包内版本不符');
  progress.set('checking-package', { detail: '检查新版 Node.js、桌面环境和数据库支持。' });
  execFileSync(path.join(directory, 'node.exe'), ['--disable-warning=ExperimentalWarning', 'scripts/check.js', '--quick'], { cwd: stage, windowsHide: true, timeout: 30000 });
  progress.set('waiting', { detail: '等待旧窗口和后台保存完成；请勿重复打开程序。' });
  const deadline = Date.now() + 120000;
  let lock;
  do {
    if (ownerPid) { try { process.kill(ownerPid, 0); await wait(300); continue; } catch { ownerPid = 0; } }
    if (desktopPid) { try { process.kill(desktopPid, 0); await wait(300); continue; } catch { desktopPid = 0; } }
    if (!await liveInstance(dataDir)) lock = tryLock(dataDir);
    if (!lock) await wait(300);
  } while (!lock && Date.now() < deadline);
  if (!lock) throw new Error('旧程序尚未退出，本次更新未安装，请退出后重试');
  const backupDir = path.join(dataDir, 'backups', '在线更新前-' + new Date().toISOString().replace(/[:.]/g, '-'));
  const previous = path.join(backupDir, 'application');
  const changed = []; let db;
  try {
    progress.set('backing-up', { detail: '备份数据库、配置和加密钱包，保留原有记录。', backupDir });
    fs.mkdirSync(previous, { recursive: true });
    if (fs.existsSync(path.join(dataDir, 'records.sqlite'))) {
      db = new DatabaseSync(path.join(dataDir, 'records.sqlite'));
      await backup(db, path.join(backupDir, 'records.sqlite')); db.close(); db = null;
    }
    const configFile = path.join(dataDir, 'config.json');
    const configHash = fs.existsSync(configFile) ? sha256(fs.readFileSync(configFile)) : null;
    if (configHash) fs.copyFileSync(configFile, path.join(backupDir, 'config.json'));
    const vaultFile = path.join(dataDir, 'pool-vault.json');
    if (fs.existsSync(vaultFile)) fs.copyFileSync(vaultFile, path.join(backupDir, 'pool-vault.json'));
    const files = [];
    function collect(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const source = path.join(dir, item.name);
        if (item.isDirectory()) { collect(source); continue; }
        if (!item.isFile()) throw new Error('更新目录含有链接');
        files.push(source);
      }
    }
    collect(stage);
    progress.set('installing', { current: 0, total: files.length, unit: 'files', detail: '逐个核对并安装程序文件。' });
    let completed = 0, publishedAt = Date.now();
    for (const source of files) {
      const relative = path.relative(stage, source), target = path.join(root, relative), old = path.join(previous, relative);
      const content = fs.readFileSync(source), existed = fs.existsSync(target);
      if (!existed || sha256(fs.readFileSync(target)) !== sha256(content)) {
        if (existed) { fs.mkdirSync(path.dirname(old), { recursive: true }); fs.copyFileSync(target, old); }
        changed.push({ target, old, existed });
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
      }
      completed++;
      if (Date.now() - publishedAt >= 100 || completed === files.length) {
        progress.set('installing', { current: completed, total: files.length, unit: 'files', detail: '已核对并处理 ' + completed + ' 个程序文件。' });
        publishedAt = Date.now();
      }
    }
    progress.set('checking-installation', { detail: '检查程序语法、运行环境及配置完整性。' });
    execFileSync(path.join(directory, 'node.exe'), ['--disable-warning=ExperimentalWarning', 'scripts/check.js'], { cwd: root, windowsHide: true, timeout: 60000 });
    if (configHash && sha256(fs.readFileSync(configFile)) !== configHash) throw new Error('配置完整性检查失败');
    atomicJson(path.join(dataDir, 'update-result.json'), { ok: true, version: release.version, backupDir, reopening: true, runId: progress.runId, time: new Date().toISOString() });
  } catch (error) {
    const rollbackErrors = [];
    if (changed.length) progress.set('rolling-back', { detail: '安装检查未通过，正在恢复原程序文件。', backupDir });
    for (const item of changed.reverse()) {
      try {
        if (item.existed) fs.copyFileSync(item.old, item.target);
        else fs.unlinkSync(item.target);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    error.rollback = rollbackErrors.length ? 'failed' : changed.length ? 'restored' : 'not-needed';
    error.backupDir = backupDir;
    if (rollbackErrors.length) error.message += '；恢复原程序文件未完成，请保留工具文件夹和 data，通过备份恢复后再启动';
    throw error;
  } finally { db?.close(); lock.release(); }
  return { ok: true, version: release.version, backupDir, changedFiles: changed.length, time: new Date().toISOString() };
}
async function install({ root, dataDir, reopen = true, progress, ...options }) {
  root = path.resolve(root); dataDir = path.resolve(dataDir);
  if (!fs.existsSync(path.join(root, 'package.json')) || dataDir !== path.join(root, 'data')) throw new Error('更新目标不是有效的工具目录');
  if (!progress) {
    progress = createProgress({ directory: options.directory });
    await progress.startWindow({ scriptRoot: options.directory });
  }
  progress.set('waiting', { ownerPid: process.pid, detail: '正在接管本次更新，请等待安装完成。' });
  const progressErrors = [];
  progress = observedProgress(progress, progressErrors);
  try {
    const deadline = Date.now() + 120000;
    let updateLock, result;
    while (!(updateLock = tryUpdateLock(dataDir))) {
      if (Date.now() >= deadline) throw new Error('另一个更新仍在进行，请等待完成后再试');
      await wait(200);
    }
    // The separate reservation also covers unpacking and graceful shutdown.
    try { result = await installFiles({ root, dataDir, ...options, progress }); }
    finally { updateLock.release(); }
    result.runId = progress.runId;
    if (reopen) {
      progress.set('reopening', { detail: '安装完成，正在打开并确认新版窗口；程序保持暂停。' });
      try {
        await startApplication(root);
        const running = await liveInstance(dataDir);
        if (running?.version !== result.version) throw new Error('运行中的版本与已安装版本不一致，请查看 startup-error.log');
        result.reopened = true; result.runningVersion = running.version; result.instanceId = running.instanceId;
      }
      catch (error) { result.reopened = false; result.message = '版本已安装，自动打开未完成：' + error.message; }
    }
    atomicJson(path.join(dataDir, 'update-result.json'), result);
    if (result.reopened === true) progress.succeed({ ...result, detail: '已确认 ' + result.version + ' 新版窗口打开。' });
    else if (result.reopened === false) progress.fail(result.message, { backupDir: result.backupDir, reopened: false });
    else progress.set('installed', { detail: '版本 ' + result.version + ' 已安装，本次未请求自动打开。', backupDir: result.backupDir });
    if (progressErrors.length) {
      result.progressError = '更新进度显示异常：' + [...new Set(progressErrors)].join('；');
      atomicJson(path.join(dataDir, 'update-result.json'), result);
    }
    return result;
  } catch (error) {
    const failure = { ok: false, message: error.message, rollback: error.rollback || 'not-needed', backupDir: error.backupDir,
      runId: progress.runId, time: new Date().toISOString() };
    atomicJson(path.join(dataDir, 'update-result.json'), failure);
    progress.fail(error, failure);
    if (progressErrors.length) {
      failure.progressError = '更新进度显示异常：' + [...new Set(progressErrors)].join('；');
      atomicJson(path.join(dataDir, 'update-result.json'), failure);
    }
    throw error;
  }
}
if (require.main === module) {
  const [root, dataDir, owner, desktop, progressDirectory, runId] = process.argv.slice(2);
  Promise.resolve().then(() => install({ root, dataDir, directory: path.resolve(__dirname, '..'), ownerPid: Number(owner), desktopPid: Number(desktop),
    progress: progressDirectory ? openProgress(progressDirectory, runId) : undefined })).catch(async error => {
    if (error.rollback !== 'failed') await startApplication(root).catch(() => {});
    process.exitCode = 1;
  });
}
module.exports = { install };
