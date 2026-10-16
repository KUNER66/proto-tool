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
rem     WindowsSdkDir from the registry. Where registry access is restricted,
rem     INCLUDE/LIB end up covering only MSVC's own files and cl.exe dies
rem     with C1034 while link.exe dies with LNK1181. The SDK directories are
rem     still on disk, so they are appended below by version scan.
rem
rem  3) Encrypted MSVC headers. Some corporate DLP clients encrypt files under
rem     VC\Tools\MSVC\<ver>\include, so the compiler reads ciphertext and
rem     reports nonsense like C4335 "Mac file format". The VS package cache
rem     (payload.vsix, a plain zip) is not encrypted and holds the originals.
rem     Run _msvc_plain_extract.py once to stage plaintext copies; this script
rem     will then use them instead of the tampered directory.
rem
rem  Note: no parenthesised IF blocks below on purpose. The MSVC/SDK paths
rem  contain "(x86)"; expanding such a value inside an IF block would close
rem  the block early. goto and one-line IFs are used instead.
rem
rem  Usage:  build-tauri.bat check
rem          build-tauri.bat build --release
rem          build-tauri.bat tauri build        (runs the Tauri CLI instead)
rem ===========================================================================

set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%VCVARS%" goto novcvars

call "%VCVARS%" >nul 2>&1
if errorlevel 1 goto noenv

rem ---- locate the Windows SDK by scanning the Lib directory ----------------
set "SDKROOT=C:\Program Files (x86)\Windows Kits\10"
set "SDKVER="
for /f "delims=" %%D in ('dir /b /ad /o-n "%SDKROOT%\Lib" 2^>nul') do if not defined SDKVER set "SDKVER=%%D"

if not defined SDKVER goto nosdk

set "SDK_INC=%SDKROOT%\Include\%SDKVER%\ucrt;%SDKROOT%\Include\%SDKVER%\shared;%SDKROOT%\Include\%SDKVER%\um;%SDKROOT%\Include\%SDKVER%\winrt;%SDKROOT%\Include\%SDKVER%\cppwinrt"
set "SDK_LIB=%SDKROOT%\Lib\%SDKVER%\ucrt\x64;%SDKROOT%\Lib\%SDKVER%\um\x64"

rem ---- choose the header source: plaintext staging beats the real directory
set "PLAIN=%USERPROFILE%\_msvc_plain"
set "INC_MODE=MSVC original dir"
if not exist "%PLAIN%\vcruntime.h" goto keepmsvc
set "INCLUDE=%PLAIN%;%SDK_INC%"
set "INC_MODE=plaintext copy (%PLAIN%)"
goto setlib

:keepmsvc
set "INCLUDE=%INCLUDE%;%SDK_INC%"

:setlib
set "LIB=%LIB%;%SDK_LIB%"

rem ---- isolated CARGO_HOME ------------------------------------------------
rem Bypasses the ustc mirror configured in ~/.cargo/config.toml, which is
rem unreachable on some networks. Delete this line to reuse ~/.cargo.
set "CARGO_HOME=%USERPROFILE%\_cargo_build_tmp"
if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"

rem ---- pass through to the Tauri CLI when the first argument is "tauri" ----
rem The CLI must run from the project root, not src-tauri, and it needs the
rem environment prepared above, so the hop happens here.

if /i "%~1"=="tauri" goto tauricli

cd /d "%~dp0src-tauri"

echo [i] MSVC toolset : %VCToolsVersion%
echo [i] Windows SDK  : %SDKVER%
echo [i] headers from : %INC_MODE%
echo [i] CARGO_HOME   : %CARGO_HOME%
echo.

cargo %*
if errorlevel 1 goto cargofail
exit /b 0

:tauricli
rem %* is NOT affected by shift - it always holds the original argument list,
rem so the remaining args are spelled out explicitly instead.
cd /d "%~dp0"
echo [i] MSVC toolset : %VCToolsVersion%
echo [i] Windows SDK  : %SDKVER%
echo [i] headers from : %INC_MODE%
echo [i] command      : npx tauri %2 %3 %4 %5 %6 %7 %8 %9
echo.
npx tauri %2 %3 %4 %5 %6 %7 %8 %9
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
