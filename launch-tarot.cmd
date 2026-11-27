@echo off
rem ============================================================
rem  Tarot reader - launcher
rem
rem  Why a .cmd instead of pointing the shortcut straight at
rem  index.html: when Windows hands the .html to the default
rem  browser, an already-open window just gets a new tab and it
rem  can look like nothing happened. Launching the browser
rem  explicitly with --new-window guarantees a fresh window.
rem
rem  NOTE: this file is deliberately pure ASCII. cmd.exe parses
rem  batch files using the system ANSI codepage (GBK on a
rem  Chinese Windows), so UTF-8 Chinese text in here would turn
rem  into mojibake. The app itself is UTF-8 and unaffected.
rem ============================================================

setlocal

set "APP=%~dp0index.html"

if not exist "%APP%" (
  echo.
  echo   Cannot find index.html
  echo   Expected at: %APP%
  echo.
  echo   This launcher must sit in the same folder as index.html.
  echo.
  pause
  exit /b 1
)

set "BROWSER="

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if defined BROWSER (
  start "" "%BROWSER%" --new-window "%APP%"
) else (
  rem no known browser found - let the system pick
  start "" "%APP%"
)

exit /b 0
