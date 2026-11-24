'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createProgress, readState } = require('./update-progress');
const CHANNEL = require('../update-channel.json');
const VERSION = require('../package.json').version;
const MAX_PACKAGE = 200 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function compareVersions(a, b) {
  if (![a, b].every(v => /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v))) throw new Error('更新版本号无效');
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return Math.sign(aa[i] - bb[i]);
  return 0;
}
function verifyManifest(envelope, channel = CHANNEL) {
  if (typeof envelope?.payload !== 'string' || envelope.payload.length > 48000 || typeof envelope.signature !== 'string' || envelope.signature.length > 200) throw new Error('更新清单格式无效');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (!crypto.verify(null, bytes, channel.publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('更新签名校验失败，未安装');
  const release = JSON.parse(bytes.toString('utf8'));
  compareVersions(release.version, VERSION);
  const expected = `https://github.com/${channel.repository}/releases/download/v${release.version}/tcl-ad-tool-${release.version}-win-x64.zip`;
  if (release.url !== expected || !/^[a-f0-9]{64}$/.test(release.sha256) || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > MAX_PACKAGE || typeof release.notes !== 'string' || release.notes.length > 8000) throw new Error('更新清单内容无效');
  return release;
}
async function download(url, limit, fetcher = fetch, timeout = 120000, { onProgress = () => {}, signal: cancelSignal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal = cancelSignal ? AbortSignal.any([timeoutSignal, cancelSignal]) : timeoutSignal;
  let target = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (target.protocol !== 'https:' || target.username || target.password || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw new Error('更新下载地址不受信任');
    const response = await fetcher(target.href, { redirect: 'manual', signal, headers: { 'User-Agent': 'TCL-Ad-Studio-Updater', 'Cache-Control': 'no-cache' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('更新下载重定向无效');
      target = new URL(location, target); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`检查或下载更新失败（HTTP ${response.status}），请稍后重试`); }
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('更新文件超过允许大小'); }
    const chunks = []; let size = 0; onProgress(0);
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length; if (size > limit) throw new Error('更新文件超过允许大小'); chunks.push(chunk); onProgress(size);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('更新下载重定向过多');
}
class Updater {
  constructor({ root = path.resolve(__dirname, '..'), channel = CHANNEL, version = VERSION, fetcher = fetch,
    spawnProcess = spawn, progressFactory = createProgress } = {}) {
    Object.assign(this, { root, channel, version, fetcher, spawnProcess, progressFactory }); this.release = null; this.envelope = null; this.checkedAt = null;
    this.checkPromise = null; this.lastError = ''; this.automaticChecks = false; this.checkTimer = null;
    this.downloadPromise = null; this.downloadController = null; this.prepared = null;
    this.downloadState = { phase: 'idle', version: null, received: 0, total: 0, percent: 0, error: '', startedAt: null, lastProgressAt: null };
  }
  snapshot() {
    const transfer = this.downloadState, now = Date.now();
    const elapsedMs = transfer.startedAt ? Math.max(0, (transfer.finishedAt ? Date.parse(transfer.finishedAt) : now) - Date.parse(transfer.startedAt)) : 0;
    return { currentVersion: this.version, latestVersion: this.release?.version || null,
    available: Boolean(this.release && compareVersions(this.release.version, this.version) > 0), notes: this.release?.notes || '',
    checkedAt: this.checkedAt, checking: Boolean(this.checkPromise), lastError: this.lastError,
    repositoryUrl: 'https://github.com/' + this.channel.repository, download: { ...transfer, elapsedMs,
      bytesPerSecond: transfer.phase === 'downloading' && elapsedMs > 0 ? transfer.received * 1000 / elapsedMs : 0,
      stalledMs: transfer.phase === 'downloading' && transfer.startedAt ? Math.max(0, now - Date.parse(transfer.lastProgressAt || transfer.startedAt)) : 0 } }; }
  check() {
    if (this.checkPromise) return this.checkPromise;
    if (this.downloadPromise) return Promise.resolve(this.snapshot());
    this.checkPromise = (async () => {
      try {
        const envelope = JSON.parse((await download(this.channel.manifestUrl, 65536, this.fetcher, 20000)).toString('utf8'));
        const release = verifyManifest(envelope, this.channel);
        if (this.downloadState.version && release.version !== this.downloadState.version) {
          this.prepared = null;
          this.downloadState = { phase: 'idle', version: null, received: 0, total: 0, percent: 0, error: '', startedAt: null, lastProgressAt: null };
        }
        this.envelope = envelope; this.release = release; this.checkedAt = new Date().toISOString(); this.lastError = '';
      } catch (error) {
        this.lastError = '暂时无法检查更新，请检查网络后重试'; throw error;
      } finally { this.checkPromise = null; }
      return this.snapshot();
    })();
    return this.checkPromise;
  }
  startAutomaticChecks({ initialDelayMs = 1000, intervalMs = 6 * 60 * 60 * 1000, retryMs = 15 * 60 * 1000 } = {}) {
    this.stopAutomaticChecks(); this.automaticChecks = true;
    const schedule = delay => { this.checkTimer = setTimeout(run, delay); this.checkTimer.unref?.(); };
    const run = async () => {
      let delay = intervalMs;
      try { await this.check(); } catch { delay = retryMs; }
      if (this.automaticChecks) schedule(delay);
    };
    schedule(initialDelayMs);
  }
  stopAutomaticChecks() {
    this.automaticChecks = false; clearTimeout(this.checkTimer); this.checkTimer = null;
  }
  validateDownloadVersion(expectedVersion) {
    if (this.checkPromise) throw new Error('正在检查更新，请等待检查完成后再操作');
    if (!this.release || this.release.version !== expectedVersion || compareVersions(expectedVersion, this.version) <= 0) throw new Error('请先检查更新并确认新版本');
  }
  startDownload(expectedVersion) {
    this.validateDownloadVersion(expectedVersion);
    // Download continues independently of the HTTP response and page navigation.
    // prepare records every failure in the public state; never launch here.
    this.prepare(expectedVersion).catch(() => {});
    return this.snapshot();
  }
  async prepare(expectedVersion) {
    this.validateDownloadVersion(expectedVersion);
    if (this.downloadPromise) {
      if (this.downloadState.version !== expectedVersion) throw new Error('另一个版本正在下载，请等待完成');
      return this.downloadPromise;
    }
    if (this.prepared?.version === expectedVersion && this.downloadState.phase === 'ready') return this.readyDirectory(expectedVersion);
    const release = { ...this.release }, envelope = this.envelope;
    this.prepared = null; this.downloadController = new AbortController();
    const signal = this.downloadController.signal;
    this.downloadState = { phase: 'downloading', version: expectedVersion, received: 0, total: release.size, percent: 0, error: '',
      startedAt: new Date().toISOString(), lastProgressAt: null };
    this.downloadPromise = (async () => {
      try {
        const bytes = await download(release.url, release.size, this.fetcher, 600000, { signal, onProgress: received => {
          if (received > this.downloadState.received) this.downloadState.lastProgressAt = new Date().toISOString();
          this.downloadState.received = received;
          this.downloadState.percent = Math.min(99, Math.floor(received * 100 / release.size));
        } });
        this.downloadState.phase = 'verifying';
        if (bytes.length !== release.size || sha256(bytes) !== release.sha256) throw new Error('更新包校验失败，旧程序保持不变');
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tcl-update-'));
        await fs.promises.writeFile(path.join(directory, 'package.zip'), bytes);
        await fs.promises.writeFile(path.join(directory, 'update.json'), JSON.stringify(envelope));
        await fs.promises.mkdir(path.join(directory, 'src')); await fs.promises.mkdir(path.join(directory, 'scripts'));
        for (const name of ['update-channel.json', 'package.json', 'src/updater.js', 'src/instance.js', 'src/update-worker.js', 'src/startup.js',
          'src/update-progress.js', 'scripts/unpack-update.ps1', 'scripts/update-progress.ps1']) {
          await fs.promises.copyFile(path.join(this.root, name), path.join(directory, name));
        }
        // Runtime stays outside the installation so Windows can replace it.
        await fs.promises.copyFile(path.join(this.root, 'runtime/node.exe'), path.join(directory, 'node.exe'));
        signal.throwIfAborted();
        this.prepared = { directory, version: expectedVersion, sha256: release.sha256, size: release.size };
        this.downloadState.phase = 'ready'; this.downloadState.percent = 100; this.downloadState.finishedAt = new Date().toISOString();
        return directory;
      } catch (error) {
        this.prepared = null; this.downloadState.phase = 'error'; this.downloadState.finishedAt = new Date().toISOString();
        this.downloadState.error = signal.aborted ? '下载已取消，可重新下载' : error.message || '下载失败，请重试';
        throw error;
      } finally { this.downloadPromise = null; this.downloadController = null; }
    })();
    return this.downloadPromise;
  }
  async readyDirectory(expectedVersion) {
    this.validateDownloadVersion(expectedVersion);
    if (this.downloadState.phase !== 'ready' || this.prepared?.version !== expectedVersion) throw new Error('请先下载新版本，校验完成后再确认安装');
    const prepared = this.prepared;
    try {
      const envelope = JSON.parse(await fs.promises.readFile(path.join(prepared.directory, 'update.json'), 'utf8'));
      const release = verifyManifest(envelope, this.channel);
      const bytes = await fs.promises.readFile(path.join(prepared.directory, 'package.zip'));
      if (release.version !== expectedVersion || release.sha256 !== prepared.sha256 || bytes.length !== release.size || sha256(bytes) !== release.sha256) throw new Error();
      return prepared.directory;
    } catch {
      this.prepared = null; this.downloadState.phase = 'error'; this.downloadState.percent = 0;
      this.downloadState.error = '已下载文件缺失或校验失败，请重新下载';
      throw new Error(this.downloadState.error);
    }
  }
  async stopDownload() {
    this.downloadController?.abort();
    await this.downloadPromise?.catch(() => {});
  }
  async launch(directory, dataDir, ownerPid = process.pid, desktopPid = 0) {
    const progress = this.progressFactory({ directory, version: this.prepared?.version || this.release?.version || '', ownerPid: process.pid });
    progress.set('verifying', { detail: '更新包已下载。正在准备安装进度窗口。' });
    await progress.startWindow({ scriptRoot: directory });
    let child;
    try {
      child = this.spawnProcess(path.join(directory, 'node.exe'), ['--disable-warning=ExperimentalWarning', path.join(directory, 'src/update-worker.js'),
        this.root, dataDir, String(ownerPid), String(desktopPid), progress.directory, progress.runId], { detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = readState(progress.directory, progress.runId);
        if (state.status === 'failed') throw new Error(state.detail);
        // Ownership is handed to the worker before the desktop is told to exit.
        if (state.ownerPid === child.pid) return child;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('更新进程未能启动，原窗口保持打开');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('更新进程未确认接管，原窗口保持打开；请查看更新进度窗口');
    } catch (error) {
      // No further parent writes once the worker has taken ownership.
      const state = readState(progress.directory, progress.runId);
      if (state.ownerPid === process.pid) progress.fail(error);
      throw error;
    } finally { child?.unref(); }
  }
}
module.exports = { Updater, verifyManifest, compareVersions, download, sha256 };
