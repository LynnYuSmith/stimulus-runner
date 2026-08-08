@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Grating Stimulator
set "LOG=%~dp0runner-log.txt"
echo ============================================================ > "%LOG%"
echo  Grating Stimulator launch log  %DATE% %TIME% >> "%LOG%"
echo  OS arch: %PROCESSOR_ARCHITECTURE%  WOW64: %PROCESSOR_ARCHITEW6432% >> "%LOG%"
echo ============================================================ >> "%LOG%"

REM ---- choose a Python that actually RUNS on this machine ----
REM Prefer the arch-appropriate bundled Python, verify with --version,
REM then try the other bundled arch, then any system Python.
set "PY="
set "A64=%~dp0python-win64\python.exe"
set "A32=%~dp0python-win32\python.exe"

if /I "%PROCESSOR_ARCHITECTURE%"=="x86" (
  if defined PROCESSOR_ARCHITEW6432 ( call :try "%A64%" & call :try "%A32%" ) else ( call :try "%A32%" & call :try "%A64%" )
) else (
  call :try "%A64%" & call :try "%A32%"
)
if not defined PY ( where py      >nul 2>nul && ( set "PY=py -3"   & echo using system: py -3   >> "%LOG%" ) )
if not defined PY ( where python  >nul 2>nul && ( set "PY=python"  & echo using system: python  >> "%LOG%" ) )
if not defined PY ( where python3 >nul 2>nul && ( set "PY=python3" & echo using system: python3 >> "%LOG%" ) )

if not defined PY (
  echo.
  echo   Could not start Python. None of the bundled Pythons ran and no
  echo   system Python was found. Details are in:
  echo       %LOG%
  echo.
  echo   Send me runner-log.txt and I will fix the bundle.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the Grating Stimulator...
echo   Using: %PY%
echo   A browser (Edge) will open. KEEP THIS WINDOW OPEN while presenting.
echo   Close it (or press Ctrl-C) to stop.
echo.
echo   launching: %PY% serve.py >> "%LOG%"
%PY% serve.py 2>> "%LOG%"
set "RC=%ERRORLEVEL%"

echo.
echo ------------------------------------------------------------
echo   The server stopped (exit code %RC%).
if not "%RC%"=="0" (
  echo   It exited with an ERROR. Details were written to:
  echo       %LOG%
  echo   Send me that file and I will fix it.
)
echo ------------------------------------------------------------
pause
exit /b %RC%

:try
if defined PY goto :eof
if not exist %1 goto :eof
%1 --version >> "%LOG%" 2>&1
if errorlevel 1 ( echo FAILED to run: %1 >> "%LOG%" & goto :eof )
set "PY=%1"
echo using bundled: %1 >> "%LOG%"
goto :eof
