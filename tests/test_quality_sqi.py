"""센서 중립 SQI 자체 검증. 신호는 전부 합성이라 하드웨어가 필요 없다.

핵심은 배음비 회귀다. 앞단 대역통과가 2f 를 지운 뒤에 배음비를 재면 신호 품질이
아니라 필터 감쇠를 재게 되고, confidence 가 측정값에 의존해 버린다. RR 대역에서는
12rpm 이상이면 전부 여기 해당하므로 호흡을 붙이기 전에 막아 둔 것이다.
"""

import math

import numpy as np
import pytest
from scipy.signal import butter, sosfiltfilt

from core import quality

FS = 4.0  # 호흡 리샘플 격자. 상한 0.5Hz 의 8배
SECONDS = 30.0


def _bandpass(x: np.ndarray) -> np.ndarray:
    """RR 대역으로 자른다. 실제 경로가 그렇기 때문에 테스트도 같은 신호를 본다."""
    band = quality.BAND_RR
    sos = butter(3, [band.f_lo, band.f_hi], btype="band", fs=FS, output="sos")
    return np.asarray(sosfiltfilt(sos, x), dtype=np.float64)


def _breathing(rpm: float, noise: float = 0.0, seed: int = 0) -> np.ndarray:
    """대역통과를 거친 호흡 신호. 어댑터가 score_signal 에 넘기는 모양 그대로."""
    rng = np.random.default_rng(seed)
    t = np.arange(0.0, SECONDS, 1.0 / FS)
    signal = np.sin(2 * np.pi * (rpm / 60.0) * t)
    if noise:
        signal = signal + rng.normal(0.0, noise, size=len(t))
    return _bandpass(signal)


# --- 배음비 (d5dfc7e 회귀) --------------------------------------------------- #


def test_harmonic_is_unmeasurable_when_2f_leaves_the_band() -> None:
    """RR 대역 상한이 0.5Hz 라 12rpm 이 넘으면 2f 를 잴 수 없다."""
    low = quality.spectral_analysis(_breathing(10), FS, quality.BAND_RR)
    high = quality.spectral_analysis(_breathing(18), FS, quality.BAND_RR)

    assert math.isfinite(low.harmonic_ratio), "10rpm 은 2f=0.33Hz 로 대역 안이다"
    assert math.isnan(high.harmonic_ratio), "18rpm 은 2f=0.60Hz 로 대역 밖이다"


def test_unmeasurable_harmonic_is_excluded_not_defaulted() -> None:
    """키를 빼는 것과 0.5 를 채우는 것은 다르다. 후자면 confidence 가 깎인다."""
    sqi = quality.score_signal(_breathing(18), FS, quality.BAND_RR)

    assert "harmonic" not in sqi.scores
    assert quality.combine(sqi.scores) == pytest.approx(sqi.confidence)
    # 같은 점수에 harmonic=0.5 를 억지로 끼우면 confidence 가 내려간다 — 그게 버그였다.
    padded = dict(sqi.scores, harmonic=0.5)
    assert quality.combine(padded) < sqi.confidence


def test_confidence_does_not_depend_on_the_measured_value() -> None:
    """같은 품질의 신호라면 10rpm 과 18rpm 의 confidence 가 비슷해야 한다.

    고치기 전에는 12rpm 을 넘는 순간 배음비가 필터 감쇠를 읽어 점수가 무너졌다
    (10rpm 1.00 / 18rpm 0.17).
    """
    scores = [quality.score_signal(_breathing(rpm), FS, quality.BAND_RR).confidence
              for rpm in (10, 15, 18, 22)]

    assert min(scores) > 0.5, f"깨끗한 호흡인데 보류 수준이다: {scores}"
    assert max(scores) - min(scores) < 0.25, f"confidence 가 측정값에 의존한다: {scores}"


def test_noise_does_not_raise_the_score() -> None:
    """부호 반전 회귀. 잡음이 2f 에 에너지를 넣어 더 높은 점수를 받으면 안 된다."""
    clean = quality.score_signal(_breathing(18, noise=0.0), FS, quality.BAND_RR)
    dirty = quality.score_signal(_breathing(18, noise=0.8), FS, quality.BAND_RR)

    assert dirty.confidence < clean.confidence, (
        f"더러운 신호가 더 높은 점수를 받았다: clean={clean.confidence:.3f} "
        f"dirty={dirty.confidence:.3f}"
    )


# --- 추정값 ----------------------------------------------------------------- #


@pytest.mark.parametrize("true_rpm", [10, 12, 15, 18, 22])
def test_recovers_known_rate(true_rpm: int) -> None:
    sqi = quality.score_signal(_breathing(true_rpm), FS, quality.BAND_RR)

    assert abs(sqi.bpm - true_rpm) <= 1.0, f"추정 {sqi.bpm:.1f} / 실제 {true_rpm}"


# --- 합성 규칙 --------------------------------------------------------------- #


def test_one_zero_component_sinks_the_whole_score() -> None:
    """기하평균을 쓰는 이유. 산술평균이면 'SNR 최악인데 통과' 가 가능해진다."""
    good = {"snr": 0.9, "unambiguity": 0.9, "agreement": 0.9, "temporal": 0.9}

    assert quality.combine(good) > 0.85
    assert quality.combine(dict(good, snr=0.0)) < 0.05


def test_empty_scores_are_zero_not_one() -> None:
    """잴 게 하나도 없으면 0 이다. exp(0/0) 을 1 로 흘리면 전부 통과한다."""
    assert quality.combine({}) == 0.0


def test_temporal_penalises_impossible_jumps() -> None:
    band = quality.BAND_RR  # max 2.0 rpm/s

    steady = quality.score_temporal(15.0, 15.5, dt=1.0, band=band)
    jumped = quality.score_temporal(15.0, 45.0, dt=1.0, band=band)
    first = quality.score_temporal(15.0, None, dt=1.0, band=band)

    assert steady > 0.8
    assert jumped < 0.01
    assert first == pytest.approx(0.7), "첫 측정은 중립보다 약간 낮게 시작한다"


def test_agreement_holds_judgement_when_one_estimator_fails() -> None:
    """한쪽을 못 구한 것은 불일치가 아니다. 벌점도 가점도 주지 않는다."""
    assert quality.score_agreement(15.0, float("nan"), tol=2.4) == 0.5
    assert quality.score_agreement(15.0, 15.0, tol=2.4) == pytest.approx(1.0)
    assert quality.score_agreement(15.0, 30.0, tol=2.4) < 0.01
