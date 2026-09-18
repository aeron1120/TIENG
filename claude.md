# CLAUDE.md — 이륜차 사고 감지 시스템 (Phase 0–1)

라즈베리파이 기반 온디바이스 센싱 파이프라인. 카메라(광류·지평선) + IMU + 폰(GPS·통신) 융합.

---

## 0. 작업 원칙

1. **데이터 계약(`core/schemas.py`)을 먼저 확정한다.** 변경이 필요하면 먼저 물어볼 것.
2. **어댑터 추가가 곧 기능 추가다.** 새 센서를 붙일 때 `core/adapters/` 외의 파일을 고쳐야 한다면 설계가 잘못된 것이다.
3. **어떤 어댑터가 죽어도 파이프라인은 계속 돈다.** 실패한 어댑터는 `state: "error"`로 강등되고 나머지는 정상 동작한다.
4. **없는 값을 지어내지 않는다.** SQI가 기준 미달이면 값을 내지 않고 `state: "low_quality"`로 보류한다. 이 프로젝트의 핵심 안전 장치다.
5. **지표·융합 코드는 순수 함수다.** 내부에서 시계를 읽거나 I/O를 하지 않는다. 같은 입력이면 실시간과 리플레이 결과가 비트 단위로 같아야 한다.
6. **모든 판정은 근거와 함께 로그에 남긴다.** "왜 발동/미발동했는가"를 지표별 실측값과 임계값으로 기록한다.
7. 커밋 단위는 작게. 한 커밋에 하나의 어댑터 또는 하나의 지표.
8. 주석은 "왜"를 적는다. "무엇"은 코드가 말한다.

---

## 1. 무엇을 만드는가

주행 중 **차체 전방 카메라와 IMU로 신호를 수집·융합해 사고 감지 지표를 계산하고 기록**하는 시스템. 감지 알고리즘 튜닝에 쓸 데이터셋과, 그 데이터로 오프라인 재현이 가능한 파이프라인을 만드는 것이 목표다.

### 왜 카메라인가 (설계 배경, 코드에 영향 있음)

이륜차는 선회 시 중력과 원심력의 합력이 차체 수직축과 정렬되도록 기울어진다. 따라서 **정상 선회 중에는 가속도계로 뱅크각을 관측할 수 없고**, 자이로 적분은 드리프트가 쌓인다. 카메라의 지평선은 드리프트 없는 절대 롤 기준을 제공한다. 또한 GPS 1Hz는 200ms 충돌 구간을 분해하지 못하고 골목·터널에서 끊긴다. 노면 광류는 카메라 높이가 고정이라 스케일이 알려진 절대 속도를 30~60Hz로 제공한다.

→ 카메라 상단 ROI = 롤각, 하단 ROI = 속도, 이벤트 시 = 증거 프레임.

### 명시적 비목표

- 감지 판정 후 **경보·SOS·119·상담원 연동은 구현하지 않는다.** 규칙은 평가하고 로그만 남긴다 (`detection.enabled: false`가 기본값).
- 헬멧 태그(사람 채널)는 Phase 2다. 스키마에 자리만 두고 어댑터는 만들지 않는다.
- 폰 앱은 별도 저장소다. 여기서는 폰이 POST하는 **ingest 엔드포인트만** 구현한다.
- 실시간 스트리밍 영상 저장은 하지 않는다. 링버퍼와 이벤트 스냅샷만 남긴다.

---

## 2. 데이터 계약

`core/schemas.py`에 Pydantic v2로 정의. 모든 계층이 이 스키마로만 통신한다.

