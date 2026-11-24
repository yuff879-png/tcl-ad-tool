'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');

// SQLite holds a Windows file lock for the lifetime of this transaction. The OS
// releases it even after a crash; a recycled PID can never own this lock.
function tryLock(dataDir, name = 'instance-lock.sqlite') {
  fs.mkdirSync(dataDir, { recursive: true });
  let db;
  try {
    db = new DatabaseSync(path.join(dataDir, name));
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    let released = false;
    return { release() { if (!released) { released = true; db.close(); } } };
  } catch (error) {
    db?.close();
    if (error.errcode === 5 || error.errcode === 6) return null;
    throw error;
  }
}

async function liveInstance(dataDir) {
  try {
    const old = JSON.parse(fs.readFileSync(path.join(dataDir, 'instance.json'), 'utf8'));
    if (!Number.isInteger(old.port) || old.port < 1 || old.port > 65535 || !old.instanceId || !old.token) return null;
    const response = await fetch(`http://127.0.0.1:${old.port}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    return response.ok && health.app === 'tcl-ad-studio' && health.instanceId === old.instanceId ? { ...old, version: health.version } : null;
  } catch { return null; }
}

function legacyOwnerAlive(dataDir) {
  const file = path.join(dataDir, 'app.lock');
  let pid, writtenAt;
  try { pid = Number(fs.readFileSync(file, 'utf8')); writtenAt = fs.statSync(file).mtimeMs; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform !== 'win32') return true;
  // Compatibility with 1.0.0 only. A live PID alone is not proof of ownership.
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { @{ name=$p.Name; command=$p.CommandLine; started=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`;
  try {
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 6000 }).trim();
    if (!output) return false;
    const owner = JSON.parse(output);
    return owner.name?.toLowerCase() === 'node.exe' && owner.started <= writtenAt + 1000
      && /(?:src[\\/]server\.js|[\\/]server\.js)(?:[\s"]|$)/i.test(owner.command || '');
  } catch { throw new Error('无法确认旧版进程状态，请先退出旧版工具后再启动'); }
}

function tryUpdateLock(dataDir) { return tryLock(dataDir, 'update-lock.sqlite'); }

// Both the updater and the backend own OS locks. A launcher must wait until
// copying/saving has finished before it reads and starts application files.
async function waitForLaunch(dataDir, { timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const updateLock = tryUpdateLock(dataDir);
    if (updateLock) {
      try {
        const existing = await liveInstance(dataDir);
        if (existing) return { existing };
        const lock = tryLock(dataDir);
        if (lock) { lock.release(); return {}; }
      } finally { updateLock.release(); }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error('工具仍在保存数据或安装更新，请等待完成后再打开；详情见 data/update-result.json 和 startup-error.log');
}

async function acquireInstance(dataDir, { timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let legacyAlive = false, nextLegacyCheck = 0;
  do {
    const existing = await liveInstance(dataDir);
    if (existing) return { existing };
    const lock = tryLock(dataDir);
    if (lock) {
      try {
        if (Date.now() >= nextLegacyCheck) { legacyAlive = legacyOwnerAlive(dataDir); nextLegacyCheck = Date.now() + 1000; }
        if (legacyAlive) { lock.release(); }
        else {
          // A healthy 1.0.0 instance could have finished starting during the probe.
          const old = await liveInstance(dataDir);
          if (old) { lock.release(); return { existing: old }; }
          try { fs.unlinkSync(path.join(dataDir, 'app.lock')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          return { lock };
        }
      } catch (error) { lock.release(); throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error('工具仍在启动或退出中，未重复打开。请稍后重试；若持续出现，请先关闭已有工具窗口');
}

async function checkIdle(dataDir) {
  const updating = tryUpdateLock(dataDir);
  if (!updating) throw new Error('更新正在进行，请等待完成后再修复运行环境');
  try {
    if (await liveInstance(dataDir)) throw new Error('请先退出工具，再修复运行环境');
    const lock = tryLock(dataDir);
    if (!lock) throw new Error('工具正在运行、启动或退出，请稍后再修复');
    try { if (legacyOwnerAlive(dataDir)) throw new Error('请先退出旧版工具，再修复运行环境'); }
    finally { lock.release(); }
  } finally { updating.release(); }
}

if (require.main === module && process.argv.includes('--check-idle')) {
  checkIdle(process.env.TCL_DATA_DIR || path.resolve(__dirname, '../data')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { tryLock, tryUpdateLock, liveInstance, waitForLaunch, legacyOwnerAlive, acquireInstance, checkIdle };
