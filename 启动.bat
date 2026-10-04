@echo off
chcp 65001 >nul
setlocal
set "DIR=%~dp0"
if not exist "%DIR%.venv\Scripts\python.exe" (
  echo [错误] 没有找到运行环境 .venv
  echo 请先双击运行「首次安装.bat」
  pause
  exit /b 1
)
echo 正在启动学习网页，请稍等几秒...
start "学习网页服务" /min cmd /c ""%DIR%.venv\Scripts\python.exe" "%DIR%run_server.py" & pause"
timeout /t 4 >nul
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo.
  echo [提示] 服务没有起来，所以先不打开浏览器了。
  echo        请看那个最小化的黑色窗口里写了什么，常见原因：
  echo          - 端口 8787 被别的程序占用；
  echo          - 运行环境坏了，重跑一次「首次安装.bat」。
  echo.
  pause
  exit /b 1
)
set "SITE=http://127.0.0.1:8787"
if not exist "%DIR%data" mkdir "%DIR%data" >nul 2>nul
rem 问一下 Python「本机该用 http 还是 https」（开了自签 HTTPS 时必须是 https）。
rem 这里刻意不用 for /f：那会让命令以引号开头，触发 cmd /c 的引号剥离规则而报错。
"%DIR%.venv\Scripts\python.exe" "%DIR%tools\site_url.py" > "%DIR%data\site_url.txt" 2>nul
set "SITE_TMP="
if exist "%DIR%data\site_url.txt" set /p SITE_TMP=<"%DIR%data\site_url.txt"
if defined SITE_TMP set "SITE=%SITE_TMP%"
start "" "%SITE%"
echo.
echo 已经帮你打开浏览器。
echo 网址：%SITE%
echo 手机想访问：看那个最小化的黑色窗口里显示的网址。
echo 要停止服务，双击「停止.bat」。
timeout /t 6 >nul
