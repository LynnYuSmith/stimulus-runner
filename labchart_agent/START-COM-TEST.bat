@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title LabChart COM test
echo.
echo   No network: checks that this PC can talk to LabChart, and puts ONE test comment into it.
echo   Open LabChart 8 with a document (recording or not) first.
echo.
pause
"%~dp0python-win64\python.exe" "%~dp0labchart_agent.py" --com-test
echo.
echo   Look for "COM test from the comment agent" in LabChart. The result is also in agent-log.txt.
pause
