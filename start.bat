@echo off
chcp 65001 >nul
title MoodTune 情绪电台 · 本地服务（请勿关闭本窗口）
cd /d "%~dp0"

echo.
echo   ================================================
echo     MoodTune 情绪电台 - 正在启动本地服务
echo   ================================================
echo.
echo   启动后浏览器会自动打开，地址形如：
echo       http://localhost:8010/
echo.
echo   [!] 请保持这个窗口开着，关掉窗口服务就停了。
echo       如果觉得碍事，下次请双击「启动系统.vbs」，
echo       它会在后台静默运行，不弹窗口。
echo.
echo   ------------------------------------------------
echo.

where node >nul 2>nul
if %errorlevel%==0 (
    node server.js
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    echo   没找到 Node.js，改用 Python 启动...
    start "" http://localhost:8010/
    python -m http.server 8010
    goto :end
)

echo   [错误] 这台机器上没找到 Node.js 或 Python。
echo.
echo   请先安装 Node.js（https://nodejs.org），安装时保持默认选项，
echo   装完重新双击本文件即可。
echo.

:end
echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
