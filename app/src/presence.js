'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

async function windowPresent(dataDir) {
  if (process.platform !== 'win32') return true;
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve(__dirname, '../scripts/window-state.ps1'), '-ProfilePath', path.join(dataDir, 'browser-profile')],
  { encoding: 'utf8', timeout: 8000, windowsHide: true });
  const result = JSON.parse(stdout.trim());
  if (typeof result.present !== 'boolean') throw new Error('窗口状态返回无效');
  return result.present;
}
async function closePreviousWindows(dataDir) {
  if (process.platform !== 'win32') return { matched: 0, closed: 0, remaining: 0 };
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve(__dirname, '../scripts/window-state.ps1'), '-ProfilePath', path.resolve(dataDir, 'browser-profile'), '-ClosePrevious'],
  { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const result = JSON.parse(stdout.trim());
  if (![result.matched, result.closed, result.remaining].every(n => Number.isSafeInteger(n) && n >= 0)
    || result.closed + result.remaining !== result.matched) throw new Error('旧窗口关闭结果无效');
  return result;
}

class PresenceMonitor {
  constructor({ probe, engine, pool, close, canClose, now = () => performance.now() }) {
    Object.assign(this, { probe, engine, pool, close, canClose, now });
    this.missingSince = null; this.lastHeartbeat = now(); this.lastCheck = null;
    this.windowState = 'checking'; this.checking = false; this.closed = false; this.warned = false;
  }
  heartbeat() { this.lastHeartbeat = this.now(); }
  snapshot() { return { windowState: this.windowState, heartbeatAgeSeconds: Math.floor((this.now() - this.lastHeartbeat) / 1000), lastCheck: this.lastCheck }; }
  async tick() {
    if (this.checking || this.closed) return;
    this.checking = true;
    try {
      const present = await this.probe();
      if (this.closed) return;
      this.windowState = present ? 'open' : 'closed'; this.lastCheck = new Date().toISOString(); this.warned = false;
      if (present) { this.missingSince = null; return; }
      this.missingSince ??= this.now();
      const elapsed = this.now() - this.missingSince;
      // Two consecutive native observations avoid treating a refresh/startup as a close.
      if (elapsed >= 10000 && (this.engine.running || this.engine.energyRecovery || this.pool?.running)) {
        this.engine.log('warn', '工具窗口已关闭，自动暂停后续投放；最小化和切换窗口不会触发此暂停');
        this.engine.stop();
        await this.pool?.stop();
      }
      if (elapsed >= 90000 && this.canClose()) await this.close();
    } catch {
      if (this.closed) return;
      this.windowState = 'unknown'; this.missingSince = null;
      if (!this.warned) { this.warned = true; this.engine.log('warn', '暂时无法读取工具窗口状态，将重试；投放仍按资源与交易检查运行，可使用“暂停”或“退出程序”停止'); }
    } finally { this.checking = false; }
  }
  stop() { this.closed = true; }
}
module.exports = { PresenceMonitor, windowPresent, closePreviousWindows };
