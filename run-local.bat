@echo off
setlocal
title Bulls vs Unicorns - local stack
cd /d "%~dp0"

echo ============================================
echo   BULLS vs UNICORNS - starting local stack
echo ============================================
echo.

echo [1/3] Solana test validator (WSL)...
wsl.exe -d Ubuntu -e bash -lc "pgrep -f solana-test-validator >/dev/null && echo already-running || (mkdir -p ~/svalidator && cd ~/svalidator && nohup solana-test-validator --quiet >validator.log 2>&1 & sleep 2; echo started)"
echo     waiting for validator RPC...
call :waitfor 8899 30

echo [2/3] Game engine...
start "bulls-engine" cmd /k "cd /d "%~dp0engine" && set SOLANA_RPC=http://127.0.0.1:8899 && npm start"
call :waitfor 8090 30

echo [3/3] Web server...
start "bulls-web" cmd /k "cd /d "%~dp0" && node serve-web.mjs"
call :waitfor 8123 20

echo.
echo   Opening game...
start "" "http://localhost:8123/?engine=ws://localhost:8090"
echo.
echo   Game:   http://localhost:8123
echo   Engine: ws://localhost:8090
echo   Chain:  http://127.0.0.1:8899  (point Phantom here: Settings ^> Developer ^> Custom RPC)
echo.
echo   Close the two popup windows to stop the engine/web server.
pause
exit /b

:waitfor
set /a _n=0
:wfloop
netstat -ano | findstr ":%1 " | findstr LISTENING >nul 2>&1
if not errorlevel 1 goto :wfok
set /a _n+=1
if %_n% geq %2 (echo     WARNING: port %1 did not come up & exit /b 1)
ping -n 2 127.0.0.1 >nul 2>&1
goto :wfloop
:wfok
echo     OK - port %1 is up
exit /b 0
