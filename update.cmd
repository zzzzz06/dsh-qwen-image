@echo off
setlocal
set "HERE=%~dp0"
set "CODE=1"

node --version >nul 2>nul
if errorlevel 1 goto find_runtime

node "%HERE%install.mjs" --upgrade %*
set "CODE=%ERRORLEVEL%"
goto finish

:find_runtime
set "APP=%DSH_APP%"
if not exist "%APP%" set "APP=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if not exist "%APP%" set "APP=%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe"
if exist "%APP%" goto run_electron

echo 找不到 node，也找不到 DeepSeek Harness。
echo 请安装 Node.js，或把本文件放到 DSH 插件目录后重试。
echo.
goto finish

:run_electron
set "ELECTRON_RUN_AS_NODE=1"
"%APP%" "%HERE%install.mjs" --upgrade %*
set "CODE=%ERRORLEVEL%"
goto finish

:finish
if "%~1"=="" pause
exit /b %CODE%