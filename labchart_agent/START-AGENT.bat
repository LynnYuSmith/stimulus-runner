@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title LabChart comment agent
echo.
echo   LabChart comment agent: puts every stimulus the runner plays into LabChart as a comment.
echo   Open LabChart 8 with your document first. Keep this window open during the session.
echo   The first time, Windows may ask to allow network access: allow it (private/domain network).
echo.
"%~dp0python-win64\python.exe" "%~dp0labchart_agent.py" %*
echo.
echo   The agent stopped. Its log is agent-log.txt next to this file.
pause
