@echo off
cd /d "%~dp0"
title Sticker Booth Device Agent
echo Starting local device agent on http://127.0.0.1:8788
echo Open http://127.0.0.1:8787/hardware.html to test.
python device_agent.py
echo.
echo Device agent stopped. Press any key to close.
pause >nul
