@echo off
setlocal
if "%~1"=="" (
  call "%~dp0install.cmd" --uninstall --profile desktop
) else (
  call "%~dp0install.cmd" --uninstall %*
)
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%