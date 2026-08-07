"""confidence 산출.

어댑터가 신호에서 뽑은 관측치를 0~1 신뢰도 하나로 합친다. 이 값이 기준에 못
미치면 어댑터는 값을 내보내지 않고 보류한다 (README §0-4).

가중치와 정규화 상수는 여기 상수로 둔다. 운영자가 조정하는 임계값이 아니라
신호처리 알고리즘의 일부라서다. 반대로 "얼마부터 믿을 것인가"(confidence_min)는
운영 정책이므로 thresholds.yaml 에서 읽는다 (README §10).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import yaml

# SQI 가중 합. 합이 1.0 이어야 confidence 가 0~1 에 머문다.
W_SNR = 0.45
W_ENERGY = 0.30
W_ROI = 0.15
W_BRIGHTNESS = 0.10

SNR_MID_DB = 6.0  # q_snr = 0.5 가 되는 SNR
SNR_SLOPE_DB = 3.0
SKIN_RATIO_REF = 0.35  # 이만큼 잡히면 ROI 품질 만점
SKIN_RATIO_FLOOR = 0.10  # 이 아래면 ROI 가 얼굴을 놓친 것으로 본다
BRIGHTNESS_OK = (45.0, 220.0)  # 밖이면 절반으로 감점
BETA_MOTION = 0.7  # q_motion = 1 - BETA * jitter_norm

DEFAULT_THRESHOLDS = Path("config/thresholds.yaml")


@dataclass(frozen=True)
class Quality:
    """confidence 와 그 성분. 성분을 함께 남겨야 왜 보류됐는지 추적할 수 있다."""

    confidence: float
    q_snr: float
    q_energy: float
    q_roi: float
    q_brightness: float
    q_motion: float

    def hold_reason(self) -> str:
        """confidence 가 낮을 때 어느 성분이 끌어내렸는지. README §8 디버깅용."""
        if self.q_motion < 0.6:
            return "motion/ROI jitter"
        if self.q_roi < 0.6:
            return "low ROI quality"
        if self.q_brightness < 1.0:
            return "lighting"
        if self.q_snr < 0.5 or self.q_energy < 0.5:
            return "low signal quality"
        return "low SQI"


def score(
    *,
    peak_snr_db: float,
    band_energy_ratio: float,
    skin_ratio: float,
    brightness: float,
    jitter_norm: float,
) -> Quality:
    q_snr = _sigmoid((peak_snr_db - SNR_MID_DB) / SNR_SLOPE_DB)
    q_energy = _clip(band_energy_ratio)
    q_roi = _clip(skin_ratio / SKIN_RATIO_REF)
    q_brightness = 1.0 if BRIGHTNESS_OK[0] <= brightness <= BRIGHTNESS_OK[1] else 0.5
    # 움직임은 가산이 아니라 곱으로 깎는다. 흔들리면 나머지가 아무리 좋아도 못 믿는다.
    q_motion = 1.0 - BETA_MOTION * _clip(jitter_norm)

    # 피부가 이만큼도 안 잡히면 얼굴을 놓친 것이므로 가중합에 맡기지 않는다.
    # q_roi 지분이 0.15 뿐이라, 얼굴이 나가도 잡음 스펙트럼의 SNR 이 높으면
    # 게이트를 통과해 엉뚱한 BPM 이 나간다 (실측에서 skin 2% 에 159bpm 관측).
    if skin_ratio < SKIN_RATIO_FLOOR:
        return Quality(0.0, q_snr, q_energy, q_roi, q_brightness, q_motion)

    confidence = _clip(
        (
            W_SNR * q_snr
            + W_ENERGY * q_energy
            + W_ROI * q_roi
            + W_BRIGHTNESS * q_brightness
        )
        * q_motion
    )
    return Quality(confidence, q_snr, q_energy, q_roi, q_brightness, q_motion)


def load_confidence_min(path: Path = DEFAULT_THRESHOLDS) -> float:
    """활성 프로파일의 confidence_min. 발표 때 어느 프로파일인지 밝혀야 한다 (README §7)."""
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    profile = raw["profile"]
    return float(raw[profile]["confidence_min"])


def _clip(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def _sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    z = math.exp(x)
    return z / (1.0 + z)
