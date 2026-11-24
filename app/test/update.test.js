'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Updater, verifyManifest, compareVersions, download, sha256 } = require('../src/updater');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const channel = { repository: 'example/tool', manifestUrl: 'https://github.com/example/tool/releases/latest/download/update.json', publicKey };
const bytes = Buffer.from('fake offline archive');
const release = { version: '1.0.4', url: 'https://github.com/example/tool/releases/download/v1.0.4/tcl-ad-tool-1.0.4-win-x64.zip', sha256: sha256(bytes), size: bytes.length, notes: 'Offline update test' };
function sign(value) { const payload = Buffer.from(JSON.stringify(value)); return { payload: payload.toString('base64'), signature: crypto.sign(null, payload, privateKey).toString('base64') }; }
test('release signatures authenticate version, URL, size and hash together', () => {
  assert.deepEqual(verifyManifest(sign(release), channel), release);
  const envelope = sign(release); envelope.payload = Buffer.from(JSON.stringify({ ...release, version: '9.9.9' })).toString('base64');
  assert.throws(() => verifyManifest(envelope, channel), /签名/);
  const foreign = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => verifyManifest(sign(release), { ...channel, publicKey: foreign }), /签名/);
});
test('signed but malformed or redirected release metadata is rejected', () => {
  for (const patch of [{ url: 'https://evil.example/package.zip' }, { size: 0 }, { size: 201 * 1024 * 1024 }, { sha256: 'bad' }, { version: '../x' }]) {
    assert.throws(() => verifyManifest(sign({ ...release, ...patch }), channel));
  }
});
test('numeric versions do not misorder 1.0.10 and 1.0.9 or accept prerelease syntax', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1); assert.equal(compareVersions('1.0.3', '1.0.3'), 0);
  assert.equal(compareVersions('1.0.2', '1.0.3'), -1); assert.throws(() => compareVersions('1.0.4-dev', '1.0.3'));
});
test('bounded HTTPS download follows GitHub asset redirects without forwarding credentials', async () => {
  let requests = 0;
  const result = await download(channel.manifestUrl, 50, async (url, options) => {
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, undefined); requests++;
    return requests === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test' } }) : new Response(bytes);
  });
  assert.deepEqual(result, bytes); assert.equal(requests, 2);
});
test('download blocks arbitrary hosts, insecure redirects, oversized and missing releases', async () => {
  await assert.rejects(download('http://github.com/test', 100), /不受信任/);
  await assert.rejects(download(channel.manifestUrl, 100, async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } })), /不受信任/);
  await assert.rejects(download(channel.manifestUrl, 2, async () => new Response(bytes)), /大小/);
  await assert.rejects(download(channel.manifestUrl, 100, async () => new Response(null, { status: 404 })), /HTTP 404/);
});
test('latest version check only exposes a newer signed release and leaves installation untouched', async () => {
  const updater = new Updater({ channel, version: '1.0.3', fetcher: async () => new Response(JSON.stringify(sign(release))) });
  const state = await updater.check(); assert.equal(state.available, true); assert.equal(state.latestVersion, '1.0.4');
  updater.version = '1.0.4'; assert.equal(updater.snapshot().available, false);
  await assert.rejects(updater.prepare('1.0.4'), /先检查/);
});
test('corrupt archive or a mismatched version cannot prepare installation', async () => {
  const updater = new Updater({ channel, version: '1.0.3', fetcher: async () => new Response('tampered') });
  updater.release = release;
  await assert.rejects(updater.prepare('1.0.9'), /先检查/);
  await assert.rejects(updater.prepare('1.0.4'), /校验/);
});
test('concurrent checks share one request and a failed recheck retains the signed notice', async () => {
  let unblock, calls = 0, fail = false;
  const gate = new Promise(resolve => { unblock = resolve; });
  const updater = new Updater({ channel, version: '1.0.3', fetcher: async () => {
    calls++; await gate;
    if (fail) throw new Error('offline');
    return new Response(JSON.stringify(sign(release)));
  } });
  const first = updater.check(), second = updater.check();
  assert.equal(calls, 1); assert.equal(updater.snapshot().checking, true);
  unblock(); assert.deepEqual(await first, await second);
  assert.equal(updater.snapshot().checking, false); assert.equal(updater.snapshot().available, true);
  fail = true; await assert.rejects(updater.check(), /offline/);
  assert.equal(updater.snapshot().available, true); assert.equal(updater.snapshot().latestVersion, '1.0.4');
  assert.ok(updater.snapshot().lastError);
});
test('automatic checks run on startup, retry failures and stop scheduling on exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, fail = true;
  const updater = new Updater({ channel, version: '1.0.3', fetcher: async () => {
    calls++; if (fail) throw new Error('offline');
    return new Response(JSON.stringify(sign(release)));
  } });
  updater.startAutomaticChecks({ initialDelayMs: 10, retryMs: 20, intervalMs: 100 });
  t.after(() => updater.stopAutomaticChecks());
  t.mock.timers.tick(9); assert.equal(calls, 0);
  t.mock.timers.tick(1); await assert.rejects(updater.check(), /offline/); assert.equal(calls, 1);
  fail = false;
  t.mock.timers.tick(19); assert.equal(calls, 1);
  t.mock.timers.tick(1); await updater.check(); assert.equal(calls, 2);
  t.mock.timers.tick(99); assert.equal(calls, 2);
  t.mock.timers.tick(1); await updater.check(); assert.equal(calls, 3);
  updater.stopAutomaticChecks(); t.mock.timers.tick(1000); assert.equal(calls, 3);
});
function downloadFixture(t, fetcher, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-download-test-'));
  for (const file of ['update-channel.json', 'package.json', 'src/updater.js', 'src/instance.js', 'src/update-worker.js', 'src/update-progress.js', 'src/startup.js', 'scripts/unpack-update.ps1', 'scripts/update-progress.ps1', 'runtime/node.exe']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'isolated test file');
  }
  const updater = new Updater({ root, channel, version: '1.0.3', fetcher, ...options }); updater.release = release; updater.envelope = sign(release);
  const directories = new Set();
  t.after(async () => {
    await updater.stopDownload(); if (updater.prepared) directories.add(updater.prepared.directory);
    for (const directory of [root, ...directories]) fs.rmSync(directory, { recursive: true, force: true });
  });
  return { updater, directories };
}
test('download reports actual received bytes and remains below 100 percent until verification finishes', async t => {
  let controller, calls = 0;
  const { updater, directories } = downloadFixture(t, async () => { calls++; return new Response(new ReadableStream({ start(c) { controller = c; } })); });
  const state = updater.startDownload(release.version); assert.equal(state.download.phase, 'downloading');
  const joined = updater.prepare(release.version); assert.equal(calls, 1);
  controller.enqueue(bytes.subarray(0, 5)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.snapshot().download.received, 5); assert.equal(updater.snapshot().download.percent, Math.floor(5 * 100 / bytes.length));
  assert.equal(updater.prepared, null);
  controller.enqueue(bytes.subarray(5)); controller.close();
  const directory = await joined; directories.add(directory);
  assert.equal(updater.snapshot().download.phase, 'ready'); assert.equal(updater.snapshot().download.percent, 100);
  assert.equal(updater.snapshot().download.received, bytes.length);
  assert.ok(!JSON.stringify(updater.snapshot()).includes(directory));
  assert.equal(await updater.readyDirectory(release.version), directory); assert.equal(await updater.prepare(release.version), directory);
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(path.join(directory, 'package.zip')), bytes);
  for (const helper of ['src/update-progress.js', 'scripts/update-progress.ps1']) {
    assert.deepEqual(fs.readFileSync(path.join(directory, helper)), fs.readFileSync(path.join(updater.root, helper)));
  }
});
test('failed or truncated downloads cannot become installable and can be retried', async t => {
  let fail = true, calls = 0;
  const { updater, directories } = downloadFixture(t, async () => { calls++; return new Response(fail ? bytes.subarray(0, 2) : bytes); });
  await assert.rejects(updater.prepare(release.version), /校验/);
  assert.equal(updater.snapshot().download.phase, 'error'); assert.equal(updater.prepared, null);
  await assert.rejects(updater.readyDirectory(release.version), /先下载/);
  fail = false; directories.add(await updater.prepare(release.version));
  assert.equal(updater.snapshot().download.phase, 'ready'); assert.equal(calls, 2);
});
test('install rechecks stored package and refuses missing, modified or different-version files', async t => {
  const { updater, directories } = downloadFixture(t, async () => new Response(bytes));
  const directory = await updater.prepare(release.version); directories.add(directory);
  await assert.rejects(updater.readyDirectory('9.9.9'), /先检查/);
  fs.writeFileSync(path.join(directory, 'package.zip'), 'modified');
  await assert.rejects(updater.readyDirectory(release.version), /重新下载/);
  assert.equal(updater.snapshot().download.phase, 'error'); assert.equal(updater.prepared, null);
});
test('checking during a download preserves its selected version and never starts another request', async t => {
  let finish, calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const { updater, directories } = downloadFixture(t, async () => { calls++; await gate; return new Response(bytes); });
  const preparing = updater.prepare(release.version);
  try { assert.equal((await updater.check()).download.version, release.version); assert.equal(calls, 1); }
  finally { finish(); }
  directories.add(await preparing);
});
test('a later release check invalidates the older ready selection and requires a new download', async t => {
  let manifest = false;
  const newer = { ...release, version: '1.0.5', url: release.url.replaceAll('1.0.4', '1.0.5') };
  const { updater, directories } = downloadFixture(t, async () => new Response(manifest ? JSON.stringify(sign(newer)) : bytes));
  directories.add(await updater.prepare(release.version)); manifest = true;
  assert.equal((await updater.check()).latestVersion, '1.0.5'); assert.equal(updater.snapshot().download.phase, 'idle');
  await assert.rejects(updater.readyDirectory('1.0.4'), /先检查/);
  await assert.rejects(updater.readyDirectory('1.0.5'), /先下载/);
});
test('exiting cancels a download without launching or installing and releases the job', async t => {
  const { updater } = downloadFixture(t, async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  updater.startDownload(release.version); await updater.stopDownload();
  assert.equal(updater.downloadPromise, null); assert.equal(updater.prepared, null);
  assert.equal(updater.snapshot().download.phase, 'error'); assert.match(updater.snapshot().download.error, /取消/);
});

test('download timing reports received bytes and an idle connection without inventing progress', async t => {
  let controller;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T00:00:00Z') });
  const { updater, directories } = downloadFixture(t, async () => new Response(new ReadableStream({ start(c) { controller = c; } })));
  const preparing = updater.prepare(release.version);
  const initial = updater.snapshot().download;
  assert.ok(initial.startedAt); assert.equal(initial.received, 0);
  t.mock.timers.tick(2000); controller.enqueue(bytes.subarray(0, 5)); await new Promise(resolve => setImmediate(resolve));
  const moving = updater.snapshot().download;
  assert.equal(moving.received, 5); assert.ok(moving.bytesPerSecond > 0); assert.ok(moving.lastProgressAt);
  t.mock.timers.tick(5000);
  const waiting = updater.snapshot().download;
  assert.equal(waiting.received, moving.received); assert.equal(waiting.percent, moving.percent);
  assert.ok(waiting.elapsedMs >= 7000); assert.ok(waiting.stalledMs >= 5000);
  controller.enqueue(bytes.subarray(5)); controller.close(); directories.add(await preparing);
  assert.equal(updater.snapshot().download.phase, 'ready');
});

test('failed progress-window startup preserves the old server and never launches the install worker', async t => {
  const { createProgress } = require('../src/update-progress');
  const { createApp } = require('../src/server');
  const { config, FakeChain, address } = require('./fixtures');
  const { atomicJson } = require('../src/config');
  let workerSpawns = 0, installing = 0, closed = 0;
  const { updater, directories } = downloadFixture(t, async () => new Response(bytes), {
    progressFactory: options => {
      const progress = createProgress(options);
      progress.startWindow = async () => { throw new Error('Synthetic progress window failed to open'); };
      return progress;
    },
    spawnProcess: () => { workerSpawns++; throw new Error('Worker must not start without its progress window'); },
  });
  directories.add(await updater.prepare(release.version));
  const dataDir = path.join(updater.root, 'data'), settings = config();
  atomicJson(path.join(dataDir, 'config.json'), settings);
  const beforeConfig = fs.readFileSync(path.join(dataDir, 'config.json'));
  const app = await createApp({ dataDir, updater, automaticUpdates: false, chainFactory: c => new FakeChain(c),
    desktop: { pid: 1, onInstalling: () => installing++, onClosed: () => closed++ } });
  app.store.offer('live', { to: address(3), txid: 'synthetic-old-trigger', asset: 'TRX', amount: '150' }, settings, 1);
  const pending = app.store.next('live'); app.store.update(pending.id, 'uncertain', { txid: 'a'.repeat(64) });
  const original = app.store.get(pending.id);
  const base = `http://127.0.0.1:${app.port}`, headers = { Cookie: 'tcl_session=' + app.token, Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json' };
  try {
    const response = await fetch(base + '/api/update/install', { method: 'POST', headers, body: JSON.stringify({ confirmed: true, version: release.version }) });
    assert.equal(response.status, 400); assert.match((await response.json()).error, /progress window/);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(workerSpawns, 0); assert.equal(installing, 0); assert.equal(closed, 0);
    assert.equal((await fetch(base + '/api/state', { headers })).status, 200);
    assert.equal(app.engine.state, 'stopped'); assert.deepEqual(app.store.get(pending.id), original);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'config.json')), beforeConfig);
    assert.equal(updater.snapshot().download.phase, 'ready');
  } finally { await app.close(); }
});

