@echo off
REM ============================================================
REM  Scan Tool - Windows launcher
REM  Installs dependencies, builds the UI, and starts the bridge.
REM  Then open http://localhost:3001 in a browser.
REM ============================================================
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Download the LTS from https://nodejs.org
  pause
  exit /b 1
)

echo.
echo === Installing server dependencies ===
cd server
call npm install --no-fund --no-audit || goto :err
cd ..

echo.
echo === Building the web UI ===
cd web
call npm install --no-fund --no-audit || goto :err
call npm run build || goto :err
cd ..

echo.
echo === Starting Scan Tool ===
echo Open http://localhost:3001 in your browser.
echo (Leave this window open while scanning. Press Ctrl+C to stop.)
echo.
cd server
call npm start
goto :eof

:err
echo.
echo [ERROR] Setup failed. See the message above.
pause
exit /b 1
