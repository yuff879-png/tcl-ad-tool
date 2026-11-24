'use strict';
const path = require('node:path');
const { startApplication } = require('../src/startup');
const { waitForLaunch } = require('../src/instance');
async function main() {
  const root = path.resolve(__dirname, '..');
  await waitForLaunch(process.env.TCL_DATA_DIR || path.join(root, 'data'));
  try { require('./check'); }
  catch (error) { throw new Error('运行环境检查未通过，请运行“修复运行环境.cmd”：' + error.message); }
  if (!process.exitCode) await startApplication(root);
}
main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
