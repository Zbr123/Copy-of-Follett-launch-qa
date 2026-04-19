@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to launch Follett Launch QA.
  echo Please install Node.js 20+ and try again.
  pause
  exit /b 1
)

node scripts\launch-local.js
pause
