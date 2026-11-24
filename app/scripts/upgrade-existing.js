'use strict';
// Recovery entry point for versions whose own update UI blocks on pending rows.
// Use the same signed release verification, backup and rollback as online updates.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline/promises');
const { Updater } = require('../src/updater');
const { checkIdle } = require('../src/instance');
const { install } = require('../src/update-worker');
const { createProgress } = require('../src/update-progress');
async function upgradeExisting({ target, bundleRoot = path.resolve(__dirname, '..'), fetcher = fetch, reopen = true, progress = console.log, progressReporter }) {
  const root = fs.realpathSync(path.resolve(String(target).trim().replace(/^"|"$/g, '')));
  if (root.toLowerCase() === fs.realpathSync(bundleRoot).toLowerCase()) throw new Error('请选择原来的旧版文件夹，不是本次新解压的文件夹');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'tcl-ad-studio') throw new Error('这个文件夹不是 TCL 广告投放工具');
  const dataDir = path.join(root, 'data');
  if (!fs.existsSync(path.join(dataDir, 'config.json'))) throw new Error('旧版 data/config.json 不存在，请核对文件夹');
  try { await checkIdle(dataDir); }
  catch { throw new Error('旧版程序还在运行、启动或退出。请在旧版暂停投放并点击“退出程序”，稍后重试'); }
  const updater = new Updater({ root: bundleRoot, version: pkg.version, fetcher });
  if (!progressReporter) {
    progressReporter = createProgress({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-upgrade-progress-')) });
    await progressReporter.startWindow({ scriptRoot: bundleRoot });
  }
  let displayError;
  const display = (phase, details) => {
    try { progressReporter.set(phase, details); }
    catch (error) { if (!displayError) progress('更新进度显示异常，升级仍在继续：' + error.message); displayError = error; }
  };
  try {
    display('checking', { detail: '检查 GitHub 官方更新清单。原文件夹和 data 会保留。' });
    progress('正在检查 GitHub 最新版本…');
    const state = await updater.check();
    if (!state.available) throw new Error('所选旧版已是最新版本，无需覆盖升级');
    progress(`准备从 ${pkg.version} 升级到 ${state.latestVersion}；原 data、钱包和记录会保留。正在下载并验证签名…`);
    display('downloading', { version: state.latestVersion, detail: '正在下载签名更新包，原程序尚未修改。' });
    const timer = setInterval(() => {
      const transfer = updater.snapshot().download;
      if (transfer.phase === 'downloading') display('downloading', { current: transfer.received, total: transfer.total, unit: 'bytes', detail: '正在下载签名更新包，原程序尚未修改。' });
      else if (transfer.phase === 'verifying' || transfer.phase === 'ready') display('verifying', { detail: '下载完成，正在校验签名并准备安装文件。' });
    }, 250);
    let directory;
    try { directory = await updater.prepare(state.latestVersion); }
    finally { clearInterval(timer); }
    progress('签名和文件校验通过，正在备份并安装…');
    const result = await install({ root, dataDir, directory, reopen, progress: progressReporter });
    progress(`升级完成：${result.version}\n备份位置：${result.backupDir}\n以后仍使用原文件夹内的“一键启动.cmd”，启动后保持暂停。`);
    if (result.reopened === false) progress(result.message);
    return result;
  } catch (error) { try { progressReporter.fail(error); } catch (displayFailure) { progress('更新进度显示异常：' + displayFailure.message); } throw error; }
}
if (require.main === module) {
  (async () => {
    console.log('TCL 旧版原地升级\n请先在旧版暂停投放并点击“退出程序”。\n此工具保留旧文件夹中的 data，无需手动搬记录。');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let target;
    try { target = await rl.question('粘贴旧版工具文件夹的完整路径，然后回车：'); }
    finally { rl.close(); }
    if (!target.trim()) throw new Error('未选择旧版文件夹');
    await upgradeExisting({ target });
  })().catch(error => { console.error('升级未完成：' + error.message + '\n请保留旧文件夹和 data，解决上述问题后重试。'); process.exitCode = 1; });
}
module.exports = { upgradeExisting };
