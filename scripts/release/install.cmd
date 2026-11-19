@echo off
rem ---------------------------------------------------------------------------
rem FontDeck installer.
rem
rem Everything here is ASCII on purpose: cmd.exe parses .cmd files byte by byte
rem using the system code page (936 on a Chinese Windows), so UTF-8 Chinese text
rem in this file would break the command lines apart.
rem
rem Layout after install:
rem   %LOCALAPPDATA%\FontDeck\runtime\        node.exe + portable python (shared)
rem   %LOCALAPPDATA%\FontDeck\app\<version>\  application code (one per version)
rem   %LOCALAPPDATA%\FontDeck\current         text file: absolute path of active app
rem   %APPDATA%\Adobe\CEP\extensions\com.fontdeck.panel
rem
rem The panel reads the "current" pointer at startup, so switching or rolling
rem back a version is just rewriting that one file.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
title FontDeck Installer

set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

if not exist "%SRC%\VERSION" goto :nofiles
set "VER="
for /f "usebackq delims=" %%v in ("%SRC%\VERSION") do set "VER=%%v"
if "%VER%"=="" goto :nofiles

set "FD=%LOCALAPPDATA%\FontDeck"
set "APPDIR=%FD%\app\%VER%"
set "RUNTIME=%FD%\runtime"
set "PANEL=%APPDATA%\Adobe\CEP\extensions\com.fontdeck.panel"

echo.
echo   FontDeck %VER%
echo   ---------------------------------------------
echo   install to : %APPDIR%
echo.

if not exist "%FD%" mkdir "%FD%" >nul 2>&1
if not exist "%FD%\app" mkdir "%FD%\app" >nul 2>&1

rem --- runtime is shared between versions; only lay it down once -------------
if exist "%RUNTIME%\node\node.exe" if exist "%RUNTIME%\python\python.exe" goto :runtime_ready
echo   [1/3] runtime (node + python, about 400 MB) ...
if exist "%RUNTIME%" rmdir /s /q "%RUNTIME%"
xcopy "%SRC%\runtime" "%RUNTIME%\" /e /i /q /h /y >nul
if errorlevel 1 goto :fail_runtime
:runtime_ready

rem --- application code ------------------------------------------------------
echo   [2/3] application ...
if exist "%APPDIR%" rmdir /s /q "%APPDIR%"
xcopy "%SRC%\app" "%APPDIR%\" /e /i /q /h /y >nul
if errorlevel 1 goto :fail_app

rem --- remember the previous version so a bad release can be rolled back ----
if exist "%FD%\current" (
    set "OLD="
    for /f "usebackq delims=" %%c in ("%FD%\current") do set "OLD=%%c"
    if not "!OLD!"=="" (
        if /i not "!OLD!"=="%APPDIR%" (
            >"%FD%\current.previous" echo !OLD!
        )
    )
)
>"%FD%\current" echo %APPDIR%

rem --- panel shell -----------------------------------------------------------
echo   [3/3] Illustrator panel ...
if not exist "%APPDATA%\Adobe\CEP\extensions" mkdir "%APPDATA%\Adobe\CEP\extensions" >nul 2>&1
if exist "%PANEL%" rmdir /s /q "%PANEL%"
xcopy "%SRC%\panel" "%PANEL%\" /e /i /q /h /y >nul
if errorlevel 1 goto :fail_panel

rem --- stop the old service, otherwise it keeps holding port 47615 and the
rem     new version would never be the one answering ------------------------
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":47615" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%p >nul 2>&1
)

echo.
echo   Done.
echo.
echo   Next step: fully quit Illustrator (not just close the panel) and start
echo   it again. The panel shell can only be reloaded by the host application.
echo.
echo   If the panel window was already open, reopen it from:
echo     Window ^> Extensions ^> FontDeck
echo.
pause
exit /b 0

:fail_runtime
echo.
echo   ERROR: failed to copy runtime. Is disk full?
pause
exit /b 1

:fail_app
echo.
echo   ERROR: failed to copy application files.
pause
exit /b 1

:fail_panel
echo.
echo   ERROR: failed to install the panel into the CEP extensions folder.
echo   Target: %PANEL%
pause
exit /b 1

:nofiles
echo.
echo   ERROR: VERSION or package files are missing.
echo   Extract the whole zip first, then run install.cmd from that folder.
echo   Current folder: %SRC%
pause
exit /b 1