```python
from datetime import datetime
from typing import Literal
from pydantic import BaseModel

Mode  = Literal["live", "replay", "simulated", "unavailable"]
State = Literal["ok", "low_quality", "stale", "error", "no_adapter"]

# ── 원시 샘플 (기록 대상) ────────────────────────────────
class ImuSample(BaseModel):
    t: float                      # 단조 시계 기준 초 (세션 시작 = 0.0)
    ax: float; ay: float; az: float      # m/s^2, 센서 좌표계
    gx: float; gy: float; gz: float      # rad/s
    temp: float | None = None
    seq: int                      # FIFO 연속성 검증용
    source: str                   # "icm42688" | "adxl372" | "sim"

class CamMetrics(BaseModel):
    """프레임 1장에서 뽑은 특징값. 프레임 자체는 링버퍼로만 간다."""
    t: float
    frame_id: int
    roll_cam: float | None        # rad, 지평선 기준 절대 롤. 실패 시 None
    roll_sqi: float               # 0.0~1.0
    flow_speed: float | None      # m/s, 노면 평면 모델 기반. 실패 시 None
    flow_sqi: float
    flow_n_inliers: int
    flow_residual: float          # 평면 모델 잔차 RMS (px)
    mean_luma: float              # 야간 품질 진단용
    exposure_us: int

class PhoneSample(BaseModel):
    t: float                      # 서버 시계로 변환된 값
    t_device: float               # 폰이 보낸 원본 타임스탬프
    lat: float; lon: float
    gps_speed: float | None       # m/s
    gps_acc: float | None         # m, 수평 정확도
    heading: float | None
    battery: float | None

# ── 융합 결과 ────────────────────────────────────────────
class FusedState(BaseModel):
    t: float
    roll: float                   # rad, 상보 필터 출력
    roll_state: State
    pitch: float
    speed: float | None           # m/s, 광류+GPS 융합
    speed_state: State
    speed_source: Literal["flow", "gps", "blend", "none"]
    accel_h: float                # m/s^2, 중력 제거 후 수평 성분 크기
    yaw_rate: float               # rad/s

class Indicator(BaseModel):
    key: str                      # "delta_v" | "peak_g" | "jerk" | "bank_angle" | ...
    value: float | None
    unit: str | None
    state: State
    sqi: float | None             # 해당 없으면 None
    t: float

class RuleTrace(BaseModel):
    """왜 발동/미발동했는지. 원칙 6."""
    rule: str                     # "impact_trigger" | "lowside" | "fall_confirm"
    fired: bool
    inputs: dict[str, float | None]   # 지표 실측값
    thresholds: dict[str, float]
    blocked_by: str | None        # "low_quality" 등, 판정 불가 사유

class Event(BaseModel):
    id: str
    t: float
    kind: Literal["trigger", "confirm", "reject", "manual_mark", "sqi_drop"]
    traces: list[RuleTrace]
    ring_dump_path: str | None    # 원시 데이터 덤프 위치

class Snapshot(BaseModel):
    """대시보드/API용 현재 상태."""
    device_id: str
    session_id: str
    t: float
    mode: Mode
    fused: FusedState | None
    indicators: list[Indicator]
    recent_events: list[Event]
    health: dict[str, float]      # 드롭률, FIFO 오버플로, 지터 등
```

### 규칙

- `value`가 `None`이면 프론트는 `—`를 표시하고 그래프에 점을 찍지 않는다. **0으로 대체 금지.**
- 모든 `t`는 **세션 시작을 0으로 하는 단조 시계 기준 초**다. 벽시계는 세션 메타데이터에 한 번만 기록한다. 어댑터가 각자 시계를 쓰면 융합이 무의미해진다.
- 폰 샘플은 `t_device`를 그대로 보존하고, 오프셋 추정 결과를 적용한 `t`를 따로 채운다.

---

## 3. 폴더 구조

