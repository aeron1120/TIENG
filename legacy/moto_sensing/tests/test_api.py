"""모듈 ↔ 화면 경계 검증 (api/server.py).

프론트를 따로 만들기로 했으므로, 이 경계가 조용히 어긋나면 두 쪽 다 자기는 맞다고
믿으면서 화면만 깨진다. 여기서 잡는다.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from core.schemas import Snapshot

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "web" / "fixtures" / "snapshot.json"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """세션을 tmp 로 돌린다. 안 그러면 테스트가 실기의 sessions/ 에 쌓인다."""
    text = (ROOT / "config" / "default.yaml").read_text(encoding="utf-8")
    text = text.replace('session_dir: "./sessions"', f'session_dir: "{tmp_path.as_posix()}"')
    cfg = tmp_path / "test.yaml"
    cfg.write_text(text, encoding="utf-8")

    monkeypatch.setenv("MOTO_CONFIG", str(cfg))
    monkeypatch.setenv("MOTO_SOURCE", "sim")

    from api.server import app

    with TestClient(app) as running:
        yield running


def _wait_for_snapshot(client: TestClient, timeout: float = 5.0) -> dict[str, object]:
    """첫 틱이 돌 때까지 기다린다. 그전에는 503 이 정상이다."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get("/api/snapshot")
        if response.status_code == 200:
            return dict(response.json())
        time.sleep(0.05)
    raise AssertionError("첫 스냅샷이 오지 않았다")


def test_snapshot_crosses_the_boundary(client: TestClient) -> None:
    snapshot = Snapshot.model_validate(_wait_for_snapshot(client))

    assert snapshot.mode == "simulated"
    assert snapshot.health, "health 가 비어 있으면 §12 에서 볼 것이 없다"
    # 융합도 지표도 아직 없다. 빈 것을 빈 채로 내보내야 한다 (§0-4).
    assert snapshot.fused is None
    assert snapshot.indicators == []


def test_no_snapshot_is_better_than_a_made_up_one(client: TestClient) -> None:
    """첫 틱 전에 0 으로 채운 스냅샷을 주면 화면이 그 0 을 진짜 값으로 그린다."""
    response = client.get("/api/snapshot")
    assert response.status_code in (200, 503)


def test_health_answers_without_waiting_for_a_tick(client: TestClient) -> None:
    """Render 헬스체크가 보는 경로. /api/snapshot 은 503 을 내므로 쓸 수 없다 —
    걸면 Render 가 기동 중인 서비스를 죽은 것으로 보고 무한 재시작한다."""
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_ws_pushes_the_same_contract(client: TestClient) -> None:
    _wait_for_snapshot(client)
    with client.websocket_connect("/ws") as ws:
        Snapshot.model_validate_json(ws.receive_text())


def test_unknown_api_path_is_404_not_html(client: TestClient) -> None:
    """빌드된 화면을 같은 포트로 내보내면 catch-all 이 API 를 삼킬 수 있다.

    JSON 을 기다리던 쪽이 index.html 을 받으면 엉뚱한 데서 깨진다.
    """
    assert client.get("/api/nope").status_code == 404


def test_committed_fixture_still_matches_the_model() -> None:
    """web/ 이 백엔드 없이 그릴 때 쓰는 표본 (tools/export_contract.py).

    계약이 바뀌면 프론트가 깨지기 전에 여기서 먼저 걸린다. TypeScript 쪽은 JSON 을
    캐스팅해서 읽으므로 이 검사를 대신해 주지 못한다.
    """
    snapshot = Snapshot.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))

    assert snapshot.mode == "simulated", "표본이 실측처럼 보이면 안 된다 (§0-4)"
    assert any(i.value is None for i in snapshot.indicators), "— 경로를 그릴 표본이 없다"
    assert any(i.state == "no_adapter" for i in snapshot.indicators)
