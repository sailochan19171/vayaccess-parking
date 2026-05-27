@echo off
REM VayAccess Systems · Parking Control
REM Reuses the existing venv at D:\park-vision-pro\2026-05-19\venv (~2 GB of installed deps).
SET VENV_PYTHON=D:\park-vision-pro\2026-05-19\venv\Scripts\python.exe

echo Starting VayAccess Systems on http://localhost:5002
"%VENV_PYTHON%" "%~dp0app.py"
pause
