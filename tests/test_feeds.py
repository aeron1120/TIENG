"""브라우저 카메라 표본 경로.

여기서 고정하려는 것은 둘이다.

1. 웹에서 잰 값이 파이에서 잰 값과 같은 계산을 탄다. 두 배포의 숫자가 갈리면
   "이 심박은 검증된 값"이라고 말할 근거가 없어진다 (core/quality.py 의 이관 기록).
2. 카메라를 끄면 마지막 값이 화면에 남지 않는다. 멎은 숫자가 실시간인 척 남아
   있는 것은 값을 지어내는 것과 같다 (README §0-4).
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from api.feeds import STALE_AFTER_S, Feed, Feeds
from core.pulse import HrEstimator

REPO_ROOT = Path(__file__).resolve().parents[1]
FS = 30.0


def _synthetic_rgb(true_bpm: float, seconds: float = 12.0) -> tuple[np.ndarray, np.ndarray]:
    """tests/test_rppg.py 와 같은 신호. 두 경로를 같은 입력으로 비교하려는 것이다.

    기본 길이가 창(WINDOW_SEC)과 같은 12초인 이유: 더 길게 주면 Feed 가 앞쪽을
    잘라 내므로 추정기에 직접 넣은 것과 입력이 달라진다. 자르는 것 자체는 카메라
    어댑터와 같은 동작이고, 여기서 보려는 것은 모으는 과정이 신호를 건드리는가다.
    """
    rng = np.random.default_rng(0)
    t = np.arange(0.0, seconds, 1.0 / FS)
    pulse = np.sin(2 * np.pi * (true_bpm / 60.0) * t)
    drift = 0.015 * np.sin(2 * np.pi * 0.08 * t)
    rgb = (
        np.array([0.60, 0.50, 0.42])[None, :]
        + np.outer(pulse, [0.010, 0.030, 0.015])
        + drift[:, None]
        + rng.normal(0, 0.004, size=(len(t), 3))
    )
    return t, rgb


def _samples(t: np.ndarray, rgb: np.ndarray) -> list[tuple[float, float, float, float]]:
    return [(float(ts), float(r), float(g), float(b)) for ts, (r, g, b) in zip(t, rgb, strict=True)]


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.cloud.yaml"))
    monkeypatch.setenv("TFV_USERS_DB", str(tmp_path / "users.db"))
    from api.main import app

    return TestClient(app)


# --- 숫자가 같은가 ---------------------------------------------------------- #


@pytest.mark.parametrize("true_bpm", [55, 72, 120])
def test_the_browser_path_gives_the_same_bpm(true_bpm: int) -> None:
    """창이 다 찬 뒤 한 번에 넣으면 추정기를 직접 부른 것과 같아야 한다.

    브라우저 경로가 하는 일은 표본을 모아 두는 것뿐이다. 여기서 값이 갈리면
    모으는 과정이 신호를 건드린 것이다.
    """
    t, rgb = _synthetic_rgb(true_bpm)

    direct = HrEstimator(source="browser", mode="live", gate=0.4).estimate(
        t, rgb, 0.0, 0.35, 128.0
    )
    through_feed = Feed(source="browser", mode="live", gate=0.4).push(
        _samples(t, rgb), 0.0, 0.35, 128.0
    )

    assert through_feed.value == direct.value
    assert through_feed.confidence == direct.confidence
    assert through_feed.state == direct.state == "ok"
    assert abs(float(direct.value or 0) - true_bpm) <= 3.0


def test_arriving_in_batches_matches_one_shot() -> None:
    """실제로는 초당 한 묶음씩 온다. 나눠 넣었다고 값이 달라지면 안 된다."""
    t, rgb = _synthetic_rgb(72)
    samples = _samples(t, rgb)

    one_shot = Feed(source="browser", mode="live", gate=0.4).push(samples, 0.0, 0.35, 128.0)

    piecemeal = Feed(source="browser", mode="live", gate=0.4)
    last = None
    for start in range(0, len(samples), 30):  # 1초 치씩
        last = piecemeal.push(samples[start : start + 30], 0.0, 0.35, 128.0)

    assert last is not None
    assert last.value == one_shot.value
    assert last.confidence == one_shot.confidence


def test_out_of_order_samples_are_dropped() -> None:
    """탭이 백그라운드로 가면 브라우저 시계가 실제로 흔들린다."""
    t, rgb = _synthetic_rgb(72)
    samples = _samples(t, rgb)
    feed = Feed(source="browser", mode="live", gate=0.4)

    feed.push(samples, 0.0, 0.35, 128.0)
    before = feed.metrics()[0].value
    # 이미 지나간 시각의 표본을 다시 밀어 넣는다.
    feed.push(samples[:60], 0.0, 0.35, 128.0)

    assert feed.metrics()[0].value == before


def test_a_short_window_warms_up_instead_of_guessing() -> None:
    t, rgb = _synthetic_rgb(72, seconds=3.0)
    metric = Feed(source="browser", mode="live", gate=0.4).push(
        _samples(t, rgb), 0.0, 0.35, 128.0
    )

    assert metric.state == "low_quality"
    assert metric.value is None
    assert metric.progress is not None and metric.progress < 1.0


# --- 끄면 사라지는가 -------------------------------------------------------- #


def test_a_silent_session_drops_out() -> None:
    feeds = Feeds()
    t, rgb = _synthetic_rgb(72)
    feeds.feed("chulsoo").push(_samples(t, rgb), 0.0, 0.35, 128.0)

    assert feeds.get("chulsoo")  # 방금 올렸으니 보인다

    feeds._feeds["chulsoo"].touched = time.monotonic() - STALE_AFTER_S - 0.1
    assert feeds.get("chulsoo") is None  # 멎은 값은 안 나간다

    feeds.prune()
    assert len(feeds) == 0


def test_dropping_is_immediate() -> None:
    """카메라를 끈 사람은 몇 초를 기다리지 않아야 한다."""
    feeds = Feeds()
    t, rgb = _synthetic_rgb(72)
    feeds.feed("chulsoo").push(_samples(t, rgb), 0.0, 0.35, 128.0)

    feeds.drop("chulsoo")
    assert feeds.get("chulsoo") is None


def test_two_sessions_keep_separate_estimators() -> None:
    """추정기는 상태를 들고 있다. 하나를 돌려 쓰면 한쪽의 이전 값이 다른 쪽의
    점프 판정 기준이 된다."""
    feeds = Feeds()
    slow_t, slow_rgb = _synthetic_rgb(55)
    fast_t, fast_rgb = _synthetic_rgb(120)

    slow = feeds.feed("chulsoo").push(_samples(slow_t, slow_rgb), 0.0, 0.35, 128.0)
    fast = feeds.feed("younghee").push(_samples(fast_t, fast_rgb), 0.0, 0.35, 128.0)

    assert slow.value is not None and fast.value is not None
    assert abs(float(slow.value) - 55) <= 3.0
    assert abs(float(fast.value) - 120) <= 3.0  # 55 다음이라고 점프로 거부되면 안 된다


# --- 엔드포인트 ------------------------------------------------------------- #


def test_pushing_needs_a_session(client: TestClient) -> None:
    with client:
        t, rgb = _synthetic_rgb(72, seconds=1.0)
        body = {"samples": _samples(t, rgb), "skin_ratio": 0.35, "brightness": 128.0}
        assert client.post("/api/rppg/samples", json=body).status_code == 401


def test_a_pushed_value_comes_back_on_my_socket_only(client: TestClient) -> None:
    with client:
        client.post("/api/auth/guest")
        t, rgb = _synthetic_rgb(72)
        body = {"samples": _samples(t, rgb), "skin_ratio": 0.35, "brightness": 128.0}

        reading = client.post("/api/rppg/samples", json=body).json()
        assert reading["metric"]["state"] == "ok"
        assert reading["metric"]["value"] is not None
        assert reading["metric"]["mode"] == "live"  # 진짜 카메라로 잰 값이다

        with client.websocket_connect("/ws?source=device") as ws:
            mine = ws.receive_json()
        with client.websocket_connect("/ws") as ws:
            room = ws.receive_json()

    hr = next(m for m in mine["metrics"] if m["key"] == "hr")
    assert hr["value"] == reading["metric"]["value"]
    # 방을 보는 화면에는 안 나온다. 이 배포에는 카메라가 없다.
    assert next(m for m in room["metrics"] if m["key"] == "hr")["value"] is None


def test_an_oversized_batch_is_refused(client: TestClient) -> None:
    """한 요청이 이벤트 루프를 오래 잡으면 1Hz 샘플 루프가 밀린다."""
    with client:
        client.post("/api/auth/guest")
        body = {"samples": [[float(i), 0.6, 0.5, 0.42] for i in range(5000)]}
        assert client.post("/api/rppg/samples", json=body).status_code == 422


def test_quality_components_are_clamped(client: TestClient) -> None:
    """브라우저가 보내는 값이라 범위를 넘겨 신뢰도를 부풀릴 수 있으면 안 된다."""
    with client:
        client.post("/api/auth/guest")
        t, rgb = _synthetic_rgb(72, seconds=1.0)
        body = {"samples": _samples(t, rgb), "skin_ratio": 9.0}
        assert client.post("/api/rppg/samples", json=body).status_code == 422
