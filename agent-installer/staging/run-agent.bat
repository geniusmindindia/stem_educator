@echo off
title StemEducatorApp Hardware Agent
cd /d "%~dp0"
echo.
echo Starting the hardware agent...
echo Keep this window open while using hardware features on the web app.
echo Close this window to stop the agent.
echo.
"node-runtime\node.exe" src\index.js
pause
