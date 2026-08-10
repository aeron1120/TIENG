"""열화상 호흡 어댑터 자체 검증. 합성 프레임으로 도니 하드웨어가 필요 없다.

legacy/tieng_rppg/confidence/selftest_thermal.py 를 옮겨온 것으로, 이식 과정에서
캡처→ROI→추정 배선이 망가지지 않았는지가 핵심이다.

실장비가 오면 이 파일은 그대로 둔다. 합성 경로는 신호처리 검증용으로 계속 남기고,
실측은 scripts/hwcheck.py 와 별도 세션이 본다.
"""

import numpy as np
import pytest

from core.adapters.thermal_mlx90640 import (
    FRAME_H,
    FRAME_W,
    MIN_DELTA_T,
    MIN_ROI_PIXELS,
    SyntheticThermalCamera,
    ThermalFrame,
    ThermalRespiration,
    roi_stats,
)

ROI = (13, 9, 6, 5)  # 30픽셀
CAPTURE_DT = 0.25  # 4Hz


def _adapter(gate: float = 0.4, rpm: float = 15.0) -> ThermalRespiration:
    adapter = ThermalRespiration(id="thermal", mode="simulated", nostril_roi=list(ROI),
                                 synthetic_rpm=rpm)
    adapter._gate = gate
    return adapter


def _collect(rpm: float, seconds: float, dt: float = CAPTURE_DT) -> tuple[np.ndarray, np.ndarray]:
    """합성 카메라를 돌려 (시각, ROI 평균온도) 시계열을 만든다."""
    camera = SyntheticThermalCamera(rpm=rpm, seed=int(rpm), roi=ROI, dt=dt)
    times, temps = [], []
    for _ in range(int(seconds / dt)):
        frame = camera.read()
        mean_c, _, _ = roi_stats(frame, ROI)
        times.append(frame.t)
        temps.append(mean_c)
    return np.asarray(times, dtype=np.float64), np.asarray(temps, dtype=np.float64)


# --- roi_stats -------------------------------------------------------------- #


def test_roi_stats_reads_the_patch() -> None:
    grid = np.full((FRAME_H, FRAME_W), 20.0)
    grid[9:14, 13:19] = 33.0  # 5행 x 6열
    mean_c, pixels, delta_t = roi_stats(ThermalFrame(0.0, grid), ROI)

    assert mean_c == pytest.approx(33.0)
    assert pixels == 30
    assert delta_t == pytest.approx(0.0)


def test_roi_stats_clips_at_the_frame_edge() -> None:
    """코가 화면 가장자리에 걸쳐도 죽지 않아야 한다."""
    grid = np.full((FRAME_H, FRAME_W), 20.0)
    _, pixels, _ = roi_stats(ThermalFrame(0.0, grid), (30, 22, 6, 5))

    assert pixels == 4  # (30,22)~(32,24) 로 잘린다


def test_roi_stats_outside_the_frame_is_empty() -> None:
    grid = np.full((FRAME_H, FRAME_W), 20.0)
    mean_c, pixels, delta_t = roi_stats(ThermalFrame(0.0, grid), (40, 40, 4, 4))

    assert pixels == 0
    assert np.isnan(mean_c)  # 0 으로 대체하지 않는다
    assert delta_t == 0.0


# --- 추정 ------------------------------------------------------------------- #


@pytest.mark.parametrize("true_rpm", [10, 15, 22])
def test_recovers_synthetic_breathing(true_rpm: int) -> None:
    """4Hz 로 30초 모아서 합성 호흡을 복원한다 (RR 최소 창 20초)."""
    times, temps = _collect(true_rpm, seconds=30.0)
    metric = _adapter(rpm=true_rpm)._estimate(times, temps, roi_pixels=30, delta_t=3.0)

    assert metric.state == "ok", f"보류됨 (confidence={metric.confidence})"
    assert metric.value is not None
    assert abs(float(metric.value) - true_rpm) <= 2.0
    assert metric.unit == "rpm"
    assert metric.key == "rr"
    assert metric.progress == 1.0


def test_confidence_is_reported_with_the_value() -> None:
    times, temps = _collect(15, seconds=30.0)
    metric = _adapter()._estimate(times, temps, roi_pixels=30, delta_t=3.0)

    assert metric.confidence is not None and metric.confidence >= 0.4


# --- 게이트 ----------------------------------------------------------------- #


def test_roi_too_small_is_held() -> None:
    """코가 너무 멀면 픽셀이 몇 개 안 남는다. 32x24 에서는 현실적인 실패다."""
    times, temps = _collect(15, seconds=30.0)
    metric = _adapter()._estimate(times, temps, roi_pixels=MIN_ROI_PIXELS - 1, delta_t=3.0)

    assert metric.state == "low_quality"
    assert metric.value is None


