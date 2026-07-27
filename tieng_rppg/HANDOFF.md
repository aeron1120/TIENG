# TIENG TouchFree Vitals — 인수인계 문서 (v2)

> 이 문서 하나로 다른 AI(Claude Code 등)나 사람이 바로 이어서 작업할 수 있도록 프로젝트 맥락·진행상황·다음 할 일을 정리했다.
> 이전 버전(`HANDOFF.md` v1, Cowork 세션 산출물)을 대체함. 작성 시점 기준 모든 코드는 동작 검증(selftest PASS + 실제 웹캠 라이브 확인) 완료 상태.

---

## 0. 한 줄 요약

카메라(웹캠) 한 대로 **심박수(HR)** 를 추정하고, **신호 품질지수(SQI)** 로 "믿을 만할 때만" 값을 보여주는(아니면 사유와 함께 보류) 비접촉 웰니스 모니터링 데모.
호흡수(RR)는 상체 움직임 기반 **보조 지표**. 대상: 1인 가구 고령자 돌봄. **의료기기 아님. SpO2·혈압 미구현(주장 금지).**

---

## 1. 프로젝트 배경 & 제품 철학

- **소속/맥락**: 학생 공모전(TIENG) 예선 단계 기획서 + 데모. 발표에서 라이브 시연 + 정량 검증 제시가 목표.
- **핵심 차별점**: rPPG 알고리즘 재현이 아니라 "측정 → **품질 판단(SQI 게이팅)** → 기록 → 이상 감지 → 보호자 알림"의 **완결된 돌봄 흐름**.
- **참고 자료 2건** (원본 PDF는 폴더에 없음, §7에 핵심만 추출):
  - **논문(rppg1)**: 「FMCW 레이더 유도 저주파 제거와 품질지수 융합 기반 rPPG 생체신호 추정」(단국대, 2025).
  - **기획서**: 「TouchFree Vitals - rPPG demo v2 기반 보완 기획서」.

### 이번 세션에서 정리된 "제품이 왜 의미있는가"에 대한 결론 (발표/기획서에 참고)
- 이 제품의 가치는 **정확도가 아니라 "정직한 존재감"** 에 있다는 결론. 웨어러블은 노인 대상 착용 순응도 문제로 현실에서 잘 실패하고, 카메라는 착용 없이 "가끔이라도" 신호를 준다는 게 강점.
- 단, 그 가치가 성립하려면 **모를 땐 모른다고 보류하는 정직함(SQI 게이팅)** 이 전제조건 — 장식 기능이 아니라 제품이 성립하기 위한 핵심.
- **한계도 명확히 인지**: rPPG는 물리적으로 동작(motion)에 매우 취약함(논문 자체 수치: 머리 움직임 시 MAE 13.4 → SQI<0.5 게이팅 후 2.89). 즉 지금 구조로는 **정적인 순간에만** 의미있는 측정이 나옴.
- **발전 방향으로 논의된 것 (미구현, 예선 기획서에 "발전 가능성"으로만 언급하기로 결정)**:
  1. **레이더 융합** (Seeed MR60BHA2 60GHz mmWave) — 흉벽 도플러는 머리 움직임에 상대적으로 안 흔들려서, 동적 상황에서도 진짜 활력징후를 잴 수 있는 근본 해법. §6-(B)에 이미 있던 로드맵 항목. **이번 세션 결론: 예선 단계이니 지금 구현하지 말고, 기획서에 "다음 단계 발전 가능성"으로만 문장으로 제시.**
  2. **활동/존재 감지 축 추가 (아이디어 단계, 미구현)** — 지금 ROI jitter/optical flow는 "HR 품질을 깎아먹는 방해 요소"로만 쓰이는데, 이를 뒤집어서 "가만히 있을 때=활력징후 측정 / 움직일 때=활동·생존 신호"로 이원화하면 하루 전체가 의미있어질 수 있다는 아이디어. 특히 "오랫동안 움직임이 전혀 없음"은 낙상/응급 상황을 잡는 독립적으로 유용한 신호. **다음 세션에서 이어서 논의/구현할 후보.**
  3. **순간값보다 트렌드**: 하루 몇 번의 정적 측정만 모아도, 며칠 누적하면 개인별 기준선(baseline) 대비 이상 탐지가 가능 — 커버리지 낮은 것의 실질적 완화책.

