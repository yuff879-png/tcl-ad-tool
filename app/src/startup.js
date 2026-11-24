'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { waitForLaunch } = require('./instance');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Start the bundled, publisher-signed Node runtime directly. The optional EXE
// launcher is unsigned and can be rejected by Windows application control.
async function startApplication(root, { spawnProcess = spawn, timeoutMs = 180000 } = {}) {
  const statusFile = path.join(os.tmpdir(), 'tcl-startup-' + crypto.randomUUID() + '.status');
  const deadline = Date.now() + timeoutMs;
  let child;
  try {
    await waitForLaunch(process.env.TCL_DATA_DIR || path.join(root, 'data'), { timeoutMs });
    child = spawnProcess(path.join(root, 'runtime/node.exe'), ['--disable-warning=ExperimentalWarning', path.join(root, 'src/server.js'), '--open'], {
      cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, TCL_STARTUP_STATUS: statusFile },
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const readStatus = () => {
      try { return fs.readFileSync(statusFile, 'utf8'); }
      catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; return ''; }
    };
    while (Date.now() < deadline) {
      let status = readStatus();
      if (status === 'ready') return { pid: child.pid };
      if (status.startsWith('error\n')) throw new Error(status.slice(6));
      if (child.exitCode !== null || child.signalCode !== null) {
        // Read again: readiness can be written between the probe and exit.
        status = readStatus();
        if (status === 'ready') return { pid: child.pid };
        if (status.startsWith('error\n')) throw new Error(status.slice(6));
        throw new Error('工作台启动失败，请查看 startup-error.log 或运行“检查运行环境.cmd”');
      }
      await wait(100);
    }
    throw new Error('工作台启动超时，请查看 startup-error.log；也可双击“一键启动.cmd”重试');
  } finally {
    child?.unref();
    try { fs.unlinkSync(statusFile); } catch { /* Startup may fail before reporting status. */ }
  }
}

module.exports = { startApplication };
