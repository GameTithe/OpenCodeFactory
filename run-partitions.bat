@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "PROJECT_ROOT=%~dp0."
set "SERVER_URL=http://127.0.0.1:4096"

call :ensure_server
if errorlevel 1 (
  pause
  exit /b 1
)

node "%ROOT%.opencode\tools\partition_runner.cjs" --project "%PROJECT_ROOT%"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%

:ensure_server
curl.exe --silent --fail "%SERVER_URL%/global/health" >nul 2>&1
if not errorlevel 1 goto :server_ready

start "OpenCode Server" /D "%ROOT%" cmd /k "opencode.cmd serve --hostname 127.0.0.1 --port 4096"

for /l %%I in (1,1,20) do (
  curl.exe --silent --fail "%SERVER_URL%/global/health" >nul 2>&1 && goto :server_ready
  timeout /t 1 /nobreak >nul
)

echo Failed to start the OpenCode server at %SERVER_URL%.
exit /b 1

:server_ready
exit /b 0
