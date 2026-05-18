@echo off
setlocal

set "BACKEND_DIR=%~dp0backend"
set "GAME_DIR=%~dp0little_town"

echo.
echo  =====================================
echo   Town Inbox launcher
echo  =====================================
echo   backend: %BACKEND_DIR%
echo   game:    %GAME_DIR%
echo.

REM ---------- env sanity check ----------
if not exist "%BACKEND_DIR%\.env" (
    echo [warn] %BACKEND_DIR%\.env not found.
    echo        Backend will boot but Gmail features won't work until you
    echo        copy .env.example to .env and fill in GOOGLE_CLIENT_ID etc.
    echo.
)

REM ---------- dep install (visible in this window) ----------
if not exist "%BACKEND_DIR%\node_modules" (
    echo [setup] Installing backend dependencies...
    pushd "%BACKEND_DIR%"
    call npm install
    popd
    echo.
)

if not exist "%GAME_DIR%\node_modules" (
    echo [setup] Installing game dependencies...
    pushd "%GAME_DIR%"
    call npm install
    popd
    echo.
)

REM ---------- launch each service in its own titled window ----------
echo [launch] Backend  - http://localhost:3091   (TownInbox-Backend window, --watch)
start "TownInbox-Backend" /D "%BACKEND_DIR%" cmd /k npm run dev

echo [launch] Game     - http://localhost:5173   (TownInbox-Game window)
start "TownInbox-Game" /D "%GAME_DIR%" cmd /k npm run dev

echo.
echo  =====================================
echo   Both services are now running in
echo   their own windows. Watch those for
echo   logs.
echo.
echo   Press any key in THIS window to
echo   stop all services and exit.
echo  =====================================
echo.
pause >nul

echo.
echo Stopping services...
taskkill /FI "WINDOWTITLE eq TownInbox-Backend*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq TownInbox-Game*"    /T /F >nul 2>&1
echo Done.
endlocal
