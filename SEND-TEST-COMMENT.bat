@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title LabChart comment test
echo.
echo   Sends three test comments to the comment agent on the LabChart PC (address from labchart.txt).
echo   Start the agent there first (START-AGENT.bat) with LabChart open.
echo.
set "PY="
for %%P in ("%~dp0python-win64\python.exe" "%~dp0python-win32\python.exe") do (
  if not defined PY if exist %%P ( %%P --version >nul 2>&1 && set "PY=%%~P" )
)
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY ( echo   No Python found next to this file. & pause & exit /b 1 )
"%PY%" "%~dp0send_test_comment.py" %*
pause
