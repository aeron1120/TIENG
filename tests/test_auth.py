"""계정·세션·권한.

여기서 고정하려는 것은 "누가 무엇을 못 보는가"다. 통과하는 경로보다 막히는 경로가
중요해서, 등급별로 거절되는 쪽을 먼저 적었다.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, TypeAlias

import pytest
from fastapi.testclient import TestClient

from api.auth import AuthError, Users

if TYPE_CHECKING:  # psycopg 는 cloud extras 다. 없는 기기에서도 이 파일은 모여야 한다.
    from api.auth_pg import PgUsers

# 저장소 테스트는 두 구현에 똑같이 적용된다. 규칙이 갈리면 배포마다 계정이 다르게
# 동작하고, 그건 화면에서 보이지 않는다.
Store: TypeAlias = "Users | PgUsers"

REPO_ROOT = Path(__file__).resolve().parents[1]

# 실수로 운영 DB 를 비우지 않도록 DATABASE_URL 과 다른 이름을 쓴다. 아래 픽스처는
# 매 테스트마다 세 테이블을 TRUNCATE 하므로, 운영 문자열이 흘러들면 계정이 사라진다.
#
#   $env:TFV_TEST_DATABASE_URL = "postgresql://..."   # PowerShell
TEST_DSN = "TFV_TEST_DATABASE_URL"


@pytest.fixture(params=["sqlite", "postgres"])
def users(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[Store]:
    if request.param == "sqlite":
        store: Store = Users(tmp_path / "users.db")
        store.init()
        yield store
        return

    dsn = os.environ.get(TEST_DSN)
    if not dsn:
        pytest.skip(f"{TEST_DSN} 이 없다. Postgres 판은 건너뛴다")

    from api.auth_pg import PgUsers

    store = PgUsers(dsn)
    store.init()
    # tmp_path 로 격리되는 SQLite 와 달리 여기는 DB 하나를 계속 쓴다. 앞 테스트가
    # 남긴 계정이 있으면 "첫 가입자가 관리자"부터 성립하지 않는다.
    #
    # 끝나고도 한 번 더 비운다. 앞만 치우면 마지막 테스트가 만든 계정이 DB 에 남고,
    # 이 DB 를 배포가 같이 쓰면 화면에서 처음 가입한 사람이 관리자가 되지 못한다.
    def clear() -> None:
        with store.pool.connection() as conn:
            conn.execute("TRUNCATE users, sessions, profiles RESTART IDENTITY CASCADE")

    clear()
    try:
        yield store
    finally:
        clear()
        # 테스트마다 풀을 새로 연다. 안 닫으면 무료 플랜의 연결 수를 금방 다 쓴다.
        store.close()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DEVICE_CONFIG", str(REPO_ROOT / "config" / "device.mock.yaml"))
    monkeypatch.setenv("TFV_USERS_DB", str(tmp_path / "users.db"))
    from api.main import app

    return TestClient(app)


# --- 저장소 ---


def test_the_first_account_is_the_admin(users: Store) -> None:
    """기기를 처음 켠 사람이 주인이다. 그 뒤로는 전부 member 다."""
    owner = users.register("owner", "correct horse")
    nurse = users.register("nurse", "battery staple")

    assert (owner.role, nurse.role) == ("admin", "member")
    assert owner.active and nurse.active


def test_the_first_account_does_not_wait_for_approval(users: Store) -> None:
    """첫 사람을 대기시키면 승인해 줄 사람이 없어 기기가 잠긴다."""
    owner = users.register("owner", "correct horse")

    assert owner.approved is True
    assert users.principal(users.login("owner", "correct horse")) is not None


def test_later_signups_wait_for_approval(users: Store) -> None:
    """공개 주소에서는 주소를 아는 누구나 들어오게 두면 안 된다."""
    users.register("owner", "correct horse")
    nurse = users.register("nurse", "battery staple")

    assert nurse.approved is False
    with pytest.raises(AuthError) as exc:
        users.login("nurse", "battery staple")
    assert exc.value.status == 403

    users.set_approved(nurse.id, True)
    who = users.principal(users.login("nurse", "battery staple"))
    assert who is not None and who.role == "member"


def test_waiting_and_blocked_do_not_read_the_same(users: Store) -> None:
    """기다리면 되는 사람과 사람을 찾아가야 하는 사람에게 같은 말을 하면 안 된다."""
    users.register("owner", "correct horse")
    nurse = users.register("nurse", "battery staple")

    with pytest.raises(AuthError) as waiting:
        users.login("nurse", "battery staple")

    users.set_approved(nurse.id, True)
    users.set_active(nurse.id, False)
    with pytest.raises(AuthError) as blocked:
        users.login("nurse", "battery staple")

    assert waiting.value.detail != blocked.value.detail


def test_withdrawing_approval_closes_open_sessions(users: Store) -> None:
    """승인을 거뒀는데 열려 있던 창이 살아 있으면 거둔 것이 아니다."""
    users.register("owner", "correct horse")
    nurse = users.register("nurse", "battery staple")
    users.set_approved(nurse.id, True)
    token = users.login("nurse", "battery staple")
    assert users.principal(token) is not None

    users.set_approved(nurse.id, False)
    assert users.principal(token) is None


def test_wrong_password_and_unknown_id_look_the_same(users: Store) -> None:
    """어느 아이디가 존재하는지 응답으로 알려주지 않는다."""
    users.register("owner", "correct horse")

    errors = []
    for name, password in (("owner", "wrong"), ("ghost", "wrong")):
        with pytest.raises(AuthError) as exc:
            users.login(name, password)
        errors.append((exc.value.status, exc.value.detail))

    assert errors[0] == errors[1]


def test_blocking_closes_open_sessions(users: Store) -> None:
    """차단하면 이미 들어와 있던 창도 같이 끊겨야 한다. 안 그러면 안 막힌 것과 같다."""
    users.register("owner", "correct horse")
    nurse = users.register("nurse", "battery staple")
    users.set_approved(nurse.id, True)
    token = users.login("nurse", "battery staple")
    assert users.principal(token) is not None

    users.set_active(nurse.id, False)
    assert users.principal(token) is None
    with pytest.raises(AuthError) as exc:
        users.login("nurse", "battery staple")
    assert exc.value.status == 403

    users.set_active(nurse.id, True)
    assert users.principal(users.login("nurse", "battery staple")) is not None


def test_the_last_admin_cannot_be_blocked(users: Store) -> None:
    owner = users.register("owner", "correct horse")
    with pytest.raises(AuthError):
        users.set_active(owner.id, False)


def test_short_credentials_are_refused(users: Store) -> None:
    with pytest.raises(AuthError):
        users.register("ab", "correct horse")
    with pytest.raises(AuthError):
        users.register("owner", "short")


def test_duplicate_id_is_refused(users: Store) -> None:
    users.register("owner", "correct horse")
    with pytest.raises(AuthError) as exc:
        users.register("OWNER", "battery staple")  # 대소문자만 다른 것도 같은 아이디다
    assert exc.value.status == 409


def test_only_one_admin_when_everyone_registers_at_once(users: Store) -> None:
    """화면이 공개 주소로 열려 있어서 첫 가입 순간에 여럿이 몰릴 수 있다.

    세는 것과 넣는 것이 한 트랜잭션 안에 없으면 둘 다 "내가 첫 번째"로 본다.
    관리자가 둘이면 서로를 차단할 수 있고, 그건 화면 어디에도 안 보인다.
    """
    with ThreadPoolExecutor(max_workers=5) as pool:
        accounts = [
            future.result()
            for future in [
                pool.submit(users.register, f"racer{i}", "correct horse") for i in range(5)
            ]
        ]

    assert sum(account.role == "admin" for account in accounts) == 1
    assert sum(account.approved for account in accounts) == 1


# --- 엔드포인트 ---


def test_without_a_session_nothing_opens(client: TestClient) -> None:
    with client:
        assert client.get("/api/snapshot").status_code == 401
        assert client.get("/api/system").status_code == 401
        assert client.get("/api/layout").status_code == 401


def test_guest_sees_the_live_screen_only(client: TestClient) -> None:
    with client:
        assert client.post("/api/auth/guest").json() == {"username": None, "role": "guest"}

        assert client.get("/api/snapshot").status_code == 200
        assert client.get("/api/layout").status_code == 200
        # 기록·시스템·검증은 계정이 있어야 한다.
        assert client.get("/api/system").status_code == 403
        assert client.get("/api/interventions").status_code == 403
        assert client.get("/api/logs").status_code == 403


def test_the_first_registration_logs_you_straight_in(client: TestClient) -> None:
    """첫 사람은 승인할 사람이 없으므로 그 자리에서 들어온다."""
    with client:
        body = client.post(
            "/api/auth/register", json={"username": "owner", "password": "correct horse"}
        )
        assert body.json() == {
            "pending": False,
            "principal": {"username": "owner", "role": "admin"},
        }

        assert client.get("/api/system").status_code == 200
        assert client.get("/api/interventions").status_code == 200


def test_a_pending_registration_gets_no_session(client: TestClient) -> None:
    """쿠키를 내주고 화면만 가리면 대기 중에도 API 가 열려 있는 셈이다."""
    with client:
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        client.post("/api/auth/logout")

        body = client.post(
            "/api/auth/register", json={"username": "nurse", "password": "battery staple"}
        )
        assert body.json() == {"pending": True, "principal": None}

        # 세션이 없으니 회원 경로가 열리면 안 된다.
        assert client.get("/api/system").status_code in (401, 403)


def test_availability_answers_before_the_form_is_submitted(client: TestClient) -> None:
    """가입 화면이 치는 동안 묻는 경로. 가입할 때의 판정과 같은 답이어야 한다."""
    with client:
        assert client.get("/api/auth/available", params={"username": "owner"}).json() == {
            "available": True,
            "detail": "",
        }
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})

        after = client.get("/api/auth/available", params={"username": "OWNER"}).json()
        assert after["available"] is False  # 대소문자만 다른 것도 같은 아이디다
        # 짧은 아이디는 여기서도 막힌다. 통과시켜 놓고 가입에서 거절하면 안 된다.
        short = client.get("/api/auth/available", params={"username": "ab"}).json()
        assert short["available"] is False


def test_only_an_admin_manages_accounts(client: TestClient) -> None:
    with client:
        client.post("/api/auth/guest")
        assert client.get("/api/auth/users").status_code == 403

        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        assert [u["username"] for u in client.get("/api/auth/users").json()] == ["owner"]


def test_blocking_flows_through_the_api(client: TestClient) -> None:
    with client:
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        client.post("/api/auth/register", json={"username": "nurse", "password": "battery staple"})
        # 가입이 곧 로그인이라 지금 클라이언트는 nurse 다. 관리자로 돌아간다.
        client.post("/api/auth/login", json={"username": "owner", "password": "correct horse"})

        nurse = next(u for u in client.get("/api/auth/users").json() if u["username"] == "nurse")
        after = client.put(f"/api/auth/users/{nurse['id']}/active", json={"active": False}).json()
        assert next(u for u in after if u["username"] == "nurse")["active"] is False

        client.post("/api/auth/logout")
        assert (
            client.post(
                "/api/auth/login", json={"username": "nurse", "password": "battery staple"}
            ).status_code
            == 403
        )


def test_an_admin_cannot_block_themselves_out(client: TestClient) -> None:
    with client:
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        owner = client.get("/api/auth/users").json()[0]
        assert (
            client.put(f"/api/auth/users/{owner['id']}/active", json={"active": False}).status_code
            == 400
        )


def test_logout_drops_the_session(client: TestClient) -> None:
    with client:
        client.post("/api/auth/guest")
        assert client.get("/api/snapshot").status_code == 200

        client.post("/api/auth/logout")
        assert client.get("/api/auth/me").json() is None
        assert client.get("/api/snapshot").status_code == 401


# --- 프로필 ---


def test_profile_starts_empty_and_survives_a_save(client: TestClient) -> None:
    """아직 안 적은 사람에게는 빈 양식을 준다. 없는 값을 지어내지 않는다."""
    with client:
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        assert client.get("/api/auth/profile").json()["display_name"] == ""

        saved = client.put(
            "/api/auth/profile",
            json={"display_name": "김정민", "sex": "남성", "guardian_email": "mom@example.com"},
        ).json()
        assert saved["display_name"] == "김정민"
        assert saved["updated_at"] is not None  # 서버가 시각을 채운다
        assert saved["phone"] == ""  # 안 적은 칸은 빈 채로

        assert client.get("/api/auth/profile").json()["guardian_email"] == "mom@example.com"


def test_a_profile_belongs_to_the_session_not_the_body(client: TestClient) -> None:
    """본문으로 남의 계정을 가리킬 수 없다. 어느 계정인지는 쿠키가 정한다."""
    with client:
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        client.put("/api/auth/profile", json={"display_name": "주인"})

        # 가입만으로는 세션이 안 생긴다. 관리자로 있는 동안 승인해 두고 갈아탄다.
        client.post("/api/auth/register", json={"username": "nurse", "password": "battery staple"})
        nurse = next(a for a in client.get("/api/auth/users").json() if a["username"] == "nurse")
        client.put(f"/api/auth/users/{nurse['id']}/approved", json={"approved": True})

        client.post("/api/auth/login", json={"username": "nurse", "password": "battery staple"})
        client.put("/api/auth/profile", json={"display_name": "간호사", "username": "owner"})

        assert client.get("/api/auth/profile").json()["display_name"] == "간호사"
        client.post("/api/auth/login", json={"username": "owner", "password": "correct horse"})
        assert client.get("/api/auth/profile").json()["display_name"] == "주인"


def test_a_guest_has_no_profile(client: TestClient) -> None:
    with client:
        client.post("/api/auth/guest")
        assert client.get("/api/auth/profile").status_code == 403
        assert client.put("/api/auth/profile", json={"display_name": "x"}).status_code == 403


def test_profile_caps_what_it_will_store(client: TestClient) -> None:
    """클라이언트가 준 값을 그대로 디스크에 쓰는 경로다 (core/layout.py 와 같은 이유)."""
    with client:
        client.post("/api/auth/register", json={"username": "owner", "password": "correct horse"})
        assert client.put("/api/auth/profile", json={"phone": "0" * 200}).status_code == 422
        assert client.put("/api/auth/profile", json={"notes": "가" * 3000}).status_code == 422


def test_websocket_refuses_a_session_less_client(client: TestClient) -> None:
    """지표가 실제로 흐르는 통로. REST 만 막고 여기를 열어 두면 게이트가 없는 것과 같다."""
    from starlette.websockets import WebSocketDisconnect

    with client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws") as ws:
                ws.receive_text()


def test_websocket_accepts_a_guest(client: TestClient) -> None:
    with client:
        client.post("/api/auth/guest")
        with client.websocket_connect("/ws") as ws:
            assert "device_id" in ws.receive_json()
