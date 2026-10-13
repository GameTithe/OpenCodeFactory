@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "SERVER_URL=http://127.0.0.1:4096"
set "SESSION_FILE=%ROOT%opencode-session-ids.txt"

if not exist "%SESSION_FILE%" (
  echo No saved Worker session was found.
  exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%SESSION_FILE%") do (
  if "%%A"=="WORKER_SESSION" set "WORKER_SESSION=%%B"
)

if not defined WORKER_SESSION (
  echo The saved Worker session ID is missing.
  exit /b 1
)

start "OpenCode Worker" /D "%ROOT%" cmd /k "opencode.cmd attach %SERVER_URL% --session %WORKER_SESSION%"
