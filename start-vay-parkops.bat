@echo off
set "APP_DIR=%~dp0"
set "NODE_EXE=C:\Users\Home\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
cd /d "%APP_DIR%"
echo Starting VAY ParkOps Control...
echo.
echo Open this URL in your browser:
echo http://localhost:4175
echo.
"%NODE_EXE%" server.mjs
pause
