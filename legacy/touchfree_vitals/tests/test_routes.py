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
        assert client.get("/api/camera").json() == {"available": False, "sources": []}
        assert client.get("/api/camera/stream").status_code == 404


def test_layout_survives_a_reload(client: TestClient) -> None:
    """브라우저 저장소를 안 쓰므로 (README §10) 서버가 배치를 기억해야 한다."""
    with client:
        assert client.get("/api/layout").json() == {"hero": "hr", "order": []}

        saved = {"hero": "temp", "order": ["lux", "hr", "humidity"]}
        assert client.put("/api/layout", json=saved).status_code == 200
        assert client.get("/api/layout").json() == saved


def test_a_layout_belongs_to_the_account(client: TestClient, account_db: Users) -> None:
    """한 사람이 배치를 바꿨다고 다른 사람 화면이 같이 바뀌면 안 된다.

    기기별 파일 하나에 두던 것을 계정별로 옮긴 이유가 이것이다 (core/layout.py).
    화면이 공개 주소로 열리면서 방 하나에 태블릿 하나라는 전제가 깨졌다.
    """
    with client:
        client.put("/api/layout", json={"hero": "camera", "order": ["hr"]})

        # 두 번째 계정을 만들고 승인한 뒤 그쪽으로 갈아탄다.
        client.post("/api/auth/register", json={"username": "nurse", "password": "battery staple"})
        nurse = next(a for a in client.get("/api/auth/users").json() if a["username"] == "nurse")
        client.put(f"/api/auth/users/{nurse['id']}/approved", json={"approved": True})
        client.post("/api/auth/login", json={"username": "nurse", "password": "battery staple"})

        assert client.get("/api/layout").json() == {"hero": "hr", "order": []}
        client.put("/api/layout", json={"hero": "lux", "order": []})

        # 돌아오면 내 배치가 그대로 있어야 한다.
        client.post("/api/auth/login", json={"username": "tester", "password": "correct horse"})
        assert client.get("/api/layout").json() == {"hero": "camera", "order": ["hr"]}


def test_a_broken_layout_falls_back(client: TestClient, account_db: Users) -> None:
    """배치 한 줄 때문에 화면이 안 뜨면 곤란하다."""
    with client:
        client.put("/api/layout", json={"hero": "temp", "order": ["lux"]})

    with account_db._connect() as conn:  # noqa: SLF001 - 깨진 값을 만들 다른 길이 없다
        conn.execute("UPDATE layouts SET ordering = '{ 이건 JSON 이 아니다'")

    with client:
        assert client.get("/api/layout").json() == {"hero": "hr", "order": []}


def test_layout_caps_how_much_it_will_store(client: TestClient) -> None:
    """클라이언트가 준 값을 그대로 저장소에 쓰는 경로다."""
    with client:
        res = client.put("/api/layout", json={"hero": "hr", "order": [f"k{i}" for i in range(64)]})
        assert res.status_code == 422
        assert client.put("/api/layout", json={"hero": "x" * 200, "order": []}).status_code == 422


# --- 카메라 backend 선택 ------------------------------------------------------ #
# 파이에 ssh 로 붙어 device.yaml 을 고치고 서비스를 재시작하는 대신 화면에서 바꾼다.
# 진짜 rppg 대신 가짜 어댑터를 쓰는 이유는 tests/fixture_camera.py 에 적어 뒀다.

CAMERA_YAML = """
device_id: tfv-cam-01
adapters:
  - id: rppg
    module: tests.fixture_camera
    mode: live
    params: { backend: picamera2 }
"""


@pytest.fixture
def camera_client(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, account_db: Users
) -> TestClient:
    config = tmp_path / "device.yaml"
    config.write_text(CAMERA_YAML, encoding="utf-8")
    monkeypatch.setenv("DEVICE_CONFIG", str(config))
    monkeypatch.setattr("core.registry.CAMERA_MODULE", "tests.fixture_camera")
    # 실기의 state/overrides.json 에 쓰지 않는다.
    monkeypatch.setattr("core.overrides.DEFAULT_PATH", tmp_path / "overrides.json")
    from api.main import app

    return sign_in(TestClient(app), account_db)


def test_switching_backend_reopens_only_that_adapter(camera_client: TestClient) -> None:
    """CSI 가 안 열릴 때 화면에서 opencv 로 바꾸면 카드가 바로 살아난다."""
    with camera_client as client:
        before = client.get("/api/system").json()
        assert before["camera_backend"] == "picamera2"
        assert before["camera_adapter"] == "rppg"
        assert before["adapters"][0]["state"] == "failed"

        body = client.put("/api/system/camera-backend", json={"backend": "opencv"}).json()

    assert body["camera_backend"] == "opencv"
    assert body["adapters"][0]["state"] == "running"


def test_the_chosen_backend_survives_a_restart(
    camera_client: TestClient, tmp_path: Path
) -> None:
    """device.yaml 은 그대로 두고 state/ 에 남긴다 (core/overrides.py)."""
    with camera_client as client:
        client.put("/api/system/camera-backend", json={"backend": "opencv"})

    config = tmp_path / "device.yaml"
    assert "backend: picamera2" in config.read_text(encoding="utf-8")  # 파일은 안 건드린다

    with camera_client as client:  # lifespan 을 다시 태운다 = 서버 재시작
        body = client.get("/api/system").json()

    assert body["camera_backend"] == "opencv"
    assert body["adapters"][0]["state"] == "running"


def test_unknown_backend_never_reaches_the_adapter(camera_client: TestClient) -> None:
    """오타가 조용히 엉뚱한 카메라를 열면 안 된다."""
    with camera_client as client:
        res = client.put("/api/system/camera-backend", json={"backend": "picamera"})
        assert res.status_code == 422
        assert client.get("/api/system").json()["camera_backend"] == "picamera2"


def test_no_camera_adapter_means_nothing_to_switch(client: TestClient) -> None:
    """mock 구성에는 rppg 카메라가 없다. 화면은 선택칸을 감춘다."""
    with client:
        assert client.get("/api/system").json()["camera_backend"] is None
        res = client.put("/api/system/camera-backend", json={"backend": "opencv"})
        assert res.status_code == 404


def test_cancel_rejects_unknown_intervention(client: TestClient) -> None:
    """이미 나간 알림은 취소되지 않는다. 없는 것도 마찬가지다."""
    with client:
        assert client.post("/api/interventions/없는id/cancel").status_code == 404
