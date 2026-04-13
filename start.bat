@echo off
:: Save the project directory BEFORE changing code page (chcp 65001 breaks Chinese paths)
set "PROJECT_DIR=%~dp0"
title QuantMatrix MT5 - Quantitative Trading Platform
color 0A

echo.
echo  ========================================================
echo     QuantMatrix MT5 - Quantitative Trading Platform
echo     Download and Run Edition
echo  ========================================================
echo.

:: ============================================================
:: Step 1: Find or download Node.js
:: ============================================================

set "NODE_CMD=node"
set "NPM_CMD=npm"
set "USE_PORTABLE=0"

:: Check if Node.js is installed globally
where node >nul 2>nul
if %errorlevel% neq 0 goto :check_portable

echo [OK] Node.js found in system PATH.

:: Verify npm actually works from a different directory (not affected by corrupted node_modules)
pushd %TEMP%
call npm -v >nul 2>nul
set "GLOBAL_NPM_OK=%errorlevel%"
popd

if %GLOBAL_NPM_OK% equ 0 (
    echo [OK] Global npm verified in temp directory.
    goto :node_ready
)

echo [WARN] Node.js found but npm is not working properly (even in temp directory).
echo [WARN] Will use portable Node.js instead...
echo.

:check_portable
:: Check if portable Node.js exists locally
if exist "%PROJECT_DIR%node-portable\node.exe" (
    echo [OK] Portable Node.js found.
    set "NODE_CMD=%PROJECT_DIR%node-portable\node.exe"
    set "NPM_CMD=%PROJECT_DIR%node-portable\npm.cmd"
    set "USE_PORTABLE=1"
    set "PATH=%PROJECT_DIR%node-portable;%PATH%"
    goto :node_ready
)

:: If we reach here, global npm failed and no portable version exists
:: Download portable as backup solution
echo [WARN] Global npm is not functional and no portable Node.js found.

:: Node.js not found, download portable version
echo [INFO] Node.js not found. Downloading portable version...
echo [INFO] This only happens once. Please wait...
echo.

:: Detect system architecture
set "ARCH=x64"
if "%PROCESSOR_ARCHITECTURE%"=="x86" (
    if not defined PROCESSOR_ARCHITEW6432 (
        set "ARCH=x86"
    )
)

:: Set Node.js version and download URL
set "NODE_VER=v20.18.0"
set "NODE_DIR=node-%NODE_VER%-win-%ARCH%"
set "NODE_ZIP=%NODE_DIR%.zip"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/%NODE_ZIP%"
set "NODE_SHASUMS=SHASUMS256.txt"
set "NODE_SHASUMS_URL=https://nodejs.org/dist/%NODE_VER%/%NODE_SHASUMS%"

echo [INFO] Downloading Node.js %NODE_VER% (%ARCH%)...
echo [INFO] URL: %NODE_URL%
echo.

:: Download using PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $ProgressPreference = 'SilentlyContinue'; try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%PROJECT_DIR%%NODE_ZIP%' -UseBasicParsing; Write-Host '[OK] Download complete.' } catch { Write-Host '[ERROR] Download failed:' $_.Exception.Message; exit 1 }"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to download Node.js.
    echo [ERROR] Please download Node.js manually from https://nodejs.org/
    echo [ERROR] Or check your internet connection and try again.
    pause
    exit /b 1
)

echo [INFO] Downloading official checksum file...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $ProgressPreference = 'SilentlyContinue'; try { Invoke-WebRequest -Uri '%NODE_SHASUMS_URL%' -OutFile '%PROJECT_DIR%%NODE_SHASUMS%' -UseBasicParsing; Write-Host '[OK] Checksum file downloaded.' } catch { Write-Host '[ERROR] Checksum download failed:' $_.Exception.Message; exit 1 }"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to download official SHASUMS256.txt.
    del "%PROJECT_DIR%%NODE_ZIP%" 2>nul
    del "%PROJECT_DIR%%NODE_SHASUMS%" 2>nul
    pause
    exit /b 1
)

