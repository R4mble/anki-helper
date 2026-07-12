@echo off
setlocal
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File "%~dp0win-cut-bbc-pic-hotkey.ps1" -Port %1 -PidFile "%~2" -StatusFile "%~3" -LogFile "%~4"
