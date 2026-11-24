'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 或以上版本才支持内置 SQLite');
require('tronweb'); require('dotenv');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE check_environment(value TEXT)'); db.close();
const pin = require('../src/desktop/runtime.json');
const desktop = path.join(root, 'runtime/electron');
for (const file of ['electron.exe', 'resources.pak', 'icudtl.dat', 'v8_context_snapshot.bin', 'locales/zh-CN.pak', 'locales/en-US.pak', 'resources/default_app.asar']) {
  if (!fs.existsSync(path.join(desktop, file))) throw new Error('Electron 桌面环境不完整，请运行“修复运行环境.cmd”：' + file);
}
if (fs.readFileSync(path.join(desktop, 'version'), 'utf8').trim() !== pin.version) throw new Error('Electron 版本不匹配，请修复运行环境');
if (!process.argv.includes('--quick')) {
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else if (file.endsWith('.js')) {
        const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
        if (checked.status !== 0) throw new Error(checked.stderr || '语法检查失败');
      }
    }
  }
  for (const directory of ['src', 'public', 'scripts', 'test']) if (fs.existsSync(path.join(root, directory))) visit(path.join(root, directory));
}
console.log('OK: Node.js ' + process.version + ', Electron ' + pin.version + ', TronWeb, dotenv, SQLite, JavaScript syntax');
