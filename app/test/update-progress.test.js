'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createProgress, openProgress } = require('../src/update-progress');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl progress 中文 '));
  let now = Date.parse('2026-11-20T00:00:00Z');
  const progress = createProgress({ directory, version: '1.3.5', now: () => now });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory: progress.directory, progress, advance: ms => { now += ms; } };
}
function childProcess() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123456, exitCode: null, signalCode: null, unref() {}, kill() { this.exitCode = 0; } });
  setImmediate(() => child.emit('spawn'));
  return child;
}

test('progress records one update identity and separates overall and current-stage elapsed time', t => {
  const { progress, advance } = fixture(t), initial = progress.snapshot();
  assert.equal(initial.schemaVersion, 1); assert.equal(initial.version, '1.3.5'); assert.equal(initial.status, 'running');
  assert.ok(initial.runId); assert.equal(initial.ownerPid, process.pid);
  advance(2000); progress.set('waiting', { detail: 'Waiting for the original application to close' });
  const waiting = progress.snapshot();
  assert.equal(waiting.runId, initial.runId); assert.equal(waiting.startedAt, initial.startedAt);
  assert.ok(Date.parse(waiting.phaseStartedAt) > Date.parse(initial.phaseStartedAt));
  advance(1000); progress.set('waiting', { detail: 'Still saving the original application' });
  const latest = progress.snapshot();
  assert.equal(latest.phaseStartedAt, waiting.phaseStartedAt); assert.ok(Date.parse(latest.updatedAt) > Date.parse(waiting.updatedAt));
  assert.deepEqual(JSON.parse(fs.readFileSync(progress.stateFile, 'utf8')), latest);
});

test('file progress uses completed work and resets to indeterminate for unmeasured stages', t => {
  const { progress } = fixture(t);
  progress.set('installing', { current: 1, total: 3, unit: 'files' });
  assert.equal(progress.snapshot().percent, 33);
  progress.set('installing', { current: 2, total: 3, unit: 'files' });
  assert.equal(progress.snapshot().percent, 66);
  progress.set('installing', { current: 3, total: 3, unit: 'files' });
  assert.equal(progress.snapshot().percent, 100); assert.equal(progress.snapshot().status, 'running');
  progress.set('checking-installation');
  assert.equal(progress.snapshot().percent, null);
  for (const field of ['current', 'total', 'unit']) assert.equal(progress.snapshot()[field], null);
  progress.set('reopening'); assert.equal(progress.snapshot().percent, null); assert.equal(progress.snapshot().status, 'running');
});

test('unmeasured and invalid file totals never claim determinate completion', t => {
  const { progress } = fixture(t);
  for (const details of [{ current: 0, total: 0 }, { current: 2, total: 1 }, { current: -1, total: 2 }, { current: 1 }, { current: 1, total: Infinity }]) {
    progress.set('installing', details); assert.equal(progress.snapshot().percent, null);
  }
});

test('opening progress rejects a different update and a partially written state', t => {
  const { directory, progress } = fixture(t);
  assert.equal(openProgress(directory, progress.runId).snapshot().runId, progress.runId);
  assert.throws(() => openProgress(directory, 'not-the-current-run'));
  fs.writeFileSync(progress.stateFile, '{"schemaVersion":1,"runId":');
  assert.throws(() => openProgress(directory, progress.runId));
});

test('restart must be confirmed on the target version before progress can succeed', t => {
  const { progress } = fixture(t);
  progress.set('reopening');
  for (const details of [{}, { reopened: false, runningVersion: '1.3.5' }, { reopened: true, runningVersion: '1.3.4' }]) {
    assert.throws(() => progress.succeed(details)); assert.equal(progress.snapshot().status, 'running');
  }
  progress.succeed({ reopened: true, runningVersion: '1.3.5' });
  assert.equal(progress.snapshot().status, 'succeeded'); assert.equal(progress.snapshot().phase, 'succeeded');
});

test('direct stage updates cannot bypass evidence required for successful completion', t => {
  const { progress } = fixture(t);
  assert.throws(() => progress.set('succeeded'));
  assert.equal(progress.snapshot().status, 'running');
});

