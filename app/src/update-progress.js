'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const TITLES = {
  checking: '正在检查新版本', downloading: '正在下载更新包', verifying: '正在验证更新包',
  extracting: '正在解压更新包', 'checking-package': '正在检查新版运行环境', waiting: '正在等待旧程序保存并退出',
  'backing-up': '正在备份配置和历史记录', installing: '正在安装新版文件',
  'checking-installation': '正在验证安装结果', reopening: '正在打开新版工作台', 'rolling-back': '正在恢复原程序文件',
  succeeded: '更新完成，新版已打开', failed: '更新未完成', installed: '安装完成',
};
const TERMINAL = new Set(['failed', 'succeeded', 'installed']);
function atomicJson(file, value) {
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  try {
    const deadline = Date.now() + 1500;
    let delay = 10;
    for (;;) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        // Windows readers/indexers can briefly deny replacement despite the
        // application's own readers allowing delete sharing. Keep the old JSON
        // intact and retry the same complete candidate for a bounded interval.
        const remaining = deadline - Date.now();
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, remaining));
        delay = Math.min(delay * 2, 100);
      }
    }
  }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function readState(directory, runId) {
  if (!/^[a-f0-9-]{36}$/.test(runId || '')) throw new Error('更新进度标识无效');
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'progress-state.json'), 'utf8'));
  if (state.schemaVersion !== 1 || state.runId !== runId || !TITLES[state.phase] || !['running', ...TERMINAL].includes(state.status)) throw new Error('更新进度记录不属于本次更新');
  return state;
}
function reporter(directory, initial, now = Date.now) {
  let state = initial;
  const stateFile = path.join(directory, 'progress-state.json');
  const extractFile = path.join(directory, 'extract-progress.json');
  const readyFile = path.join(directory, 'ui-ready.json');
  const api = {
    directory, runId: state.runId, stateFile, extractFile,
    snapshot() { return { ...state }; },
    set(phase, details = {}) {
      if (!TITLES[phase]) throw new Error('未知的更新阶段');
      if (TERMINAL.has(state.status)) throw new Error('本次更新已经结束');
      if (phase === 'succeeded' && (details.reopened !== true || details.runningVersion !== state.version)) throw new Error('尚未确认新版窗口和运行版本');
      const time = new Date(now()).toISOString();
      const measurable = Number.isFinite(details.current) && Number.isFinite(details.total) && details.total > 0
        && details.current >= 0 && details.current <= details.total;
      const status = TERMINAL.has(phase) ? phase : 'running';
      const version = details.version ?? state.version;
      if (version && !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)) throw new Error('更新版本号无效');
      const next = { ...state, phase, title: TITLES[phase], status, version, detail: String(details.detail || ''),
        phaseStartedAt: phase === state.phase ? state.phaseStartedAt : time, updatedAt: time,
        ownerPid: Number.isSafeInteger(details.ownerPid) && details.ownerPid > 0 ? details.ownerPid : state.ownerPid,
        current: measurable ? details.current : null, total: measurable ? details.total : null,
        unit: measurable ? String(details.unit || 'files') : null,
        percent: measurable ? Math.floor(details.current * 100 / details.total) : null,
        ...(TERMINAL.has(status) ? { finishedAt: time } : {}),
      };
      if (phase === 'failed' && details.reopened === true && details.runningVersion === version) next.title = '更新已完成，进度显示异常';
      for (const key of ['backupDir', 'rollback', 'runningVersion', 'instanceId', 'reopened']) {
        if (Object.hasOwn(details, key)) next[key] = details[key];
      }
      atomicJson(stateFile, next); state = next; return api.snapshot();
    },
    fail(error, details = {}) {
      if (TERMINAL.has(state.status)) return api.snapshot();
      return api.set('failed', { ...details, detail: String(error?.message || error || '更新未完成') });
    },
    succeed(details = {}) {
      if (details.reopened !== true || details.runningVersion !== state.version) throw new Error('尚未确认新版窗口和运行版本');
      return api.set('succeeded', details);
    },
    async startWindow({ spawnProcess = spawn, timeoutMs = 15000, scriptRoot = path.resolve(__dirname, '..') } = {}) {
      const script = path.join(directory, 'update-progress.ps1');
      fs.copyFileSync(path.join(scriptRoot, 'scripts/update-progress.ps1'), script);
      const hostScript = path.join(directory, 'progress-host.js');
      fs.copyFileSync(__filename, hostScript);
      try { fs.unlinkSync(readyFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temporaryNode = path.join(scriptRoot, 'node.exe');
      const executable = fs.existsSync(temporaryNode) ? temporaryNode : path.join(scriptRoot, 'runtime/node.exe');
      let child;
      try {
        // PowerShell needs a console host even when its console is hidden. The
        // detached, signed Node host survives the original desktop's shutdown;
        // its ordinary child PowerShell displays the independent WinForms UI.
        child = spawnProcess(executable, ['--disable-warning=ExperimentalWarning', hostScript, '--host',
          '-ScriptFile', script, '-StateFile', stateFile, '-RunId', state.runId], { detached: true, windowsHide: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
            if (ready.runId === state.runId && ready.pid === child.pid && ready.shownAt) return { pid: child.pid, windowPid: ready.windowPid, runId: state.runId };
          } catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
          if (child.exitCode !== null || child.signalCode !== null) throw new Error('更新进度窗口未能打开');
          await wait(100);
        }
        throw new Error('更新进度窗口启动超时');
      } catch (error) {
        const failure = new Error('无法显示更新进度，尚未开始安装：' + error.message);
        api.fail(failure);
        if (child && child.exitCode === null && child.signalCode === null) child.kill();
        throw failure;
      } finally { child?.unref(); }
    },
  };
  return api;
}
function createProgress({ directory, version = '', ownerPid = process.pid, now = Date.now }) {
  const runId = crypto.randomUUID(), time = new Date(now()).toISOString();
  directory = path.join(path.resolve(directory), 'progress-' + runId);
  fs.mkdirSync(directory, { recursive: true });
  const initial = { schemaVersion: 1, runId, version, status: 'running', phase: 'checking', title: TITLES.checking,
    detail: '', ownerPid, startedAt: time, phaseStartedAt: time, updatedAt: time,
    current: null, total: null, unit: null, percent: null };
  atomicJson(path.join(directory, 'progress-state.json'), initial);
  return reporter(directory, initial, now);
}
function openProgress(directory, runId) {
  directory = path.resolve(directory); return reporter(directory, readState(directory, runId));
}
async function runHost() {
  const argument = name => process.argv[process.argv.indexOf(name) + 1];
  const script = argument('-ScriptFile'), stateFile = argument('-StateFile'), runId = argument('-RunId');
  const directory = path.dirname(path.resolve(stateFile));
  readState(directory, runId);
  if (path.resolve(script) !== path.join(directory, 'update-progress.ps1')) throw new Error('进度窗口脚本路径无效');
  const executable = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const output = fs.openSync(path.join(directory, 'window-error.log'), 'a');
  let child;
  try {
    child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script, '-StateFile', stateFile, '-RunId', runId, '-HostPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', output, output] });
  } finally { fs.closeSync(output); }
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) process.exitCode = 1;
}
if (require.main === module && process.argv.includes('--host')) runHost().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createProgress, openProgress, readState, atomicJson, TITLES };
