@echo off
chcp 65001 >nul
setlocal
set "DIR=%~dp0"
echo 正在创建运行环境...
python -m venv --system-site-packages "%DIR%.venv"
if not exist "%DIR%.venv\Scripts\python.exe" (
  echo [错误] 创建失败，请确认电脑里装了 Python 3.11 以上版本。
  pause
  exit /b 1
)
echo 正在安装依赖（需要联网）...
"%DIR%.venv\Scripts\python.exe" -m pip install --upgrade pip
"%DIR%.venv\Scripts\python.exe" -m pip install -r "%DIR%requirements.txt"
echo.
echo 安装完成，现在可以双击「启动.bat」。
pause