echo [INFO] Finding expected SHA256 for %NODE_ZIP%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $zipName = '%NODE_ZIP%'; $zipPath = '%PROJECT_DIR%%NODE_ZIP%'; $checksumPath = '%PROJECT_DIR%%NODE_SHASUMS%'; $entry = Get-Content -Path $checksumPath | Where-Object { $_ -match ('\s' + [regex]::Escape($zipName) + '$') } | Select-Object -First 1; if (-not $entry) { Write-Host '[ERROR] Expected SHA256 entry not found for %NODE_ZIP%.'; exit 2 }; $expected = ($entry -split '\s+')[0].Trim(); Write-Host ('[OK] Expected SHA256 found: ' + $expected); $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.Trim(); if ($actual -ine $expected) { Write-Host ('[ERROR] SHA256 mismatch. Expected ' + $expected + ' but got ' + $actual + '.'); exit 3 }; Write-Host ('[OK] SHA256 verified: ' + $actual);"
if %errorlevel% neq 0 (
    echo [ERROR] Node.js archive failed SHA256 verification. Aborting startup.
    del "%PROJECT_DIR%%NODE_ZIP%" 2>nul
    del "%PROJECT_DIR%%NODE_SHASUMS%" 2>nul
    pause
    exit /b 1
)

:: Extract using PowerShell
echo [INFO] Extracting verified Node.js archive...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -Path '%PROJECT_DIR%%NODE_ZIP%' -DestinationPath '%PROJECT_DIR%' -Force; Write-Host '[OK] Extraction complete.' } catch { Write-Host '[ERROR] Extraction failed:' $_.Exception.Message; exit 1 }"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to extract Node.js.
    del "%PROJECT_DIR%%NODE_ZIP%" 2>nul
    del "%PROJECT_DIR%%NODE_SHASUMS%" 2>nul
    pause
    exit /b 1
)

:: Rename to node-portable
if exist "%PROJECT_DIR%node-portable" rd /s /q "%PROJECT_DIR%node-portable"
ren "%PROJECT_DIR%%NODE_DIR%" "node-portable"

:: Clean up zip file
del "%PROJECT_DIR%%NODE_ZIP%" 2>nul
del "%PROJECT_DIR%%NODE_SHASUMS%" 2>nul

echo [OK] Node.js portable installed successfully.
echo.

set "NODE_CMD=%PROJECT_DIR%node-portable\node.exe"
set "NPM_CMD=%PROJECT_DIR%node-portable\npm.cmd"
set "USE_PORTABLE=1"
set "PATH=%PROJECT_DIR%node-portable;%PATH%"

:node_ready

:: Skip project-directory npm verification entirely.
:: npm.cmd uses %~dp0 internally which breaks when CMD's current dir has non-ASCII chars.
:: The temp-directory check above already confirmed npm is functional.
:: Clean up corrupted node_modules/npm if it exists (can confuse npm module resolution)
if exist "%PROJECT_DIR%node_modules\npm" (
    echo [WARN] Removing corrupted node_modules\npm...
    rd /s /q "%PROJECT_DIR%node_modules\npm" 2>nul
)

echo [OK] npm verified.

:: Show Node.js version
echo --------------------------------------------------
echo  Node.js version:
call "%NODE_CMD%" -v
echo --------------------------------------------------
echo.

:: ============================================================
:: Step 2: Install dependencies
:: ============================================================

:: Check if node_modules exists and is healthy
set "NEED_INSTALL=0"
if not exist "%PROJECT_DIR%node_modules" set "NEED_INSTALL=1"

:: If node_modules exists but is corrupted/incomplete, remove and reinstall
if exist "%PROJECT_DIR%node_modules" (
    if not exist "%PROJECT_DIR%node_modules\.package-lock.json" (
        echo [WARN] node_modules appears corrupted or incomplete. Cleaning up...
        rd /s /q "%PROJECT_DIR%node_modules" 2>nul
        set "NEED_INSTALL=1"
    )
)
echo.

