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
    assert body["interventions"] == []
    assert [m["key"] for m in body["metrics"]] == ["hr", "temp", "humidity", "rr", "posture"]


def test_websocket_pushes_snapshots(client: TestClient) -> None:
    with client, client.websocket_connect("/ws") as ws:
        first = json.loads(ws.receive_text())
        second = json.loads(ws.receive_text())

    assert first["ts"] != second["ts"]  # 계속 갱신된다
    rr = [m for m in second["metrics"] if m["key"] == "rr"][0]
    assert rr["mode"] == "simulated"
    assert rr["state"] in {"ok", "low_quality"}