```
moto-crash-sensing/
├── core/
│   ├── schemas.py              # 데이터 계약. 먼저 확정.
│   ├── clock.py                # 단조 시계, 폰 오프셋 추정
│   ├── adapters/
│   │   ├── base.py             # SensorAdapter ABC
│   │   ├── imu_icm42688.py     # SPI, FIFO 폴링           [live]
│   │   ├── imu_adxl372.py      # SPI, 고G (선택)          [live]
│   │   ├── camera_picam.py     # Picamera2, GS 카메라     [live]
│   │   ├── phone_ingest.py     # HTTP 수신                [live]
│   │   ├── imu_sim.py          # 합성 신호                [simulated]
│   │   └── replay.py           # 세션 파일 재생           [replay]
│   ├── vision/
│   │   ├── calib.py            # 내부·외부 파라미터, 지면 모델
│   │   ├── horizon.py          # 지평선 롤 추정 + SQI
│   │   ├── flow.py             # 노면 광류 속도 + SQI
│   │   └── roi.py              # ROI 정의, 캘리브 기반 생성
│   ├── fusion/
│   │   ├── attitude.py         # 상보 필터 (자이로 + 카메라 롤)
│   │   ├── speed.py            # 광류 + GPS, SQI 가중
│   │   └── gravity.py          # 중력 제거, 수평 성분 분리
│   ├── indicators/
│   │   ├── impact.py           # delta_v, peak_g, jerk, duration
│   │   ├── attitude_ind.py     # bank_angle, roll_rate, 지속시간
│   │   ├── motion.py           # flow_loss, post_stop_attitude
│   │   └── registry.py         # 지표 등록·실행
│   ├── rules.py                # 규칙 평가 (판정은 하되 경보 없음)
│   ├── quality.py              # SQI 산출·게이팅 공통 로직
│   ├── ring.py                 # IMU/프레임 링버퍼 + 덤프
│   ├── recorder.py             # 세션 기록 (parquet/jsonl)
│   └── pipeline.py             # 스레드 구성, 융합 루프
├── api/
│   ├── server.py               # FastAPI: /snapshot, /ingest, /events
│   └── ws.py                   # 대시보드 실시간 push
├── web/
│   └── index.html              # 단일 페이지 대시보드 (빌드 도구 없음)
├── tools/
│   ├── calibrate_camera.py     # 체커보드 → intrinsics
│   ├── calibrate_mount.py      # 장착 높이·피치 → 지면 모델
│   ├── replay.py               # 세션 재처리, 지표 CSV 출력
│   ├── mark.py                 # 근접사고 수동 라벨 (버튼/키)
│   └── inspect_session.py      # 드롭·지터·SQI 요약 리포트
├── config/
│   ├── default.yaml
│   └── calib.json              # 캘리브 결과 (기기별, git 제외)
├── sessions/                   # 기록 출력 (git 제외)
├── tests/
│   ├── test_schemas.py
│   ├── test_indicators.py      # 합성 신호 기반
│   ├── test_fusion.py
│   └── test_replay_determinism.py   # 가장 중요
├── pyproject.toml
└── README.md
```

---

## 4. 어댑터 명세

### base.py

```python
class SensorAdapter(ABC):
    id: str
    mode: Mode

    def start(self) -> None: ...
    def stop(self) -> None: ...
    def health(self) -> dict[str, float]: ...   # 드롭, 오버플로, 지터
    # 각 어댑터는 자기 큐에 샘플을 push. 파이프라인이 pull.
```

**모든 어댑터는 예외를 삼키고 `state="error"`로 강등한다.** 파이프라인은 어댑터가 죽어도 루프를 멈추지 않는다.

### imu_icm42688.py

- SPI, **내장 FIFO를 반드시 사용한다.** 매 샘플 인터럽트로 읽으면 Pi에서 지터가 발생한다.
- ODR 1kHz, 20ms 주기로 FIFO 배치 읽기. 각 샘플의 `t`는 **FIFO 카운트와 ODR로 역산**한다 (읽은 시각으로 찍지 않는다 — 이게 지터의 주원인).
- 헤더의 시퀀스/카운트로 오버플로를 감지하고 `health()`에 누적 보고.
- 결측 구간은 보간하지 않고 **구멍으로 남긴다** (원칙 4).

### camera_picam.py

- Picamera2. **Global Shutter Camera 전제.** 롤링 셔터는 진동으로 이미지가 휘어 광류가 무의미해진다.
- 60fps, mono 또는 Y 채널만, 640×480 급.
- **자동 노출 금지.** 셔터 고정 + 게인만 제한 범위에서 조정. 자동 노출은 프레임마다 밝기가 튀어 광류 추적을 깨뜨린다. 야간 셔터값은 캘리브로 결정.
- 프레임은 두 경로로 간다: (1) `vision/`으로 넘겨 `CamMetrics` 생성, (2) 링버퍼에 15fps JPEG로 다운샘플 저장.
- 프레임 타임스탬프는 Picamera2의 **SensorTimestamp**를 쓴다.