test('installation without reopening remains installed rather than successful restart', t => {
  const { progress } = fixture(t);
  progress.set('installed', { status: 'installed', detail: 'Installed; opening was not requested' });
  assert.equal(progress.snapshot().status, 'installed'); assert.equal(progress.snapshot().phase, 'installed');
  assert.notEqual(progress.snapshot().status, 'succeeded');
});

test('a failed update remains visible after a late progress callback', t => {
  const { progress } = fixture(t);
  progress.set('checking-installation'); progress.fail(new Error('Synthetic validation failure'));
  const failed = progress.snapshot();
  assert.equal(failed.status, 'failed'); assert.equal(failed.phase, 'failed');
  assert.match(JSON.stringify(failed), /Synthetic validation failure/);
  assert.throws(() => progress.set('installing', { current: 4, total: 4, unit: 'files' }));
  assert.deepEqual(progress.snapshot(), failed);
});

test('failed atomic publication cannot commit success in memory or suppress a later failure', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl progress publication '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = require.resolve('../src/update-progress'), loaded = new Module(source, module), realRequire = Module.createRequire(source);
  loaded.filename = source; loaded.paths = module.paths; let interrupted = false;
  loaded.require = name => name === 'node:fs' ? { ...fs, renameSync: (temporary, destination) => {
    if (!interrupted && JSON.parse(fs.readFileSync(temporary, 'utf8')).status === 'succeeded') {
      interrupted = true; throw Object.assign(new Error('Synthetic atomic publication denied'), { code: 'ENOSPC' });
    }
    return fs.renameSync(temporary, destination);
  } } : realRequire(name);
  loaded._compile(fs.readFileSync(source, 'utf8'), source);
  const progress = loaded.exports.createProgress({ directory, version: '1.3.5' });
  progress.set('reopening');
  assert.throws(() => progress.succeed({ reopened: true, runningVersion: '1.3.5' }), /publication denied/);
  assert.equal(progress.snapshot().status, 'running');
  assert.equal(JSON.parse(fs.readFileSync(progress.stateFile, 'utf8')).status, 'running');
  progress.fail(new Error('Could not persist completion; check the result'));
  assert.equal(progress.snapshot().status, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(progress.stateFile, 'utf8')).status, 'failed');
});

