@echo off
rem Double-click this file to start the overlay.
rem main.js starts the backend (server.js) by itself, hidden, and kills it on quit.
rem Keep this file ASCII-only: Chinese comments + chcp 65001 can break cmd parsing.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox
exit
