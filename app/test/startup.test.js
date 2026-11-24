'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { startApplication } = require('../src/startup');
const { tryLock, tryUpdateLock } = require('../src/instance');

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl startup 中文 '));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/server.js'), source);
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const spawnProcess = (executable, args, options) => {
    assert.equal(executable, path.join(root, 'runtime/node.exe'));
    assert.equal(options.windowsHide, true); assert.equal(args.at(-1), '--open');
    const child = spawn(process.execPath, args, options); children.push(child); return child;
  };
  return { root, spawnProcess };
}

test('direct runtime launch waits for ready and accepts an existing-instance launcher exiting', async t => {
  const f = fixture(t, "require('node:fs').writeFileSync(process.env.TCL_STARTUP_STATUS, 'ready')");
  const result = await startApplication(f.root, { spawnProcess: f.spawnProcess });
  assert.ok(result.pid > 0);
});
test('direct runtime launch surfaces server startup errors', async t => {
  const f = fixture(t, "require('node:fs').writeFileSync(process.env.TCL_STARTUP_STATUS, 'error\\n配置损坏，未覆盖原配置')");
  await assert.rejects(startApplication(f.root, { spawnProcess: f.spawnProcess }), /配置损坏/);
});
test('a process exiting without readiness is not reported as a successful restart', async t => {
  const f = fixture(t, 'process.exitCode = 1');
  await assert.rejects(startApplication(f.root, { spawnProcess: f.spawnProcess }), /启动失败/);
});
test('missing runtime and startup timeout return actionable failures', async t => {
  const f = fixture(t, 'setInterval(() => {}, 1000)');
  await assert.rejects(startApplication(f.root), /ENOENT/);
  await assert.rejects(startApplication(f.root, { spawnProcess: f.spawnProcess, timeoutMs: 300 }), /启动超时/);
});

test('ready written between the status probe and child exit is still accepted', async t => {
  const f = fixture(t, '');
  const spawnProcess = (_executable, _args, options) => {
    const child = new EventEmitter(); child.pid = 1; child.signalCode = null; child.unref = () => {};
    Object.defineProperty(child, 'exitCode', { get() { fs.writeFileSync(options.env.TCL_STARTUP_STATUS, 'ready'); return 0; } });
    setImmediate(() => child.emit('spawn')); return child;
  };
  assert.deepEqual(await startApplication(f.root, { spawnProcess }), { pid: 1 });
});

for (const [name, acquire] of [['legacy installation', tryLock], ['update reservation', tryUpdateLock]]) {
  test('launcher waits for ' + name + ' before spawning any application code', async t => {
    const f = fixture(t, "require('node:fs').writeFileSync(process.env.TCL_STARTUP_STATUS, 'ready')");
    const lock = acquire(path.join(f.root, 'data')); let spawned = false;
    const started = startApplication(f.root, { timeoutMs: 5000, spawnProcess: (...args) => {
      spawned = true; return f.spawnProcess(...args);
    } });
    try {
      await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(spawned, false);
    } finally { lock.release(); }
    await started; assert.equal(spawned, true);
  });
}