### phone_ingest.py

- `POST /ingest` 로 배치 수신. 폰이 죽거나 네트워크가 끊겨도 파이프라인은 계속 돈다.
- 오프셋 추정: 요청/응답 왕복 시간으로 NTP 방식 추정, 지수이동평균으로 갱신. 추정 불확실성이 크면 GPS를 융합에서 강등.

### replay.py

- 세션 디렉터리를 읽어 **원래 타임스탬프 순서대로** 샘플을 방출한다.
- 실시간 모드와 동일한 인터페이스. 파이프라인은 자기가 리플레이 중인지 몰라야 한다.

---

## 5. 파이프라인 구성

```
[IMU 스레드]  FIFO 배치 → imu_queue      (1kHz)
[카메라 스레드] 프레임 → vision → cam_queue (60Hz) + ring(15fps JPEG)
[HTTP 스레드] 폰 → phone_queue           (1Hz)
                      ↓
[융합 루프 50Hz] 큐 드레인 → 시간 정렬 → fusion → indicators → rules
                      ↓
        recorder(전량 기록) + ring(10초 원시) + snapshot(대시보드)
```

- 융합 루프는 **고정 50Hz 틱**. 각 틱에서 해당 구간까지 도착한 샘플만 쓴다.
- 지표 중 delta_v 같은 고주파 항목은 융합 루프가 아니라 **IMU 스레드에서 슬라이딩 윈도우로 계산**해 결과만 큐로 넘긴다. 1kHz 데이터를 50Hz 루프로 끌고 오면 지연이 생긴다.
- GIL 때문에 numpy 연산은 배열 단위로 처리한다. 샘플 단위 파이썬 루프 금지.

---

## 6. 지표 계산 명세

파라미터는 전부 `config/default.yaml`에서 온다. **코드에 상수 박지 말 것.**

### 6.1 지면 모델 (vision/calib.py)

카메라 높이 `h`(m), 하향 피치 `θ`(rad), 초점거리 `f`(px), 주점 `cy`(px).

이미지 행 `y`의 지면점에 대해:

```
α = atan((y - cy) / f)          # 광축 기준 각
φ = θ + α                       # 전체 내림각
X = h / tan(φ)                  # 카메라로부터의 지면 거리
```

전진 속도 `v`일 때 그 점의 세로 광류:

```
flow_y = v · f · h · sec²(φ - θ) / (X² + h²)
```

따라서 관측된 `flow_y`에서:

```
v = flow_y · (X² + h²) / (f · h · sec²(φ - θ))
```

- ROI 내 여러 행에서 각각 `v`를 구하고 **중앙값**을 취한다. 행마다 추정이 크게 다르면 지면 가정이 깨진 것(경사, 차량 통과) → SQI 하락.
- 롤이 크면 ROI를 롤만큼 회전 보정한 뒤 계산한다.

### 6.2 광류 (vision/flow.py)

- 노면 ROI에서 `goodFeaturesToTrack` → `calcOpticalFlowPyrLK` (sparse). dense는 Pi에서 60fps를 못 맞춘다.
- 역방향 추적 오차로 이상치 제거 → 평면 모델 피팅 → 잔차 기반 인라이어 선별.
- `flow_sqi` 구성 요소 (각각 0~1로 정규화 후 가중 곱):
  - 인라이어 수 / 목표 특징 수
  - 평면 모델 잔차 RMS (낮을수록 좋음)
  - 행간 속도 추정의 일관성 (표준편차)
  - 평균 휘도가 유효 범위 안인지 (야간 핵심 항목)
- **인라이어가 기준 미만이면 `flow_speed = None`, `state = "low_quality"`.** 이때 속도 융합은 GPS로 폴백한다.

### 6.3 지평선 롤 (vision/horizon.py)

- 상단 ROI에서 그래디언트 방향 히스토그램 또는 Hough → 지배적 직선 각도.
- `roll_sqi`: 직선 지지 픽셀 비율, 대비, 프레임 간 연속성.
- **야간에는 실패가 기본값이다.** 실패를 예외가 아니라 정상 경로로 다룰 것. 가로등·차선·건물 수직선을 보조 단서로 쓰는 것은 후속 과제로 남기고, 지금은 SQI를 정직하게 낮춘다.

