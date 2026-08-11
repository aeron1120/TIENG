@echo off
REM TouchFree Vitals - development launcher.
REM
REM   scripts\dev.bat         live mode (uses the webcam)
REM   scripts\dev.bat mock    no webcam, synthetic sensors
REM
REM Opens two windows (backend + web). Close both to stop.
REM
REM ASCII only on purpose: cmd.exe reads .bat files in the OEM codepage
REM (CP949 on Korean Windows), so non-ASCII bytes corrupt parsing.
REM Korean documentation lives in docs\hardware.md instead.

setlocal

REM "%~dp0.." leaves a ".." in the path. Expand it so quoting stays sane
REM even though the repo path contains spaces and non-ASCII characters.
pushd "%~dp0.."
set "ROOT=%CD%"
popd

if /I "%~1"=="mock" (set "CFG=config\device.mock.yaml") else (set "CFG=config\device.yaml")

if not exist "%ROOT%\.venv\Scripts\uvicorn.exe" goto :no_venv
if not exist "%ROOT%\web\node_modules" goto :no_node

REM Child processes inherit this, so nothing has to be chained inside start.
REM Chaining with && inside a quoted cmd /k argument is fragile.
set "DEVICE_CONFIG=%CFG%"

REM --reload watches our packages only. Plain --reload walks the whole tree,
REM so .venv and web\node_modules get watched too and a pip/npm install would
REM restart the server. Config files are not watched either way (uvicorn only
REM looks at .py), so a device.yaml edit still needs a manual restart.
REM
REM In live mode each reload re-opens the camera, which costs a few seconds on
REM picamera2 -- it settles auto-exposure before locking it (core/adapters/rppg.py).
start "TFV backend" /d "%ROOT%" cmd /k .venv\Scripts\uvicorn.exe api.main:app --port 8000 --reload --reload-dir api --reload-dir core --reload-dir actuators
start "TFV web" /d "%ROOT%\web" cmd /k npm run dev

echo.
echo   config      %CFG%
echo   dashboard   http://localhost:5173/
echo   api docs    http://127.0.0.1:8000/docs
echo.
if /I not "%~1"=="mock" echo   Live mode holds the webcam. Close both windows to stop.
if /I "%~1"=="mock" echo   Wait ~50s to watch the L1 light intervention fire.
echo.
goto :eof

:no_venv
echo [!] .venv not found. From the repo root:
echo       python -m venv .venv
echo       .venv\Scripts\activate
echo       pip install -e ".[dev]"
pause
exit /b 1

:no_node
echo [!] web\node_modules not found. Run:
echo       cd web
echo       npm install
pause
exit /b 1