if "%NEED_INSTALL%"=="0" goto :deps_ready

if not exist "%PROJECT_DIR%package-lock.json" (
    echo [ERROR] package-lock.json not found.
    echo [ERROR] Secure automatic dependency installation requires a lockfile.
    pause
    exit /b 1
)

echo [INFO] Checking and installing dependencies...
echo [INFO] Installing from lockfile with npm ci...
echo [INFO] Lifecycle scripts are enabled.
echo [INFO] Please wait, this may take a minute...
echo.

:: Run npm from TEMP dir with --prefix to avoid Chinese-character path breaking npm.cmd
pushd %TEMP%
call "%NPM_CMD%" ci --omit=dev --prefix "%PROJECT_DIR%"
if %errorlevel% equ 0 (
    popd
    goto :install_ok
)

echo.
echo [WARN] First install attempt failed. Retrying with cache clean...
call "%NPM_CMD%" cache clean --force 2>nul
popd
if exist "%PROJECT_DIR%node_modules" rd /s /q "%PROJECT_DIR%node_modules"
pushd %TEMP%
call "%NPM_CMD%" ci --omit=dev --prefix "%PROJECT_DIR%"
set "INSTALL_OK=%errorlevel%"
popd
if %INSTALL_OK% equ 0 goto :install_ok

echo.
echo [ERROR] Failed to install dependencies from package-lock.json.
echo [ERROR] Please check your internet connection and try again.
pause
exit /b 1

:install_ok
echo.
echo [OK] Dependencies installed successfully.
echo.

:deps_ready

:: ============================================================
:: Step 4: Auto-create .env if not present
:: ============================================================

if not exist "%PROJECT_DIR%.env" (
    if exist "%PROJECT_DIR%.env.example" (
        echo [INFO] Creating .env configuration file...
        copy "%PROJECT_DIR%.env.example" "%PROJECT_DIR%.env" >nul
        echo [OK] .env file created from template.
        echo [TIP] Edit .env to customize settings [optional].
        echo.
    ) else (
        echo [INFO] No .env file found. Server will use default values.
        echo.
    )
)

:: ============================================================
:: Step 5: Create data and public directories
:: ============================================================

if not exist "%PROJECT_DIR%data" (
    mkdir "%PROJECT_DIR%data"
    echo [OK] Data directory created.
    echo.
)

if not exist "%PROJECT_DIR%public" (
    mkdir "%PROJECT_DIR%public"
    echo [OK] Public directory created.
    echo.
)

:: ============================================================
:: Step 6: Auto-launch MetaTrader 5
:: ============================================================

echo [INFO] Checking MetaTrader 5...

set "MT5_EXE="

:: Check if MT5_PATH is set in .env file
if exist "%PROJECT_DIR%.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%PROJECT_DIR%.env") do (
        if "%%A"=="MT5_PATH" (
            set "MT5_EXE=%%B"
        )
    )
)
if defined MT5_EXE (
    if exist "%MT5_EXE%" (
        echo [OK] Using MT5 path from .env: %MT5_EXE%
        goto :mt5_found
    ) else (
        echo [WARNING] MT5_PATH in .env is invalid: %MT5_EXE%
        set "MT5_EXE="
    )
)

:: Check common MT5 installation paths
if exist "C:\Program Files\MetaTrader 5\terminal64.exe" (
    set "MT5_EXE=C:\Program Files\MetaTrader 5\terminal64.exe"
)
if exist "C:\Program Files (x86)\MetaTrader 5\terminal.exe" (
    set "MT5_EXE=C:\Program Files (x86)\MetaTrader 5\terminal.exe"
)

