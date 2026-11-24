"""Extract only an existing public release into a new isolated test directory."""
from pathlib import Path
import sys
import zipfile

archive, destination = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=False)
with zipfile.ZipFile(archive) as package:
    for item in package.infolist():
        parts = Path(item.filename).parts
        assert parts[0] == 'TCL广告投放工具' and len(parts) > 1
        relative = Path(*parts[1:])
        target = (destination / relative).resolve()
        assert target.is_relative_to(destination) and 'data' != parts[1]
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(package.read(item))
