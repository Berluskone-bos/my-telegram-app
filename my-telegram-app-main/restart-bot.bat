@echo off
chcp 65001 >nul
echo.
echo ═══════════════════════════════════════════
echo   ПЕРЕЗАПУСК БОТА GULF WESTERN OIL
echo ═══════════════════════════════════════════
echo.

echo [1/3] Остановка существующих процессов...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 >nul

echo [2/3] Запуск бота...
cd /d "%~dp0bot"
start "Gulf Western Bot" cmd /k "node bot.js"

echo [3/3] Ожидание запуска...
timeout /t 3 >nul

echo.
echo ═══════════════════════════════════════════
echo   БОТ ПЕРЕЗАПУЩЕН!
echo ═══════════════════════════════════════════
echo.
echo Теперь откройте @Gulf_Western_Oil_bot в Telegram
echo и отправьте /start
echo.
pause
