"""세션별 지표 격리.

여기서 고정하려는 것은 "내 지표가 남에게 안 보인다"다. 이 화면은 여러 사람이 각자
자기 기기 카메라로 심박을 재는 곳이 되고, 그 값이 섞이면 생체데이터가 새는 것이다.
로그인 게이트를 앞에 세운 이유(api/auth.py)가 여기서 실제로 쓰인다.

값이 섞여도 화면은 멀쩡해 보인다 — 숫자가 하나 떠 있을 뿐이라 누구 것인지는 화면에
안 적혀 있다. 그래서 눈으로 확인할 수 없고 테스트로 잡아야 한다.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from api.auth import COOKIE
from api.schemas import Metric, Snapshot
from api.ws import Hub, Viewer, view_for

REPO_ROOT = Path(__file__).resolve().parents[1]
TS = datetime(2026, 1, 1, tzinfo=UTC)


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.mock.yaml"))
    monkeypatch.setenv("TFV_USERS_DB", str(tmp_path / "users.db"))
    from api.main import app

    return TestClient(app)


def _metric(key: str, value: float | None, source: str = "rppg") -> Metric:
    return Metric(
        key=key,
        value=value,
        unit="bpm",
        source=source,
        mode="live",
        state="ok" if value is not None else "no_adapter",
        confidence=0.9 if value is not None else None,
        progress=1.0,
        ts=TS,
    )


def _room(hr: float | None = None) -> Snapshot:
    return Snapshot(
        device_id="tfv-test",
        ts=TS,
        metrics=[_metric("hr", hr), _metric("temp", 22.5, source="bme680")],
        interventions=[],
    )


class _FakeSocket:
    """Hub 가 쓰는 것만 흉내낸다 — accept 와 send_text."""

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def accept(self) -> None: ...

    async def send_text(self, payload: str) -> None:
        self.sent.append(payload)


# --- 어느 스냅샷을 볼 것인가 ------------------------------------------------ #


def test_the_room_view_is_untouched() -> None:
    """서버 센서를 보는 사람에게는 지금까지와 같은 것이 간다."""
    room = _room(hr=70.0)
    assert view_for(Viewer(key="a", source="server"), room, {"a": [_metric("hr", 61.0)]}) is room


def test_my_device_metric_replaces_the_same_card() -> None:
    room = _room(hr=None)
    view = view_for(Viewer(key="a", source="device"), room, {"a": [_metric("hr", 61.0)]})

    assert [m.value for m in view.metrics] == [61.0, 22.5]
    # 방의 나머지 카드는 그대로다. 브라우저에 없는 센서라고 카드를 지우면 이 시스템이
    # 무엇을 보는 물건인지가 화면에서 사라진다.
    assert [m.key for m in view.metrics] == [m.key for m in room.metrics]


def test_a_device_view_without_a_push_falls_back_to_the_room() -> None:
    """카메라를 아직 안 켠 사람에게 빈 화면을 주지 않는다."""
    room = _room(hr=None)
    assert view_for(Viewer(key="a", source="device"), room, {}) is room


def test_the_room_snapshot_is_not_mutated() -> None:
    """덮어쓰기가 원본을 건드리면 다음 사람에게 그 값이 새어 나간다."""
    room = _room(hr=None)
    view_for(Viewer(key="a", source="device"), room, {"a": [_metric("hr", 61.0)]})

    assert [m.value for m in room.metrics] == [None, 22.5]


# --- 실제로 나눠 보내는가 --------------------------------------------------- #


async def test_two_sessions_never_see_each_other() -> None:
    """이 파일의 존재 이유. 철수 값이 영희 소켓으로 나가면 안 된다."""
    hub = Hub()
    chulsoo, younghee, watcher = _FakeSocket(), _FakeSocket(), _FakeSocket()
    await hub.connect(chulsoo, Viewer(key="chulsoo", source="device"))  # type: ignore[arg-type]
    await hub.connect(younghee, Viewer(key="younghee", source="device"))  # type: ignore[arg-type]
    await hub.connect(watcher, Viewer(key="watcher", source="server"))  # type: ignore[arg-type]

    await hub.broadcast(
        _room(hr=None),
        {"chulsoo": [_metric("hr", 61.0)], "younghee": [_metric("hr", 132.0)]},
    )

    assert "61.0" in chulsoo.sent[0] and "132.0" not in chulsoo.sent[0]
    assert "132.0" in younghee.sent[0] and "61.0" not in younghee.sent[0]
    # 방을 보는 사람에게는 둘 다 안 간다. 방의 카메라가 낸 값이 아니다.
    assert "61.0" not in watcher.sent[0] and "132.0" not in watcher.sent[0]


async def test_the_same_session_in_two_tabs_sees_the_same_thing() -> None:
    """한 사람이 창을 두 개 열었을 뿐이다. 나누는 단위는 소켓이 아니라 세션이다."""
    hub = Hub()
    first, second = _FakeSocket(), _FakeSocket()
    await hub.connect(first, Viewer(key="chulsoo", source="device"))  # type: ignore[arg-type]
    await hub.connect(second, Viewer(key="chulsoo", source="device"))  # type: ignore[arg-type]

    await hub.broadcast(_room(hr=None), {"chulsoo": [_metric("hr", 61.0)]})

    assert first.sent == second.sent
    assert "61.0" in first.sent[0]


# --- 엔드포인트까지 이어서 -------------------------------------------------- #


def test_the_socket_carries_the_session_of_its_cookie(client: TestClient) -> None:
    """소스와 세션이 핸드셰이크에서 정해진다. 접속 뒤 클라이언트가 바꿀 수 없다."""
    with client:
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        token = client.cookies.get(COOKIE)
        assert token is not None

        state: Any = client.app.state  # type: ignore[attr-defined]
        state.personal = {token: [_metric("hr", 61.0)]}

        with client.websocket_connect("/ws?source=device") as ws:
            mine = ws.receive_json()
        with client.websocket_connect("/ws") as ws:  # 기본값은 서버 센서다
            room = ws.receive_json()

    assert _hr(mine) == 61.0
    assert _hr(room) != 61.0


def test_another_sessions_value_does_not_leak(client: TestClient) -> None:
    with client:
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        token = client.cookies.get(COOKIE)

        state: Any = client.app.state  # type: ignore[attr-defined]
        state.personal = {"someone-elses-token": [_metric("hr", 132.0)]}

        with client.websocket_connect("/ws?source=device") as ws:
            snapshot = ws.receive_json()

    assert token != "someone-elses-token"
    assert _hr(snapshot) != 132.0


def _hr(snapshot: dict[str, Any]) -> float | None:
    value = next(m["value"] for m in snapshot["metrics"] if m["key"] == "hr")
    return None if value is None else float(value)
