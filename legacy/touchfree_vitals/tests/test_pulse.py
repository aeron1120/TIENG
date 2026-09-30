"""core/pulse.py 신호경로 검증. 카메라 없이 합성 신호로 돈다.

브라우저 카메라가 올린 RGB 가 타는 추정기다 (api/routes/rppg.py). 파이 카메라 쪽
어댑터(core/adapters/rppg.py)는 tests/test_rppg.py 가 본다.

legacy/tieng_rppg 의 selftest 2·3 을 옮겨온 것으로, 이식 과정에서 알고리즘이
망가지지 않았는지가 핵심이다.
"""

import time
from pathlib import Path

import numpy as np
import pytest

from core import quality, thresholds
from core.pulse import HrEstimator, _coefficients

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


def _estimator(gate: float = 0.4) -> HrEstimator:
    """신호경로만 본다. 카메라는 여기 관여하지 않는다 (core/pulse.py).

    어댑터를 거치지 않는 이유는 추정기가 프레임 소스를 모르기 때문이다 — 브라우저가
    올린 RGB 도 같은 객체를 탄다.
    """
    return HrEstimator(source="rppg", mode="live", gate=gate)


@pytest.mark.parametrize("true_bpm", [55, 72, 90, 120, 150])
def test_estimates_known_bpm_within_3(true_bpm: int) -> None:
    t, rgb = _synthetic_rgb(true_bpm)
    metric = _estimator().estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "ok", f"보류됨 (confidence={metric.confidence})"
    assert metric.value is not None
    assert abs(float(metric.value) - true_bpm) <= 3.0
    assert metric.unit == "bpm"


def test_degraded_input_is_held_not_guessed() -> None:
    """어둡고 흔들리고 피부가 안 잡히면 값을 내지 않는다 (README §0-4)."""
    t, rgb = _synthetic_rgb(72)
    estimator = _estimator()

    clean = estimator.estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)
    degraded = estimator.estimate(t, rgb, jitter_norm=1.0, skin_ratio=0.05, brightness=10.0)

    assert clean.state == "ok" and clean.value is not None
    assert degraded.state == "low_quality"
    assert degraded.value is None  # 0 으로 대체하지 않는다
    # 값을 보류했더라도 왜 보류했는지는 숫자로 말할 수 있어야 한다. 둘 다 있어야
    # 비교도 성립한다.
    assert clean.confidence is not None and degraded.confidence is not None
    assert degraded.confidence < clean.confidence


def test_short_window_warms_up_without_value() -> None:
    t, rgb = _synthetic_rgb(72, seconds=4.0)
    metric = _estimator().estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "low_quality"
    assert metric.value is None
    assert metric.confidence is None  # 아직 confidence 를 말할 근거가 없다


def test_the_bandpass_is_designed_once_per_setting() -> None:
    """계수는 신호가 아니라 설정에서 나온다.

    설계가 estimate() 시간의 4분의 1 이었다. 신호와 무관한 일을 초당 한 번씩,
    재는 사람 수만큼 다시 하고 있었다.

    다시 하지 않는 대신 설정이 다르면 반드시 다른 계수가 나와야 한다. 캐시가
    섞이면 15Hz 로 올라온 신호를 30Hz 용 필터로 거르게 되고, 그건 화면에
    "값이 좀 이상하다"로만 보인다.
    """
    same = _coefficients(30.0, 42.0, 180.0)
    assert _coefficients(30.0, 42.0, 180.0) is same  # 다시 설계하지 않는다

    assert not np.array_equal(same[0], _coefficients(15.0, 42.0, 180.0)[0])
    assert not np.array_equal(same[0], _coefficients(30.0, 50.0, 180.0)[0])


def test_flat_signal_is_held() -> None:
    t = np.arange(0.0, 14.0, 1.0 / FS)
    rgb = np.tile(np.array([0.6, 0.5, 0.42]), (len(t), 1))
    metric = _estimator().estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "low_quality"
    assert metric.value is None


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
    metric = _estimator().estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.02, brightness=100.0)

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
    estimator = _estimator()
    seen = []
    for seconds in (1.0, 2.0, 4.0, 6.0):
        t, rgb = _synthetic_rgb(72, seconds=seconds)
        metric = estimator.estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)
        assert metric.state == "low_quality" and metric.value is None
        assert metric.progress is not None
        seen.append(metric.progress)

    assert seen == sorted(seen), f"진행률이 단조증가하지 않는다: {seen}"
    assert all(p < 1.0 for p in seen), seen


def test_progress_is_full_once_a_value_comes_out() -> None:
    t, rgb = _synthetic_rgb(72)
    metric = _estimator().estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "ok"
    assert metric.progress == 1.0


def test_bad_signal_is_full_progress_not_warming_up() -> None:
    """이 구분이 이 필드의 존재 이유다. 창은 다 찼고 신호가 나쁜 것이다."""
    t, rgb = _synthetic_rgb(72)
    metric = _estimator().estimate(t, rgb, jitter_norm=1.0, skin_ratio=0.05, brightness=10.0)

    assert metric.state == "low_quality"
    assert metric.value is None
    assert metric.progress == 1.0  # 기다린다고 나아지지 않는다


# --- 점프 거부 ------------------------------------------------------------- #
# 신호가 나쁜 것과 값만 버린 것은 다르다. 실기에서 신뢰도 0.91 인데 124bpm 후보가
# 올라온 적이 있는데, 둘을 한 상태로 묶으면 화면이 "품질 미달"이라고 말하면서 옆에
# 높은 신뢰도를 같이 띄우게 된다.


def test_jump_rejection_reports_rejected_not_low_quality() -> None:
    estimator = _estimator()
    t, rgb = _synthetic_rgb(72)
    # 1초 전에 130bpm 을 받아들인 것으로 둔다. 72 로 내려오려면 8bpm/s 를 훌쩍 넘는다.
    estimator._prev_bpm = 130.0
    estimator._prev_t = time.monotonic() - 1.0

    metric = estimator.estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "rejected"
    assert metric.value is None  # 지어내지 않는다 (README §0-4)
    assert metric.progress == 1.0  # 기다린다고 나아지는 상태가 아니다
    # 게이트를 통과한 신호다. 이 값이 낮으면 애초에 low_quality 로 갔어야 한다.
    assert metric.confidence is not None and metric.confidence >= estimator.gate


def test_plausible_change_still_comes_out() -> None:
    """가드가 정상 변화까지 막으면 값이 영영 안 나온다. 8bpm/s 안쪽은 통과한다."""
    estimator = _estimator()
    t, rgb = _synthetic_rgb(72)
    estimator._prev_bpm = 70.0
    estimator._prev_t = time.monotonic() - 1.0

    metric = estimator.estimate(t, rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0)

    assert metric.state == "ok"
    assert metric.value is not None


def test_progress_needs_both_gates() -> None:
    """샘플이 적으면 창이 길어도 아직 못 낸다. 진행률은 덜 찬 쪽을 따른다."""
    t, rgb = _synthetic_rgb(72, seconds=14.0)
    sparse_t, sparse_rgb = t[::20], rgb[::20]  # 14초에 걸쳐 21개뿐

    metric = _estimator().estimate(
        sparse_t, sparse_rgb, jitter_norm=0.0, skin_ratio=0.35, brightness=128.0
    )
    assert metric.state == "low_quality"
    assert metric.progress is not None and metric.progress < 1.0