### 6.4 자세 융합 (fusion/attitude.py)

상보 필터:

```
roll_pred = roll_prev + gx · dt
β_eff     = β · roll_sqi
roll      = (1 - β_eff) · roll_pred + β_eff · roll_cam      # roll_cam이 None이면 β_eff = 0
```

- `roll_sqi`가 0이면 순수 자이로 적분이 되고, 드리프트가 누적된다. **누적 시간을 함께 기록**해 일정 시간을 넘으면 `state = "low_quality"`로 강등한다.
- 정차 시(가속도 크기 ≈ 1g, 자이로 ≈ 0) 가속도계로 롤을 재초기화한다. 이때만 가속도계가 유효하다.

### 6.5 속도 융합 (fusion/speed.py)

- `flow_sqi ≥ 임계` → `flow` 사용
- GPS 정확도가 양호하고 flow 품질이 낮음 → `gps`
- 둘 다 유효 → SQI 가중 blend, 그리고 **두 값의 차이를 로그에 남긴다** (광류 캘리브 검증에 이 차이가 핵심 데이터다)
- 둘 다 실패 → `speed = None`, `speed_source = "none"`

### 6.6 지표 (indicators/)

| key | 계산 | 출처 |
|---|---|---|
| `delta_v` | 중력 제거 후 수평 가속도를 200ms 슬라이딩 윈도우로 적분 | IMU 1kHz |
| `peak_g` | 합성 가속도 최대값 | IMU |
| `jerk` | da/dt 최대값 | IMU |
| `impact_duration` | 임계 초과 구간 길이 | IMU |
| `yaw_rate_peak` / `roll_rate_peak` | 자이로 합성 최대 | IMU |
| `bank_angle` | 융합 롤 절대값 | fusion |
| `bank_duration` | 임계 초과 지속시간 | fusion |
| `speed_drop` | 속도 급감폭 | fusion |
| `flow_loss` | 광류 인라이어가 급락하고 회복되지 않는 지속시간 | vision |
| `post_stop_attitude` | 정지 후 롤 유지 시간 | fusion |

각 지표는 `Indicator`를 반환하며, **입력이 `low_quality`면 지표도 `low_quality`로 전파**한다.

### 6.7 규칙 (rules.py)

규칙은 평가하되 아무 동작도 하지 않는다. `RuleTrace`를 남기고 `Event(kind="trigger"/"reject")`를 기록한다.

```yaml
rules:
  impact_trigger:   { delta_v_min: 3.33, speed_prior_min: 4.2 }   # m/s
  lowside_trigger:  { bank_min: 0.87, speed_min: 2.8 }            # rad, m/s
  fall_confirm:     { bank_min: 1.05, duration_min: 3.0, speed_max: 0.83 }
```

- **핵심 입력이 `low_quality`면 기각하지 않고 `blocked_by`를 채운다.** 놓침은 되돌릴 수 없다. 기각과 판정 불가는 다른 결과다.
- 임계값은 전부 추정치다. Phase 1 데이터로 확정한다.

---

## 7. 링버퍼와 이벤트 덤프

- IMU 링: 10초, 1kHz × 6축 × float32 ≈ 240KB. numpy 원형 배열.
- 프레임 링: 10초, 15fps JPEG q70 ≈ 5MB.
- 트리거 발생 시 **충격 전후 ±5초**를 `sessions/<id>/events/<event_id>/`에 덤프한다.
- 덤프는 **별도 스레드**에서 수행한다. 융합 루프에서 디스크 I/O를 하면 틱이 밀린다.

---

## 8. 세션 기록 포맷

```
sessions/2026-09-18T22-14-03_<device>/
├── meta.json          # 벽시계 시작 시각, config 스냅샷, calib 스냅샷, git commit
├── imu.parquet        # ImuSample 전량
├── cam.parquet        # CamMetrics 전량
├── phone.parquet      # PhoneSample 전량
├── fused.parquet      # FusedState (재현 검증용)
├── indicators.parquet
├── events.jsonl
├── marks.jsonl        # 근접사고 수동 라벨
└── events/<event_id>/ # 링버퍼 덤프 + 프레임
```

