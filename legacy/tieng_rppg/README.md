# TIENG TouchFree Vitals — rPPG 데모 v4 (논문/기획서 발전 반영)

카메라 한 대로 심박수(HR)를 추정하고 **신호 품질지수(SQI)** 로 측정 가능 상태를 판단해,
품질이 낮은 구간에서는 값을 **보류(hold)** 하는 웰니스 모니터링 보조 데모.
rppg1 논문(FMCW 레이더 유도 저주파 제거 + 품질지수 융합)과 TIENG 기획서의 발전 포인트를 반영했다.

> 연구·교육·시연용. 의료 진단/응급 판단/치료 결정에 사용하지 말 것. SpO2·혈압은 미구현이며 주장하지 않음.

## 폴더 구조

```
tieng_rppg/
├── rppg_demo_v4.py        # 메인 데모 (웹캠 HR/RR + SQI 게이팅 + 저주파제거/facemesh/프로파일링)
├── roi_facemesh.py        # [2순위] MediaPipe 볼 다각형 ROI (선택, 미설치 시 자동 폴백)
├── evaluate.py            # [1순위] 펄스옥시미터 기준 정량 검증(MAE/RMSE/±5·±10/보류율/플롯)
├── confidence/            # 신뢰도·호흡수 모듈 (데모와 독립 실행/검증 가능)
│   ├── confidence.py        # 4층 confidence (게이트→SQI→시간일관성→캘리브레이션) + fuse
│   ├── respiration.py       # 호흡수 추정 (Source × Estimator 분리). --rr-engine new 가 사용
│   ├── example_wiring.py    # 배선 예제 (카메라 불필요). 웹캠 루프는 데모에만 있음
│   └── selftest_*.py        # 합성 신호 자체 검증
├── dashboard/
│   └── app.py             # [6순위] FastAPI 로컬 대시보드 (숫자만, 원본영상 미저장)
├── requirements.txt
└── README.md
```

## 설치

```bash
pip install -r requirements.txt
# 최소 실행만 원하면: pip install numpy scipy opencv-python
```

## 이번 반영 항목 (우선순위별)

| # | 항목 | 근거 | 플래그/파일 |
|---|------|------|-------------|
| 1 | 정량 검증 하네스 | 기획서 6.3·12-4, 논문 5.2 | `evaluate.py` |
| 2 | 볼 다각형 ROI + YCrCb | 논문 2.1.2 / Fig 2-3 | `--use-facemesh`, `roi_facemesh.py` |
| 3 | 카메라 단독 저주파 제거 | 논문 4.1.2(레이더 유도)의 카메라 근사 | `--lowfreq-ref` |
| 4 | SQI 성분·시나리오·FPS 로깅 | 논문 5.2 조건별 분석 | `--scenario`, 확장 CSV |
| 5 | 성능 프로파일링 | 기획서 6.3(10~15 FPS) | `--profile` |
| 6 | 로컬 대시보드 + 프라이버시 | 기획서 8.2·3.2·5.3 | `dashboard/app.py` |

## 실행 명령어

```bash
# 알고리즘 자체 검증 (카메라 불필요)
python rppg_demo_v4.py --selftest

# 기본 데모
python rppg_demo_v4.py

# 논문 3종 실험 시나리오 (각 60초, CSV 태깅)
python rppg_demo_v4.py --log static.csv       --scenario static       --profile
python rppg_demo_v4.py --log lighting.csv     --scenario lighting      --profile
python rppg_demo_v4.py --log head_motion.csv  --scenario head_motion   --profile

# 저주파 제거 + 볼 다각형 ROI 동시 사용
python rppg_demo_v4.py --lowfreq-ref --use-facemesh --log run.csv --scenario lighting

# 호흡수 엔진 교체 (기본은 legacy = 내장 estimate_respiration)
python rppg_demo_v4.py --rr-engine new --log run.csv --scenario static

# 정량 검증 (펄스옥시미터 CSV와 비교)
python evaluate.py --demo static.csv --ref pulseox.csv --out report/
python evaluate.py --demo head_motion.csv --ref pulseox.csv --offset -1.5   # 시작시각 정렬 보정
python evaluate.py --selftest

# 로컬 대시보드 (데모가 --log 로 쓰는 CSV를 실시간 표시)
python dashboard/app.py --csv run.csv --port 8000    # http://127.0.0.1:8000
python dashboard/app.py --selftest
```

