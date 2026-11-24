'use strict';
// Verify a genuine 1.3.7 Electron -> HTTP install -> original worker -> 1.3.8
// desktop and progress-window handoff. A preload supplies exact signed local
// download bytes and passively records native spawn. Released sources and
// updater decisions are neither replaced nor patched.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const cp = require('node:child_process');
const { atomicJson } = require('../app/src/config');
const { sha256, verifyManifest } = require('../app/src/updater');
const root = path.resolve(__dirname, '..'), from = '1.3.7', version = '1.3.8';
const hash = file => sha256(fs.readFileSync(file));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const quotePs = value => "'" + value.replace(/'/g, "''") + "'";
const folder = fs.mkdtempSync(path.join(__dirname, 'tcl-138-real-self-update-'));
const target = path.join(folder, 'TCL广告投放工具'), dataDir = path.join(target, 'data');
const traceFile = path.join(folder, 'preload-events.jsonl');
function processes() {
  const node = path.join(target, 'runtime/node.exe'), electron = path.join(target, 'runtime/electron/electron.exe');
  const query = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'electron.exe'" | Where-Object { $_.ExecutablePath -eq ${quotePs(node)} -or $_.ExecutablePath -eq ${quotePs(electron)} } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`;
  const output = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output); return Array.isArray(parsed) ? parsed : [parsed];
}
function processWindow(pid) {
  const command = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $item=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if($null -ne $item){[pscustomobject]@{pid=$item.Id;title=$item.MainWindowTitle;handle=$item.MainWindowHandle.ToInt64()}|ConvertTo-Json -Compress}`;
  const output = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
  return output ? JSON.parse(output) : null;
}
function events() {
  try { return fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
async function until(fn, timeoutMs = 180000, description = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await wait(200); }
  throw new Error('Timeout waiting for ' + description);
}
async function ready(wanted) {
  try {
    const instance = JSON.parse(fs.readFileSync(path.join(dataDir, 'instance.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${instance.port}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    if (response.ok && health.instanceId === instance.instanceId && health.version === wanted) return instance;
  } catch {}
  return null;
}
async function request(instance, route, body) {
  const base = `http://127.0.0.1:${instance.port}`;
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: 'tcl_session=' + instance.token, Origin: base, 'X-TCL-Request': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
}
async function exit(instance) {
  await request(instance, '/api/exit', {});
  await until(() => !alive(instance.pid), 15000, 'isolated backend exit');
  await until(() => processes().length === 0, 15000, 'all isolated application processes exit');
}
async function launch(env) {
  const log = fs.openSync(path.join(folder, 'initial-launch.log'), 'a');
  const child = cp.spawn(path.join(target, 'runtime/node.exe'), ['--disable-warning=ExperimentalWarning', path.join(target, 'src/server.js'), '--open'],
    { cwd: target, env, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Original desktop launcher did not finish')); }, 45000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Original desktop launcher exit ' + code)); });
  });
}
async function main() {
  const baselineArchive = path.join(root, `publish/v${from}/tcl-ad-tool-${from}-win-x64.zip`);
  const baseline = verifyManifest(JSON.parse(fs.readFileSync(path.join(root, `publish/v${from}/update.json`))));
  assert.equal(baseline.version, from); assert.equal(hash(baselineArchive), baseline.sha256); assert.equal(fs.statSync(baselineArchive).size, baseline.size);
  const publishedBaseline = JSON.parse(fs.readFileSync(path.join(root, `publish/v${from}/online-update-verification-${from}.json`)));
  assert.equal(publishedBaseline.version, from); assert.equal(publishedBaseline.sha256, baseline.sha256);
  assert.equal(publishedBaseline.draft, false); assert.equal(publishedBaseline.prerelease, false);
  assert.equal(publishedBaseline.publicPackageFullyDownloaded, true);
  const manifestFile = path.join(root, `publish/v${version}/update.json`);
  const archiveFile = path.join(root, `publish/v${version}/tcl-ad-tool-${version}-win-x64.zip`);
  const release = verifyManifest(JSON.parse(fs.readFileSync(manifestFile)));
  const sourceRead = cp.spawnSync('python', ['-X', 'utf8', '-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read("TCL广告投放工具/release-manifest.json").decode("utf-8"))',
    archiveFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(sourceRead.status, 0, sourceRead.stderr);
  const packagedManifest = JSON.parse(sourceRead.stdout);
  const candidate = { version: packagedManifest.version, sha256: release.sha256,
    startupSourceHashes: packagedManifest.sourceHashes, progressSourceHashes: {} };
  const expectedSha = candidate.sha256;
  assert.equal(candidate.version, version);
  assert.equal(baseline.sha256, '73687d20736d495a0019d95d90530a2480994abb5d97b16b763cb18043b1abc1', 'Immutable published 1.3.7 baseline');
  assert.equal(release.version, version); assert.equal(release.sha256, expectedSha); assert.equal(hash(archiveFile), expectedSha); assert.equal(fs.statSync(archiveFile).size, release.size);
  assert.equal(candidate.sha256, expectedSha);
  const extracted = cp.spawnSync('python', ['-X', 'utf8', path.join(__dirname, 'extract-release.py'), baselineArchive, target], { encoding: 'utf8', windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr);
  const sourceNames = ['package.json', 'src/server.js', 'src/desktop/main.js', 'src/desktop-launch.js', 'src/updater.js', 'src/update-worker.js', 'src/startup.js', 'src/instance.js',
    'src/update-progress.js', 'scripts/update-progress.ps1', 'scripts/unpack-update.ps1'];
  const oldHashes = Object.fromEntries(sourceNames.map(name => [name, hash(path.join(target, name))]));
  const oldManifest = JSON.parse(fs.readFileSync(path.join(target, 'release-manifest.json')));
  for (const [name, digest] of Object.entries(oldManifest.sourceHashes)) assert.equal(hash(path.join(target, name)), digest, 'released source ' + name);
  const { config, address } = require(path.join(target, 'test/fixtures'));
  const settings = config({ privateKey: '', apiKey: '', poolFundingKey: '', rpcUrl: 'https://127.0.0.1:9', autoResumeEnergy: false });
  atomicJson(path.join(dataDir, 'config.json'), settings);
  const { Store } = require(path.join(target, 'src/store'));
  const store = new Store(dataDir);
  const { DeliveryReporter: BaselineReporter } = require(path.join(target, 'src/delivery-reporter'));
  const baselineReporter = new BaselineReporter(store, () => settings);
  await baselineReporter.close();
  const { WalletPool } = require(path.join(target, 'src/pool'));
  const pool = new WalletPool(store, dataDir, () => settings, () => { throw new Error('No chain during isolated fixture setup'); });
  await pool.close();
  for (const [i, status] of ['queued', 'failed'].entries()) {
    const source = String(i).padStart(64, 'a');
    assert.equal(store.offer('live', { to: address(100 + i), txid: source, asset: 'TRX', amount: '150' }, settings, 12345), true);
    const row = store.db.prepare('SELECT * FROM deliveries WHERE source_tx=?').get(source);
    if (status === 'failed') store.update(row.id, status, { detail: 'isolated release verification, never signed or broadcast' });
  }
  store.setMeta('online-progress-fixture', { preserved: true });
  const tables = ['deliveries', 'legacy_addresses', 'legacy_transactions', 'meta', 'delivery_attempts', 'delivery_retry', 'delivery_receipts', 'pool_wallets', 'pool_batches', 'pool_jobs', 'energy_orders', 'platform_delivery_reports', 'platform_delivery_candidates']
    .map(name => ({ name, columns: store.db.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name), rows: JSON.parse(JSON.stringify(store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())) }));
  store.close();
  const { PoolVault } = require(path.join(target, 'src/pool-vault'));
  const vault = new PoolVault(dataDir); vault.initialize('isolated-self-update-password'); vault.lock();
  const configHash = hash(path.join(dataDir, 'config.json')), vaultHash = hash(vault.file);
  const channel = JSON.parse(fs.readFileSync(path.join(target, 'update-channel.json')));
  const preload = path.join(folder, 'test-fetch-preload.cjs');
  fs.writeFileSync(preload, `'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const traceFile = ${JSON.stringify(traceFile)};
function record(event) { fs.appendFileSync(traceFile, JSON.stringify({time:new Date().toISOString(),pid:process.pid,...event})+'\\n'); }
if (process.argv.includes('--desktop-backend')) {
  global.fetch = async (input, options) => {
    const url = String(input?.url || input);
    const file = url === ${JSON.stringify(channel.manifestUrl)} ? ${JSON.stringify(manifestFile)} : url === ${JSON.stringify(release.url)} ? ${JSON.stringify(archiveFile)} : null;
    if (!file) { record({type:'blocked-fetch'}); throw new Error('Isolated verification blocked unexpected outbound fetch'); }
    options?.signal?.throwIfAborted(); record({type:'fixture-download',kind:file.endsWith('.zip')?'archive':'manifest'});
    return new Response(fs.readFileSync(file));
  };
}
const originalSpawn = cp.spawn;
cp.spawn = function(executable, args, options) {
  const child = originalSpawn(executable,args,options);
  const worker = args?.find(arg => String(arg).endsWith('update-worker.js'));
  if (worker) {
    const directory = path.resolve(path.dirname(worker),'..');
    const hashes = Object.fromEntries(['src/updater.js','src/update-worker.js','src/startup.js','src/instance.js','src/update-progress.js','scripts/update-progress.ps1','scripts/unpack-update.ps1'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex')]));
    const position=args.indexOf(worker), call=args.slice(position+1);
    const progressDirectory=call[4],runId=call[5],ready=JSON.parse(fs.readFileSync(path.join(progressDirectory,'ui-ready.json'),'utf8'));
    const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
    record({type:'worker-spawn',workerPid:child.pid,directory,ownerPid:Number(call[2]),desktopPid:Number(call[3]),oldBackendAlive:alive(Number(call[2])),oldDesktopAlive:alive(Number(call[3])),progressDirectory,runId,uiReady:ready,hashes});
  }
  if (args?.some(arg=>String(arg).endsWith('progress-host.js'))) record({type:'progress-host-spawn',hostPid:child.pid});
  if (args?.includes('-HostPid')) {
    record({type:'progress-window-spawn',windowPid:child.pid,hostPid:Number(args[args.indexOf('-HostPid')+1])});
    child.once('exit',(code,signal)=>record({type:'progress-window-exit',windowPid:child.pid,code,signal}));
  }
  return child;
};
record({type:'preload',role:process.argv.includes('--desktop-backend')?'backend':process.argv.some(arg=>String(arg).endsWith('update-worker.js'))?'worker':process.versions.electron?'electron':'launcher'});
`);
  const env = { ...process.env, TCL_DATA_DIR: dataDir, NODE_OPTIONS: '--require ' + JSON.stringify(preload) };
  delete env.TCL_STARTUP_STATUS; delete env.ELECTRON_RUN_AS_NODE;
  let current, old, oldDesktop, worker, progressUi, closed = false;
  try {
    await launch(env); old = await until(() => ready(from), 20000, 'genuine 1.3.7 health'); current = old;
    const oldProcesses = processes();
    const backend = oldProcesses.find(item => item.ProcessId === old.pid); assert.ok(backend);
    oldDesktop = oldProcesses.find(item => item.ProcessId === backend.ParentProcessId); assert.ok(oldDesktop);
    assert.equal(path.resolve(oldDesktop.ExecutablePath).toLowerCase(), path.join(target, 'runtime/electron/electron.exe').toLowerCase());
    const oldState = await request(old, '/api/state');
    assert.equal(oldState.version, from); assert.equal(oldState.state, 'stopped'); assert.equal(oldState.pool.unlocked, false); assert.equal(oldState.config.hasPrivateKey, false);
    for (const [name, expected] of Object.entries(oldHashes)) assert.equal(hash(path.join(target, name)), expected, 'unchanged released source ' + name);
    console.log(JSON.stringify({ phase: 'genuine-old-desktop-ready', oldBackendPid: old.pid, oldElectronPid: oldDesktop.ProcessId, version: from, paused: true, locked: true }));
    assert.equal((await request(old, '/api/update/check', {})).latestVersion, version);
    await request(old, '/api/update/download', { version });
    await until(async () => {
      const update = await request(old, '/api/update');
      if (update.download.phase === 'error') throw new Error(update.download.error);
      return update.download.phase === 'ready';
    }, 30000, 'signed candidate download');
    console.log(JSON.stringify({ phase: 'signed-candidate-ready', sha256: expectedSha }));
    const installAt = Date.now();
    await request(old, '/api/update/install', { version, confirmed: true });
    worker = await until(() => events().find(event => event.type === 'worker-spawn'), 10000, 'original worker spawn');
    assert.equal(worker.ownerPid, old.pid); assert.equal(worker.desktopPid, oldDesktop.ProcessId);
    assert.equal(worker.oldBackendAlive, true); assert.equal(worker.oldDesktopAlive, true);
    for (const [name, expected] of Object.entries(worker.hashes)) assert.equal(expected, oldHashes[name], 'original temporary worker source ' + name);
    progressUi = worker.uiReady;
    assert.equal(progressUi.runId, worker.runId); assert.ok(progressUi.pid > 0 && progressUi.windowPid > 0);
    assert.ok(Date.parse(progressUi.shownAt) <= Date.parse(worker.time), 'Real UI shown before the original worker starts');
    const hostSpawn = events().find(event => event.type === 'progress-host-spawn' && event.hostPid === progressUi.pid);
    const uiSpawn = events().find(event => event.type === 'progress-window-spawn' && event.windowPid === progressUi.windowPid);
    assert.ok(hostSpawn); assert.ok(uiSpawn); assert.equal(uiSpawn.hostPid, progressUi.pid);
    const initialWindow = processWindow(progressUi.windowPid);
    assert.ok(initialWindow?.handle > 0); assert.equal(initialWindow.title, 'TCL 更新进度');
    console.log(JSON.stringify({ phase: 'original-updater-progress-visible', runId: worker.runId, uiPid: progressUi.windowPid, hostPid: progressUi.pid }));
    const progressFile = path.join(worker.progressDirectory, 'progress-state.json');
    const samples = [], extractionSamples = [], observedPhases = new Set();
    let oldExitedAfterMs, healthyAfterMs, windowAfterOldExit, finalProgress;
    const monitorDeadline = Date.now() + 180000;
    while (Date.now() < monitorDeadline) {
      const progress = json(progressFile), hostAlive = alive(progressUi.pid), windowAlive = alive(progressUi.windowPid);
      const newInstance = await ready(version);
      if (newInstance && healthyAfterMs === undefined) {
        current = newInstance; healthyAfterMs = Date.now() - installAt;
        assert.ok(hostAlive && windowAlive, 'Original progress remains alive until real 1.3.8 health is observed');
        console.log(JSON.stringify({ phase: 'new-version-health-observed-with-progress', healthyAfterMs, newBackendPid: current.pid, uiPid: progressUi.windowPid }));
      }
      if (oldExitedAfterMs === undefined && !alive(old.pid) && !alive(oldDesktop.ProcessId)) {
        oldExitedAfterMs = Date.now() - installAt;
        assert.ok(hostAlive && windowAlive, 'Progress survives old backend and Electron shutdown');
        windowAfterOldExit = processWindow(progressUi.windowPid);
        assert.ok(windowAfterOldExit?.handle > 0); assert.equal(windowAfterOldExit.title, 'TCL 更新进度');
        console.log(JSON.stringify({ phase: 'old-desktop-and-backend-exited-progress-remains', oldBackendPid: old.pid, oldElectronPid: oldDesktop.ProcessId, oldExitedAfterMs, uiPid: progressUi.windowPid }));
      }
      if (healthyAfterMs === undefined) assert.ok(hostAlive && windowAlive, 'Progress host/window must not close before new version health');
      if (progress) {
        assert.equal(progress.runId, worker.runId); assert.equal(progress.version, version);
        if (progress.status === 'failed') throw new Error('Original update progress failed: ' + progress.detail);
        if (progress.current == null || progress.total == null) assert.equal(progress.percent, null);
        else assert.equal(progress.percent, Math.floor(progress.current * 100 / progress.total));
        samples.push({ at: new Date().toISOString(), phase: progress.phase, status: progress.status, current: progress.current, total: progress.total,
          hostAlive, windowAlive, oldBackendAlive: alive(old.pid), oldElectronAlive: alive(oldDesktop.ProcessId), newVersionHealthy: Boolean(newInstance) });
        if (!observedPhases.has(progress.phase)) {
          observedPhases.add(progress.phase); console.log(JSON.stringify({ phase: 'observed-original-worker-stage', stage: progress.phase }));
        }
        if (progress.status === 'succeeded') {
          assert.ok(newInstance, 'Success progress is backed by the real healthy new instance');
          assert.equal(progress.runningVersion, version); assert.equal(progress.reopened, true); assert.equal(progress.instanceId, newInstance.instanceId);
          finalProgress = progress;
        }
      }
      const extraction = json(path.join(worker.progressDirectory, 'extract-progress.json'));
      if (extraction) {
        assert.equal(extraction.runId, worker.runId); assert.equal(extraction.phase, 'extracting');
        assert.ok(extraction.current >= 0 && extraction.current <= extraction.total && extraction.total > 0);
        extractionSamples.push({ at: new Date().toISOString(), current: extraction.current, total: extraction.total });
      }
      const result = json(path.join(dataDir, 'update-result.json'));
      if (result?.ok === false) throw new Error('Original update worker failed: ' + result.message);
      if (finalProgress && healthyAfterMs !== undefined && oldExitedAfterMs !== undefined) break;
      await wait(100);
    }
    assert.ok(finalProgress, 'Original progress must reach successful terminal state');
    assert.ok(oldExitedAfterMs !== undefined && healthyAfterMs !== undefined);
    assert.ok(oldExitedAfterMs < healthyAfterMs);
    assert.ok(samples.some(sample => !sample.oldBackendAlive && !sample.oldElectronAlive && !sample.newVersionHealthy && sample.windowAlive && sample.hostAlive), 'Observed the independent progress interval after old desktop shutdown');
    assert.ok(extractionSamples.some(sample => sample.current < sample.total), 'Observed real partial extraction byte count');
    assert.equal(extractionSamples.at(-1).current, extractionSamples.at(-1).total);
    assert.equal(fs.existsSync(path.join(worker.progressDirectory, 'extract-progress-warning.json')), false);
    fs.writeFileSync(path.join(folder, 'progress-observations.json'), JSON.stringify({ samples, extractionSamples, finalProgress }, null, 2));
    assert.notEqual(current.pid, old.pid); assert.notEqual(current.instanceId, old.instanceId);
    const installed = await until(() => {
      const result = json(path.join(dataDir, 'update-result.json'));
      if (!result) return null;
      return typeof result.reopened === 'boolean' ? result : null;
    }, 45000, 'original worker final reopen result');
    assert.equal(installed.ok, true); assert.equal(installed.version, version); assert.equal(installed.reopened, true);
    assert.equal(installed.runningVersion, version); assert.equal(installed.instanceId, current.instanceId); assert.equal(installed.runId, worker.runId);
    assert.equal(installed.progressError, undefined, 'Normal upgrade must not degrade progress publication');
    await until(() => !alive(progressUi.pid) && !alive(progressUi.windowPid), 15000, 'successful progress host/window automatic close');
    const progressClosedAfterMs = Date.now() - installAt;
    const uiExitEvent = events().find(event => event.type === 'progress-window-exit' && event.windowPid === progressUi.windowPid);
    assert.ok(uiExitEvent); assert.equal(uiExitEvent.code, 0);
    assert.ok(Date.parse(uiExitEvent.time) >= Date.parse(finalProgress.finishedAt), 'Native progress closes after confirmed success');
    await until(() => !alive(worker.workerPid), 15000, 'original worker exit');
    const newProcesses = processes(), nextBackend = newProcesses.find(item => item.ProcessId === current.pid); assert.ok(nextBackend);
    const nextDesktop = newProcesses.find(item => item.ProcessId === nextBackend.ParentProcessId); assert.ok(nextDesktop);
    assert.equal(newProcesses.filter(item => item.CommandLine?.includes('--desktop-backend')).length, 1);
    assert.equal(newProcesses.filter(item => item.ExecutablePath.toLowerCase().endsWith('electron.exe') && !item.CommandLine?.includes('--type=')).length, 1);
    const state = await request(current, '/api/state'), environment = await request(current, '/api/environment');
    assert.equal(state.version, version); assert.equal(state.state, 'stopped'); assert.equal(state.pool.unlocked, false); assert.equal(state.config.hasPrivateKey, false);
    assert.equal(environment['窗口类型'], 'Electron 独立桌面窗口');
    console.log(JSON.stringify({ phase: 'new-desktop-healthy', newBackendPid: current.pid, newElectronPid: nextDesktop.ProcessId, version, healthyAfterMs, reopened: installed.reopened }));
    assert.equal(hash(path.join(dataDir, 'config.json')), configHash); assert.equal(hash(vault.file), vaultHash);
    assert.equal(hash(path.join(installed.backupDir, 'config.json')), configHash); assert.equal(hash(path.join(installed.backupDir, 'pool-vault.json')), vaultHash);
    const { DatabaseSync } = require('node:sqlite');
    for (const file of [path.join(dataDir, 'records.sqlite'), path.join(installed.backupDir, 'records.sqlite')]) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
        const isInstalled = file === path.join(dataDir, 'records.sqlite');
        for (const table of tables) {
          assert.deepEqual(db.prepare(`PRAGMA table_info(${table.name})`).all().map(column => column.name), table.columns, 'schema preserved ' + table.name);
          let rows = JSON.parse(JSON.stringify(db.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all()));
          assert.deepEqual(rows, table.rows, 'preserved ' + table.name);
        }
        if (isInstalled) {
          for (const name of ['platform_delivery_reports', 'platform_delivery_candidates']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n, 0, 'unbound empty outbox');
          assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'platform_report_%'").get().n, 6);
        }
      }
      finally { db.close(); }
    }
    for (const [name, expected] of Object.entries({ ...candidate.startupSourceHashes, ...candidate.progressSourceHashes })) assert.equal(hash(path.join(target, name)), expected, 'installed candidate source ' + name);
    for (const name of sourceNames) {
      const backupFile = path.join(installed.backupDir, 'application', name);
      if (fs.existsSync(backupFile)) assert.equal(hash(backupFile), oldHashes[name], 'original source backup ' + name);
    }
    const stableInstance = current.instanceId;
    await Promise.all([launch(env), launch(env)]);
    assert.equal((await ready(version)).instanceId, stableInstance);
    const repeated = processes();
    assert.equal(repeated.filter(item => item.CommandLine?.includes('--desktop-backend')).length, 1);
    assert.equal(repeated.filter(item => item.ExecutablePath.toLowerCase().endsWith('electron.exe') && !item.CommandLine?.includes('--type=')).length, 1);
    await exit(current); closed = true;
    const recordedEvents = events();
    assert.equal(recordedEvents.filter(event => event.type === 'blocked-fetch').length, 0);
    const result = { from, version, checkedAt: new Date().toISOString(), target, packageSha256: expectedSha, baselineSha256: baseline.sha256,
      genuineReleasedBaseline: true, originalSourceHashes: oldHashes, originalSourcesUnmodifiedBeforeInstall: true,
      injection: 'NODE_OPTIONS preload supplies exact signed manifest/archive bytes to fetch and records real process spawn; released files unchanged',
      signedDownloadAndInstallThroughOriginalHttpApi: true, originalWorkerHashes: worker.hashes, originalWorkerPid: worker.workerPid,
      passedOriginalOwnerPid: worker.ownerPid, passedOriginalDesktopPid: worker.desktopPid, originalWorkerExited: true,
      oldBackendPid: old.pid, oldElectronPid: oldDesktop.ProcessId, oldBackendExited: true, oldElectronExited: true, oldExitedAfterMs,
      newBackendPid: current.pid, newElectronPid: nextDesktop.ProcessId, healthyAfterMs, originalWorkerReportedReopened: installed.reopened,
      progressRunId: worker.runId, progressDirectory: worker.progressDirectory, progressHostPid: progressUi.pid, progressWindowPid: progressUi.windowPid,
      originalProgressSourcesUnmodified: true, progressVisibleBeforeOriginalProcessesExit: true,
      progressRemainedVisibleAfterOldProcessesExit: true, progressStayedAliveUntilNewVersionHealth: true,
      progressSuccessMatchesRunningInstance: true, progressWindowClosedItselfAfterSuccess: true, progressClosedAfterMs,
      progressWindowAfterOldExit: windowAfterOldExit, observedProgressPhases: [...observedPhases], progressSamples: samples.length,
      actualExtractionBytes: extractionSamples.at(-1).total, actualExtractionProgressObserved: true, indeterminateStagesDoNotFakePercent: true,
      observedProgressFile: path.join(folder, 'progress-observations.json'), progressDisplayError: null,
      newVersionHealthAndElectronEnvironmentVerified: true, singleBackendAndElectron: true, repeatedStartsReuseSameInstance: true,
      startsPaused: true, vaultStartsLocked: true, noPrivateKey: true, configAndEncryptedVaultPreserved: true, databaseRowsPreserved: true, originalTableSchemasPreserved: true, reportingOutboxMigrationVerified: true, reportingOutboxPreservedFrom137: true,
      unboundReportingMakesNoRequests: true, backupsVerified: true,
      installedStartupSourcesMatchSignedCandidate: true, newProcessesExitedCleanly: true, downloadNetworkRequests: 0,
      realBroadcasts: 0, personalInstallationChanged: false, published: false };
    atomicJson(path.join(folder, 'result.json'), result);
    atomicJson(path.join(__dirname, 'electron-self-update-verification-1.3.8-from-1.3.7.json'), result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (!closed) {
      try { current = await ready(version) || await ready(from); if (current) await exit(current); } catch {}
      // Only the disposable target's executable paths qualify for cleanup.
      for (const item of processes()) { try { process.kill(item.ProcessId); } catch {} }
      if (worker && alive(worker.workerPid)) {
        const workerPath = path.resolve(worker.directory, 'node.exe');
        assert.ok(workerPath.startsWith(path.resolve(require('node:os').tmpdir()) + path.sep));
        try { process.kill(worker.workerPid); } catch {}
      }
      for (const pid of [progressUi?.windowPid, progressUi?.pid]) if (pid && alive(pid)) { try { process.kill(pid); } catch {} }
    }
  }
}
main().catch(error => { fs.writeFileSync(path.join(folder, 'failure.txt'), error.stack || error.message); console.error(error.stack || error.message); process.exitCode = 1; });
