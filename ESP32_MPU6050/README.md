# ESP32·MPU6050 실험 데이터 분석

사용자는 2026-09-30에 현재 자료가 실제 실험 데이터이며 이전 합성 자료에서 파일명과 설명을 복사했다고 확인했습니다. 이 설명을 기준으로 측정 자료의 파일명을 `REAL_`로 통일했습니다. CSV의 수치·열 이름과 NPZ 배열은 변경하지 않았습니다.

## 파일 구성

| 파일 | 내용 |
|---|---|
| `data/REAL_trials_145.csv` | 29조건 × 5회 개별 결과 |
| `data/REAL_summary_29.csv` | 조건별 평균·표본 SD·후보 수 |
| `data/REAL_*_repeat1.npz` | 29조건의 1회차 기록과 포함된 참조·추정 배열 |
| `data/REAL_*_repeat1.csv` | A1·A4·C9·D5·D6 1회차 시계열 |
| `data/ANALYSIS_sensor_order_ablation.csv` | 저장된 모델 배열의 축 제한·필터 순서 비교 |
| `data/ANALYSIS_sampling_phase.csv` | 저장된 1kHz 격자의 간격 추출·시작 위상 비교 |
| `data/SIM_reference_29_scenarios.csv` | 기존 시뮬레이션 PDF의 29조건 요약 |
| `data/MEASUREMENT_metadata.json` | 사용자 출처 확인, 분석 범위, 미확인 계측 정보 |
| `data/ANALYSIS_verification.json` | 현재 자료의 개수·범위·누락 등 일관성 검증 |
| `data/TEMPLATE_additional_measurement.csv` | 추가 측정·메타데이터 기록 양식. 빈 양식 자체는 기존 실험 부재의 증거가 아님 |
| `figures/*.png` | 현재 파일명과 설명에 맞춘 그래프 |
| `make_figures.py` | 현재 자료의 그래프와 계산 보조표 생성 |
| `build_report.py` | 현재 자료의 분석 PDF 생성 |
| `prepare_additional_measurement.py` | 추가 측정 양식 생성. 측정값이 입력된 양식의 덮어쓰기를 막음 |
| `file_rename_manifest.json` | 이전→현재 경로와 원본 SHA-256 |
| `legacy/` | 이전 합성 모델 코드·가정. 현재 데이터와 별도 출력 경로 사용 |

## 현재 자료로 그래프·보고서 만들기

```powershell
python make_figures.py
python build_report.py
```

기본 보고서 출력은 이 폴더의 `output/pdf/ESP32_MPU6050_데이터_분석보고서.pdf`입니다. 다른 위치는 `python build_report.py --output "경로.pdf"`로 지정합니다. 의존성은 `requirements.txt`를 참고하세요. Windows 맑은 고딕 또는 설치된 NanumGothic을 사용합니다.

이번에 수정한 기존 보고서는 [ESP32_MPU6050 데이터 분석보고서](../pcx125_sim/pcx125_helmet/output/pdf/ESP32_MPU6050_데이터_분석보고서.pdf)에 반영했습니다.

`make_figures.py`는 `REAL_` CSV·NPZ를 읽으며 그래프, `ANALYSIS_` 계산표와 검증 JSON을 갱신합니다. 원시 기록과 반복 요약을 재생성하지 않습니다. 최초 150ms 및 순번 누락을 가로지르는 150ms ΔV 창의 NaN은 보존합니다.

## 열과 단위

| 열/배열 | 의미 |
|---|---|
| `data_*` | 기존 분석 열 이름. 파일 접두사와 별개이며 호환성을 위해 유지 |
| `sim_*` | 기존 시뮬레이션 요약 |
| `t_esp_s` / `t`, `receiver_time_s` / `rx_time` | 파일에 저장된 센서·수신 시각, 초 |
| `packet_seq` / `seq` | 샘플 순번; 누락 검증에 사용 |
| `ax_raw`~`az_raw`, `gx_raw`~`gz_raw` | 원시 정수 코드 |
| `ax_g`~`az_g` / `a` | 가속도, g; 3축 크기 계산 시 다시 9.81로 나누지 않음 |
| `gx_dps`~`gz_dps` / `g` | 각속도, °/s |
| `delta_v_est_mps` / `dv_est` | 추정 자세로 중력을 제거한 150ms 벡터 적분 크기, m/s |
| `bank_est_deg` / `roll_est` | 추정 뱅크각, ° |
| `data_truth_*`, `latent_*`, `dv_true`, `roll_true`, `dv_oracle`, `pose_error` | 참조·모델 관련 채널. 독립 기준 장비로 측정한 값인지는 별도 확인 필요 |
| `t_grid`, `full_amag`, `*_amag` | 저장된 처리 비교용 격자·배열. 수신 시각 `t`와 길이가 다를 수 있음 |

파일명의 `REAL_`는 사용자가 확인한 데이터 분류입니다. 원시 채널, 추정값, 모델 참조값이 하나의 NPZ에 함께 있으므로 접두사만으로 모든 배열이 독립적인 실측 정답이라는 뜻은 아닙니다. 평균±SD는 조건별 5회 표본 표준편차(ddof=1)입니다.

## 출처 정정과 남아 있는 확인 사항

이전 보고서의 “자료 전체의 합성 생성 이력 확인”이라는 단정은 사용자 설명을 반영하여 수정했습니다. 기존 README와 `physical_tests_performed=0`은 복사된 모델 자료로 보존하며 현재 실험 횟수로 인용하지 않습니다. 실험 날짜·보드 ID·펌웨어·기준 장비는 확인 전까지 임의로 채우지 않습니다.

별도로 이전 분석에서는 A1·A4·D5 1회차의 원시 코드, 순번, 센서/수신 시각, 추정 ΔV가 함께 제공된 생성 코드의 출력과 정확히 일치했습니다. 이 확인은 파일명 비교가 아닌 수치 비교였습니다. 사용자 확인과 이 수치 관찰을 함께 기록하며, 모델과 측정 기록의 관계는 원본 수집 로그·처리 이력으로 확인할 항목으로 남깁니다. 참조 ΔV·각도 오차와 트리거 지연은 기준 채널의 출처가 확인될 때까지 실제 장비 정확도나 물리적 응답 지연으로 단정하지 않습니다.

## 이전 모델 코드

```powershell
python legacy/generate_synthetic.py
python legacy/make_synthetic_figures.py
python legacy/build_synthetic_report.py
```

위 명령은 `legacy/generated/`의 `MODEL_` 자료만 생성합니다. 현재 `data/REAL_*`를 덮어쓰지 않습니다. `legacy/legacy_model_assumptions.json`은 이전 모델의 가정이며 실제 보드의 레지스터 읽기 결과가 아닙니다.

## 수치 검증 범위

29조건·145개 결과, 조건별 5회, 29개 원시 NPZ와 5개 CSV를 확인했습니다. 2~5회차 원시 파형은 현재 폴더에 없으므로 요약 통계만 검증할 수 있습니다. C8은 제공 자료에 없습니다. C5는 미재현, B5·C9는 경계 조건으로 별도 해석합니다.

파일명 변경 전 자료와 이전 PDF는 `_backup/filename_cleanup_20260930.zip`에 보존됩니다. 측정 CSV·NPZ는 변경 전후 SHA-256이 동일한지 검증했습니다.
