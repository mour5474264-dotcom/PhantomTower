@echo off
setlocal
cd /d "%~dp0"
if "%PHANTOM_LICENSE_ADMIN_SECRET%"=="" if exist "data\license-admin-secret.txt" set /p PHANTOM_LICENSE_ADMIN_SECRET=<"data\license-admin-secret.txt"
if "%PHANTOM_LICENSE_ADMIN_SECRET%"=="" set /p PHANTOM_LICENSE_ADMIN_SECRET=请输入授权管理密钥：
if "%PHANTOM_LICENSE_ADMIN_SECRET%"=="" (
  echo.
  echo 未输入管理员密钥，程序未启动。
  pause
  exit /b 1
)
if not exist "data" mkdir "data"
if not exist "data\license-admin-secret.txt" >"data\license-admin-secret.txt" echo %PHANTOM_LICENSE_ADMIN_SECRET%
if "%~1"=="" (
  node cloudflare-api\scripts\license-admin-tencent.cjs
) else (
  node cloudflare-api\scripts\license-manager-tencent.cjs %*
)
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
  echo.
  echo 管理台启动失败，错误代码：%exitCode%
  pause
)
exit /b %exitCode%
