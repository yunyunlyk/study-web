@echo off
chcp 65001 >nul
setlocal
set "DIR=%~dp0"
"%DIR%.venv\Scripts\python.exe" "%DIR%tools\tunnel.py" stop
timeout /t 3 >nul