'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { launchDesktop } = require('../src/desktop-launch');
const { tryLock } = require('../src/instance');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-desktop-start-'));
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(root, 'runtime/electron'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime/electron/electron.exe'), 'test process');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.3.4' }));
  let version = '1.3.4';
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: 'tcl-ad-studio', version, instanceId: 'test-instance' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const publish = nextVersion => {
    version = nextVersion || version;
    fs.writeFileSync(path.join(dataDir, 'instance.json'), JSON.stringify({
      port: server.address().port, token: 'test-token', instanceId: 'test-instance', version: 'untrusted-metadata',
    }));
  };
  const spawnProcess = run => (_executable, _args, options) => {
    const child = new EventEmitter(); child.pid = 1; child.exitCode = null; child.signalCode = null; child.unref = () => {};
    setImmediate(() => { child.emit('spawn'); run(options.env.TCL_STARTUP_STATUS, child); }); return child;
  };
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, publish, spawnProcess };
}

test('slow primary readiness is shared by simultaneous secondary launches that exit first', async t => {
  const f = await fixture(t); const statuses = [];
  const spawnProcess = f.spawnProcess((status, child) => {
    statuses.push(status); child.exitCode = 0;
  });
  const starts = Array.from({ length: 3 }, () => launchDesktop(f.root, { spawnProcess, timeoutMs: 5000 }));
  await delay(350); assert.equal(statuses.length, 3); assert.equal(new Set(statuses).size, 3);
  f.publish(); for (const status of statuses) fs.writeFileSync(status, 'ready');
  const results = await Promise.all(starts);
  assert.ok(results.every(result => result.version === '1.3.4' && result.instanceId === 'test-instance'));
  assert.ok(statuses.every(status => !fs.existsSync(status)));
});

test('a stale live version is rejected without spawning or stopping it', async t => {
  const f = await fixture(t); f.publish('1.3.3'); let spawned = false;
  await assert.rejects(launchDesktop(f.root, { spawnProcess: () => { spawned = true; } }), /旧版窗口仍在运行/);
  assert.equal(spawned, false);
  assert.ok(fs.existsSync(path.join(f.dataDir, 'instance.json')));
});

test('a stale Electron ready cannot escape to an old updater status file', async t => {
  const f = await fixture(t);
  const previous = process.env.TCL_STARTUP_STATUS;
  const parentStatus = path.join(os.tmpdir(), 'tcl-startup-' + require('node:crypto').randomUUID() + '.status');
  process.env.TCL_STARTUP_STATUS = parentStatus;
  t.after(() => { if (previous === undefined) delete process.env.TCL_STARTUP_STATUS; else process.env.TCL_STARTUP_STATUS = previous; fs.rmSync(parentStatus, { force: true }); });
  const spawnProcess = f.spawnProcess(status => {
    assert.notEqual(status, parentStatus); f.publish('1.3.3'); fs.writeFileSync(status, 'ready');
  });
  await assert.rejects(launchDesktop(f.root, { spawnProcess }), /旧版窗口仍在运行/);
  assert.equal(fs.existsSync(parentStatus), false);
});

test('a launch during desktop shutdown waits for the lock and reopens without another click', async t => {
  const f = await fixture(t); let launches = 0, lock;
  const spawnProcess = f.spawnProcess(status => {
    launches++;
    if (launches === 1) {
      lock = tryLock(f.dataDir); fs.writeFileSync(status, 'error\n程序正在退出，请稍后重新打开');
      setTimeout(() => { lock.release(); lock = null; }, 350);
    } else { assert.equal(lock, null); f.publish(); fs.writeFileSync(status, 'ready'); }
  });
  t.after(() => lock?.release());
  assert.equal((await launchDesktop(f.root, { spawnProcess, timeoutMs: 5000 })).version, '1.3.4');
  assert.equal(launches, 2);
});
