@echo off
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo.
echo PromptLens startup
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js, then try again.
  pause
  exit /b 1
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo Rust was not found. Install Rust, then open a new window and try again.
  pause
  exit /b 1
)

echo Closing an existing PromptLens window if one is open...
taskkill /F /IM promptlens.exe >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":1420" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
)

if not exist "node_modules\" (
  echo Installing frontend packages...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting. Keep this window open.
call npm run tauri:dev
if errorlevel 1 (
  echo.
  echo Startup failed. Read the messages above.
  pause
  exit /b 1
)