test('installer launch waits for both a visible progress window and worker ownership before returning', async t => {
  const { createProgress, openProgress, readState } = require('../src/update-progress');
  let showWindow, adopt, progress, child, spawns = 0, completed = false;
  const visible = new Promise(resolve => { showWindow = resolve; });
  const { updater, directories } = downloadFixture(t, async () => new Response(bytes), {
    progressFactory: options => { progress = createProgress(options); progress.startWindow = () => visible; return progress; },
    spawnProcess: (_executable, args, options) => {
      spawns++; assert.equal(options.windowsHide, true);
      child = new EventEmitter(); Object.assign(child, { pid: 123456, exitCode: null, signalCode: null, unref() {} });
      const workerProgress = openProgress(args.at(-2), args.at(-1));
      adopt = () => workerProgress.set('waiting', { ownerPid: child.pid });
      setImmediate(() => child.emit('spawn')); return child;
    },
  });
  const directory = await updater.prepare(release.version); directories.add(directory);
  const launch = updater.launch(directory, path.join(updater.root, 'data')).then(value => { completed = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(spawns, 0); assert.equal(completed, false);
  showWindow(); await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(spawns, 1); assert.equal(completed, false);
  adopt(); assert.equal(await launch, child);
  assert.equal(readState(progress.directory, progress.runId).ownerPid, child.pid);
});

test('worker exit before ownership is an installation error rather than permission to close the old app', async t => {
  const { createProgress, readState } = require('../src/update-progress'); let progress;
  const { updater, directories } = downloadFixture(t, async () => new Response(bytes), {
    progressFactory: options => { progress = createProgress(options); progress.startWindow = async () => {}; return progress; },
    spawnProcess: () => {
      const child = new EventEmitter(); Object.assign(child, { pid: 123456, exitCode: 1, signalCode: null, unref() {} });
      setImmediate(() => child.emit('spawn')); return child;
    },
  });
  const directory = await updater.prepare(release.version); directories.add(directory);
  await assert.rejects(updater.launch(directory, path.join(updater.root, 'data')), /未能启动/);
  assert.equal(readState(progress.directory, progress.runId).status, 'failed');
});
