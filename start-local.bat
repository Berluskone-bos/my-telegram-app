@echo off
echo.
echo ========================================
echo   GULF WESTERN OIL - LOCAL TEST
echo ========================================
echo.
echo This script will:
echo   1. Start the web server (port 3000)
echo   2. Start ngrok tunnel (for HTTPS)
echo.
echo Prerequisites:
echo   - Node.js installed
echo   - ngrok installed (npm install -g ngrok)
echo   - Bot token in bot/.env
echo.
pause

echo.
echo Starting web server...
start "Web Server" cmd /k "cd /d %~dp0 && python -m http.server 3000"

echo.
echo Starting ngrok tunnel...
timeout /t 2 >nul
start "Ngrok" cmd /k "ngrok http 3000"

echo.
echo ========================================
echo   INSTRUCTIONS:
echo ========================================
echo.
echo 1. Wait for ngrok to start
echo 2. Copy the HTTPS URL (https://xxxx.ngrok.io)
echo 3. Update bot/.env with:
echo    WEB_APP_URL=https://xxxx.ngrok.io
echo 4. Start the bot:
echo    cd bot && npm start
echo 5. Open your bot in Telegram
echo 6. Send /start and click "Open Shop"
echo.
pause
