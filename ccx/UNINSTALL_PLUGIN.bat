@echo off
setlocal

fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator permission...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory 'C:\'"
  exit /b
)

set "UPIA=C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

if not exist "%UPIA%" (
  echo Adobe UnifiedPluginInstallerAgent was not found.
  echo Install or repair Adobe Creative Cloud Desktop, then try again.
  echo.
  pause
  exit /b 1
)

echo Removing Flux Local Edit...
echo.

pushd C:\
"%UPIA%" /remove "Flux Local Edit"
echo.
"%UPIA%" /list all | findstr /i /c:"Flux Local Edit" >nul
set "PLUGIN_FOUND=%ERRORLEVEL%"
popd

if "%PLUGIN_FOUND%"=="0" (
  echo Adobe still reports Flux Local Edit as installed.
  echo Check: C:\ProgramData\Adobe\UPI\Log\Upia.log
  echo Check: C:\ProgramData\Adobe\UPI\Log\EMCL.log
) else (
  echo Flux Local Edit is removed.
  echo Restart Photoshop if it was open.
)

echo.
pause
exit /b %PLUGIN_FOUND%
