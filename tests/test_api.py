"""mock 설정으로 서버를 띄웠을 때 스냅샷이 실제로 흐르는지."""

import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from core.adapters.hr_mock import HeartRateMock

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.mock.yaml"))
    from api.main import app

    return TestClient(app)


def snapshot_body(client: TestClient, timeout_s: float = 5.0) -> dict[str, Any]:
    """첫 스냅샷이 나올 때까지 기다린 뒤 본문을 준다.

    /api/snapshot 은 배경 루프가 첫 틱을 돌기 전에는 503 을 낸다. 그건 계약이다 —
    스냅샷이 없으면 없다고 답하고 빈 값을 지어내지 않는다 (README §0-4). 창이 열려
    있는 시간은 어댑터가 얼마나 무거운지에 달렸으므로(열화상은 캡처 스레드를 띄운다)
    바로 GET 하면 어느 쪽이 올지 알 수 없다.
    """
    deadline = time.monotonic() + timeout_s
    while True:
        response = client.get("/api/snapshot")
        if response.status_code == 200:
            body: dict[str, Any] = response.json()
            return body
        assert response.status_code == 503, f"뜻밖의 상태 {response.status_code}"
        assert time.monotonic() < deadline, f"{timeout_s}초 안에 첫 스냅샷이 안 나왔다"
        time.sleep(0.05)


def test_snapshot_endpoint_serves_the_contract(client: TestClient) -> None:
    with client:
        body = snapshot_body(client)

    assert body["device_id"] == "tfv-mock-01"
    assert [m["key"] for m in body["metrics"]] == [
        "temp", "humidity", "lux", "occupancy", "hr", "rr", "posture",
    ]


def test_websocket_pushes_snapshots(client: TestClient) -> None:
    with client, client.websocket_connect("/ws") as ws:
        first = json.loads(ws.receive_text())
        second = json.loads(ws.receive_text())

    assert first["ts"] != second["ts"]  # 계속 갱신된다
    rr = [m for m in second["metrics"] if m["key"] == "rr"][0]
    assert rr["mode"] == "simulated"
    assert rr["state"] in {"ok", "low_quality"}


def test_interventions_endpoint_serves_the_contract(client: TestClient) -> None:
    """개입이 없으면 빈 목록, 있으면 계약대로 생긴 이벤트."""
    with client:
        body = client.get("/api/interventions").json()

    assert isinstance(body, list)
    for event in body:
        assert event["level"] in {"L0", "L1", "L2", "L3", "L4"}
        assert event["trigger"]  # 왜 발화했는지가 비어 있으면 기록의 의미가 없다
        assert set(event) >= {"id", "level", "action", "trigger", "before", "after", "ts"}


def test_every_metric_carries_the_progress_field(client: TestClient) -> None:
    """계약에 필드가 늘었으면 전 지표가 그 모양으로 나가야 한다 (README §0-1)."""
    with client:
        body = snapshot_body(client)

    for metric in body["metrics"]:
        assert "progress" in metric, metric["key"]
        assert metric["progress"] is None or 0.0 <= metric["progress"] <= 1.0


async def test_mock_hr_warms_up_before_it_reports() -> None:
    """카메라 없이도 진행률 화면을 볼 수 있어야 데모에서 확인이 된다."""
    adapter = HeartRateMock(id="rppg", mode="simulated", warmup_s=4.0)

    steps = []
    for _ in range(6):
        metric = (await adapter.read())[0]
        steps.append((metric.state, metric.progress))

    # 앞 3틱은 준비 중, 그 뒤로는 창이 찼다.
    assert [s for s, _ in steps[:3]] == ["low_quality"] * 3
    assert [p for _, p in steps[:3]] == [0.25, 0.5, 0.75]
    assert all(p == 1.0 for _, p in steps[3:])


async def test_mock_hr_has_no_warmup_by_default() -> None:
    """기본값은 준비 구간 없음. 이 성질을 원하는 config 만 켠다."""
    adapter = HeartRateMock(id="rppg", mode="simulated")
    assert (await adapter.read())[0].progress == 1.0
