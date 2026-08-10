"""엔드포인트 테스트용 로그인 헬퍼.

로그인 게이트(api/auth.py)가 생기면서 화면이 쓰는 엔드포인트는 전부 세션을 요구한다.
테스트마다 가입·로그인 왕복을 다시 적는 대신, 계정 DB 를 tmp 에 만들고 세션 쿠키를
미리 꽂은 클라이언트를 여기서 만든다.

등급별로 무엇이 열리고 무엇이 막히는지는 tests/test_auth.py 가 따로 본다. 여기서
관리자를 쓰는 이유는 그 테스트들의 관심사가 권한이 아니라 응답 모양이기 때문이다.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.auth import COOKIE, Users


@pytest.fixture
def account_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Users:
    """계정 DB 를 tmp 로 돌린다. 안 그러면 테스트가 실기의 state/users.db 에 쌓인다."""
    path = tmp_path / "users.db"
    monkeypatch.setenv("TFV_USERS_DB", str(path))
    store = Users(path)
    store.init()
    return store


def sign_in(client: TestClient, store: Users) -> TestClient:
    """관리자 세션을 물린 클라이언트. 첫 가입자라 승인을 기다리지 않는다."""
    store.register("tester", "correct horse")
    client.cookies.set(COOKIE, store.login("tester", "correct horse"))
    return client
