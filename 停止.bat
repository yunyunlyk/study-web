@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
  set FOUND=1
)
if "!FOUND!"=="1" (
  echo 学习网页服务已停止。
) else (
  echo 没有发现正在运行的学习网页服务。
)
timeout /t 3 >nul