### 기준(ref) CSV 형식
`evaluate.py` 는 시간 열(`elapsed_sec/time/sec/t`)과 BPM 열(`bpm/hr/pulse/spo2_hr`)을 자동 인식한다.
인식 실패 시 `--ref-time-col`, `--ref-bpm-col` 로 직접 지정. 시작시각이 다르면 `--offset` 로 맞춘다.

## 디버깅 포인트

- **HR이 계속 hold 된다** → 데모 화면의 `ROI=/skin=NNNpx/jit=/SQI` 를 본다.
  - `skin` ≈ 0 : YCrCb 임계값이 조명/피부톤과 안 맞음 → `rppg_demo_v4.skin_mask_ycrcb()` Cr/Cb 조정.
  - `jit` 큼 : 움직임 페널티가 SQI를 눌렀음 → 고정 자세 유도 또는 `--jitter-scale-px` ↑.
  - hold `lighting` : 밝기가 45~220 밖 → `--bright` 또는 조명 개선.
- **저주파 제거 효과가 없다(`LF` 표시는 뜨는데 개선 X)** → 호흡 참조가 약함.
  가슴이 주황 박스에 들어오는지 확인(`chest ROI not visible` 이면 참조 미수집). `estimate_bpm(ref_times/ref_values)` 로 진단.
- **facemesh가 안 켜진다** → 콘솔 `[facemesh] mediapipe 미설치 ...` → `pip install mediapipe`.
  안 깔아도 Haar 사각형 ROI로 정상 동작(폴백).
- **FPS 미달** (`--profile` 이 "미달" 표시) → 해상도(`--width/--height`)↓, `--update-sec`↑, facemesh off.
- **evaluate 결과 n이 0/작다** → demo·ref 시간축 미정렬. `--offset` 로 시작시각 맞추고 `--tolerance` 확대.
- **대시보드가 `waiting`** → `--csv` 경로가 데모 `--log` 와 동일한지 확인. 데모가 실제로 쓰고 있어야 함.

## 자체 검증(selftest) 요약

| 대상 | 명령 | 내용 |
|------|------|------|
| 데모 코어 | `python rppg_demo_v4.py --selftest` | 스킨마스크·HR 5종(≤3bpm)·SQI 게이팅·저주파제거·호흡 |
| facemesh 기하 | `python roi_facemesh.py` | 다각형→마스크→RGB, 가중결합 (cv2만 필요) |
| 검증 하네스 | `python evaluate.py --selftest` | MAE/게이팅 대비/coverage/정렬 |
| 대시보드 | `python dashboard/app.py --selftest` | 엔드포인트/waiting/프라이버시 |
| confidence | `cd confidence && python selftest_confidence.py` | 오차 상관·캘리브레이션·히스테리시스·융합·알림 |
| 호흡수 골조 | `cd confidence && python selftest_respiration.py` | 추정기 4종·윈도우 길이·RIAV/RIFV/RIIV·융합 |

## 아직 안 한 것 (범위 방어)

- SpO2·혈압 추정 (기획서 12-2: 경쟁사 영역, 데모 범위 밖)
- 실제 SMS/카카오 발송 (자격증명·동의 전까지 CSV/이메일 데모만)
- 실제 FMCW 레이더 융합 (논문의 하드웨어 파트) — `--lowfreq-ref` 는 그 아이디어의 카메라 단독 근사
```
