@echo off
chcp 65001 >nul
"%~dp0..\runtime\node.exe" --disable-warning=ExperimentalWarning "%~dp0upgrade-existing.js"
pause
