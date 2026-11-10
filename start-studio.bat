@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  旗袍表情工坊 · 本地生产台
echo  正在启动后端与前端，浏览器会自动打开。
echo.
python server.py
pause
