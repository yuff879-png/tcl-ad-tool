"""Reproducible allow-list packaging. Never include personal data in the shared ZIP."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import zipfile
from datetime import datetime, timezone
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
APP = ROOT / 'app'
VERSION = json.loads((APP/'package.json').read_text(encoding='utf-8'))['version']
PORTABLE_DIRS = ['src', 'public', 'scripts', 'launcher', 'test', 'node_modules', 'runtime']
PORTABLE_FILES = ['package.json', 'package-lock.json', 'update-channel.json', '使用说明.md', '更新说明.md', 'Start.cmd', 'Repair_Runtime.cmd', 'Check_Runtime.cmd']

def sha(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--update', action='store_true', help='Update application files, preserving all existing data')
    parser.add_argument('--clean', action='store_true', help='Do not seed any personal data into the destination')
    parser.add_argument('--launcher-from', type=Path, help='Reuse an existing launcher only when its source and icon match exactly')
    args = parser.parse_args()
    destination = args.destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and not args.update:
        raise SystemExit(f'Refusing to overwrite existing destination: {destination}')
    runtime = APP / 'runtime'
    expected = next(line.split()[0] for line in (runtime/'SHASUMS256.txt').read_text().splitlines() if line.endswith('  win-x64/node.exe'))
    if sha(runtime/'node.exe') != expected:
        raise SystemExit('Node runtime does not match official checksum')
    desktop = json.loads((runtime/'electron-runtime.json').read_text(encoding='utf-8'))
    pin = json.loads((APP/'src/desktop/runtime.json').read_text(encoding='utf-8'))
    if any(desktop[k] != pin[k] for k in ['version', 'archive', 'url', 'sha256']):
        raise SystemExit('Electron runtime pin does not match verified archive')
    for name, digest in desktop['files'].items():
        if sha(runtime/'electron'/name) != digest:
            raise SystemExit(f'Electron runtime file changed: {name}')
    # Approved T mark: the same 96-unit geometry as public/icon.svg. Render
    # oversize before generating the ICO frames so small Windows icons stay crisp.
    scale = 12
    im = Image.new('RGBA', (96 * scale, 96 * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle((0, 0, 96 * scale - 1, 96 * scale - 1), radius=25 * scale, fill='#6652E8')
    draw.polygon([(x * scale, y * scale) for x, y in [(23, 27), (71, 27), (62, 40), (52, 40), (52, 71), (38, 71), (38, 40), (23, 40)]], fill='white')
    draw.rounded_rectangle((63 * scale, 57 * scale, 75 * scale, 69 * scale), radius=3 * scale, fill='#9DF0D1')
    im = im.resize((256, 256), Image.Resampling.LANCZOS)
    icon = APP/'launcher'/'app.ico'
    im.save(icon, sizes=[(n, n) for n in [16, 20, 24, 32, 40, 48, 64, 128, 256]])
    compiler = Path(r'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe')
    if args.launcher_from:
        previous = args.launcher_from.resolve()
        for name in ['launcher/Launcher.cs', 'launcher/app.ico']:
            if sha(previous/name) != sha(APP/name):
                raise SystemExit('Existing launcher source or icon differs; cannot reuse it')
        shutil.copy2(previous/'TCL.exe', APP/'TCL.exe')
    else:
        subprocess.run([str(compiler), '/nologo', '/target:winexe', '/platform:anycpu', '/reference:System.Windows.Forms.dll',
                        '/reference:System.Drawing.dll', f'/win32icon:{icon}', f'/out:{APP / "TCL.exe"}', str(APP/'launcher'/'Launcher.cs')], check=True)
    stage = ROOT/'release'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')/'TCL广告投放工具'
    stage.mkdir(parents=True)
    for name in PORTABLE_DIRS:
        shutil.copytree(APP/name, stage/name)
    for name in PORTABLE_FILES + ['TCL.exe']:
        shutil.copy2(APP/name, stage/name)
    shutil.copy2(APP/'TCL.exe', stage/'TCL广告投放工具.exe')
    # ASCII command body supports cmd.exe even when the surrounding path is Chinese.
    for source, alias in [('Start.cmd', '一键启动.cmd'), ('Check_Runtime.cmd', '检查运行环境.cmd'), ('Repair_Runtime.cmd', '修复运行环境.cmd')]:
        shutil.copy2(stage/source, stage/alias)
    manifest = {'name': 'TCL 广告投放工作台', 'version': VERSION, 'platform': 'Windows 10/11 x64',
                'nodeVersion': '24.15.0', 'nodeSha256': expected,
                'desktop': 'Electron', 'electronVersion': desktop['version'], 'electronArchiveSha256': desktop['sha256'],
                'createdAt': datetime.now(timezone.utc).isoformat(), 'personalDataIncluded': False,
                'packageLockSha256': sha(stage/'package-lock.json'),
                'sourceHashes': {str(f.relative_to(stage)).replace('\\','/'):sha(f) for group in ['src','public','scripts','launcher'] for f in (stage/group).rglob('*') if f.is_file()}}
    (stage/'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    for item in stage.rglob('*'):
        if item.name in ['config.json', '.env', 'records.sqlite', 'instance.json', 'pool-vault.json'] or item.suffix == '.sqlite':
            raise SystemExit(f'Unexpected private artifact in clean package: {item}')
    contents = [f for f in stage.rglob('*') if f.is_file()]
    if len(contents) > 30000 or sum(f.stat().st_size for f in contents) > 600 * 1024 * 1024:
        raise SystemExit('Package exceeds legacy updater extraction limits')
    zip_path = destination.parent/f'TCL广告投放工具_便携版_{VERSION}.zip'
    if zip_path.exists():
        if not args.update: raise SystemExit(f'Refusing to overwrite existing ZIP: {zip_path}')
        shutil.copy2(zip_path, stage.parent/'previous-portable.zip')
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(stage.rglob('*')):
            if file.is_file(): archive.write(file, file.relative_to(stage.parent))
    if zip_path.stat().st_size > 200 * 1024 * 1024:
        raise SystemExit('Package exceeds legacy updater download limit')
    shutil.copytree(stage, destination, dirs_exist_ok=args.update)
    shutil.copy2(ROOT/'设计与修改说明.md', destination/'设计与修改说明.md')
    report = ROOT/f'验证报告_{VERSION}.md'
    if not report.exists(): report = ROOT/'验证报告.md'
    if report.exists(): shutil.copy2(report, destination/report.name)
    data = destination/'data'
    data.mkdir(exist_ok=True)
    for name in ['config.json', 'records.sqlite', 'migration-report.json']:
        if not args.clean and (APP/'data'/name).exists() and not (data/name).exists(): shutil.copy2(APP/'data'/name, data/name)
    result = {'personalFolder': str(destination), 'cleanZip': str(zip_path), 'zipSize': zip_path.stat().st_size,
              'zipSha256': sha(zip_path), 'stage': str(stage)}
    (ROOT/'delivery.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    (zip_path.with_suffix('.sha256.txt')).write_text(f'{result["zipSha256"]}  {zip_path.name}\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
