"""보는 사람이 없으면 카메라를 놓는다.

화면을 닫았는데 카메라 LED 가 남아 있으면, 그 기기는 무엇을 하고 있는지 모르는
기기가 된다. 반대로 새로고침마다 껐다 켜면 값이 계속 끊긴다 — 유예가 그 사이다.
"""

from __future__ import annotations

import asyncio

import pytest

from api import ws as ws_module
from api.ws import Hub
from core.adapters.camera import CameraAdapter


class _FakeSocket:
    def __init__(self) -> None:
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True


class _Watcher:
    """set_watched 가 언제 무엇으로 불렸는지만 기록한다."""

    def __init__(self) -> None:
        self.calls: list[bool] = []

    async def __call__(self, watched: bool) -> None:
        self.calls.append(watched)


@pytest.fixture(autouse=True)
def _short_grace(monkeypatch: pytest.MonkeyPatch) -> None:
    """유예를 테스트가 기다릴 만한 길이로 줄인다."""
    monkeypatch.setattr(ws_module, "IDLE_GRACE_S", 0.02)


async def _settle() -> None:
    """유예 타이머가 깨어날 시간을 준다."""
    await asyncio.sleep(0.05)


# --- 구독자 수 ------------------------------------------------------------- #


async def test_first_viewer_acquires() -> None:
    watcher = _Watcher()
    hub = Hub(on_watched=watcher)

    await hub.connect(_FakeSocket())  # type: ignore[arg-type]

    assert watcher.calls == [True]


async def test_second_viewer_does_not_acquire_again() -> None:
    """이미 열려 있는 장치를 다시 열 이유가 없다."""
    watcher = _Watcher()
    hub = Hub(on_watched=watcher)

    await hub.connect(_FakeSocket())  # type: ignore[arg-type]
    await hub.connect(_FakeSocket())  # type: ignore[arg-type]

    assert watcher.calls == [True]


async def test_last_viewer_leaving_releases() -> None:
    watcher = _Watcher()
    hub = Hub(on_watched=watcher)
    socket = _FakeSocket()

    await hub.connect(socket)  # type: ignore[arg-type]
    hub.disconnect(socket)  # type: ignore[arg-type]
    await _settle()

    assert watcher.calls == [True, False]


async def test_one_viewer_leaving_keeps_it_open() -> None:
    watcher = _Watcher()
    hub = Hub(on_watched=watcher)
    first, second = _FakeSocket(), _FakeSocket()

    await hub.connect(first)  # type: ignore[arg-type]
    await hub.connect(second)  # type: ignore[arg-type]
    hub.disconnect(first)  # type: ignore[arg-type]
    await _settle()

    assert watcher.calls == [True]


async def test_refresh_does_not_cycle_the_camera() -> None:
    """새로고침은 끊었다가 곧바로 다시 붙는 것이다. 유예 안에 돌아오면 그대로 둔다."""
    watcher = _Watcher()
    hub = Hub(on_watched=watcher)
    socket = _FakeSocket()

    await hub.connect(socket)  # type: ignore[arg-type]
    hub.disconnect(socket)  # type: ignore[arg-type]
    await hub.connect(_FakeSocket())  # type: ignore[arg-type]
    await _settle()

    assert watcher.calls == [True]


async def test_a_failing_device_does_not_break_the_connection() -> None:
    """카메라를 못 열었다고 화면까지 끊기면 무엇이 잘못됐는지 볼 방법이 없다."""

    async def explode(watched: bool) -> None:
        raise RuntimeError("카메라 0 를 열 수 없다")

    hub = Hub(on_watched=explode)
    socket = _FakeSocket()

    await hub.connect(socket)  # type: ignore[arg-type]

    assert socket.accepted is True


async def test_close_cancels_a_pending_release() -> None:
    """종료 뒤에 깨어나는 타이머를 남기지 않는다."""
    watcher = _Watcher()
    hub = Hub(on_watched=watcher)
    socket = _FakeSocket()

    await hub.connect(socket)  # type: ignore[arg-type]
    hub.disconnect(socket)  # type: ignore[arg-type]
    await hub.close()
    await _settle()

    assert watcher.calls == [True]


# --- 어댑터 --------------------------------------------------------------- #


async def test_releasing_an_unopened_camera_is_a_no_op() -> None:
    """기동 직후 구독자가 없으면 열지도 않은 카메라를 놓으라는 요청이 온다."""
    adapter = CameraAdapter(id="camera", mode="live")

    await adapter.release()  # 예외 없이 지나가야 한다

    assert adapter._cap is None


async def test_acquiring_twice_does_not_open_twice() -> None:
    """장치를 두 번 열면 Windows 에서는 점유 실패, Linux 에서는 노출이 흔들린다."""
    adapter = CameraAdapter(id="camera", mode="live")
    adapter._thread = object()  # type: ignore[assignment]

    await adapter.acquire()  # 열려 있다고 보고 그냥 돌아와야 한다

    assert adapter._cap is None
