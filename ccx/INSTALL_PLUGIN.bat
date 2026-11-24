@echo off
setlocal DisableDelayedExpansion

set "LOCAL_EDIT_BAT=%~f0"
fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator permission...
  powershell -NoProfile -Command "try { Start-Process -FilePath $env:LOCAL_EDIT_BAT -Verb RunAs -WorkingDirectory ($env:SystemDrive + '\') -ErrorAction Stop } catch { Write-Error $_; exit 1 }"
  if errorlevel 1 exit /b 1
  exit /b 0
)

set "ADOBE_COMMON=%CommonProgramFiles%"
if defined CommonProgramW6432 set "ADOBE_COMMON=%CommonProgramW6432%"
set "UPIA=%ADOBE_COMMON%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
set "CCX=%~dp0com.local.photoshop.flux-local-edit_PS.ccx"

if not exist "%UPIA%" (
  echo Adobe UnifiedPluginInstallerAgent was not found.
  echo Install or repair Adobe Creative Cloud Desktop, then try again.
  echo.
  pause
  exit /b 1
)

if not exist "%CCX%" (
  echo Plugin package was not found next to this installer:
  echo "%CCX%"
  echo.
  pause
  exit /b 1
)

echo Installing Local Edit 0.4.0. Close Photoshop before installing.
echo.

pushd "%SystemDrive%\" || exit /b 1
"%UPIA%" /install "%CCX%"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" "%UPIA%" /list all
popd

if "%RC%"=="0" (
  echo Adobe reports successful installation.
  echo Restart Photoshop, then open Plugins ^> Local Edit.
) else (
  echo Adobe installation failed with exit code %RC%.
  echo Check: "%ProgramData%\Adobe\UPI\Log\Upia.log"
  echo Check: "%ProgramData%\Adobe\UPI\Log\EMCL.log"
)

echo.
pause
exit /b %RC%
