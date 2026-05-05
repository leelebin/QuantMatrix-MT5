@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "NODE_CMD=node"

title QuantMatrix MT5 - Remote Access

echo.
echo  ========================================================
echo     QuantMatrix MT5 - Remote Access Startup
echo  ========================================================
echo.

set "TRUST_PROXY=1"

echo [INFO] Starting QuantMatrix server in a separate window...
start "" cmd /c ""%PROJECT_DIR%start.bat""

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Waiting for portable Node.js to finish installing...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline = (Get-Date).AddMinutes(2); do { if (Test-Path '%PROJECT_DIR%node-portable\node.exe') { exit 0 }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $deadline); exit 1"
    if errorlevel 1 (
        echo [ERROR] Portable Node.js was not ready within 2 minutes.
        pause
        exit /b 1
    )
)

if exist "%PROJECT_DIR%node-portable\node.exe" set "NODE_CMD=%PROJECT_DIR%node-portable\node.exe"

echo [INFO] Preparing remote HTTPS access with ngrok...
pushd "%PROJECT_DIR%"
call "%NODE_CMD%" scripts\start-remote-access.js
set "REMOTE_EXIT=%errorlevel%"
popd

if %REMOTE_EXIT% neq 0 (
    echo.
    echo [ERROR] Remote access setup failed.
    pause
    exit /b %REMOTE_EXIT%
)

echo.
echo [OK] Remote access is ready.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$statePath = '%PROJECT_DIR%data\remote-access-state.json'; if (Test-Path $statePath) { $s = Get-Content $statePath -Raw | ConvertFrom-Json; Write-Host ''; Write-Host ('  Public URL: ' + $s.publicUrl); Write-Host ('  Outer User: ' + $s.basicAuth.username); Write-Host ('  Outer Password: ' + $s.basicAuth.password); Write-Host '' } else { Write-Host '[WARN] remote-access-state.json not found. Check Telegram for the latest URL.' }"
pause
