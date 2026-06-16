@echo off
title NANDO GAME - FLASHEADOR ESP32
color 0A
cls

echo ========================================
echo    NANDO GAME - FLASHEADOR ESP32
echo ========================================
echo.
echo Conecta el ESP32 por USB. 
echo.

set PORT=
for /f "tokens=2 delims=:" %%A in ('mode 2^>nul ^| findstr /i "COM"') do (
  set PORT=%%A
  goto :found
)

if "%PORT%"=="" (
  echo No se detecto ningun puerto COM.
  set /p PORT="Ingresa el puerto manualmente (ej: COM3): "
) else (
  echo Puerto detectado: %PORT%
)

:found
set PORT=%PORT: =%
echo.
echo Flasheando en %PORT%...
echo.

esptool.exe --chip esp32 --port %PORT% --baud 921600 write-flash --erase-all 0x0 firmware.bin

if %errorlevel% neq 0 (
  color 0C
  echo.
  echo ERROR: No se pudo flashear.
  echo.
  pause
  exit /b 1
)

color 0A
echo.
echo ========================================
echo    FLASHEO EXITOSO!
echo ========================================
pause
