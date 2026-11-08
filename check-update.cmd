@echo off
setlocal
call "%~dp0install.cmd" --check-update %*
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%