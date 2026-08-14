"""rPPG 신호경로 자체 검증. 카메라 없이 합성 신호로 돈다.

legacy/tieng_rppg 의 selftest 2·3 을 옮겨온 것으로, 이식 과정에서 알고리즘이
망가지지 않았는지가 핵심이다.
"""

from pathlib import Path

import numpy as np
import pytest

from core import quality, thresholds
from core.adapters.rppg import RppgAdapter

REPO_ROOT = Path(__file__).resolve().parents[1]
FS = 30.0


def _synthetic_rgb(
    true_bpm: float, seconds: float = 14.0, noise: float = 0.004
) -> tuple[np.ndarray, np.ndarray]:
    """맥파가 실린 ROI 평균 RGB 시계열. 호흡성 저주파 드리프트도 섞는다."""
    rng = np.random.default_rng(0)
    t = np.arange(0.0, seconds, 1.0 / FS)
    pulse = np.sin(2 * np.pi * (true_bpm / 60.0) * t)
    drift = 0.015 * np.sin(2 * np.pi * 0.08 * t)
    rgb = (
        np.array([0.60, 0.50, 0.42])[None, :]
        + np.outer(pulse, [0.010, 0.030, 0.015])
        + drift[:, None]
        + rng.normal(0, noise, size=(len(t), 3))
    )
    return t, rgb


def _adapter(gate: float = 0.4) -> RppgAdapter:
    adapter = RppgAdapter(id="rppg", mode="live")
    adapter._gate = gate
    return adapter


@pytest.mark.parametrize("true_bpm", [55, 72, 90, 120, 150])
def test_estimates_known_bpm_within_3(true_bpm: int) -> None:
    t, rgb = _synthetic_rgb(true_bpm)
    metric = _adapter()._estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "ok", f"보류됨 (confidence={metric.confidence})"
    assert metric.value is not None
    assert abs(float(metric.value) - true_bpm) <= 3.0
    assert metric.unit == "bpm"


def test_degraded_input_is_held_not_guessed() -> None:
    """어둡고 흔들리고 피부가 안 잡히면 값을 내지 않는다 (README §0-4)."""
    t, rgb = _synthetic_rgb(72)
    adapter = _adapter()

    clean = adapter._estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)
    degraded = adapter._estimate(t, rgb, jitter_norm=1.0, skin_ratio=0.05, brightness=10.0)

    assert clean.state == "ok" and clean.value is not None
    assert degraded.state == "low_quality"
    assert degraded.value is None  # 0 으로 대체하지 않는다
    assert degraded.confidence is not None and degraded.confidence < clean.confidence


def test_short_window_warms_up_without_value() -> None:
    t, rgb = _synthetic_rgb(72, seconds=4.0)
    metric = _adapter()._estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "low_quality"
    assert metric.value is None
    assert metric.confidence is None  # 아직 confidence 를 말할 근거가 없다


def test_flat_signal_is_held() -> None:
    t = np.arange(0.0, 14.0, 1.0 / FS)
    rgb = np.tile(np.array([0.6, 0.5, 0.42]), (len(t), 1))
    metric = _adapter()._estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "low_quality"
    assert metric.value is None


async def test_camera_fault_surfaces_as_exception() -> None:
    """카메라가 빠지면 예외로 올려 registry 가 state=error 로 강등하게 둔다."""
    adapter = _adapter()
    adapter._fault = "카메라 프레임을 연속으로 못 읽었다"
    with pytest.raises(RuntimeError):
        await adapter.read()


# --- quality.py -------------------------------------------------------------- #


def test_confidence_components_move_the_right_way() -> None:
    good = quality.score(
        peak_snr_db=15.0, band_energy_ratio=0.8, skin_ratio=0.4, brightness=128.0, jitter_norm=0.0
    )
    dark = quality.score(
        peak_snr_db=15.0, band_energy_ratio=0.8, skin_ratio=0.4, brightness=10.0, jitter_norm=0.0
    )
    shaky = quality.score(
        peak_snr_db=15.0, band_energy_ratio=0.8, skin_ratio=0.4, brightness=128.0, jitter_norm=1.0
    )

    assert 0.0 <= good.confidence <= 1.0
    assert good.confidence > dark.confidence
    assert good.confidence > shaky.confidence
    assert dark.hold_reason() == "lighting"
    assert shaky.hold_reason() == "motion/ROI jitter"


