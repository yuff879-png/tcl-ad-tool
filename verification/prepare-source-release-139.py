"""Synchronize only verified public candidate sources into the release checkout."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'source-release'
proof = json.loads((ROOT / 'verification/package-verification-1.3.9.json').read_text('utf-8'))
assert Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=TARGET, text=True).strip()).resolve() == TARGET.resolve()
assert proof['status'] == 'passed' and proof['candidateTests']['pass'] == 392
with zipfile.ZipFile(proof['archive']) as archive:
    names = list(proof['sourceHashes']) + ['Start.cmd', 'Repair_Runtime.cmd', 'Check_Runtime.cmd']
    for name in names:
        data = archive.read('TCL广告投放工具/' + name)
        if name in proof['sourceHashes']:
            assert hashlib.sha256(data).hexdigest() == proof['sourceHashes'][name]
        target = TARGET / 'app' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
for name in ['验证报告_1.3.9.md', 'verify_package_139.py', 'verify_online_1_3_9.js',
             'verification/verify-manual-upgrade-139.js', 'verification/verify-manual-update-139.js',
             'verification/prepare-source-release-139.py']:
    shutil.copy2(ROOT / name, TARGET / name)
readme = TARGET / 'README.md'
text = readme.read_text('utf-8')
text = text.replace('## 1.3.8\n', '''## 1.3.9

新增「批量投放」页面：粘贴地址或导入 TXT / 单列 CSV，预览后确认。手动名单优先，扫描照常运行并继续入队，批次处理后接续普通队列。沿用原发送间隔，不增加发送并发；支持进度、去重、查看记录及取消剩余地址。TRC20、TRC10、平台能量及原资源保护继续生效。

基于 v1.3.8 更新，最终便携包通过 392 项测试；旧版原更新器与数据库迁移使用隔离数据验收。

## 1.3.8
''')
readme.write_text(text, 'utf-8')
architecture = TARGET / '设计与修改说明.md'
text = architecture.read_text('utf-8').replace('- app/src/engine.js', '- app/src/manual-batches.js 负责名单校验、短效预览确认、持久批次、防重复及取消；复用原发送任务，扫描继续入队。\n- app/src/engine.js', 1)
architecture.write_text(text, 'utf-8')
print(json.dumps({'version':'1.3.9','publicAppFiles':len(names),'sourceMatchesVerifiedPackage':True,'personalDataIncluded':False}))
