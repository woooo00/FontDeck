@echo off
rem FontDeck: start the local service silently and return immediately.
rem launcher.pyw is run by pythonw.exe (GUI subsystem), which never creates a
rem console window; it in turn starts node with CREATE_NO_WINDOW.
rem Pure ASCII on purpose: cmd.exe parses this file with the system code page.
cd /d "%~dp0"
start "" "C:\Users\6\.workbuddy\binaries\python\envs\default\Scripts\pythonw.exe" "%~dp0launcher.pyw"
exit /b 0