test('the progress window must acknowledge this run before installation can continue', async t => {
  const { directory, progress } = fixture(t); let ready;
  const spawnProcess = (_file, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.equal(args[args.indexOf('-StateFile') + 1], progress.stateFile);
    assert.equal(args[args.indexOf('-RunId') + 1], progress.runId);
    const child = childProcess();
    ready = () => fs.writeFileSync(path.join(directory, 'ui-ready.json'), JSON.stringify({ runId: progress.runId, pid: child.pid, shownAt: new Date().toISOString() }));
    return child;
  };
  let completed = false;
  const opening = progress.startWindow({ spawnProcess, timeoutMs: 2000 }).then(value => { completed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(completed, false);
  ready(); await opening; assert.equal(completed, true);
});

for (const state of ['wrong-run', 'wrong-process', 'partial-json', 'no-ready']) test('progress window ' + state + ' never counts as ready', async t => {
  const { directory, progress } = fixture(t);
  const spawnProcess = () => {
    const child = childProcess();
    if (state !== 'no-ready') fs.writeFileSync(path.join(directory, 'ui-ready.json'), state === 'partial-json' ? '{' : JSON.stringify({ runId: state === 'wrong-run' ? 'old-run' : progress.runId, pid: state === 'wrong-process' ? child.pid + 1 : child.pid, shownAt: new Date().toISOString() }));
    return child;
  };
  await assert.rejects(progress.startWindow({ spawnProcess, timeoutMs: 200 }));
  assert.notEqual(progress.snapshot().status, 'succeeded');
});

test('an exited progress window cannot hand off installation without its ready acknowledgement', async t => {
  const { progress } = fixture(t);
  const spawnProcess = () => { const child = childProcess(); child.exitCode = 1; return child; };
  await assert.rejects(progress.startWindow({ spawnProcess, timeoutMs: 2000 }));
});

function workerFixture(t, { installedCheckError = false, rollbackError = false, reopenError = false, wrongRunningVersion = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl progress worker 中文 '));
  const root = path.join(base, 'application'), dataDir = path.join(root, 'data'), directory = path.join(base, 'installer');
  for (const folder of [dataDir, directory, path.join(root, 'src')]) fs.mkdirSync(folder, { recursive: true });
  const packageBytes = Buffer.from('Synthetic signed archive; extraction is mocked');
  const updater = require('../src/updater');
  const release = { version: '1.3.5', size: packageBytes.length, sha256: updater.sha256(packageBytes) };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.3.4' }));
  fs.writeFileSync(path.join(root, 'src/existing.js'), 'old application source');
  fs.writeFileSync(path.join(directory, 'package.zip'), packageBytes);
  fs.writeFileSync(path.join(directory, 'update.json'), JSON.stringify({ syntheticOfflineManifest: true }));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ synthetic: true, paused: true }));
  fs.writeFileSync(path.join(dataDir, 'pool-vault.json'), 'synthetic encrypted wallet archive');
  const db = new DatabaseSync(path.join(dataDir, 'records.sqlite'));
  db.exec("CREATE TABLE historical_evidence(id INTEGER PRIMARY KEY,status TEXT); INSERT INTO historical_evidence VALUES(1,'uncertain'),(2,'confirmed')"); db.close();
  const original = { config: fs.readFileSync(path.join(dataDir, 'config.json')), vault: fs.readFileSync(path.join(dataDir, 'pool-vault.json')) };
  const progress = createProgress({ directory: path.join(directory, 'progress'), version: release.version });
  progress.startWindow = async () => {};
  const events = [], set = progress.set.bind(progress);
  progress.set = (...args) => { const result = set(...args); events.push(progress.snapshot()); return result; };
  let reopened = false, reopenCalls = 0;
  const workerPath = require.resolve('../src/update-worker'), loaded = new Module(workerPath, module);
  loaded.filename = workerPath; loaded.paths = module.paths;
  const realRequire = Module.createRequire(workerPath);
  loaded.require = name => {
    if (name === 'node:fs' && rollbackError) return { ...fs, copyFileSync: (source, target) => {
      if (source.startsWith(path.join(dataDir, 'backups') + path.sep) && target === path.join(root, 'src/existing.js')) throw new Error('Synthetic rollback file lock');
      return fs.copyFileSync(source, target);
    } };
    if (name === './updater') return { ...updater, verifyManifest: () => release };
    if (name === './startup') return { startApplication: async () => {
      reopenCalls++; if (reopenError) throw new Error('Synthetic restart timeout'); reopened = true; return { pid: 123456 };
    } };
    if (name === './instance') return { ...realRequire(name), liveInstance: async () => reopened
      ? { version: wrongRunningVersion ? '1.3.4' : release.version, instanceId: 'synthetic-new-instance' } : null };
    if (name === 'node:child_process') return { ...realRequire(name), execFileSync: (_file, args, options) => {
      if (args.includes('-Archive')) {
        const stage = args[args.indexOf('-Destination') + 1]; fs.mkdirSync(path.join(stage, 'src'), { recursive: true });
        fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ version: release.version }));
        fs.writeFileSync(path.join(stage, 'src/existing.js'), 'new application source');
        fs.writeFileSync(path.join(stage, 'src/new.js'), 'new application file');
      } else if (options.cwd === root && installedCheckError) throw new Error('Synthetic installed-file check failed');
      return Buffer.alloc(0);
    } };
    return realRequire(name);
  };
  loaded._compile(fs.readFileSync(workerPath, 'utf8'), workerPath);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const unchangedData = () => {
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'config.json')), original.config);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'pool-vault.json')), original.vault);
    const check = new DatabaseSync(path.join(dataDir, 'records.sqlite'));
    try { assert.deepEqual(check.prepare('SELECT status FROM historical_evidence ORDER BY id').all().map(row => row.status), ['uncertain', 'confirmed']); }
    finally { check.close(); }
  };
  return { root, dataDir, directory, progress, events, unchangedData, reopenCalls: () => reopenCalls,
    run: (reopen = true) => loaded.exports.install({ root, dataDir, directory, progress, reopen }) };
}

