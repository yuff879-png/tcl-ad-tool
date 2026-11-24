"""Test and scan frozen 1.3.8 sources, recording exact before/after manifests."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
VERSION = "1.3.8"
NODE = str(APP / "runtime/node.exe")
assert json.loads((APP / "package.json").read_text("utf-8"))["version"] == VERSION
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
audit = ROOT / "verification" / ("release-audit-" + VERSION + "-" + stamp)
scan = ROOT / "verification" / ("source-secrets-" + VERSION + "-" + stamp)
audit.mkdir(); scan.mkdir()


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def write(file, value):
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sources():
    return sorted([file for folder in ["src", "public", "scripts", "launcher", "test"]
                   for file in (APP / folder).rglob("*") if file.is_file()]
                  + [APP / name for name in ["package.json", "package-lock.json", "update-channel.json", "使用说明.md", "更新说明.md"]])


before = {file.relative_to(APP).as_posix(): sha(file) for file in sources()}
write(audit / "source-before-tests.json", before)
parse = audit / "parse-powershell.ps1"
parse.write_text("$bad=@(); $files=Get-ChildItem -LiteralPath 'scripts' -Recurse -Filter '*.ps1'; foreach($file in $files){$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$bad += $file.Name}}; if($bad.Count){$bad; exit 1}; Write-Output ('OK: '+$files.Count+' PowerShell scripts parsed')", encoding="utf-8")


def check(name, command, timeout=180):
    started = datetime.now(timezone.utc).isoformat()
    result = subprocess.run(command, cwd=APP, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    log = audit / (name + ".log")
    log.write_text(result.stdout + result.stderr, encoding="utf-8")
    value = {"exit_code": result.returncode, "started_at_utc": started,
             "completed_at_utc": datetime.now(timezone.utc).isoformat(), "log": str(log),
             "log_sha256": sha(log), "command": command}
    if name == "full-tests":
        value["counts"] = {key: int(re.search(r"(?m)^.*?\b" + key + r" (\d+)\s*$", result.stdout).group(1))
                           for key in ["tests", "pass", "fail", "cancelled", "skipped", "todo"]}
    return name, value


with ThreadPoolExecutor(max_workers=3) as executor:
    tasks = [executor.submit(check, "full-tests", [NODE, "--disable-warning=ExperimentalWarning", "--test", "--test-timeout=60000", "test/*.test.js"], 600),
             executor.submit(check, "environment-check", [NODE, "--disable-warning=ExperimentalWarning", "scripts/check.js"]),
             executor.submit(check, "powershell-parse", ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(parse)])]
    checks = dict(task.result() for task in tasks)
after = {file.relative_to(APP).as_posix(): sha(file) for file in sources()}
write(audit / "source-after-tests.json", after)
counts = checks["full-tests"]["counts"]
test_pass = counts["tests"] == counts["pass"] and counts["tests"] >= 353 and all(counts[field] == 0 for field in ["fail", "cancelled", "skipped", "todo"])
unchanged = before == after
summary = {"version": VERSION, "status": "passed" if unchanged and test_pass and all(check["exit_code"] == 0 for check in checks.values()) else "failed",
           "preTestManifestCaptured": True, "source_files_unchanged_during_verification": unchanged,
           "source_file_count": len(before), "checks": checks, "source_hashes": before,
           "finalSourceEvidence": {"method": "Exact SHA-256 source manifests captured immediately before and after the full test/environment/PowerShell runs.", "limitation": "Synthetic tests do not execute real purchases or broadcast transactions."}}
write(audit / "summary.json", summary)
assert summary["status"] == "passed", str(audit / "summary.json")
for file in sources():
    target = scan / "source" / file.relative_to(APP)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file, target)
write(scan / "source-manifest.json", before)
command = [r"C:\Users\AX\.codex\tools\gitleaks-8.30.1\gitleaks.exe", "dir", str(scan / "source"), "--redact=100", "--no-banner", "--no-color", "--ignore-gitleaks-allow", "--gitleaks-ignore-path", str(scan / "source"), "--report-format", "json", "--report-path", str(scan / "gitleaks-redacted.json"), "--timeout", "180"]
result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=200)
(scan / "gitleaks-redacted.log").write_text(result.stdout + result.stderr, encoding="utf-8")
findings = json.loads((scan / "gitleaks-redacted.json").read_text("utf-8"))
after_scan = {file.relative_to(APP).as_posix(): sha(file) for file in sources()}
scan_summary = {"scanner": "gitleaks 8.30.1", "status": "passed" if result.returncode == 0 and not findings and after_scan == before else "failed",
                "scanner_exit_code": result.returncode, "scan_file_count": len(before), "finding_count": len(findings), "audit": str(audit / "summary.json"),
                "audit_hashes_match": True, "source_unchanged_during_scan": after_scan == before,
                "report": str(scan / "gitleaks-redacted.json"), "report_sha256": sha(scan / "gitleaks-redacted.json"),
                "excluded": ["runtime", "node_modules", "data", "private key stores"]}
write(scan / "summary.json", scan_summary)
print(json.dumps({"audit": str(audit / "summary.json"), "scan": str(scan / "summary.json"), "tests": counts, "source_files": len(before), "findings": len(findings), "preTestManifestCaptured": True}, ensure_ascii=False, indent=2))
assert scan_summary["status"] == "passed", str(scan / "summary.json")