`meta.json`에 config와 calib를 통째로 넣는 이유: 나중에 임계값을 바꿨을 때 **어떤 설정으로 찍힌 데이터인지** 모르면 데이터 전체가 쓸모없어진다.

---

## 9. 리플레이 결정성 (가장 중요한 요구사항)

`tests/test_replay_determinism.py`가 이 프로젝트의 핵심 테스트다.

```
동일 세션을 두 번 리플레이 → fused.parquet, indicators.parquet가 완전히 동일
실시간 기록본 ↔ 리플레이 결과 → 허용 오차 내 일치
```

이게 깨지면 지표 튜닝을 주행 없이 할 수 없게 되고, 프로젝트가 멈춘다. 그래서:

- 융합·지표·규칙 코드에서 `time.time()`, `random`, 스레드 순서 의존 금지.
- 모든 상태는 명시적으로 전달한다. 전역 변수 금지.
- 부동소수 누적 순서를 바꾸는 최적화 금지.

---

## 10. 설정 파일

`config/default.yaml`

```yaml
device_id: "pi5-01"
adapters:
  imu:    { enabled: true, backend: "icm42688", odr_hz: 1000, fifo_batch_ms: 20 }
  hi_g:   { enabled: false, backend: "adxl372", odr_hz: 800 }
  camera: { enabled: true, fps: 60, width: 640, height: 480,
            shutter_us_day: 2000, shutter_us_night: 8000, gain_max: 8.0 }
  phone:  { enabled: true, port: 8000 }

vision:
  road_roi:    { y_top_ratio: 0.60, y_bot_ratio: 0.95, x_margin_ratio: 0.15 }
  horizon_roi: { y_top_ratio: 0.05, y_bot_ratio: 0.40 }
  flow: { max_features: 200, min_inliers: 30, residual_max_px: 1.5 }

fusion:
  loop_hz: 50
  attitude: { beta: 0.05, gyro_only_max_s: 10.0 }
  speed:    { flow_sqi_min: 0.5, gps_acc_max_m: 15.0 }

indicators:
  delta_v_window_ms: 200
  impact_threshold_g: 2.0

detection:
  enabled: false      # Phase 1에서는 절대 true로 두지 말 것

recording:
  ring_seconds: 10
  frame_ring_fps: 15
  dump_pre_s: 5
  dump_post_s: 5
  session_dir: "./sessions"
```

---

## 11. 실행 명령어

```bash
# 설치 (Pi OS Bookworm, picamera2는 시스템 패키지 사용)
sudo apt install -y python3-picamera2 python3-opencv
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -e ".[dev]"

# SPI 활성화 후 재부팅
sudo raspi-config nonint do_spi 0

# 캘리브레이션 (최초 1회 + 장착 변경 시마다)
python tools/calibrate_camera.py --frames 30 --out config/calib.json
python tools/calibrate_mount.py --height-m 0.95 --marker-distances 2,4,6 --out config/calib.json

# 센서 없이 구조 검증
python -m core.pipeline --config config/default.yaml --source sim

# 실주행 기록
python -m core.pipeline --config config/default.yaml --source live

# 대시보드 (다른 터미널)
uvicorn api.server:app --host 0.0.0.0 --port 8000

# 기록 재처리 — 임계값 바꿔가며 여기서 튜닝
python tools/replay.py sessions/2026-09-18T22-14-03_pi5-01 \
    --config config/tuning_A.yaml --out out/tuning_A.csv

# 세션 품질 리포트
python tools/inspect_session.py sessions/<id>

# 테스트
pytest -q
pytest tests/test_replay_determinism.py -v

# 부팅 시 자동 시작
sudo cp deploy/moto-sensing.service /etc/systemd/system/
sudo systemctl enable --now moto-sensing
```

---

## 12. 디버깅 포인트

구현하면서 여기서 반드시 막힌다. `health()`와 `inspect_session.py`에 다음을 노출할 것.

