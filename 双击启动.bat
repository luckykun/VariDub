@echo off
rem =====================================================================
rem  VariDub launcher entry.
rem  Keep THIS file ASCII-only: cmd seeks .bat lines by byte offset, so any
rem  non-ASCII text whose bytes disagree with the console codepage makes cmd
rem  execute `rem` comments as commands ('ectron-vite' is not recognized).
rem  All Chinese UI lives in scripts\launch.ps1 (UTF-8 with BOM), which talks
rem  to the console through the Unicode API and is codepage-independent.
rem
rem  Usage:  (double-click)        -> interactive menu
rem          this.bat packaged|mock|dev|smoke
rem =====================================================================
setlocal
set "PS1=%~dp0scripts\launch.ps1"
if not exist "%PS1%" goto missing
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"
goto bye

:missing
echo [VariDub] scripts\launch.ps1 not found next to this .bat.
echo           Keep the whole repository together, or run:
echo           npm run dev
set "RC=1"

:bye
endlocal & exit /b %RC%
