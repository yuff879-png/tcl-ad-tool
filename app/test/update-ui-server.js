'use strict';
// Isolated update flow: synthetic signed bytes, fake chain, installation is a marker only.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), os = require('node:os');
const { createApp } = require('../src/server');
const { Updater, sha256 } = require('../src/updater');
const { config, FakeChain, address } = require('./fixtures');
const { atomicJson } = require('../src/config');
const version = require('../package.json').version;
const scenario = process.argv[2] || 'newer';
if (!['newer', 'current', 'offline', 'running', 'pending', 'download-error'].includes(scenario)) throw new Error('Unknown UI scenario');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-update-ui-')), dataDir = path.join(root, 'data');
  const settings = config({ apiKey: '', maxPerRun: 0 }); atomicJson(path.join(dataDir, 'config.json'), settings);
  for (const file of ['update-channel.json', 'package.json', 'src/updater.js', 'src/instance.js', 'src/update-worker.js', 'src/startup.js', 'scripts/unpack-update.ps1', 'runtime/node.exe']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'UI fixture: never executed');
  }
  const keys = crypto.generateKeyPairSync('ed25519');
  const nextVersion = version.split('.').map((value, index) => String(Number(value) + (index === 2 ? 1 : 0))).join('.');
  const latest = scenario === 'current' ? version : nextVersion;
  const archive = Buffer.alloc(8 * 1024 * 1024, 'synthetic'); let downloadAttempts = 0;
  const release = { version: latest, url: `https://github.com/example/ui-test/releases/download/v${latest}/tcl-ad-tool-${latest}-win-x64.zip`,
    size: archive.length, sha256: sha256(archive), notes: '界面验收样例：左侧可手动检查和下载；实时进度，下载校验完成后再确认安装。' };
  const payload = Buffer.from(JSON.stringify(release));
  const envelope = { payload: payload.toString('base64'), signature: crypto.sign(null, payload, keys.privateKey).toString('base64') };
  const updater = new Updater({ root, channel: { repository: 'example/ui-test', manifestUrl: 'https://github.com/example/ui-test/releases/latest/download/update.json', publicKey: keys.publicKey },
    fetcher: async (url, { signal }) => {
      if (scenario === 'offline') throw new Error('Offline visual fixture');
      if (url.endsWith('update.json')) { await new Promise(resolve => setTimeout(resolve, 300)); return new Response(JSON.stringify(envelope)); }
      if (scenario === 'download-error' && ++downloadAttempts === 1) return new Response('corrupt fixture');
      let offset = 0;
      return new Response(new ReadableStream({ async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (signal.aborted) { controller.error(signal.reason); return; }
        controller.enqueue(archive.subarray(offset, offset + 262144)); offset += 262144;
        if (offset >= archive.length) controller.close();
      } }));
    } });
  updater.launch = async () => { atomicJson(path.join(root, 'installation-requested.json'), { mockInstallOnly: true }); };
  const chain = new FakeChain(settings); chain.receipt = async () => ({});
  chain.buildAndSign = chain.broadcast = async () => { throw new Error('UI fixture forbids signing and broadcasting'); };
  const app = await createApp({ dataDir, updater, chainFactory: () => chain });
  app.engine.preflightResult = await chain.preflight(); app.engine.preflightResult.token.balance = '8995007220.376321530432496993';
  app.engine.wallet = app.engine.preflightResult.resources;
  if (scenario === 'running') {
    app.engine.state = 'running'; app.engine.running = true; app.engine.mode = 'simulate';
    const stop = app.engine.stop.bind(app.engine);
    app.engine.stop = () => { stop(); setTimeout(() => { app.engine.state = 'stopped'; }, 100); };
  }
  if (scenario === 'pending') {
    app.store.offer('live', { to: address(3), txid: 'fixture-source', asset: 'TRX', amount: '150' }, settings, 11);
    app.store.update(app.store.next('live').id, 'uncertain', { txid: '0'.repeat(64) });
  }
  clearInterval(app.engine.confirmationTimer); clearInterval(app.engine.statisticsTimer);
  atomicJson(path.resolve(__dirname, '../test-output', `update-ui-${scenario}.json`), { url: app.url, port: app.port, dataDir, root });
  console.log(JSON.stringify({ scenario, url: app.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close());
})();