---

## 2. 현재 폴더/파일 구조

경로: **`C:\TIENG\tieng_rppg\`**

```
tieng_rppg/
├── rppg_demo_v4.py       # 메인 데모 (1342줄). 웹캠 HR/RR + SQI 게이팅 + 사이드 패널 UI. selftest PASS
├── run_experiment.py     # [신규] static/lighting/head_motion 3시나리오 자동 실행 + 요약표
├── roi_facemesh.py       # [옵션] MediaPipe 볼 다각형 ROI. mediapipe 없으면 자동 폴백. selftest PASS
├── evaluate.py           # 정량 검증 하네스 (펄스옥시미터 CSV 대비 MAE/RMSE 등). selftest PASS
├── confidence/           # [신규] 신뢰도·호흡수 모듈. 데모와 독립 실행/검증 가능. selftest PASS
│   ├── confidence.py       # 4층 confidence + 캘리브레이션 + fuse
│   ├── respiration.py      # 호흡수 골조 (Source × Estimator). --rr-engine new 가 사용
│   ├── integrate_webcam.py # confidence 단독 웹캠 배선 예제 (데모와 별개 파이프라인)
│   └── selftest_confidence.py / selftest_respiration.py
├── dashboard/
│   └── app.py            # FastAPI 로컬 대시보드 (숫자만 표시, 원본영상 미저장). selftest PASS
├── requirements.txt      # 의존성 (Pillow 추가됨 - 사이드 패널 한글 라벨용)
├── README.md
├── HANDOFF.md             # ← 이 문서
├── architecture.html / architecture_visual.html / healthcare_device_research.html  # 문서용 HTML 3종
```

> 실행 중 생기는 산출물(`run.csv`, `guardian_alerts.csv`, `caregiver_inbox_demo.txt`, `experiments/`)은 `.gitignore` 대상. 정식 파일 아님, 필요시 삭제해도 무방.
> `C:\TIENG\claude.md` 에 코딩 행동 지침(간결/외과적 수정/검증 우선)이 있음. 계속 따를 것.

---

## 3. 이번 세션에서 한 일 (v1 HANDOFF 이후)

1. **UI 전면 개편 — 오른쪽 사이드 패널**
   기존 상단 텍스트 오버레이(`cv2.putText`, 한글 불가)를 버리고, **Pillow 기반 한글 사이드 패널**로 교체.
   - HR 히어로 숫자 + 상태 배지(신뢰가능/사용가능/보류) + SQI 미터바
   - RR 보조지표(작게 표시) + 배지 + 미터바
   - 맥파 파형 스파크라인, ROI/신호 정보, 보호자 알림 상태, 하단 면책문구
   - 카메라 화면에도 이마/호흡 ROI 한글 태그(Pillow) 오버레이
   - 창 크기 조절/최대화 시 레터박스 + 비율 유지 확대(이중 리샘플링 없이 고해상도 원본에서 1회만 리사이즈 — 흐림 방지)
   - dataviz 스킬의 검증된 상태 팔레트(good/warning/critical) 사용
   - 브라우저(superpowers 비주얼 컴패니언)로 정적 목업 먼저 만들고 웹캠과 합쳐 검증 후 반영하는 과정 거침(현재 프로토타입 파일은 정리 완료, 결과만 `rppg_demo_v4.py`에 남음)
2. **버그 수정 3건** (UI 반영 후 실사용 중 발견)
   - ROI 박스 색상이 RGB/BGR 반전으로 뒤바뀌어 있던 것
   - 볼(양볼) ROI에 라벨을 달았더니 얼굴(눈 부근)을 가리던 것 → 이마에만 라벨 유지
   - RR이 `--`(미측정)일 때 배지가 위로 밀려 겹치던 것 → 폰트 고정 지표(`getmetrics()`) 기반으로 레이아웃 계산하도록 수정
3. **haarcascade 얼굴 검출기 누락 문제 해결**
   설치된 `opencv-python`/`opencv-contrib-python` 5.0.0.93 두 패키지 모두 `cv2/data/`에 haar cascade XML을 더 이상 번들하지 않는 게 원인이었음(패키지 자체의 사양 변경, 설치 깨짐 아님). 공식 OpenCV GitHub 저장소에서 `haarcascade_frontalface_default.xml`을 받아 `cv2.data.haarcascades` 경로에 직접 배치해서 해결. 이후 얼굴 검출 정상 동작, ROI가 `forehead` 고정에서 `multi`(이마+양볼)로 정상화됨.
   **주의**: 이 파일은 pip 패키지에 안 딸려오므로, 다른 환경에 새로 설치할 때 이 조치를 다시 해줘야 할 수 있음.
4. **SQI 배지 깜빡임(히스테리시스) 개선**
   기존엔 0.5초마다 raw SQI로 배지(신뢰가능/사용가능/보류)를 그대로 그려서, 경계값(0.50, 0.70) 근처 노이즈로 배지가 초 단위로 깜빡이는 문제가 있었음.
   → `hysteresis_label()` 함수 추가: 상태 전환에 dead-band(기본 ±0.04, `--sqi-hysteresis`로 조절)를 둬서 화면 라벨만 안정화. **CSV 로깅되는 raw SQI/게이팅 판정 자체는 그대로 유지**(연구 근거 훼손 방지가 설계 원칙).
   단, 헤드뱅잉처럼 SQI가 데드밴드 폭을 훨씬 넘어 크게 떨어지는 진짜 나쁜 순간은 여전히 즉시 "보류"로 전환됨(의도된 동작, 버그 아님).
5. **`--duration SEC` 옵션 + `run_experiment.py` 신규 작성**
   `rppg_demo_v4.py`에 지정 시간 후 자동 종료 옵션 추가(기본 무제한, 기존 동작 안 깨짐). 이를 이용해 `run_experiment.py`가 static→lighting→head_motion 3시나리오를 순차 자동 녹화(시나리오당 기본 60초, `--duration`으로 조절)하고 `experiments/<타임스탬프>/`에 CSV 저장 + 종료 후 시나리오별 요약표(HR평균/SQI평균/표시율/FPS) 콘솔 출력.
6. **디버깅 부산물 정리**: 세션 중 만든 프로토타입 파일(`ui_preview_A.py`, `ui_mockup_A.html`, `.superpowers/`)과 테스트용 CSV 다수 삭제 완료.

---
   
## 4. 실행 방법 & 검증

### 설치
```powershell
cd C:\TIENG\tieng_rppg
pip install -r requirements.txt
```
> haarcascade 파일이 없다는 에러가 뜨면 §3-3 조치를 다시 수행할 것:
> ```powershell
> $dest = (python -c "import cv2; print(cv2.data.haarcascades)").Trim() + "haarcascade_frontalface_default.xml"
> Invoke-WebRequest -Uri "https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/haarcascade_frontalface_default.xml" -OutFile $dest
> ```

### 알고리즘 자체 검증(카메라 불필요)
```powershell
python rppg_demo_v4.py --selftest        # SELFTEST RESULT: PASS
python evaluate.py --selftest
```

### 웹캠 데모
```powershell
python rppg_demo_v4.py                                   # 기본 (사이드 패널 UI)
python rppg_demo_v4.py --log run.csv --scenario static
python rppg_demo_v4.py --duration 60 --log run.csv        # 60초 후 자동 종료
```
q/ESC 종료. **웹캠 프로세스를 이전 창 안 닫고 중복 실행하면 카메라 충돌로 화면이 깨짐(경험함) — 새로 띄우기 전 기존 python 프로세스 종료 확인할 것.**

### 3시나리오 자동 실험 (신규)
```powershell
python run_experiment.py                      # 시나리오당 60초, experiments/<타임스탬프>/ 에 저장
python run_experiment.py --duration 90
```

### 웹 대시보드 (2개 터미널)
```powershell
python rppg_demo_v4.py --log run.csv --scenario static
python dashboard\app.py --csv run.csv --port 8000
```

---

## 5. 알려진 이슈 / 주의점

- **rPPG는 동작(motion)에 근본적으로 취약함**: 논문 자체 수치로 머리 움직임 시 MAE 13.4bpm. 지금 구조로는 정적 상황에서만 신뢰 가능. §1의 "제품 철학" 참고 — 이건 버그가 아니라 카메라 rPPG의 물리적 한계이며, 기획서에서 정직하게 포지셔닝해야 함.
- **단일 피험자 주의**: 논문 성능치는 단일 피험자 기준. "3bpm 이하"는 레이더 융합 결과이고 카메라 단독 정적 조건은 MAE 4.66.
- **저주파 제거의 한계**: HR 대역 안의 고조파는 못 없앰. 과대주장 금지.
- **범위 밖(구현 금지)**: SpO2, 혈압, 의료 진단 표현, 자격증명·동의 전 실제 SMS/카카오 발송.
- **`--sqi-hysteresis`는 표시 전용**: CSV의 raw `heart_sqi`/`heart_status`와는 별개. 정량 분석(evaluate.py)은 항상 raw 컬럼 기준으로 해야 함.

---

## 6. 다음 할 일 (우선순위)

### (A) 정량 검증 계속 (진행 중)
- `run_experiment.py`로 3시나리오 데이터는 모을 수 있게 됨. 다음: 실제 펄스옥시미터(CMS50E급, 예산 3만원) 확보해서 `evaluate.py --ref`로 MAE/RMSE 오차표 산출 — **기획서 6.3 정량 검증 계획의 핵심 산출물**.
- 펄스옥시미터 없이도 `run_experiment.py` 요약표(표시율/SQI평균)만으로 시나리오 간 비교 스토리는 가능.

### (B) 활동/존재 감지 축 (아이디어 확정, 구현 여부 미결정 — §1 참고)
- 다음 세션에서 "동적 상황에서도 의미있게" 방향을 이어가고 싶다면, ROI jitter/optical flow를 역이용한 활동 감지 + 장시간 무동작 알림부터 논의 시작.

### (C) 기획서/발표 자료
- §1의 "제품 철학" 문단과 레이더 발전 가능성을 예선 기획서에 반영.

### (D) 로드맵(나중, 하드웨어 필요)
- Seeed MR60BHA2 60GHz 레이더 연동 (본선 단계에서 고려).
- 공개 데이터셋(UBFC-rPPG, PURE) 오프라인 검증 — 용량 큼, 다운로드 경로 확보 필요.
- 라즈베리파이5 온디바이스 포팅.
- SQLite 기록·장기추세, 실제 이메일 알림.

---

## 7. 핵심 기술 참고

### SQI 정의 (논문 2.2.1, 식 2.1~2.5) — 현재 코드에 구현됨
```
peak_snr_db      = 10*log10(peak_psd / 대역내_노이즈중앙값)
hr_band_energy   = HR대역(0.7~3.0Hz) 에너지 / 전체대역(0.3~4.0Hz) 에너지
q_snr            = sigmoid((peak_snr_db - 6)/3)
q_energy         = clip(hr_band_energy, 0, 1)
q_roi            = clip(skin_ratio / 0.35, 0, 1)
q_brightness     = 1.0 if 45<=brightness<=220 else 0.5
q_motion         = 1.0 - 0.7*jitter_norm       # jitter_norm = clip(jitter_px/6, 0, 1)
SQI = clip((0.45*q_snr + 0.30*q_energy + 0.15*q_roi + 0.10*q_brightness) * q_motion, 0, 1)
게이트: SQI >= 0.50 일 때만 HR 표시/갱신. (0.70 이상 Reliable, 0.50~0.69 Usable, 미만 Hold)
```

### 표시 안정화 (이번 세션 추가, `hysteresis_label()`)
```
margin = --sqi-hysteresis (기본 0.04)
Hold → 표시 전환:      sqi >= gate + margin
표시 → Hold 전환:      sqi <  gate - margin
Usable → Reliable:     sqi >= 0.70 + margin
Reliable → Usable:     sqi <  0.70 - margin
```
raw SQI/게이팅 판정 자체와 무관한, 화면 배지 전용 로직.

### 논문 실험 결과(검증 목표치)
- 정적·조명고정 rPPG 단독: MAE 4.66 / RMSE 7.89 / ±5bpm 81.1% / ±10bpm 88.7%.
- 머리 움직임: MAE 13.4 → SQI<0.5 구간 제거 시 MAE 2.89 (게이팅 효과 = 이 데모의 핵심 근거).

### CSV 컬럼(`--log` 출력)
```
elapsed_sec, heart_bpm, heart_sqi, heart_status, heart_hold_reason,
resp_rpm, resp_sqi, resp_status, resp_hold_reason,
roi_name, skin_pixel_count, skin_ratio, brightness, roi_jitter_px,
peak_snr_db, hr_band_energy_ratio, q_snr, q_energy, q_motion,
lowfreq_applied, scenario, rr_engine, fps, heart_alert, resp_alert
```
`rr_engine` 은 나중에 추가된 열이다(`legacy`|`new`). 소비자(evaluate.py,
dashboard/app.py, run_experiment.py)는 모두 열 이름으로 읽으므로 기존 코드는 영향 없다.
`--rr-engine new` 인 행에서는 `resp_sqi` 가 SQI 가 아니라 confidence 값이다 —
두 엔진의 RR 을 섞어서 통계 내지 말 것.

---

## 8. 다음 AI에게 (작업 지침)

- 코드 스타일: 기존 파일 관례 유지(타입힌트, dataclass, 한국어 주석). `C:\TIENG\claude.md` 규칙(간결·외과적 수정·검증 우선) 준수.
- **큰 파일 수정 후 반드시** `python -m py_compile` + `--selftest` 로 회귀 확인. 웹캠 관련 변경은 실제 실행해서 확인할 것(에이전트가 화면을 직접 볼 순 없으니 CSV 출력이나 스크린샷 피드백으로 검증).
- 웹캠 데모를 여러 번 띄울 땐 **이전 python 프로세스가 남아있지 않은지 먼저 확인**(카메라 중복 점유 시 화면이 깨짐 — 실제로 겪은 문제).
- 새 기능은 옵션 플래그로 추가하고 기본 동작을 깨지 말 것(`--duration`, `--sqi-hysteresis` 처럼).
- 의료적 주장(SpO2/혈압/진단) 추가 금지. "demo only, not a medical device" 문구 유지.
- UI를 더 손볼 땐 브레인스토밍(디자인 논의) 먼저, 구현은 그 다음 — 이번 세션에서 이 순서로 진행했고 잘 맞았음(사용자 피드백).
- 가장 먼저 확인할 것: §6-(A) 펄스옥시미터 확보 여부, §6-(B) 활동감지 방향 결정 여부를 사용자에게 물어볼 것.

---

*이 문서는 Claude Code 세션에서 생성/갱신됨.*