| 증상 | 원인 | 확인 방법 |
|---|---|---|
| IMU 샘플 간격이 불규칙 | 읽은 시각으로 타임스탬프를 찍음 | FIFO 카운트 역산으로 변경. `imu.parquet`의 `diff(t)` 히스토그램 |
| IMU 데이터 구멍 | FIFO 오버플로 | `health["fifo_overflow"]` 누적. 배치 주기를 줄일 것 |
| 프레임 드롭 | 광류 처리가 60fps를 못 따라감 | `health["frame_drop_rate"]`. ROI 축소 또는 특징점 수 감소 |
| 속도 추정이 널뜀 | 자동 노출로 프레임 밝기 변동 | `CamMetrics.exposure_us`가 변하는지 확인. 셔터 고정 |
| 속도가 계속 과대/과소 | 장착 높이·피치 캘리브 오차 | GPS 속도와의 차이를 기록해뒀으므로 회귀로 보정 계수 산출 |
| 롤각이 서서히 틀어짐 | 자이로 드리프트, 카메라 SQI 0 지속 | `gyro_only_duration` 추적. 정차 시 재초기화 동작 확인 |
| 야간에 지표가 전부 None | 정상 동작임 | SQI 시계열로 확인. 이 구간 비율이 Phase 1의 핵심 결과 |
| 이벤트 덤프 후 루프가 밀림 | 융합 루프에서 디스크 I/O | 덤프를 별도 스레드로 |
| 장시간 주행 후 느려짐 | Pi 스로틀링 또는 디스크 포화 | `vcgencmd get_throttled`, 남은 용량을 `health`에 포함 |
| 리플레이 결과가 매번 다름 | 순수성 위반 | `test_replay_determinism` 실패 지점 추적 |
| 폰 데이터 시간이 어긋남 | 오프셋 추정 실패 | `t - t_device` 시계열이 안정적인지 |

---

## 13. 구현 순서

각 단계는 검증이 통과해야 다음으로 간다.

1. `schemas.py` + `config` 로딩 → 검증: 스키마 왕복 테스트 통과
2. `recorder.py` + `imu_sim.py` + 최소 `pipeline.py` → 검증: 합성 신호로 세션 디렉터리가 생성되고 parquet를 다시 읽을 수 있음
3. `replay.py` + 결정성 테스트 → 검증: 2회 리플레이 결과 동일
4. `imu_icm42688.py` → 검증: 1kHz에서 10분간 구멍 0, 간격 표준편차가 목표 이내
5. `camera_picam.py` + `calib.py` + 캘리브 도구 → 검증: 알려진 거리의 마커가 지면 모델로 오차 범위 내 복원
6. `flow.py` → 검증: 자전거·도보로 일정 속도 이동 시 GPS 대비 오차 확인
7. `horizon.py` → 검증: 카메라를 알려진 각도로 기울였을 때 롤 복원
8. `fusion/` → 검증: 자이로 단독 구간에서 드리프트 크기 측정, 재초기화 동작
9. `indicators/` + `rules.py` → 검증: 합성 충격 신호에서 delta_v가 이론값과 일치
10. `ring.py` + 이벤트 덤프 → 검증: 트리거 시 ±5초가 온전히 저장되고 루프 틱이 안 밀림
11. `api/` + `web/` → 검증: SQI와 지표를 실시간으로 볼 수 있고, `None`이 `—`로 표시됨
12. `tools/mark.py` → 검증: 주행 중 버튼으로 라벨이 찍힘

---

## 14. 하지 말 것

- 감지되면 소리를 내거나 알림을 보내는 코드. Phase 1은 **기록만** 한다.
- SQI가 낮을 때 마지막 유효값을 계속 표시하는 것. `None`을 그대로 내보낸다.
- 결측 IMU 샘플 보간.
- 지표 코드 안에서 파일 쓰기나 시계 읽기.
- 임계값 하드코딩.
- dense optical flow, 딥러닝 모델. Pi에서 60fps를 못 맞춘다.
- 원본 영상 상시 저장. 링버퍼와 이벤트 스냅샷만.
