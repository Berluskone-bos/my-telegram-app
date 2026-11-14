@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запускаю проверку PartsAPI...
py partsapi_tester.py
if errorlevel 1 python partsapi_tester.py
pause