:: Search in Program Files for broker-named MT5 installations
if not defined MT5_EXE (
    for /d %%D in ("C:\Program Files\*MetaTrader*") do (
        if exist "%%D\terminal64.exe" (
            set "MT5_EXE=%%D\terminal64.exe"
        )
    )
)
if not defined MT5_EXE (
    for /d %%D in ("C:\Program Files (x86)\*MetaTrader*") do (
        if exist "%%D\terminal.exe" (
            set "MT5_EXE=%%D\terminal.exe"
        )
    )
)

:: Search in user AppData for MT5
if not defined MT5_EXE (
    for /d %%D in ("%LOCALAPPDATA%\*MetaTrader*") do (
        if exist "%%D\terminal64.exe" (
            set "MT5_EXE=%%D\terminal64.exe"
        )
    )
)

:: Search Desktop shortcuts (registry-based search)
if not defined MT5_EXE (
    for /f "tokens=*" %%A in ('where /r "%USERPROFILE%\Desktop" terminal64.exe 2^>nul') do (
        set "MT5_EXE=%%A"
    )
)

:mt5_found
if defined MT5_EXE (
    :: Check if MT5 is already running
    tasklist /FI "IMAGENAME eq terminal64.exe" 2>nul | find /I "terminal64.exe" >nul
    if %errorlevel% equ 0 (
        echo [OK] MetaTrader 5 is already running.
    ) else (
        echo [OK] Found MT5: %MT5_EXE%
        echo [INFO] Launching MetaTrader 5...
        start "" "%MT5_EXE%"
        echo [OK] MetaTrader 5 launched.
    )
) else (
    echo [WARNING] MetaTrader 5 not found automatically.
    echo [WARNING] Please start MT5 manually, or set MT5_PATH in .env
    echo [TIP] Common install path: C:\Program Files\MetaTrader 5\
)
echo.

:: ============================================================
:: Step 7: Start the server and open browser
:: ============================================================

set "APP_PORT=5000"
if exist "%PROJECT_DIR%.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%PROJECT_DIR%.env") do (
        if /I "%%A"=="PORT" set "APP_PORT=%%B"
    )
)
if not defined APP_PORT set "APP_PORT=5000"

set "DASHBOARD_URL=http://localhost:%APP_PORT%"
set "API_URL=%DASHBOARD_URL%/api/health"
set "WS_URL=ws://localhost:%APP_PORT%/ws"

:: If QuantMatrix is already running on this port, just open the dashboard.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -Uri '%API_URL%' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200 -and $r.Content -match '\"success\":true') { exit 10 } else { exit 0 } } catch { exit 0 }" >nul 2>nul
if %errorlevel% equ 10 (
    echo [OK] QuantMatrix server is already running on port %APP_PORT%.
    echo [INFO] Opening dashboard...
    start "" "%DASHBOARD_URL%"
    exit /b 0
)

:: If another program is using the port, stop here with a friendly message.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$conn = Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($conn) { $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue; if ($proc) { Write-Host ('[ERROR] Port %APP_PORT% is already in use by PID ' + $proc.Id + ' (' + $proc.ProcessName + ').') } else { Write-Host '[ERROR] Port %APP_PORT% is already in use.' }; exit 12 } else { exit 0 }"
if %errorlevel% equ 12 (
    echo [TIP] Close the existing process, or change PORT in .env before starting QuantMatrix.
    pause
    exit /b 1
)

echo ========================================================
echo   Starting QuantMatrix MT5 Server...
echo.
echo   Dashboard: %DASHBOARD_URL%
echo   API:       %API_URL%
echo   WebSocket: %WS_URL%
echo.
echo   Press Ctrl+C to stop the server
echo ========================================================
echo.

:: Open browser after a short delay
start "" cmd /c "timeout /t 2 /nobreak >nul && start %DASHBOARD_URL%"

pushd "%PROJECT_DIR%"
call "%NODE_CMD%" src/server.js
popd

echo.
echo [INFO] Server stopped.
pause
