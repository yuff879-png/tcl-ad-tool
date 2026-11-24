'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tryLock, tryUpdateLock, acquireInstance, checkIdle } = require('../src/instance');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(50); }
  throw new Error('Timed out waiting for isolated test process');
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-instance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL'); await finished;
}

test('OS lock excludes concurrent owners and repair, then releases without deleting its file', async t => {
  const dir = directory(t), first = tryLock(dir);
  assert.ok(first);
  try { assert.equal(tryLock(dir), null); await assert.rejects(checkIdle(dir), /正在运行/); }
  finally { first.release(); }
  const next = tryLock(dir); assert.ok(next); next.release();
  assert.ok(fs.existsSync(path.join(dir, 'instance-lock.sqlite')));
  await checkIdle(dir);
});

test('repair is also excluded during update extraction before the backend lock is acquired', async t => {
  const dir = directory(t), update = tryUpdateLock(dir);
  try { await assert.rejects(checkIdle(dir), /更新正在进行/); }
  finally { update.release(); }
  await checkIdle(dir);
});

test('a legacy lock pointing at an unrelated live PID never blocks startup or kills that process', { skip: process.platform !== 'win32' }, async t => {
  const dir = directory(t);
  const other = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60'], { stdio: 'ignore', windowsHide: true });
  try {
    fs.writeFileSync(path.join(dir, 'app.lock'), String(other.pid));
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({ pid: other.pid, port: 1, token: 'old', instanceId: 'old' }));
    const result = await acquireInstance(dir);
    try { assert.ok(result.lock); assert.equal(result.existing, undefined); assert.doesNotThrow(() => process.kill(other.pid, 0)); }
    finally { result.lock?.release(); }
    assert.equal(fs.existsSync(path.join(dir, 'app.lock')), false);
  } finally { await terminate(other); }
});

test('simultaneous launches share one server and abnormal termination does not prevent a restart', async t => {
  const dir = directory(t), children = [];
  const launch = suffix => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.resolve(__dirname, '../src/server.js')], {
      env: { ...process.env, TCL_DATA_DIR: dir, TCL_STARTUP_STATUS: path.join(dir, suffix + '.status') },
      stdio: 'ignore', windowsHide: true,
    });
    children.push(child); return child;
  };
  const status = suffix => {
    try { return fs.readFileSync(path.join(dir, suffix + '.status'), 'utf8') === 'ready'; } catch { return false; }
  };
  try {
    launch('first'); launch('second');
    await until(() => status('first') && status('second'));
    const original = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    const owner = children.find(child => child.pid === original.pid); assert.ok(owner);
    const duplicate = children.find(child => child !== owner);
    await until(() => duplicate.exitCode !== null); assert.equal(duplicate.exitCode, 0);
    const response = await fetch(`http://127.0.0.1:${original.port}/api/state`, { headers: { Cookie: 'tcl_session=' + original.token } });
    const state = await response.json(); assert.equal(state.state, 'stopped'); assert.equal(state.config.hasPrivateKey, false);
    await terminate(owner); // Mimic a crash: old instance metadata remains, OS lock releases.
    assert.ok(fs.existsSync(path.join(dir, 'instance.json')));
    const restarted = launch('restart'); await until(() => status('restart'));
    const next = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    assert.equal(next.pid, restarted.pid); assert.notEqual(next.instanceId, original.instanceId);
    const base = `http://127.0.0.1:${next.port}`;
    const exiting = await fetch(base + '/api/exit', { method: 'POST', headers: { Cookie: 'tcl_session=' + next.token, Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(exiting.status, 200); await until(() => restarted.exitCode !== null);
    assert.equal(restarted.exitCode, 0); assert.equal(fs.existsSync(path.join(dir, 'instance.json')), false);
    const lock = tryLock(dir); assert.ok(lock); lock.release();
  } finally { await Promise.all(children.map(terminate)); }
});
