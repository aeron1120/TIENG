@echo off
REM 개발용 실행. 백엔드와 프론트를 각각 새 창으로 띄운다.
REM
REM   scripts\dev.bat         실측 모드 (웹캠 사용)
REM   scripts\dev.bat mock    웹캠 없이 (mock 센서만)
REM
REM 띄운 창 두 개를 닫으면 종료된다.

setlocal

REM %~dp0.. 를 그대로 쓰면 ".." 가 남는다. 경로에 한글/공백이 섞이면 인용이
REM 꼬이므로 여기서 절대경로로 펴 둔다.
pushd "%~dp0.."
set "ROOT=%CD%"
popd

if /I "%~1"=="mock" (
  set "CFG=config\device.mock.yaml"
) else (
  set "CFG=config\device.yaml"
)

if not exist "%ROOT%\.venv\Scripts\uvicorn.exe" (
  echo [!] .venv 가 없다. 저장소 루트에서 먼저 실행할 것:
  echo       python -m venv .venv
  echo       .venv\Scripts\activate
  echo       pip install -e ".[dev]"
  pause
  exit /b 1
)

if not exist "%ROOT%\web\node_modules" (
  echo [!] web\node_modules 가 없다. 먼저 실행할 것:
  echo       cd web
  echo       npm install
  pause
  exit /b 1
)

start "TFV backend" /d "%ROOT%" cmd /k "set DEVICE_CONFIG=%CFG%&& .venv\Scripts\uvicorn.exe api.main:app --port 8000"
start "TFV web" /d "%ROOT%\web" cmd /k "npm run dev"

echo.
echo    설정      %CFG%
echo    대시보드   http://localhost:5173/
echo    API 문서   http://127.0.0.1:8000/docs
echo.
if /I not "%~1"=="mock" echo    실측 모드는 웹캠을 점유한다. 끄려면 두 창을 닫을 것.
echo.
endlocal
