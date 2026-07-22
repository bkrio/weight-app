@echo off
REM Double-click to test the Weight Tracker locally in your browser.
REM Requires Node.js (already installed on this machine).
cd /d "%~dp0"
echo ============================================================
echo   Weight Tracker - local test server
echo   Opening http://localhost:8123/ in your browser...
echo   Keep this window OPEN while testing. Close it to stop.
echo ============================================================
echo.
start "" "http://localhost:8123/"
node tools\serve.mjs
echo.
echo Server stopped. Press any key to close this window.
pause >nul
