@echo off
setlocal
chcp 936 >nul 2>&1

rem ===========================================================================
rem  proto-tool desktop build entry point
rem
rem  Why this wrapper instead of calling cargo directly:
rem
rem  1) MSVC discovery. cc-rs / vswhere locate the MSVC installation by
rem     querying the registry. Calling vcvars64.bat first sets the whole
rem     MSVC environment, which cc-rs then reuses as-is.
rem
rem  2) Windows SDK headers/libs. vcvars64.bat finds the SDK by reading
rem     WindowsSdkDir from the registry. In environments where registry
rem     access is restricted, it silently ends up with INCLUDE/LIB covering
rem     only MSVC's own files, and cl.exe then dies with C1034 while
rem     link.exe dies with LNK1181. The SDK directories are still on disk,
rem     so they are appended below by version scan.
rem
rem  Note: no parenthesised IF blocks below on purpose. The MSVC/SDK paths
rem  contain "(x86)"; expanding such a value inside an IF block would close
rem  the block early. goto and one-line IFs are used instead.
rem
rem  Usage:  build-tauri.bat check
rem          build-tauri.bat build --release
rem          build-tauri.bat tauri build
rem ===========================================================================

set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%VCVARS%" goto novcvars

call "%VCVARS%" >nul 2>&1
if errorlevel 1 goto noenv

rem ---- append the Windows SDK include/lib paths -------------------------
set "SDKROOT=C:\Program Files (x86)\Windows Kits\10"
set "SDKVER="
for /f "delims=" %%D in ('dir /b /ad /o-n "%SDKROOT%\Lib" 2^>nul') do if not defined SDKVER set "SDKVER=%%D"

if not defined SDKVER goto nosdk

set "INCLUDE=%INCLUDE%;%SDKROOT%\Include\%SDKVER%\ucrt;%SDKROOT%\Include\%SDKVER%\shared;%SDKROOT%\Include\%SDKVER%\um;%SDKROOT%\Include\%SDKVER%\winrt;%SDKROOT%\Include\%SDKVER%\cppwinrt"
set "LIB=%LIB%;%SDKROOT%\Lib\%SDKVER%\ucrt\x64;%SDKROOT%\Lib\%SDKVER%\um\x64"

rem ---- isolated CARGO_HOME ---------------------------------------------
rem Bypasses the ustc mirror configured in ~/.cargo/config.toml, which is
rem unreachable on some networks. Delete this line to reuse ~/.cargo.
set "CARGO_HOME=%USERPROFILE%\_cargo_build_tmp"
if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"

cd /d "%~dp0src-tauri"

echo [i] MSVC toolset : %VCToolsVersion%
echo [i] Windows SDK  : %SDKVER%
echo [i] CARGO_HOME   : %CARGO_HOME%
echo.

cargo %*
if errorlevel 1 goto cargofail
exit /b 0

:novcvars
echo [X] vcvars64.bat not found:
echo     %VCVARS%
echo     Install "Visual Studio Build Tools" with the C++ workload.
echo.
exit /b 1

:noenv
echo [X] Failed to initialise the MSVC environment.
echo.
exit /b 1

:nosdk
echo [X] No Windows SDK found under:
echo     %SDKROOT%\Lib
echo     Install a Windows 10/11 SDK.
echo.
exit /b 1

:cargofail
echo.
echo [X] cargo exited with an error.
echo.
exit /b 1
