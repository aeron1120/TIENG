"""졸음 어댑터. 카메라 없이 계약과 점수 계산만 본다.

이 파일이 없어서 필드 하나가 빠진 채로 커밋될 뻔했다 — 린트도 테스트도 다 통과했고,
서버를 띄워 로그를 봐야 read() 가 매 틱 죽고 있다는 걸 알 수 있었다. 어댑터가
값을 못 내면 registry 가 빈 카드로 덮어 주는 탓에 화면상으로는 "측정 중"과
구분되지 않는다.
"""

import asyncio

import numpy as np
import pytest

from core.adapters.drowsiness import DrowsinessAdapter, _slope_per_min, _z
from core.tuning import Score

FLOOR = Score().z_sd_floor_rel  # 프로파일 기본값. 기준선이 고를 때의 민감도 상한이다.


def _adapter(**kw: object) -> DrowsinessAdapter:
    return DrowsinessAdapter(id="drowsy", mode="live", **kw)  # type: ignore[arg-type]


# --- 계약 ---------------------------------------------------------------- #


def test_read_survives_without_a_frame_source() -> None:
    """공급자를 못 찾아도 죽지 않는다. 카드가 값 없이 뜨고 사유가 화면에 실린다."""
    adapter = _adapter()
    adapter.attach_frames(None)

    metrics = asyncio.run(adapter.read())

    assert [m.key for m in metrics] == adapter.provides
    assert all(m.value is None for m in metrics)
    assert all(m.state == "no_adapter" for m in metrics)


def test_read_holds_while_frames_have_not_arrived() -> None:
    """공급자는 붙었는데 프레임이 아직 없는 구간. 고장이 아니라 준비 중이다."""
    adapter = _adapter()
    adapter.attach_frames(object())  # latest_frame 을 안 부르므로 형태만 맞으면 된다

    metrics = {m.key: m for m in asyncio.run(adapter.read())}

    assert metrics["drowsiness"].state == "low_quality"
    assert metrics["drowsiness"].progress == 0.0


def test_every_promised_metric_comes_out() -> None:
    """provides 와 실제 내보내는 키가 어긋나면 카드가 영영 안 뜬다."""
    adapter = _adapter()
    adapter.attach_frames(None)

    keys = [m.key for m in asyncio.run(adapter.read())]

    assert sorted(keys) == sorted(adapter.provides)
    assert len(keys) == len(set(keys)), "같은 키를 두 번 내보낸다"


# --- z 정규화 ------------------------------------------------------------- #
# 이게 이 어댑터의 핵심이다. 채널마다 평소 흔들리는 폭이 달라서, "몇 % 변했나"로
# 재면 잡음이 큰 채널이 과대평가된다.


def test_noisy_channel_needs_a_bigger_change_to_matter() -> None:
    """둘 다 30 움직였는데, 평소 흔들림이 4배인 쪽은 4분의 1만 인정받는다."""
    quiet = _z(130.0, 100.0, 15.0, FLOOR)  # 평소 ±15
    noisy = _z(130.0, 100.0, 60.0, FLOOR)  # 평소 ±60

    assert quiet == pytest.approx(2.0)
    assert noisy == pytest.approx(0.5)


def test_a_suspiciously_stable_baseline_cannot_make_us_hair_trigger() -> None:
    """기준선이 우연히 고르면 미세한 변화가 곧바로 만점이 된다. 하한이 그걸 막는다."""
    assert _z(101.0, 100.0, 0.0, FLOOR) == pytest.approx(0.1)  # 10% 가 1σ 로 취급된다


def test_score_ignores_channels_it_does_not_have() -> None:
    """가중치를 남은 채널에 나눠 주지 않는다 — 그러면 후행 지표 하나로 만점이 난다."""
    adapter = _adapter()
    base = {"perclos": (2.0, 1.0)}
    everything = adapter._score({"perclos": 99.0}, base)

    assert everything <= 10.1, "PERCLOS 혼자 만점을 내면 조기 경보라고 말할 수 없다"


def test_head_only_counts_when_it_goes_down() -> None:
    """고개를 드는 것은 졸음이 아니라 딴 데를 보는 것이다."""
    adapter = _adapter()
    base = {"pitch": (0.55, 0.02)}

    down = adapter._score({"pitch": 0.49}, base)
    up = adapter._score({"pitch": 0.61}, base)

    assert down > 0
    assert up == 0.0


# --- 추세 ---------------------------------------------------------------- #


def test_trend_needs_enough_history() -> None:
    assert _slope_per_min([(0.0, 10.0), (1.0, 20.0)]) is None


def test_trend_reads_points_per_minute() -> None:
    """1초에 1점씩 오르면 분당 60점이다."""
    history = [(float(t), float(t)) for t in range(60)]

    assert _slope_per_min(history) == pytest.approx(60.0)


def test_flat_history_has_no_trend() -> None:
    history = [(float(t), 42.0) for t in range(60)]

    assert _slope_per_min(history) == pytest.approx(0.0, abs=1e-9)


# --- 개안도 -------------------------------------------------------------- #


def test_openness_needs_a_real_crop() -> None:
    from core.adapters.drowsiness import _openness

    assert _openness(np.zeros((0, 0), np.uint8)) is None
    assert _openness(np.zeros((4, 4), np.uint8)) is None  # 너무 작으면 못 잰다
