'use strict';
// Maintainer-only signing helper. Never package .release-keys or private data.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = __dirname, channel = require('./app/update-channel.json');
const version = require('./app/package.json').version;
const delivery = JSON.parse(fs.readFileSync(path.join(ROOT, 'delivery.json'), 'utf8'));
const folder = path.join(ROOT, 'publish', 'v' + version); fs.mkdirSync(folder, { recursive: true });
const filename = `tcl-ad-tool-${version}-win-x64.zip`;
const bytes = fs.readFileSync(delivery.cleanZip);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
if (sha256 !== delivery.zipSha256) throw new Error('Delivery package changed');
const keyFile = path.join(ROOT, '.release-keys', 'update-signing.pem');
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
if (publicKey !== channel.publicKey) throw new Error('Signing key does not match bundled verification key');
const notes = fs.readFileSync(path.join(ROOT, 'app', '更新说明.md'), 'utf8').split('\n---')[0].trim();
const release = { version, url: `https://github.com/${channel.repository}/releases/download/v${version}/${filename}`,
  sha256, size: bytes.length, notes, publishedAt: new Date().toISOString() };
const payload = Buffer.from(JSON.stringify(release));
const envelope = { payload: payload.toString('base64'), signature: crypto.sign(null, payload, key).toString('base64') };
fs.copyFileSync(delivery.cleanZip, path.join(folder, filename));
fs.writeFileSync(path.join(folder, 'update.json'), JSON.stringify(envelope, null, 2) + '\n');
fs.writeFileSync(path.join(folder, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`);
fs.writeFileSync(path.join(folder, 'release-notes.md'), notes + '\n\n完整解压后使用一键启动.cmd。旧电脑请先暂停退出，备份并保留完整 data 文件夹；更新后保持暂停。\n');
console.log(JSON.stringify({ directory: folder, version, filename, sha256, size: bytes.length, signingKeyIncluded: false }));
