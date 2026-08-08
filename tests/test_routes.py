"""화면이 쓰는 엔드포인트.

페이지가 늘면서 API 도 늘었다. 화면은 눈으로 확인하더라도, 화면이 기대는
응답 모양은 여기서 고정해 둔다.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.mock.yaml"))
    from api.main import app

    return TestClient(app)


def test_system_reports_every_component(client: TestClient) -> None:
    with client:
        body = client.get("/api/system").json()

    assert body["ready"] is True
    assert body["device_id"] == "tfv-mock-01"
    assert {a["id"] for a in body["adapters"]} == {"env", "rppg", "rr_estimator", "posture"}
    assert all(a["state"] == "running" for a in body["adapters"])
    assert [a["id"] for a in body["actuators"]] == ["room_light"]
    assert [p["level"] for p in body["policies"]] == ["L1"]
    assert body["thresholds"]["profile"] == "demo"


def test_system_explains_why_a_component_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    """실패 사유가 화면까지 와야 배선을 고칠 수 있다."""
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.yaml"))
    from api.main import app

    with TestClient(app) as client:
        body = client.get("/api/system").json()

    failed = [a for a in body["adapters"] if a["state"] == "failed"]
    assert failed, "하드웨어가 없는 개발 PC 에서는 실패한 어댑터가 있어야 한다"
    assert all(a["detail"] for a in failed)  # 사유가 비어 있으면 쓸모가 없다


def test_selftest_runs_in_a_separate_process(client: TestClient) -> None:
    """서버 안에서 직접 부르면 mock 들이 공유하는 방 상태를 흔든다."""
    with client:
        body = client.post("/api/selftest").json()

    assert body["total"] > 0
    assert body["passed"] == body["total"]
    assert body["exit_code"] == 0
    assert {c["section"] for c in body["checks"]}  # 섹션이 붙어 있어야 화면에서 묶는다


def test_validation_rejects_paths_outside_the_allowed_list(client: TestClient) -> None:
    """경로를 그대로 받으면 서버의 아무 파일이나 읽힌다."""
    with client:
        res = client.post(
            "/api/validation",
            json={"rppg": "../../etc/passwd", "ref": "../../etc/passwd"},
        )
    assert res.status_code == 400


def test_validation_reproduces_the_archived_numbers(client: TestClient) -> None:
    with client:
        datasets = {d["name"]: d["path"] for d in client.get("/api/validation/datasets").json()}
        res = client.post(
            "/api/validation",
            json={
                "rppg": datasets["static_demo_r1.csv"],
                "ref": datasets["static1_ref.csv"],
                "gate": 0.5,
                "ref_warmup_sec": 20.0,
            },
        )

    assert res.status_code == 200
    report = res.json()["markdown"]
    assert "3.65" in report and "0.720" in report  # 아카이브와 같은 값
    assert "보류율" in report


def test_log_download_stays_inside_logs(client: TestClient) -> None:
    with client:
        assert client.get("/api/logs/..%2F..%2Fpyproject.toml/download").status_code == 404