test('worker reports actual installed files and leaves no-reopen runs visibly installed', async t => {
  const f = workerFixture(t), result = await f.run(false);
  assert.equal(result.ok, true); assert.equal(f.reopenCalls(), 0);
  assert.equal(f.progress.snapshot().status, 'installed');
  const copying = f.events.filter(event => event.phase === 'installing' && event.total > 0);
  assert.ok(copying.length); assert.ok(copying.some(event => event.current > 0));
  assert.ok(copying.every(event => event.current <= event.total && event.percent === Math.floor(event.current * 100 / event.total)));
  assert.equal(copying.at(-1).current, copying.at(-1).total);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.3.5');
  assert.ok(fs.existsSync(path.join(result.backupDir, 'records.sqlite'))); f.unchangedData();
});

test('worker validation failure rolls application files back and preserves a failed progress result', async t => {
  const f = workerFixture(t, { installedCheckError: true });
  await assert.rejects(f.run(), /Synthetic installed-file check failed/);
  assert.equal(f.progress.snapshot().status, 'failed'); assert.equal(f.reopenCalls(), 0);
  assert.ok(f.events.some(event => event.phase === 'rolling-back'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.3.4');
  assert.equal(fs.readFileSync(path.join(f.root, 'src/existing.js'), 'utf8'), 'old application source');
  assert.equal(fs.existsSync(path.join(f.root, 'src/new.js')), false); f.unchangedData();
});

test('failed rollback remains a visible failure and does not describe the original application as restored', async t => {
  const f = workerFixture(t, { installedCheckError: true, rollbackError: true });
  await assert.rejects(f.run(), /恢复原程序文件未完成/);
  assert.equal(f.progress.snapshot().status, 'failed'); assert.equal(f.progress.snapshot().rollback, 'failed');
  const result = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'update-result.json'), 'utf8'));
  assert.equal(result.ok, false); assert.equal(result.rollback, 'failed'); assert.equal(f.reopenCalls(), 0); f.unchangedData();
});

for (const options of [{ reopenError: true }, { wrongRunningVersion: true }]) test('worker does not claim completion after ' + Object.keys(options)[0], async t => {
  const f = workerFixture(t, options), result = await f.run();
  assert.equal(result.ok, true); assert.equal(result.reopened, false); assert.equal(f.reopenCalls(), 1);
  assert.equal(f.progress.snapshot().status, 'failed');
  assert.ok(!f.events.some(event => event.status === 'succeeded'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.3.5'); f.unchangedData();
});

test('worker succeeds only after new-window startup and matching backend health', async t => {
  const f = workerFixture(t), result = await f.run();
  assert.equal(result.ok, true); assert.equal(result.reopened, true); assert.equal(result.runningVersion, '1.3.5');
  assert.equal(f.reopenCalls(), 1); assert.equal(f.progress.snapshot().status, 'succeeded');
  assert.ok(f.events.some(event => event.phase === 'reopening' && event.status === 'running')); f.unchangedData();
});

test('a completion-reporting error preserves confirmed installation success and records a display error', async t => {
  const f = workerFixture(t);
  f.progress.succeed = () => { throw new Error('Synthetic progress publication failed'); };
  const installed = await f.run();
  assert.equal(installed.ok, true); assert.equal(installed.reopened, true); assert.equal(installed.runningVersion, '1.3.5');
  assert.match(installed.progressError, /Synthetic progress publication failed/);
  const result = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'update-result.json'), 'utf8'));
  assert.equal(result.ok, true); assert.equal(result.reopened, true); assert.match(result.progressError, /publication failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.3.5'); f.unchangedData();
});

test('a rollback display error cannot prevent application files from being restored', async t => {
  const f = workerFixture(t, { installedCheckError: true }), set = f.progress.set.bind(f.progress);
  f.progress.set = (phase, details) => {
    if (phase === 'rolling-back') throw new Error('Synthetic rollback display failed');
    return set(phase, details);
  };
  await assert.rejects(f.run(), /Synthetic installed-file check failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.3.4');
  assert.equal(fs.readFileSync(path.join(f.root, 'src/existing.js'), 'utf8'), 'old application source');
  assert.equal(fs.existsSync(path.join(f.root, 'src/new.js')), false);
  const result = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'update-result.json'), 'utf8'));
  assert.equal(result.ok, false); assert.equal(result.rollback, 'restored');
  assert.match(result.progressError, /rollback display failed/); f.unchangedData();
});

