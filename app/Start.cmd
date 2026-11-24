@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo Bundled Node.js is missing. Run Repair_Runtime.cmd, then try again.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" --disable-warning=ExperimentalWarning "%~dp0scripts\start.js" --quick
if errorlevel 1 (
  pause
  exit /b 1
)
