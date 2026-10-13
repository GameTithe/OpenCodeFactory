@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"

if not exist "%ROOT%desktop\package.json" (
  echo The desktop app files were not found.
  pause
  exit /b 1
)

pushd "%ROOT%desktop"
call npm.cmd run dev
set "RESULT=%ERRORLEVEL%"
popd

if not "%RESULT%"=="0" pause
exit /b %RESULT%