test('upgrade-existing catches timer display errors and still clears the timer and completes installation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl upgrade progress timer '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'old'), bundleRoot = path.join(directory, 'new');
  fs.mkdirSync(path.join(target, 'data'), { recursive: true }); fs.mkdirSync(bundleRoot);
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'tcl-ad-studio', version: '1.3.4' }));
  fs.writeFileSync(path.join(target, 'data/config.json'), '{"synthetic":true}');
  const originalConfig = fs.readFileSync(path.join(target, 'data/config.json'));
  const source = require.resolve('../scripts/upgrade-existing'), loaded = new Module(source, module), realRequire = Module.createRequire(source);
  loaded.filename = source; loaded.paths = module.paths;
  let tick, cleared = false, installed = false, attemptedDisplay = false;
  const messages = [], progressReporter = {
    set(_phase, details) { if (details?.unit === 'bytes') { attemptedDisplay = true; throw new Error('Synthetic timer display failed'); } },
    fail() { throw new Error('No installation failure is expected'); },
  };
  loaded.testTimers = { setInterval(callback) { tick = callback; return 7; }, clearInterval(id) { assert.equal(id, 7); cleared = true; } };
  loaded.require = name => {
    if (name === '../src/instance') return { checkIdle: async () => {} };
    if (name === '../src/updater') return { Updater: class {
      async check() { return { available: true, latestVersion: '1.3.5' }; }
      snapshot() { return { download: { phase: 'downloading', received: 1, total: 2 } }; }
      async prepare() { assert.doesNotThrow(() => tick()); return bundleRoot; }
    } };
    if (name === '../src/update-worker') return { install: async options => {
      installed = true; assert.equal(options.progress, progressReporter); assert.equal(cleared, true);
      return { ok: true, version: '1.3.5', reopened: true, backupDir: 'synthetic-backup' };
    } };
    return realRequire(name);
  };
  loaded._compile(fs.readFileSync(source, 'utf8').replace("'use strict';", "'use strict';\nconst { setInterval, clearInterval } = module.testTimers;"), source);
  const result = await loaded.exports.upgradeExisting({ target, bundleRoot, progressReporter, progress: message => messages.push(message) });
  assert.equal(result.ok, true); assert.equal(installed, true); assert.equal(attemptedDisplay, true); assert.equal(cleared, true);
  assert.ok(messages.some(message => message.includes('Synthetic timer display failed')));
  assert.deepEqual(fs.readFileSync(path.join(target, 'data/config.json')), originalConfig);
});

const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function holdWithoutDeleteSharing(file, holdMs = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl held progress '));
  const script = path.join(directory, 'hold.ps1'), ready = path.join(directory, 'ready'), release = path.join(directory, 'release');
  fs.writeFileSync(script, `param([string]$Target,[string]$Ready,[string]$Release,[int]$HoldMs)
$ErrorActionPreference='Stop'
$handle=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
  [IO.File]::WriteAllText($Ready,'locked')
  $clock=[Diagnostics.Stopwatch]::StartNew()
  while (-not [IO.File]::Exists($Release) -and ($HoldMs -eq 0 -or $clock.ElapsedMilliseconds -lt $HoldMs)) { Start-Sleep -Milliseconds 10 }
} finally { $handle.Dispose() }
`);
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Target', file, '-Ready', ready, '-Release', release, '-HoldMs', String(holdMs)], { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  // A separate process releases the handle, so the synchronous writer can
  // retry without depending on this test process's blocked event loop.
  const deadline = Date.now() + 10000, delay = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(delay, 0, 0, 10);
  if (!fs.existsSync(ready)) { child.kill(); throw new Error('Test reader did not acquire the Windows file handle'); }
  return async () => {
    fs.writeFileSync(release, 'release');
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  };
}

test('Windows short-lived reader without delete sharing allows a complete atomic update after release', { skip: process.platform !== 'win32' }, async t => {
  const { progress } = fixture(t), release = holdWithoutDeleteSharing(progress.stateFile, 300);
  try {
    progress.set('installing', { current: 1, total: 3, unit: 'files' });
    const saved = JSON.parse(fs.readFileSync(progress.stateFile, 'utf8'));
    assert.equal(saved.phase, 'installing'); assert.equal(saved.percent, 33); assert.deepEqual(saved, progress.snapshot());
  } finally { await release(); }
});

