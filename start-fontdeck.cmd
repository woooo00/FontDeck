@echo off
rem FontDeck: start the local service silently and return immediately.
rem launcher.pyw runs under pythonw.exe (GUI subsystem) so no console window
rem ever appears; it starts node with CREATE_NO_WINDOW.
rem Pure ASCII on purpose: cmd.exe parses this file with the system code page.
cd /d "C:\Users\6\WorkBuddy\2026-11-09-14-23-57\fontdeck"
start "" "C:\Users\6\.workbuddy\binaries\python\envs\default\Scripts\pythonw.exe" "C:\Users\6\WorkBuddy\2026-11-09-14-23-57\fontdeck\launcher.pyw"
exit /b 0