def test_roi_floor_holds_even_when_the_spectrum_looks_clean() -> None:
    """얼굴을 놓치면 SNR 이 아무리 좋아도 값을 내지 않는다.

    가중합에만 맡기면 q_roi 지분이 작아 잡음이 게이트를 통과한다. 실측에서
    피부 2% 상태로 159bpm 이 나갔던 경로다.
    """
    lost = quality.score(
        peak_snr_db=20.0, band_energy_ratio=0.9, skin_ratio=0.02, brightness=100.0, jitter_norm=0.0
    )
    assert lost.confidence == 0.0
    assert lost.hold_reason() == "low ROI quality"


def test_roi_floor_does_not_punish_a_normal_roi() -> None:
    ok = quality.score(
        peak_snr_db=20.0, band_energy_ratio=0.9, skin_ratio=0.12, brightness=100.0, jitter_norm=0.0
    )
    assert ok.confidence > 0.4


async def test_lost_face_is_held_end_to_end() -> None:
    """어댑터까지 이어서, 얼굴을 놓친 창은 low_quality 로 보류된다."""
    t, rgb = _synthetic_rgb(72)
    metric = _adapter()._estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.02, brightness=100.0)

    assert metric.state == "low_quality"
    assert metric.value is None
    assert metric.confidence == 0.0


def test_confidence_stays_in_range_at_extremes() -> None:
    best = quality.score(
        peak_snr_db=99.0, band_energy_ratio=1.0, skin_ratio=1.0, brightness=128.0, jitter_norm=0.0
    )
    worst = quality.score(
        peak_snr_db=-99.0, band_energy_ratio=0.0, skin_ratio=0.0, brightness=0.0, jitter_norm=1.0
    )
    assert best.confidence == pytest.approx(1.0, abs=1e-6)
    assert 0.0 <= worst.confidence <= 1.0


def test_gate_comes_from_thresholds_yaml() -> None:
    """임계값은 코드가 아니라 thresholds.yaml 이 정한다 (README §10)."""
    active = thresholds.load(REPO_ROOT / "config" / "thresholds.yaml")
    assert active.profile == "demo"
    assert active.confidence_min == 0.4


# --- 진행률 -------------------------------------------------------------- #
# 화면이 "기다리면 나온다"와 "신호가 나빠서 못 낸다"를 구분하려면 이 값이 필요하다.
# 둘 다 state=low_quality 라 상태만 보면 같아 보인다.


def test_progress_climbs_while_the_window_fills() -> None:
    adapter = _adapter()
    seen = []
    for seconds in (1.0, 2.0, 4.0, 6.0):
        t, rgb = _synthetic_rgb(72, seconds=seconds)
        metric = adapter._estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)
        assert metric.state == "low_quality" and metric.value is None
        assert metric.progress is not None
        seen.append(metric.progress)

    assert seen == sorted(seen), f"진행률이 단조증가하지 않는다: {seen}"
    assert all(p < 1.0 for p in seen), seen


def test_progress_is_full_once_a_value_comes_out() -> None:
    t, rgb = _synthetic_rgb(72)
    metric = _adapter()._estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "ok"
    assert metric.progress == 1.0


def test_bad_signal_is_full_progress_not_warming_up() -> None:
    """이 구분이 이 필드의 존재 이유다. 창은 다 찼고 신호가 나쁜 것이다."""
    t, rgb = _synthetic_rgb(72)
    metric = _adapter()._estimate(t, rgb, jitter_norm=1.0, skin_ratio=0.05, brightness=10.0)

    assert metric.state == "low_quality"
    assert metric.value is None
    assert metric.progress == 1.0  # 기다린다고 나아지지 않는다


def test_progress_needs_both_gates() -> None:
    """샘플이 적으면 창이 길어도 아직 못 낸다. 진행률은 덜 찬 쪽을 따른다."""
    t, rgb = _synthetic_rgb(72, seconds=14.0)
    sparse_t, sparse_rgb = t[::20], rgb[::20]  # 14초에 걸쳐 21개뿐

    metric = _adapter()._estimate(
        sparse_t, sparse_rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0
    )
    assert metric.state == "low_quality"
    assert metric.progress is not None and metric.progress < 1.0