test('Windows persistent reader cannot commit an unpublished success or corrupt the previous JSON', { skip: process.platform !== 'win32' }, async t => {
  const { progress } = fixture(t); progress.set('reopening');
  const previous = progress.snapshot(), release = holdWithoutDeleteSharing(progress.stateFile), started = Date.now();
  try {
    assert.throws(() => progress.succeed({ reopened: true, runningVersion: '1.3.5' }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    assert.ok(Date.now() - started < 5000, 'The publication retry must stay bounded');
    assert.deepEqual(progress.snapshot(), previous);
    assert.deepEqual(JSON.parse(fs.readFileSync(progress.stateFile, 'utf8')), previous);
  } finally { await release(); }
  progress.fail(new Error('Progress could not be published while the file was held'));
  assert.equal(JSON.parse(fs.readFileSync(progress.stateFile, 'utf8')).status, 'failed');
});

test('Windows persistent progress-file lock cannot stop a real application rollback', { skip: process.platform !== 'win32' }, async t => {
  const f = workerFixture(t, { installedCheckError: true }), set = f.progress.set.bind(f.progress); let release;
  f.progress.set = (phase, details) => {
    if (phase === 'rolling-back') release = holdWithoutDeleteSharing(f.progress.stateFile);
    return set(phase, details);
  };
  try {
    await assert.rejects(f.run(), /Synthetic installed-file check failed/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.3.4');
    assert.equal(fs.readFileSync(path.join(f.root, 'src/existing.js'), 'utf8'), 'old application source');
    assert.equal(fs.existsSync(path.join(f.root, 'src/new.js')), false);
    const result = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'update-result.json'), 'utf8'));
    assert.equal(result.ok, false); assert.equal(result.rollback, 'restored'); assert.ok(result.progressError);
    assert.notEqual(JSON.parse(fs.readFileSync(f.progress.stateFile, 'utf8')).status, 'succeeded'); f.unchangedData();
  } finally { await release?.(); }
});

test('Windows extraction completes with a retained warning when its progress file stays locked', { skip: process.platform !== 'win32' }, async t => {
  const { directory, progress } = fixture(t), input = path.join(directory, 'input'), archive = path.join(directory, 'synthetic.zip');
  const sourceRoot = path.join(input, 'TCL广告投放工具'); fs.mkdirSync(path.join(sourceRoot, 'public'), { recursive: true });
  const content = Buffer.alloc(128 * 1024, 37); fs.writeFileSync(path.join(sourceRoot, 'public/resource.bin'), content);
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"version":"1.3.5"}');
  const zipScript = path.join(directory, 'create-zip.ps1');
  fs.writeFileSync(zipScript, `param([string]$Source,[string]$Archive)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$base=[IO.Path]::GetFullPath($Source).TrimEnd('\\')+'\\'
$zip=[IO.Compression.ZipFile]::Open($Archive,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in [IO.Directory]::EnumerateFiles($base,'*',[IO.SearchOption]::AllDirectories)) {
    $entry=$file.Substring($base.Length).Replace('\\','/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file,$entry)
  }
} finally { $zip.Dispose() }
`);
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', zipScript, '-Source', input, '-Archive', archive], { windowsHide: true, stdio: 'pipe' });
  const oldProgress = { schemaVersion: 1, runId: progress.runId, phase: 'extracting', current: 0, total: content.length, unit: 'bytes' };
  fs.writeFileSync(progress.extractFile, JSON.stringify(oldProgress));
  const release = holdWithoutDeleteSharing(progress.extractFile), destination = path.join(directory, 'unpacked');
  try {
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../scripts/unpack-update.ps1'),
      '-Archive', archive, '-Destination', destination, '-ProgressFile', progress.extractFile, '-RunId', progress.runId], { windowsHide: true, timeout: 15000, stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(path.join(destination, 'public/resource.bin')), content);
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'package.json'))).version, '1.3.5');
    assert.deepEqual(JSON.parse(fs.readFileSync(progress.extractFile, 'utf8')), oldProgress);
    const warning = JSON.parse(fs.readFileSync(path.join(directory, 'extract-progress-warning.json'), 'utf8'));
    assert.equal(warning.runId, progress.runId); assert.equal(warning.phase, 'extracting'); assert.match(warning.message, /解压仍在继续/);
  } finally { await release(); }
});
