'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');
const net = require('node:net');
const { createApp } = require('../src/server');
const { attachDesktopControl } = require('../src/desktop-control');
const { windowOptions, localUrl, externalUrl, startupFile } = require('../src/desktop/policy');
const { responsivenessGuard } = require('../src/desktop/responsiveness');
const { FakeChain, config } = require('./fixtures');
const { atomicJson } = require('../src/config');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('native dialogs and brief renderer delays do not trigger desktop recovery', async () => {
  let recoveries = 0;
  const guard = responsivenessGuard(() => recoveries++, { delayMs: 15, graceMs: 15 });
  guard.unresponsive(); guard.responsive();
  await delay(25); assert.equal(recoveries, 0);
  guard.duringDialog(() => guard.unresponsive());
  guard.unresponsive();
  await delay(25); assert.equal(recoveries, 0);
  guard.unresponsive(); guard.unresponsive();
  await delay(25); assert.equal(recoveries, 1);
  guard.unresponsive(); guard.dispose();
  await delay(25); assert.equal(recoveries, 1);
});

test('desktop renderer is isolated and only expected local and external links are permitted', () => {
  const options = windowOptions('root', { width: 1920, height: 1080 }, {});
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.backgroundThrottling, false);
  assert.ok(localUrl('http://127.0.0.1:1234/api/state', 'http://127.0.0.1:1234'));
  for (const url of ['http://127.0.0.1:1235/', 'https://evil.example', 'javascript:alert(1)', 'file:///C:/keys']) {
    assert.equal(localUrl(url, 'http://127.0.0.1:1234'), false);
    assert.equal(externalUrl(url), false);
  }
  assert.ok(externalUrl('https://t.me/tangyuan0936'));
  assert.ok(externalUrl('https://tronscan.org/#/transaction/test'));
  assert.ok(externalUrl('https://github.com/yuff879-png/tcl-ad-tool/releases'));
  assert.equal(externalUrl('https://github.com/yuff879-png/tcl-ad-tool-fake'), false);
  assert.ok(startupFile(path.join(os.tmpdir(), 'tcl-startup-abcd-1234.status')));
  assert.equal(startupFile(path.join(os.tmpdir(), 'config.json')), false);
});

test('parent disconnect closes the backend once; arbitrary IPC cannot start a campaign', async () => {
  const channel = new EventEmitter(); channel.connected = true;
  const messages = []; let closes = 0, pauses = 0;
  channel.send = (msg, done) => { messages.push(msg); done?.(); };
  channel.disconnect = () => { channel.connected = false; channel.emit('disconnect'); };
  attachDesktopControl({ close: async () => { closes++; }, pause: async () => { pauses++; } }, channel);
  channel.emit('message', { type: 'start', mode: 'live' });
  channel.emit('message', { type: 'pause', id: 'one' });
  await delay(0);
  assert.equal(pauses, 1); assert.deepEqual(messages, [{ type: 'paused', id: 'one' }]);
  channel.disconnect(); channel.emit('message', { type: 'shutdown' });
  await delay(0); assert.equal(closes, 1);
});

test('closing during asynchronous preflight cancels startup before any broadcast', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-desktop-preflight-'));
  atomicJson(path.join(dir, 'config.json'), config());
  let finish, announced;
  const entered = new Promise(resolve => { announced = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  let chain;
  const app = await createApp({ dataDir: dir, automaticUpdates: false, chainFactory: c => {
    chain = new FakeChain(c); const original = chain.preflight.bind(chain);
    chain.preflight = async () => { announced(); await gate; return original(); }; return chain;
  } });
  t.after(async () => { finish(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  const request = fetch(base + '/api/start', { method: 'POST', headers: {
    Cookie: 'tcl_session=' + app.token, Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ mode: 'simulate' }) });
  await entered;
  const closing = app.close(); finish();
  const response = await request; assert.equal(response.status, 400);
  await closing;
  assert.equal(chain.broadcasts, 0); assert.equal(app.engine.running, false); assert.equal(app.server.listening, false);
});

test('actual child backend exits cleanly when its desktop parent IPC closes', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-desktop-parent-'));
  const child = fork(path.resolve(__dirname, '../src/server.js'), ['--desktop-backend'], {
    env: { ...process.env, TCL_DATA_DIR: dir, TCL_DESKTOP_PID: String(process.pid) },
    execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ready = await new Promise((resolve, reject) => {
    child.on('message', msg => { if (msg?.type === 'ready') resolve(msg); });
    child.once('error', reject); child.once('exit', code => reject(new Error('Backend exited before ready: ' + code)));
  });
  assert.ok(ready.url.startsWith('http://127.0.0.1:'));
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.disconnect(); assert.equal(await exited, 0);
  assert.equal(fs.existsSync(path.join(dir, 'instance.json')), false);
});

test('desktop shutdown closes a Chromium-style preconnected socket without waiting for HTTP timeout', { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-desktop-socket-'));
  const app = await createApp({ dataDir: dir, automaticUpdates: false });
  const socket = net.connect(app.port, '127.0.0.1');
  t.after(async () => { socket.destroy(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const disconnected = new Promise(resolve => socket.once('close', resolve));
  await app.close(); await disconnected;
  assert.equal(app.server.listening, false); assert.equal(socket.destroyed, true);
});
