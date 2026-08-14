"""화면이 쓰는 엔드포인트.

페이지가 늘면서 API 도 늘었다. 화면은 눈으로 확인하더라도, 화면이 기대는
응답 모양은 여기서 고정해 둔다.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.auth import Users
from tests.conftest import sign_in

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, account_db: Users) -> TestClient:
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.mock.yaml"))
    from api.main import app

    return sign_in(TestClient(app), account_db)


def test_system_reports_every_component(client: TestClient) -> None:
    with client:
        body = client.get("/api/system").json()

    assert body["ready"] is True
    assert body["device_id"] == "tfv-mock-01"
    assert {a["id"] for a in body["adapters"]} == {"env", "rppg", "rr_estimator", "posture"}
    assert all(a["state"] == "running" for a in body["adapters"])
    assert [a["id"] for a in body["actuators"]] == ["room_light", "guardian_email"]
    assert [p["level"] for p in body["policies"]] == ["L1", "L4"]
    assert body["thresholds"]["profile"] == "demo"


def test_system_explains_why_a_component_failed(
    monkeypatch: pytest.MonkeyPatch, account_db: Users
) -> None:
    """실패 사유가 화면까지 와야 배선을 고칠 수 있다."""
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.yaml"))
    from api.main import app

    with sign_in(TestClient(app), account_db) as client:
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


def test_camera_says_so_when_there_is_none(client: TestClient) -> None:
    """mock 구성에는 카메라가 없다. 화면은 이걸 보고 패널을 접는다."""
    with client:
        assert client.get("/api/camera").json() == {
            "available": False,
            "sources": [],
            "fps": 0.0,
        }
        assert client.get("/api/camera/stream").status_code == 404


def test_layout_survives_a_reload(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """브라우저 저장소를 안 쓰므로 (README §10) 서버가 배치를 기억해야 한다."""
    monkeypatch.setattr("core.layout.DEFAULT_PATH", tmp_path / "layout.json")

    with client:
        assert client.get("/api/layout").json() == {"hero": "hr", "order": []}

        saved = {"hero": "temp", "order": ["lux", "hr", "humidity"]}
        assert client.put("/api/layout", json=saved).status_code == 200
        assert client.get("/api/layout").json() == saved


def test_layout_falls_back_when_the_file_is_broken(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """배치 파일 하나 때문에 화면이 안 뜨면 안 된다."""
    broken = tmp_path / "layout.json"
    broken.write_text("{ 이건 JSON 이 아니다", encoding="utf-8")
    monkeypatch.setattr("core.layout.DEFAULT_PATH", broken)

    with client:
        assert client.get("/api/layout").json()["hero"] == "hr"


def test_layout_caps_how_much_it_will_store(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """클라이언트가 준 값을 그대로 디스크에 쓰는 유일한 경로다."""
    monkeypatch.setattr("core.layout.DEFAULT_PATH", tmp_path / "layout.json")

    with client:
        res = client.put("/api/layout", json={"hero": "hr", "order": [f"k{i}" for i in range(64)]})
        assert res.status_code == 422
        assert client.put("/api/layout", json={"hero": "x" * 200, "order": []}).status_code == 422


def test_cancel_rejects_unknown_intervention(client: TestClient) -> None:
    """이미 나간 알림은 취소되지 않는다. 없는 것도 마찬가지다."""
    with client:
        assert client.post("/api/interventions/없는id/cancel").status_code == 404