def test_low_thermal_contrast_is_held() -> None:
    """실온이 체온에 가까워지면 날숨과 주변의 온도차가 줄어 신호가 묻힌다."""
    times, temps = _collect(15, seconds=30.0)
    metric = _adapter()._estimate(times, temps, roi_pixels=30, delta_t=MIN_DELTA_T / 2)

    assert metric.state == "low_quality"
    assert metric.value is None


def test_flat_signal_is_held_not_guessed() -> None:
    """렌즈가 가려지면 온도가 안 움직인다. 값을 지어내지 않는다 (README §0-4)."""
    times = np.arange(0.0, 30.0, CAPTURE_DT)
    metric = _adapter()._estimate(times, np.full(len(times), 33.0), roi_pixels=30, delta_t=3.0)

    assert metric.state == "low_quality"
    assert metric.value is None


# --- progress --------------------------------------------------------------- #


def test_progress_climbs_while_the_window_fills() -> None:
    """RR 은 20초를 채워야 첫 값이 나온다. 그 구간과 품질 미달은 화면에서 달라야 한다."""
    seen = []
    for seconds in (4.0, 8.0, 14.0, 19.0):
        times, temps = _collect(15, seconds=seconds)
        metric = _adapter()._estimate(times, temps, roi_pixels=30, delta_t=3.0)
        assert metric.state == "low_quality" and metric.value is None
        assert metric.progress is not None
        seen.append(metric.progress)

    assert seen == sorted(seen), f"진행률이 단조증가하지 않는다: {seen}"
    assert all(p < 1.0 for p in seen), seen


def test_bad_signal_is_full_progress_not_warming_up() -> None:
    """이 구분이 progress 의 존재 이유다. 창은 다 찼고 온도 대비가 없는 것이다."""
    times, temps = _collect(15, seconds=30.0)
    metric = _adapter()._estimate(times, temps, roi_pixels=30, delta_t=0.0)

    assert metric.state == "low_quality"
    assert metric.progress == 1.0  # 기다린다고 나아지지 않는다


# --- 배선 ------------------------------------------------------------------- #


async def test_simulated_mode_needs_no_hardware() -> None:
    """mode=simulated 면 합성 카메라로 돌고, 창이 차기 전에는 값을 안 낸다."""
    adapter = _adapter()
    await adapter.start()
    try:
        metric = (await adapter.read())[0]
    finally:
        await adapter.stop()

    assert metric.mode == "simulated"  # 합성값에 실측 뱃지를 붙이지 않는다
    assert metric.value is None  # 방금 켰으니 20초 창이 아직 비었다
    assert metric.progress is not None and metric.progress < 1.0


def test_bad_roi_config_fails_loudly() -> None:
    with pytest.raises(ValueError, match="nostril_roi"):
        ThermalRespiration(id="thermal", mode="simulated", nostril_roi=[1, 2, 3])


def test_ingest_timestamps_come_from_the_frame() -> None:
    """캡처 경로가 프레임의 시계를 쓰는지.

    여기서 time.monotonic() 을 다시 읽으면 합성 카메라의 사인파 위상과 타임스탬프가
    어긋나서, 루프가 드리프트한 만큼 rpm 이 틀리게 나온다. 캡처 루프는 실시간으로
    쉬기 때문에 20초를 기다릴 수 없어 _ingest 를 직접 먹인다 — 루프가 프레임마다
    하는 일이 이것뿐이다.
    """
    adapter = _adapter(rpm=15.0)
    camera = SyntheticThermalCamera(rpm=15.0, seed=15, roi=ROI, dt=CAPTURE_DT)
    for _ in range(int(30.0 / CAPTURE_DT)):
        adapter._ingest(camera.read())

    assert adapter._times[0] == pytest.approx(CAPTURE_DT)  # 실시간이 아니라 합성 시계
    metric = adapter._estimate(
        np.asarray(adapter._times), np.asarray(adapter._temps),
        adapter._roi_pixels, adapter._delta_t,
    )
    assert metric.state == "ok", f"보류됨 (confidence={metric.confidence})"
    assert metric.value is not None and abs(float(metric.value) - 15.0) <= 2.0


def test_ingest_drops_frames_older_than_the_window() -> None:
    """창 밖으로 나간 표본은 버린다. 안 버리면 메모리가 계속 자란다."""
    adapter = _adapter()
    camera = SyntheticThermalCamera(rpm=15.0, roi=ROI, dt=CAPTURE_DT)
    for _ in range(int(3 * adapter.window_s / CAPTURE_DT)):
        adapter._ingest(camera.read())

    span = adapter._times[-1] - adapter._times[0]
    assert span <= adapter.window_s
    assert len(adapter._times) == len(adapter._temps)
