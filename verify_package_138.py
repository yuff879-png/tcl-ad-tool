"""Read-only verification of the signed clean 1.3.8 candidate; no signing keys."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
VERSION = '1.3.8'
delivery = json.loads((ROOT / 'delivery.json').read_text('utf-8'))
archive = Path(delivery['cleanZip']).resolve()
assert archive.parent == ROOT / 'delivery-candidate' / VERSION, 'Unexpected candidate path'
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
assert digest == delivery['zipSha256'] and archive.stat().st_size == delivery['zipSize']
assert archive.stat().st_size < 200 * 1024 * 1024, 'Legacy update limit exceeded'
published = ROOT / 'publish' / ('v' + VERSION) / f'tcl-ad-tool-{VERSION}-win-x64.zip'
assert hashlib.sha256(published.read_bytes()).hexdigest() == digest
old_archive = ROOT / 'publish/v1.3.7/tcl-ad-tool-1.3.7-win-x64.zip'
assert hashlib.sha256(old_archive.read_bytes()).hexdigest() == '73687d20736d495a0019d95d90530a2480994abb5d97b16b763cb18043b1abc1', 'Published 1.3.7 baseline changed'
with zipfile.ZipFile(old_archive) as old:
    previous_lock = json.loads(old.read('TCL广告投放工具/package-lock.json'))
    previous_channel = json.loads(old.read('TCL广告投放工具/update-channel.json'))
    previous_manifest = json.loads(old.read('TCL广告投放工具/release-manifest.json'))

with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None
    prefix = 'TCL广告投放工具/'
    with zipfile.ZipFile(old_archive) as previous:
        added_files = sorted(set(package.namelist()) - set(previous.namelist()))
        removed_files = sorted(set(previous.namelist()) - set(package.namelist()))
        changed_files = sorted(name[len(prefix):] for name in set(package.namelist()) & set(previous.namelist())
                               if package.read(name) != previous.read(name))
        unchanged_updater_files = ['src/updater.js', 'src/update-worker.js', 'src/startup.js', 'src/instance.js',
                                  'src/desktop-launch.js', 'src/desktop/main.js', 'src/update-progress.js',
                                  'scripts/update-progress.ps1', 'scripts/upgrade-existing.js', 'scripts/unpack-update.ps1',
                                  'launcher/Launcher.cs', 'launcher/app.ico']
        for name in unchanged_updater_files:
            assert package.read(prefix + name) == previous.read(prefix + name), f'Updater or launcher changed: {name}'
    assert package.read(prefix + 'TCL.exe') == package.read(prefix + 'TCL广告投放工具.exe'), 'Launcher aliases differ'
    audit_path = sorted((ROOT / 'verification').glob('release-audit-1.3.8-*/summary.json'))[-1]
    scan_path = sorted((ROOT / 'verification').glob('source-secrets-1.3.8-*/summary.json'))[-1]
    audit = json.loads(audit_path.read_text('utf-8'))
    scan = json.loads(scan_path.read_text('utf-8'))
    scanned_hashes = json.loads((scan_path.parent / 'source-manifest.json').read_text('utf-8'))
    assert audit['version'] == VERSION and audit['status'] == scan['status'] == 'passed'
    assert Path(scan['audit']).resolve() == audit_path.resolve(), 'Scan and audit snapshots differ'
    assert scan['source_unchanged_during_scan']
    assert audit.get('preTestManifestCaptured') is True, 'Record final-test evidence limits explicitly'
    assert audit.get('finalSourceEvidence'), 'Final source/test evidence must be explained'
    for check in audit['checks'].values():
        assert hashlib.sha256(Path(check['log']).read_bytes()).hexdigest() == check['log_sha256'], 'Audit log hash mismatch'
    assert scan['audit_hashes_match'] and scan['finding_count'] == 0
    test_counts = audit['checks']['full-tests']['counts']
    assert test_counts['tests'] == test_counts['pass'] and test_counts['tests'] > 353
    assert all(test_counts[field] == 0 for field in ['fail', 'cancelled', 'skipped', 'todo'])
    assert all(check['exit_code'] == 0 for check in audit['checks'].values())
    for name, expected in audit['source_hashes'].items():
        assert scanned_hashes[name] == expected, f'Audit/scan mismatch: {name}'
    for name, expected in scanned_hashes.items():
        assert hashlib.sha256(package.read(prefix + name)).hexdigest() == expected, f'Package/audit mismatch: {name}'
    names = package.namelist()
    assert len(names) == len(set(names)) and len(names) < 30000
    assert sum(item.file_size for item in package.infolist()) < 600 * 1024 * 1024
    prefix = 'TCL广告投放工具/'
    forbidden = {'config.json', '.env', 'records.sqlite', 'pool-vault.json', 'instance.json', 'update-signing.pem'}
    private_pem = re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16}')
    for name in names:
        parts = PurePosixPath(name).parts
        assert name.startswith(prefix) and '..' not in parts and '\\' not in name
        assert PurePosixPath(name).name not in forbidden
        assert not name.startswith(tuple(prefix + directory + '/' for directory in ['data', '.release-keys', 'private', 'verification', 'output']))
        assert not name.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm'))
        if name.endswith(('.pem', '.key', '.json', '.js', '.txt', '.md', '.env')):
            assert not private_pem.search(package.read(name)), 'Serialized private key detected in package'
    manifest = json.loads(package.read(prefix + 'release-manifest.json'))
    assert manifest['version'] == VERSION and manifest['personalDataIncluded'] is False
    assert manifest['packageLockSha256'] == hashlib.sha256(package.read(prefix + 'package-lock.json')).hexdigest()
    expected_sources = {str(file.relative_to(ROOT / 'app')).replace('\\', '/') for directory in ['src', 'public', 'scripts', 'launcher'] for file in (ROOT / 'app' / directory).rglob('*') if file.is_file()}
    assert set(manifest['sourceHashes']) == expected_sources
    for name, expected in manifest['sourceHashes'].items():
        assert hashlib.sha256(package.read(prefix + name)).hexdigest() == expected
        assert hashlib.sha256((ROOT / 'app' / name).read_bytes()).hexdigest() == expected
    for file in (ROOT / 'app/test').glob('*.js'):
        assert package.read(prefix + 'test/' + file.name) == file.read_bytes()
    for name in ['package.json', 'package-lock.json', 'update-channel.json', '使用说明.md', '更新说明.md']:
        assert package.read(prefix + name) == (ROOT / 'app' / name).read_bytes()
    assert json.loads(package.read(prefix + 'package.json'))['version'] == VERSION
    lock = json.loads(package.read(prefix + 'package-lock.json'))
    assert lock['version'] == lock['packages']['']['version'] == VERSION
    assert {key: value for key, value in lock['packages'].items() if key} == {key: value for key, value in previous_lock['packages'].items() if key}
    assert json.loads(package.read(prefix + 'src/desktop/package.json'))['version'] == VERSION
    assert json.loads(package.read(prefix + 'update-channel.json')) == previous_channel
    assert hashlib.sha256(package.read(prefix + 'runtime/node.exe')).hexdigest() == manifest['nodeSha256']
    electron = json.loads(package.read(prefix + 'runtime/electron-runtime.json'))
    assert electron['version'] == manifest['electronVersion']
    for name, expected in electron['files'].items():
        assert hashlib.sha256(package.read(prefix + 'runtime/electron/' + name)).hexdigest() == expected

script = """const fs=require('node:fs'),assert=require('node:assert/strict');
const {verifyManifest}=require('./app/src/updater');
const envelope=JSON.parse(fs.readFileSync('./publish/v1.3.8/update.json','utf8'));
const release=verifyManifest(envelope);assert.equal(release.version,'1.3.8');
const baseline=verifyManifest(JSON.parse(fs.readFileSync('./publish/v1.3.7/update.json','utf8')));
assert.equal(baseline.version,'1.3.7');
const bad={...envelope,signature:Buffer.alloc(64).toString('base64')};
assert.throws(()=>verifyManifest(bad),/签名/);
console.log(JSON.stringify({version:release.version,sha256:release.sha256,size:release.size,signatureValid:true,tamperedSignatureRejected:true,
baseline:{version:baseline.version,sha256:baseline.sha256,size:baseline.size,signatureValid:true}}));"""
signature = json.loads(subprocess.run([str(ROOT / 'app/runtime/node.exe'), '-e', script], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', check=True).stdout)
assert signature['sha256'] == digest and signature['size'] == archive.stat().st_size
assert signature['baseline']['sha256'] == hashlib.sha256(old_archive.read_bytes()).hexdigest()
assert signature['baseline']['size'] == old_archive.stat().st_size
result = {'version': VERSION, 'sha256': digest, 'size': archive.stat().st_size, 'files': len(names),
          'crcValid': True, 'sourceHashesMatch': True, 'testsAndDocsMatch': True,
          'dependenciesUnchangedFrom': '1.3.7', 'officialRuntimeHashesMatch': True,
          'baselineArchive': str(old_archive), 'addedFiles': added_files, 'removedFiles': removed_files,
          'actualChangedFiles': changed_files, 'updaterUnchangedFrom': '1.3.7',
          'unchangedUpdaterAndLauncherFiles': unchanged_updater_files, 'tests': test_counts,
          'audit': str(audit_path), 'scan': str(scan_path),
          'testStartManifestCaptured': audit.get('preTestManifestCaptured'),
          'testSourceEvidence': audit.get('finalSourceEvidence'),
          'auditedSourceFilesMatch': len(audit['source_hashes']), 'scannedSourceFilesMatch': len(scanned_hashes),
          'legacyUpdaterSizeLimitsPass': True, 'publicVerificationKeyUnchanged': True,
          'personalDataIncluded': False, 'serializedPrivateKeyIncluded': False,
          'signature': signature, 'archive': str(archive), 'publishedNetwork': False,
          'startupSourceHashes': {name: manifest['sourceHashes'][name] for name in [
              'src/updater.js', 'src/update-worker.js', 'src/startup.js', 'src/instance.js',
              'src/desktop-launch.js', 'src/desktop/main.js', 'src/server.js']},
          'progressSourceHashes': {name: manifest['sourceHashes'][name] for name in [
              'src/update-progress.js', 'scripts/update-progress.ps1',
              'scripts/upgrade-existing.js', 'scripts/unpack-update.ps1']}}
output = ROOT / 'verification/package-verification-1.3.8.json'
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(result, ensure_ascii=False, indent=2), 'utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
