# Gulf Western Oil - Local Test Script
# This script starts the web server and ngrok tunnel

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  GULF WESTERN OIL - LOCAL TEST" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if ngrok is installed
$ngrokInstalled = Get-Command ngrok -ErrorAction SilentlyContinue
if (-not $ngrokInstalled) {
    Write-Host "Installing ngrok..." -ForegroundColor Yellow
    npm install -g ngrok
}

# Start web server in background
Write-Host "Starting web server on port 3000..." -ForegroundColor Green
$webServer = Start-Process python -ArgumentList "-m", "http.server", "3000" -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden

# Wait a moment
Start-Sleep -Seconds 1

# Start ngrok
Write-Host "Starting ngrok tunnel..." -ForegroundColor Green
Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  IMPORTANT:" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Copy the HTTPS URL from ngrok window" -ForegroundColor White
Write-Host "2. Update bot/.env:" -ForegroundColor White
Write-Host "   WEB_APP_URL=https://xxxx.ngrok-free.app" -ForegroundColor Cyan
Write-Host "3. Start the bot:" -ForegroundColor White
Write-Host "   cd bot && npm start" -ForegroundColor Cyan
Write-Host "4. Open your bot in Telegram" -ForegroundColor White
Write-Host "5. Send /start and click 'Open Shop'" -ForegroundColor White
Write-Host ""

# Start ngrok in new window
Start-Process ngrok -ArgumentList "http", "3000" -WindowStyle Normal

Write-Host "Press any key to stop all services..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

# Cleanup
Write-Host ""
Write-Host "Stopping services..." -ForegroundColor Yellow
Stop-Process -Id $webServer.Id -ErrorAction SilentlyContinue
Stop-Process -Name ngrok -ErrorAction SilentlyContinue
Write-Host "Done!" -ForegroundColor Green
