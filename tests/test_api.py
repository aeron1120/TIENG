"""mock 설정으로 서버를 띄웠을 때 스냅샷이 실제로 흐르는지."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.mock.yaml"))
    from api.main import app

    return TestClient(app)


def test_snapshot_endpoint_serves_the_contract(client: TestClient) -> None:
    with client:
        body = client.get("/api/snapshot").json()

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
