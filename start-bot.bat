@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ========================================
echo   АВТОПРОМОЙЛ — ЛОКАЛЬНЫЙ ЗАПУСК БОТА
echo ========================================
echo.
echo Скрипт запускает основной backend-процесс.
echo Он НЕ завершает другие процессы Node.js.
echo Для остановки используйте Ctrl+C в этом окне.
echo.

if not exist "node_modules" (
  echo Не найдены зависимости в корне проекта.
  echo Сначала выполните: npm ci
  pause
  exit /b 1
)

npm start
