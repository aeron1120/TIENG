"""데이터 계약 (CLAUDE.md §2). 모든 계층이 이 스키마로만 통신한다.

여기를 고치면 전 계층이 따라 움직여야 하므로 임의 변경 금지 (CLAUDE.md §0-1).

규칙 셋을 스키마가 강제하지는 못한다. 읽는 쪽이 지켜야 한다.
  - value 가 None 이면 화면은 `—` 를 표시하고 그래프에 점을 찍지 않는다. 0 으로
    대체 금지 (§0-4). 없는 값을 지어내지 않는 것이 이 프로젝트의 핵심 안전 장치다.
  - 모든 t 는 세션 시작을 0 으로 하는 단조 시계 기준 초다. 벽시계는 세션
    메타데이터에 한 번만 기록한다. 어댑터가 각자 시계를 쓰면 융합이 무의미해진다.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

Mode = Literal["live", "replay", "simulated", "unavailable"]
State = Literal["ok", "low_quality", "stale", "error", "no_adapter"]


# ── 원시 샘플 (기록 대상) ────────────────────────────────


class ImuSample(BaseModel):
    t: float  # 단조 시계 기준 초 (세션 시작 = 0.0)
    ax: float  # m/s^2, 센서 좌표계
    ay: float
    az: float
    gx: float  # rad/s
    gy: float
    gz: float
    temp: float | None = None
    seq: int  # FIFO 연속성 검증용
    source: str  # "icm42688" | "adxl372" | "sim"


class CamMetrics(BaseModel):
    """프레임 1장에서 뽑은 특징값. 프레임 자체는 링버퍼로만 간다."""

    t: float
    frame_id: int
    roll_cam: float | None  # rad, 지평선 기준 절대 롤. 실패 시 None
    roll_sqi: float  # 0.0~1.0
    flow_speed: float | None  # m/s, 노면 평면 모델 기반. 실패 시 None
    flow_sqi: float
    flow_n_inliers: int
    flow_residual: float  # 평면 모델 잔차 RMS (px)
    mean_luma: float  # 야간 품질 진단용
    exposure_us: int


class PhoneSample(BaseModel):
    t: float  # 서버 시계로 변환된 값
    t_device: float  # 폰이 보낸 원본 타임스탬프
    lat: float
    lon: float
    gps_speed: float | None = None  # m/s
    gps_acc: float | None = None  # m, 수평 정확도
    heading: float | None = None
    battery: float | None = None


# ── 융합 결과 ────────────────────────────────────────────


class FusedState(BaseModel):
    t: float
    roll: float  # rad, 상보 필터 출력
    roll_state: State
    pitch: float
    speed: float | None  # m/s, 광류+GPS 융합
    speed_state: State
    speed_source: Literal["flow", "gps", "blend", "none"]
    accel_h: float  # m/s^2, 중력 제거 후 수평 성분 크기
    yaw_rate: float  # rad/s


class Indicator(BaseModel):
    key: str  # "delta_v" | "peak_g" | "jerk" | "bank_angle" | ...
    value: float | None
    unit: str | None
    state: State
    sqi: float | None  # 해당 없으면 None
    t: float


class RuleTrace(BaseModel):
    """왜 발동/미발동했는지 (CLAUDE.md §0-6).

    blocked_by 가 채워진 것은 '기각' 이 아니라 '판정 불가' 다. 놓침은 되돌릴 수
    없으므로 둘을 같은 결과로 묶지 않는다 (§6.7).
    """

    rule: str  # "impact_trigger" | "lowside" | "fall_confirm"
    fired: bool
    inputs: dict[str, float | None]  # 지표 실측값
    thresholds: dict[str, float]
    blocked_by: str | None = None  # "low_quality" 등, 판정 불가 사유


class Event(BaseModel):
    id: str
    t: float
    kind: Literal["trigger", "confirm", "reject", "manual_mark", "sqi_drop"]
    traces: list[RuleTrace]
    ring_dump_path: str | None = None  # 원시 데이터 덤프 위치


class Snapshot(BaseModel):
    """대시보드/API용 현재 상태."""

    device_id: str
    session_id: str
    t: float
    mode: Mode
    fused: FusedState | None
    indicators: list[Indicator]
    recent_events: list[Event]
    health: dict[str, float]  # 드롭률, FIFO 오버플로, 지터 등
