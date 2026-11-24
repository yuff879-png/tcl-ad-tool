"""Install the pinned official Electron runtime without npm install hooks."""
from pathlib import Path
import hashlib
import json
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
VERSION = '45.3.3'
ARCHIVE = f'electron-v{VERSION}-win32-x64.zip'
SHA256 = '49dd2d3875944f08de03d34595cd30093c588b9edcabb41a0ac481028a3a5a8a'
URL = f'https://github.com/electron/electron/releases/download/v{VERSION}/{ARCHIVE}'

def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def main():
    cache = ROOT / '.downloads'
    cache.mkdir(exist_ok=True)
    archive = cache / ARCHIVE
    if not archive.exists() or sha(archive) != SHA256:
        request = urllib.request.Request(URL, headers={'User-Agent': 'TCL-Desktop-Build'})
        with urllib.request.urlopen(request, timeout=120) as response, archive.open('wb') as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
    if sha(archive) != SHA256:
        raise SystemExit('Official Electron archive checksum mismatch')
    target = ROOT / 'app/runtime/electron'
    target.mkdir(parents=True, exist_ok=True)
    files = {}
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            relative = Path(entry.filename)
            if relative.is_absolute() or '..' in relative.parts or ':' in entry.filename:
                raise SystemExit('Invalid archive path')
            if entry.is_dir():
                continue
            if relative.parts[0] == 'locales' and relative.name not in ['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']:
                continue
            file = target / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(bundle.read(entry))
            files[relative.as_posix()] = sha(file)
    manifest = {'version': VERSION, 'archive': ARCHIVE, 'url': URL, 'sha256': SHA256, 'files': files}
    (ROOT / 'app/runtime/electron-runtime.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'version': VERSION, 'files': len(files), 'archiveVerified': True,
                      'unpackedBytes': sum((target / f).stat().st_size for f in files)}))

if __name__ == '__main__':
    main()
