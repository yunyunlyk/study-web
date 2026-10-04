@echo off
chcp 65001 >nul
setlocal
set "DIR=%~dp0"
if not exist "%DIR%.venv\Scripts\python.exe" (
  echo [错误] 没有找到运行环境 .venv，请先双击「首次安装.bat」
  pause
  exit /b 1
)
echo 正在开一条手机 / 外网可用的可信 https 隧道...
echo （本机网站必须已经启动；没启动请先双击「启动.bat」）
echo.
"%DIR%.venv\Scripts\python.exe" "%DIR%tools\tunnel.py" start
echo.
echo 提示：要关掉隧道，双击「停止隧道.cmd」。本机网站不受影响。
pause