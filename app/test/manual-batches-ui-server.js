'use strict';
// Isolated UI fixture. Every chain method uses in-memory synthetic data; no RPC.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../src/server');
const { atomicJson } = require('../src/config');
const { config, FakeChain, address } = require('./fixtures');
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-manual-ui-'));
  const c = config({ maxPerRun: 0, blacklist: [address(6)], sendIntervalSeconds: 2 });
  atomicJson(path.join(dataDir, 'config.json'), c);
  const chain = new FakeChain(c), version = require('../package.json').version;
  const updater = { snapshot: () => ({ currentVersion: version, latestVersion: version, available: false }), stopAutomaticChecks() {} };
  const app = await createApp({ dataDir, automaticUpdates: false, automaticRuntime: false, chainFactory: () => chain, updater });
  app.engine.preflightResult = await chain.preflight(); app.engine.wallet = app.engine.preflightResult.resources;
  const instance = { url: app.url, port: app.port, dataDir,
    sample: [address(4), address(5), address(4), address(6), 'invalid-address', address(10)].join('\n') };
  atomicJson(path.join(__dirname, '../test-output/manual-batches-ui-instance.json'), instance);
  console.log(JSON.stringify(instance));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); });
})().catch(error => { console.error(error); process.exitCode = 1; });
