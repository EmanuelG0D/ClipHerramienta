@echo off
title OpenShorts AI - Creador de Clips
cd /d "%~dp0"
echo ===================================================
echo     INICIANDO OPENSHORTS AI (CREADOR DE CLIPS)
echo ===================================================
echo.
echo Abriendo servidor en http://localhost:8000/#app ...
timeout /t 2 >nul
start "" http://localhost:8000/#app
echo.
echo Presiona Ctrl+C en esta ventana para detener el servidor.
echo ===================================================
echo.
.\.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
pause
