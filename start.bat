@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing, this happens once...
  call npm install
  if errorlevel 1 (
    echo Install failed, see above.
    pause
    exit /b 1
  )
)
node server.js --open
pause
