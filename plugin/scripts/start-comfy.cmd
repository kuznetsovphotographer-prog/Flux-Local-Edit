@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "LOCAL_EDIT_COMFYUI_DIR="
if exist "%~dp0comfyui-path.txt" set /p "LOCAL_EDIT_COMFYUI_DIR="<"%~dp0comfyui-path.txt"
if not defined LOCAL_EDIT_COMFYUI_DIR exit /b 1
set "PYW=%LOCAL_EDIT_COMFYUI_DIR%\venv\Scripts\pythonw.exe"
if not exist "%PYW%" (
  if not exist "%LOCALAPPDATA%\LocalEdit" mkdir "%LOCALAPPDATA%\LocalEdit"
  >"%LOCALAPPDATA%\LocalEdit\comfy-launch.log" echo ComfyUI's venv\Scripts\pythonw.exe was not found. Check comfyui-path.txt.
  exit /b 1
)
start "" /b "%PYW%" "%~dp0start-comfy.py"
