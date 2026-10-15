@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title proto-tool

echo.
echo   ============================================
echo      proto-tool  -  HTML annotation tool
echo   ============================================
echo.

set "NODE_EXE="

rem ---- 1) node on PATH ----
where node >nul 2>&1
if %errorlevel%==0 (
  for /f "delims=" %%i in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)

rem ---- 2) common install locations ----
if not defined NODE_EXE (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)
if not defined NODE_EXE (
  if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
)
if not defined NODE_EXE (
  if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)

if not defined NODE_EXE (
  echo   [X] Node.js not found.
  echo.
  echo   Please install Node.js 18 or newer:  https://nodejs.org
  echo   Then run this file again.
  echo.
  pause
  exit /b 1
)

echo   [1/2] Node runtime ready
echo         !NODE_EXE!
echo.

rem ---- port: env PORT, default 7317 ----
set "APPPORT=7317"
if not "%PORT%"=="" set "APPPORT=%PORT%"

rem ---- is it already running? ----
set "ALIVE="
for /f "delims=" %%r in ('powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri 'http://127.0.0.1:%APPPORT%/api/ping' -UseBasicParsing -TimeoutSec 2).StatusCode}catch{''}" 2^>nul') do set "ALIVE=%%r"

if "!ALIVE!"=="200" (
  echo   [2/2] Already running, opening browser...
  start "" "http://127.0.0.1:%APPPORT%/"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

echo   [2/2] Starting service...
echo.
echo   ------------------------------------------------
echo    URL:  http://127.0.0.1:%APPPORT%/
echo.
echo    Keep this window open.
echo    Closing it stops the service.
echo    Your notes are already saved into the HTML.
echo   ------------------------------------------------
echo.

"!NODE_EXE!" server\index.js --open --port %APPPORT%
set "CODE=%errorlevel%"

echo.
if not "%CODE%"=="0" (
  echo   [X] Service exited with code %CODE%.
  echo.
  echo   Common causes:
  echo     - Port %APPPORT% already used by something else
  echo     - server\index.js is missing or damaged
  echo     - Node.js is too old (need 18+)
  echo.
  echo   To see the real error, run this in the folder:
  echo     "!NODE_EXE!" server\index.js
  echo.
  echo   To use another port, set PORT first, e.g.:
  echo     set PORT=7320
  echo     start.bat
  echo.
)
echo   Service stopped.
pause
