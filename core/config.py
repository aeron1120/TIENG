"""config/default.yaml 로더 (CLAUDE.md §10).

지표·규칙 파라미터는 코드가 아니라 여기서 온다 (§6, §14 "임계값 하드코딩" 금지).
세션 메타데이터에 이 설정을 통째로 박제하므로 (§8), 모델은 yaml 을 그대로 비춘다.

extra="forbid" 인 이유: 오타난 키가 조용히 무시되면 기본값으로 돈 것을 모른 채
데이터를 쌓게 된다. 그 세션은 나중에 어떤 설정으로 찍혔는지 알 수 없어 통째로
쓸모가 없어진다 — §0-4 의 "없는 값을 지어내지 않는다" 와 같은 이유다.
"""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict

DEFAULT_PATH = Path("config/default.yaml")


class _Section(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── 어댑터 ───────────────────────────────────────────────


class ImuConfig(_Section):
    enabled: bool
    backend: str
    odr_hz: int
    fifo_batch_ms: int


class HiGConfig(_Section):
    enabled: bool
    backend: str
    odr_hz: int


class CameraConfig(_Section):
    enabled: bool
    fps: int
    width: int
    height: int
    shutter_us_day: int
    shutter_us_night: int
    gain_max: float


class PhoneConfig(_Section):
    enabled: bool
    port: int


class AdaptersConfig(_Section):
    imu: ImuConfig
    hi_g: HiGConfig
    camera: CameraConfig
    phone: PhoneConfig


# ── 비전 ─────────────────────────────────────────────────


class RoadRoi(_Section):
    y_top_ratio: float
    y_bot_ratio: float
    x_margin_ratio: float


class HorizonRoi(_Section):
    y_top_ratio: float
    y_bot_ratio: float


class FlowConfig(_Section):
    max_features: int
    min_inliers: int
    residual_max_px: float


class VisionConfig(_Section):
    road_roi: RoadRoi
    horizon_roi: HorizonRoi
    flow: FlowConfig


# ── 융합 ─────────────────────────────────────────────────


class AttitudeConfig(_Section):
    beta: float
    gyro_only_max_s: float


class SpeedConfig(_Section):
    flow_sqi_min: float
    gps_acc_max_m: float


class FusionConfig(_Section):
    loop_hz: int
    attitude: AttitudeConfig
    speed: SpeedConfig


# ── 지표·판정·기록 ───────────────────────────────────────


class IndicatorsConfig(_Section):
    delta_v_window_ms: int
    impact_threshold_g: float


class DetectionConfig(_Section):
    # Phase 1 에서는 절대 true 로 두지 않는다 (§10, §14). 규칙은 평가하되
    # 경보·SOS 는 구현 자체가 없다.
    enabled: bool = False


class RecordingConfig(_Section):
    ring_seconds: float
    frame_ring_fps: int
    dump_pre_s: float
    dump_post_s: float
    session_dir: str


class Config(_Section):
    device_id: str
    adapters: AdaptersConfig
    vision: VisionConfig
    fusion: FusionConfig
    indicators: IndicatorsConfig
    detection: DetectionConfig
    recording: RecordingConfig


def load(path: Path = DEFAULT_PATH) -> Config:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return Config.model_validate(raw)
