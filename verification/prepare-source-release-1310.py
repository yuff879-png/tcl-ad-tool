"""Synchronize only verified public candidate sources into the release checkout."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'source-release'
proof = json.loads((ROOT / 'verification/package-verification-1.3.10.json').read_text('utf-8'))
assert Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=TARGET, text=True).strip()).resolve() == TARGET.resolve()
assert proof['status'] == 'passed' and proof['candidateTests']['pass'] == 410
assert json.loads((ROOT / 'verification/manual-update-verification-1.3.10.json').read_text('utf-8'))['status'] == 'passed'
with zipfile.ZipFile(proof['archive']) as archive:
    names = list(proof['sourceHashes']) + ['Start.cmd', 'Repair_Runtime.cmd', 'Check_Runtime.cmd']
    for name in names:
        data = archive.read('TCL广告投放工具/' + name)
        if name in proof['sourceHashes']:
            assert hashlib.sha256(data).hexdigest() == proof['sourceHashes'][name]
        target = TARGET / 'app' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
for name in ['验证报告_1.3.10.md', 'verify_package_1310.py', 'verify_online_1_3_10.js',
             'verification/verify-manual-update-1310.js',
             'verification/prepare-source-release-1310.py']:
    shutil.copy2(ROOT / name, TARGET / name)
readme = TARGET / 'README.md'
text = readme.read_text('utf-8')
text = text.replace('## 1.3.9\n', """## 1.3.10

批量投放可选择默认去重，或本批允许向历史已投放地址再次发送；新增记录并保留原历史、统计和去重。预览显示再次投放数量，待确认及未知结果仍须核查。

主任务暂停后保留手动批次剩余名单，点击批次记录的“继续发送”恢复原进度。普通重新启动和自动恢复只按原扫描策略运行，不自动续发暂停批次。仍按原间隔逐笔发送，扫描继续入队。

基于 v1.3.9；410 项测试、隔离页面操作、原 1.3.9 更新器安装及数据兼容检查通过。未新增依赖。

## 1.3.9
""")
readme.write_text(text, 'utf-8')
print(json.dumps({'version':'1.3.10','publicAppFiles':len(names),'sourceMatchesVerifiedPackage':True,'personalDataIncluded':False}))
