@echo off
REM Lingshu - One-click dev start (Windows)
REM
REM Startup sequence:
REM   1. TS backend (port 3000) - background
REM   2. Electron (dev mode, chat UI)
REM
REM soul Python sidecar not needed (chat memory uses backend SQLite)
REM Closing any window stops that component. Closing Electron stops all.
chcp 65001 > nul
setlocal
cd /d "%~dp0"

echo ====================================
echo   Lingshu - One-click dev start
echo ====================================
echo [DEBUG] cwd: %CD%

REM 1. Check environment
echo [DEBUG] checking node...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERR] node not found. Please install Node.js 18+
  echo.
  echo Press any key to close...
  pause > nul
  exit /b 1
)
echo [DEBUG] node version:
node --version

REM 2. npm install - only first time
if not exist "node_modules\electron" (
  echo [1/3] First run, installing dependencies 1-2 min...
  call npm install --ignore-scripts
  if errorlevel 1 (
    echo [ERR] npm install failed, errorlevel=%errorlevel%
    echo.
    echo Press any key to close...
    pause > nul
    exit /b 1
  )
) else (
  echo [DEBUG] node_modules\electron exists, skip install
)

REM 3. Start TS backend (English title avoids cmd Chinese parsing issues)
echo [2/3] Starting TS backend (port 3000)...
echo [DEBUG] running: npm --workspace backend run dev
start "Lingshu-Backend" cmd /k "npm --workspace backend run dev 2>&1"
if errorlevel 1 (
  echo [ERR] failed to start backend window, errorlevel=%errorlevel%
  echo.
  echo Press any key to close...
  pause > nul
  exit /b 1
)

REM 4. Wait 5s for backend (use ping to avoid cmd/bash timeout incompatibility)
echo [DEBUG] waiting 5s for backend...
ping 127.0.0.1 -n 6 > nul

REM 5. Start Electron (windowed)
echo [3/3] Starting Electron (desktop window)...
echo [DEBUG] running: npm --workspace electron run dev
call npm --workspace electron run dev
if errorlevel 1 (
  echo [ERR] electron failed, errorlevel=%errorlevel%
  echo.
  echo Press any key to close...
  pause > nul
  exit /b 1
)

echo.
echo Lingshu closed. Close cmd window to end all processes.
pause > nul
taskkill /FI "WINDOWTITLE eq Lingshu-*" /T /F 2>nul > nul
endlocal