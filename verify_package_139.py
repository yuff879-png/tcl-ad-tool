"""Verify the clean local 1.3.9 candidate without signing or publishing it."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
APP = ROOT / 'app'
VERSION = '1.3.9'
sha = lambda value: hashlib.sha256(value).hexdigest()
delivery = json.loads((ROOT / 'delivery.json').read_text('utf-8'))
archive = Path(delivery['cleanZip']).resolve()
assert archive.parent == ROOT / 'delivery-candidate' / VERSION
assert sha(archive.read_bytes()) == delivery['zipSha256']
assert archive.stat().st_size == delivery['zipSize'] < 200 * 1024 * 1024
prefix = 'TCL广告投放工具/'
evidence = ROOT / 'verification/manual-package-1.3.9'
evidence.mkdir(exist_ok=True)
source_hashes = {}
with zipfile.ZipFile(archive) as package, zipfile.ZipFile(ROOT / 'publish/v1.3.8/tcl-ad-tool-1.3.8-win-x64.zip') as previous:
    assert package.testzip() is None
    names = package.namelist()
    assert len(names) == len(set(names)) and len(names) < 30000
    assert sum(item.file_size for item in package.infolist()) < 600 * 1024 * 1024
    forbidden = {'config.json', '.env', 'records.sqlite', 'pool-vault.json', 'instance.json', 'update-signing.pem'}
    for name in names:
        parts = PurePosixPath(name).parts
        assert name.startswith(prefix) and '..' not in parts and '\\' not in name
        assert PurePosixPath(name).name not in forbidden and not name.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm'))
        assert not name.startswith(tuple(prefix + folder + '/' for folder in ['data', '.release-keys', 'verification', 'output', 'test-output']))
    manifest = json.loads(package.read(prefix + 'release-manifest.json'))
    assert manifest['version'] == VERSION and manifest['personalDataIncluded'] is False
    assert manifest['packageLockSha256'] == sha(package.read(prefix + 'package-lock.json'))
    assert json.loads(package.read(prefix + 'package.json'))['version'] == VERSION
    assert json.loads(package.read(prefix + 'src/desktop/package.json'))['version'] == VERSION
    lock = json.loads(package.read(prefix + 'package-lock.json'))
    old_lock = json.loads(previous.read(prefix + 'package-lock.json'))
    assert lock['version'] == lock['packages']['']['version'] == VERSION
    assert {k: v for k, v in lock['packages'].items() if k} == {k: v for k, v in old_lock['packages'].items() if k}
    assert package.read(prefix + 'update-channel.json') == previous.read(prefix + 'update-channel.json')
    for name in ['src/updater.js', 'src/update-worker.js', 'src/startup.js', 'src/desktop/main.js', 'launcher/Launcher.cs', 'TCL.exe']:
        assert package.read(prefix + name) == previous.read(prefix + name), name
    assert package.read(prefix + 'TCL.exe') == package.read(prefix + 'TCL广告投放工具.exe')
    source_files = [file for folder in ['src', 'public', 'scripts', 'launcher', 'test'] for file in (APP / folder).rglob('*') if file.is_file()]
    source_files += [APP / name for name in ['package.json', 'package-lock.json', 'update-channel.json', '使用说明.md', '更新说明.md']]
    private_pem = re.compile(rb'-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16}')
    for file in source_files:
        relative = file.relative_to(APP).as_posix()
        data = package.read(prefix + relative)
        assert data == file.read_bytes(), relative
        assert not private_pem.search(data), relative
        source_hashes[relative] = sha(data)
        destination = evidence / 'source' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    for name, digest in manifest['sourceHashes'].items():
        assert sha(package.read(prefix + name)) == source_hashes[name] == digest
    assert sha(package.read(prefix + 'runtime/node.exe')) == manifest['nodeSha256']
    electron = json.loads(package.read(prefix + 'runtime/electron-runtime.json'))
    assert electron['version'] == manifest['electronVersion']
    for name, digest in electron['files'].items():
        assert sha(package.read(prefix + 'runtime/electron/' + name)) == digest
    added = sorted(name[len(prefix):] for name in set(names) - set(previous.namelist()))
    changed = sorted(name[len(prefix):] for name in set(names) & set(previous.namelist()) if package.getinfo(name).CRC != previous.getinfo(name).CRC)

report = evidence / 'gitleaks-redacted.json'
result = subprocess.run([r'C:\Users\AX\.codex\tools\gitleaks-8.30.1\gitleaks.exe', 'dir', str(evidence / 'source'),
    '--redact=100', '--no-banner', '--no-color', '--ignore-gitleaks-allow', '--gitleaks-ignore-path', str(evidence / 'source'),
    '--report-format', 'json', '--report-path', str(report), '--timeout', '180'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=200)
(evidence / 'gitleaks-redacted.log').write_text(result.stdout + result.stderr, 'utf-8')
findings = json.loads(report.read_text('utf-8'))
assert result.returncode == 0 and not findings, 'Review the redacted scan report'
assert not list((Path(delivery['personalFolder']) / 'data').iterdir()), 'Candidate data must be empty'
output = {'version': VERSION, 'status': 'passed', 'archive': str(archive), 'size': delivery['zipSize'], 'sha256': delivery['zipSha256'],
    'files': len(names), 'crcValid': True, 'officialRuntimeHashesMatch': True, 'sourceFilesMatch': len(source_hashes),
    'dependenciesUnchangedFrom': '1.3.8', 'updateChannelUnchanged': True, 'updaterAndLauncherUnchanged': True,
    'personalDataIncluded': False, 'sourceCredentialFindings': len(findings), 'legacyUpdateSizeLimitsPassed': True,
    'addedFiles': added, 'changedFiles': changed, 'publishedToGitHub': False, 'signedForRemoteUpdate': False,
    'sourceHashes': source_hashes, 'scanReport': str(report), 'testsLogSha256': sha((ROOT / 'verification/manual-batches-all-tests.txt').read_bytes())}
(ROOT / 'verification/package-verification-1.3.9.json').write_text(json.dumps(output, ensure_ascii=False, indent=2), 'utf-8')
print(json.dumps({key: value for key, value in output.items() if key != 'sourceHashes'}, ensure_ascii=False, indent=2))
