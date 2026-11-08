@echo off
setlocal
call "%~dp0install.cmd" --check %*
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%