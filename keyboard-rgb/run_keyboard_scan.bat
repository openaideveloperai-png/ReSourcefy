@echo off
rem Starts the read-only keyboard scan. Installs the open-source "hidapi" package from PyPI if needed.
cd /d "%~dp0"
where py >nul 2>nul || (echo Python is not installed. Get it from https://www.python.org/downloads/ and run this again. & pause & exit /b 1)
py -m pip install --user --quiet --disable-pip-version-check hidapi
py keyboard_scan.py
pause
