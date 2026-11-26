'use strict';
// Public release verification using the original updater from each published ZIP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Updater, download, sha256, verifyManifest } = require('./app/src/updater');
const expected = require('./verification/package-verification-1.3.9.json');
const version = '1.3.9';
const assetName = `tcl-ad-tool-${version}-win-x64.zip`;
const folder = path.join(__dirname, 'verification', 'online-1.3.9-' + Date.now());
fs.mkdirSync(folder, { recursive: true });

async function githubRelease(suffix) {
  const response = await fetch('https://api.github.com/repos/yuff879-png/tcl-ad-tool/releases/' + suffix, {
    headers: { 'User-Agent': 'TCL-Release-Verification', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, 'GitHub API HTTP ' + response.status);
  return response.json();
}

(async () => {
  const [release, tagged] = await Promise.all([githubRelease('latest'), githubRelease('tags/v' + version)]);
  assert.equal(release.id, tagged.id);
  assert.equal(release.tag_name, 'v' + version);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.deepEqual(release.assets.map(a => a.name).sort(), ['SHA256SUMS.txt', assetName, 'update.json']);
  console.log('Published release is latest: ' + release.tag_name);
  const normalizeNewlines = text => text.replace(/\r\n/g, '\n').trim();
  assert.equal(normalizeNewlines(release.body), normalizeNewlines(fs.readFileSync(path.join(__dirname, 'publish', 'v' + version, 'github-release-body.md'), 'utf8')));

  const olderVersions = [];
  for (const oldVersion of ['1.3.8']) {
    const oldArchive = path.join(__dirname, 'publish', 'v' + oldVersion, `tcl-ad-tool-${oldVersion}-win-x64.zip`);
    const oldManifest = verifyManifest(JSON.parse(fs.readFileSync(path.join(__dirname, 'publish', 'v' + oldVersion, 'update.json'), 'utf8')));
    assert.equal(oldManifest.version, oldVersion);
    assert.equal(fs.statSync(oldArchive).size, oldManifest.size);
    assert.equal(sha256(fs.readFileSync(oldArchive)), oldManifest.sha256);
    const extracted = path.join(folder, oldVersion);
    execFileSync('python', ['-X', 'utf8', '-c',
      'import sys,zipfile\nfrom pathlib import Path\np=Path(sys.argv[2]);p.mkdir(parents=True)\nwith zipfile.ZipFile(sys.argv[1]) as z:\n for name in ["package.json","update-channel.json","src/updater.js","src/update-progress.js"]:\n  f=p/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(z.read("TCL广告投放工具/"+name))',
      oldArchive, extracted], { windowsHide: true });
    const original = require(path.join(extracted, 'src/updater.js'));
    const updater = new original.Updater({ root: extracted });
    const result = await updater.check();
    assert.equal(result.currentVersion, oldVersion);
    assert.equal(result.available, true);
    assert.equal(result.latestVersion, version);
    olderVersions.push({ version: oldVersion, recognizedUpdate: true, signatureVerified: true, baselineSignatureVerified: true, baselineSha256: oldManifest.sha256 });
    console.log(oldVersion + ' detects signed ' + version + ' update');
  }

  const updater = new Updater({ root: path.join(folder, 'current') });
  const current = await updater.check();
  assert.equal(current.currentVersion, version);
  assert.equal(current.available, false);
  assert.equal(current.latestVersion, version);
  const localManifest = verifyManifest(JSON.parse(fs.readFileSync(path.join(__dirname, 'publish', 'v' + version, 'update.json'), 'utf8')));
  assert.deepEqual(updater.release, localManifest);

  const asset = release.assets.find(a => a.name === assetName);
  assert.equal(asset.size, expected.size);
  assert.equal(asset.digest, 'sha256:' + expected.sha256);
  const bytes = await download(asset.browser_download_url, expected.size, fetch, 600000);
  const hash = sha256(bytes);
  assert.equal(bytes.length, expected.size);
  assert.equal(hash, expected.sha256);
  assert.equal(hash, updater.release.sha256);
  const sums = await download(release.assets.find(a => a.name === 'SHA256SUMS.txt').browser_download_url, 1024);
  assert.equal(sums.toString('utf8').replace(/\r\n/g, '\n'), hash + '  ' + assetName + '\n');
  const manifestBytes = await download(release.assets.find(a => a.name === 'update.json').browser_download_url, 65536);
  assert.equal(sha256(manifestBytes), sha256(fs.readFileSync(path.join(__dirname, 'publish', 'v' + version, 'update.json'))));

  const proof = {
    version, checkedAt: new Date().toISOString(), releaseUrl: release.html_url, publishedAt: release.published_at,
    latest: true, draft: false, prerelease: false,
    assets: release.assets.map(({ name, size, digest }) => ({ name, size, digest })),
    olderVersions, currentVersionCheckPassed: true, onlineManifestMatchesSignedCandidate: true,
    publicPackageFullyDownloaded: true, sha256: hash, size: bytes.length,
    personalInstallationChanged: false, realBroadcasts: 0,
  };
  fs.writeFileSync(path.join(__dirname, 'online-update-verification-1.3.9.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
