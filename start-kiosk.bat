@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  旗袍表情工坊 · 现场拍照亭
echo  正在启动后端，启动后会自动打开 kiosk 页面。
echo  不要直接双击 kiosk.html。
echo.
set OPEN_KIOSK=1
python server.py
pause
