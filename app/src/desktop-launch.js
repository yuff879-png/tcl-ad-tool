'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { liveInstance, waitForLaunch } = require('./instance');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Keep src/server.js --open as the entry point used by every released updater.
async function launchDesktop(root, { spawnProcess = spawn, timeoutMs = 150000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const dataDir = process.env.TCL_DATA_DIR || path.join(root, 'data');
  const inherited = process.env.TCL_STARTUP_STATUS;
  // An older Electron instance can acknowledge a second launch. Keep its
  // acknowledgement private until the running backend version is verified.
  const status = path.join(os.tmpdir(), 'tcl-startup-' + crypto.randomUUID() + '.status');
  const env = { ...process.env, TCL_STARTUP_STATUS: status };
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    while (Date.now() < deadline) {
      const { existing } = await waitForLaunch(dataDir, { timeoutMs: Math.max(1, deadline - Date.now()) });
      const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
      const verifyVersion = instance => {
        if (instance && instance.version !== version) throw new Error('旧版窗口仍在运行，请先保存并退出旧窗口，再打开新版；本次没有重复启动或改变投放状态');
      };
      verifyVersion(existing);
      const executable = path.join(root, 'runtime/electron/electron.exe');
      if (!fs.existsSync(executable)) throw new Error('桌面运行环境缺失，请运行“修复运行环境.cmd”或重新完整解压新版');
      try { fs.unlinkSync(status); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      child = spawnProcess(executable, [path.join(root, 'src/desktop')], {
        cwd: root, env, detached: true, windowsHide: false, stdio: 'ignore',
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      while (Date.now() < deadline) {
        let result = '';
        try { result = fs.readFileSync(status, 'utf8'); } catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; }
        if (result === 'ready') {
          const instance = await liveInstance(dataDir); verifyVersion(instance);
          if (instance) {
            if (inherited) fs.writeFileSync(inherited, 'ready');
            return { pid: child.pid, version: instance.version, instanceId: instance.instanceId };
          }
        }
        // A launch concurrent with graceful shutdown retries by itself once
        // the old process releases its lock, rather than requiring more clicks.
        if (result.startsWith('error\n程序正在退出')) break;
        if (result.startsWith('error\n')) throw new Error(result.slice(6));
        // A secondary Electron exits before the primary acknowledges focus.
        if ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null) throw new Error('桌面窗口启动失败，请运行“检查运行环境.cmd”');
        await wait(100);
      }
      child.unref(); child = null;
      await wait(100);
    }
    throw new Error('桌面窗口启动超时，请查看 startup-error.log 后重试');
  } finally {
    child?.unref();
    try { fs.unlinkSync(status); } catch {}
  }
}
module.exports = { launchDesktop };
