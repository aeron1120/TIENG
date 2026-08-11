"""계정·세션. 저장소는 state/users.db (SQLite).

이 기기는 LAN 안에서만 열린다 (README §1). 그래서 외부 인증 제공자를 쓰지 않는다.
막으려는 것은 인터넷이 아니라 "같은 네트워크에 있다는 것만으로 생체데이터가 보이는
상태"다.

셋으로 나눈다:
  guest   비회원. 실시간 화면 하나만 본다.
  member  가입한 계정. 기록·시스템·검증까지 본다.
  admin   첫 가입자. 계정을 차단할 수 있다.

가입은 열려 있다. 승인을 거치지 않는 대신 active 플래그로 나중에 차단한다 — 막을
일이 생겼을 때 쓸 손잡이는 있어야 하고, 그게 없으면 계정을 지우는 것 말고 방법이
없다.

비회원도 세션을 발급받는다. "쿠키 없음"과 "비회원으로 들어옴"이 서버에서 구분돼야
비회원에게 열어 줄 경로만 골라 열 수 있다.

세션은 HttpOnly 쿠키다. 토큰을 localStorage 에 두면 WebSocket 핸드셰이크에 얹을
방법이 없어서 — 브라우저 WebSocket 은 헤더를 못 붙인다 — 정작 지표가 흐르는 통로를
못 막는다. 쿠키는 /ws 요청에도 그냥 실린다.

scrypt 도 SQLite I/O 도 블로킹이다. 1Hz 샘플 루프가 같은 이벤트 루프에서 도므로
(core/layout.py 와 같은 이유) 호출하는 쪽에서 스레드로 넘긴다.
"""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import sqlite3
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Literal

import structlog
from fastapi import HTTPException, Request
from pydantic import BaseModel, StringConstraints

log = structlog.get_logger(__name__)

DEFAULT_PATH = Path("state/users.db")
COOKIE = "tfv_session"
SESSION_TTL = timedelta(days=30)

Role = Literal["guest", "member", "admin"]

# 권한은 포함 관계다. admin 은 member 가 보는 것을 다 본다.
_RANK: dict[str, int] = {"guest": 0, "member": 1, "admin": 2}

# scrypt 작업 인자. Pi 5 에서 한 번에 100ms 안팎이고 16MB 를 쓴다. 로그인은 드물게
# 일어나므로 그 비용은 감수하고 사전 공격 쪽 비용을 올린다.
_N, _R, _P = 2**14, 8, 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL,
    active        INTEGER NOT NULL,  -- 0 이면 차단됐다
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL 이면 비회원
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name   TEXT NOT NULL DEFAULT '',
    birthdate      TEXT NOT NULL DEFAULT '',
    sex            TEXT NOT NULL DEFAULT '',
    phone          TEXT NOT NULL DEFAULT '',
    email          TEXT NOT NULL DEFAULT '',
    guardian_name  TEXT NOT NULL DEFAULT '',
    guardian_email TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    updated_at     TEXT
);
"""

# 프로필은 전부 선택 입력이다. 안 적은 칸은 빈 문자열로 남고, 화면은 빈 칸을 지어내지
# 않는다 (README §0-4 와 같은 규칙). 목록을 따로 두는 이유는 INSERT 와 UPDATE 에서
# 같은 순서를 두 번 적지 않기 위해서다.
PROFILE_FIELDS = (
    "display_name",
    "birthdate",
    "sex",
    "phone",
    "email",
    "guardian_name",
    "guardian_email",
    "notes",
)


class Principal(BaseModel):
    """지금 요청을 보낸 쪽이 누구인가."""

    username: str | None  # 비회원이면 None
    role: Role


class Account(BaseModel):
    id: int
    username: str
    role: Role
    active: bool
    created_at: datetime


# 클라이언트가 준 값을 그대로 디스크에 쓰는 두 번째 경로다 (첫 번째는 core/layout.py).
# 거기와 같은 이유로 길이를 막는다 — 형식은 강요하지 않는다. 생년월일을 "1950년쯤"
# 이라고 적는 사람을 막을 이유가 없고, 이 값을 계산에 쓰는 곳도 아직 없다.
Line = Annotated[str, StringConstraints(max_length=120)]
Memo = Annotated[str, StringConstraints(max_length=2000)]


class Profile(BaseModel):
    """계정에 딸린 개인정보. 전부 선택 입력이다.

    보호자 이메일은 여기 적어도 L4 알림 수신자가 되지 않는다. 수신자는 지금도
    TFV_GUARDIAN_EMAIL 환경변수 하나뿐이다 (actuators/notify_email.py). 화면에서
    바꾼 값이 응급 알림 경로를 조용히 바꾸면, 잘못 적었을 때 알림이 안 나간다.
    """

    display_name: Line = ""
    birthdate: Line = ""
    sex: Line = ""
    phone: Line = ""
    email: Line = ""
    guardian_name: Line = ""
    guardian_email: Line = ""
    notes: Memo = ""
    # 서버가 정한다. 본문으로 들어와도 저장할 때 덮어쓴다.
    updated_at: datetime | None = None


class AuthError(Exception):
    """가입·로그인이 거절된 이유. 라우터가 HTTP 상태로 옮긴다."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def check_username(username: str) -> str:
    """가입 규칙에 맞게 다듬은 아이디. 어긋나면 AuthError.

    가입과 중복확인이 같은 규칙을 봐야 한다. 규칙을 두 군데 적어 두면 화면에서는
    "쓸 수 있다"고 해 놓고 제출할 때 거절하는 일이 생긴다.
    """
    username = username.strip()
    if not (3 <= len(username) <= 32):
        raise AuthError(400, "아이디는 3~32자여야 한다")
    return username


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt_hex, want = stored.split("$")
        got = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p)
        )
    except (ValueError, TypeError):
        # 해시가 깨져 있으면 로그인은 실패해야 한다. 예외를 위로 던지면 500 이 되고,
        # 그건 "비밀번호가 틀렸다"와 구분이 안 된다.
        log.warning("auth.hash_unreadable")
        return False
    return secrets.compare_digest(got.hex(), want)


class Users:
    """계정 저장소. 모든 메서드는 블로킹이므로 asyncio.to_thread 로 부른다."""

    def __init__(self, path: Path = DEFAULT_PATH) -> None:
        self.path = path

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # sqlite3.Connection 을 with 에 그냥 넣으면 트랜잭션만 닫고 연결은 열어 둔다.
        # 요청마다 새로 여는 구조라 그대로 두면 핸들이 샌다.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, isolation_level=None)  # 트랜잭션은 직접 연다
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
        finally:
            conn.close()

    def init(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    # --- 가입 / 로그인 ---

    def register(self, username: str, password: str) -> Account:
        """가입하면 바로 쓸 수 있다. 첫 가입자만 관리자가 된다.

        기기를 처음 켠 사람이 주인이라고 본다. 그 뒤로는 등급이 member 로 같고,
        관리자와의 차이는 계정을 차단할 수 있는지 하나뿐이다.
        """
        username = check_username(username)
        if len(password) < 8:
            raise AuthError(400, "비밀번호는 8자 이상이어야 한다")

        digest = hash_password(password)
        now = datetime.now(UTC)
        with self._connect() as conn:
            # 두 사람이 동시에 가입하면 둘 다 "내가 첫 번째"로 볼 수 있다. 세는 것과
            # 넣는 것이 같은 트랜잭션 안에 있어야 관리자가 둘 생기지 않는다.
            conn.execute("BEGIN IMMEDIATE")
            first = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
            role: Role = "admin" if first else "member"
            try:
                cur = conn.execute(
                    "INSERT INTO users (username, password_hash, role, active, created_at)"
                    " VALUES (?, ?, ?, 1, ?)",
                    (username, digest, role, now.isoformat()),
                )
            except sqlite3.IntegrityError:
                conn.execute("ROLLBACK")
                raise AuthError(409, "이미 쓰고 있는 아이디다") from None
            user_id = int(cur.lastrowid or 0)
            conn.execute("COMMIT")

        log.info("auth.registered", username=username, role=role)
        return Account(id=user_id, username=username, role=role, active=True, created_at=now)

    def taken(self, username: str) -> bool:
        """이미 있는 아이디인가. 대소문자는 가리지 않는다 (users.username 이 NOCASE)."""
        with self._connect() as conn:
            row = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        return row is not None

    def login(self, username: str, password: str) -> str:
        """세션 토큰. 아이디가 없어도 비밀번호가 틀려도 같은 말을 돌려준다."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, password_hash, role, active FROM users WHERE username = ?",
                (username.strip(),),
            ).fetchone()

            # 아이디가 없을 때도 해시를 한 번 계산한다. 안 그러면 응답 시간만 재도
            # 어떤 아이디가 존재하는지 알 수 있다.
            stored = row["password_hash"] if row else hash_password(password)
            if not check_password(password, stored) or row is None:
                raise AuthError(401, "아이디 또는 비밀번호가 맞지 않다")
            if not row["active"]:
                raise AuthError(403, "차단된 계정이다")

            return self._open(conn, user_id=int(row["id"]))

    def login_as_guest(self) -> str:
        with self._connect() as conn:
            return self._open(conn, user_id=None)

    def _open(self, conn: sqlite3.Connection, user_id: int | None) -> str:
        token = secrets.token_urlsafe(32)
        expires = datetime.now(UTC) + SESSION_TTL
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, expires.isoformat()),
        )
        return token

    def logout(self, token: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))

    # --- 조회 ---

    def principal(self, token: str) -> Principal | None:
        """토큰이 가리키는 사람. 없거나 만료됐으면 None.

        만료된 줄은 여기서 지운다. 세션은 계속 쌓이기만 하고 지우는 사람이 없어서,
        읽을 때 같이 치우지 않으면 파일이 한 방향으로만 자란다.
        """
        with self._connect() as conn:
            now = datetime.now(UTC).isoformat()
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            row = conn.execute(
                "SELECT u.username, u.role, u.active FROM sessions s"
                " LEFT JOIN users u ON u.id = s.user_id WHERE s.token = ?",
                (token,),
            ).fetchone()

        if row is None:
            return None
        if row["username"] is None:
            return Principal(username=None, role="guest")
        # 차단된 계정의 옛 세션이 살아 있으면 안 된다.
        if not row["active"]:
            return None
        return Principal(username=str(row["username"]), role=str(row["role"]))  # type: ignore[arg-type]

    def accounts(self) -> list[Account]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, username, role, active, created_at FROM users ORDER BY id"
            ).fetchall()
        return [
            Account(
                id=int(r["id"]),
                username=str(r["username"]),
                role=str(r["role"]),  # type: ignore[arg-type]
                active=bool(r["active"]),
                created_at=datetime.fromisoformat(str(r["created_at"])),
            )
            for r in rows
        ]

    # --- 프로필 ---

    def profile(self, username: str) -> Profile:
        """아직 아무것도 안 적었으면 빈 양식을 준다. 없는 값을 지어내지 않는다."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT p.* FROM profiles p JOIN users u ON u.id = p.user_id"
                " WHERE u.username = ?",
                (username,),
            ).fetchone()

        if row is None:
            return Profile()
        stamp = row["updated_at"]
        return Profile(
            **{field: str(row[field]) for field in PROFILE_FIELDS},
            updated_at=datetime.fromisoformat(str(stamp)) if stamp else None,
        )

    def save_profile(self, username: str, profile: Profile) -> Profile:
        now = datetime.now(UTC)
        columns = ", ".join(PROFILE_FIELDS)
        marks = ", ".join("?" * len(PROFILE_FIELDS))
        updates = ", ".join(f"{field} = excluded.{field}" for field in PROFILE_FIELDS)

        with self._connect() as conn:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if row is None:  # pragma: no cover - 세션이 가리키는 계정이라 여기 오지 않는다
                raise AuthError(404, "그런 계정이 없다")
            conn.execute(
                f"INSERT INTO profiles (user_id, {columns}, updated_at)"
                f" VALUES (?, {marks}, ?)"
                f" ON CONFLICT(user_id) DO UPDATE SET {updates}, updated_at = excluded.updated_at",
                (
                    int(row["id"]),
                    *(getattr(profile, field) for field in PROFILE_FIELDS),
                    now.isoformat(),
                ),
            )

        # 언제 적었는지는 서버 시계로 정한다. 본문에 실려 온 값은 버린다.
        return profile.model_copy(update={"updated_at": now})

    def set_active(self, user_id: int, active: bool) -> None:
        """계정을 차단하거나 되돌린다. 차단하면 열려 있던 세션도 같이 닫는다.

        관리자는 차단할 수 없다. 마지막 관리자를 막으면 아무도 차단을 못 한다.
        """
        with self._connect() as conn:
            row = conn.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
            if row is None:
                raise AuthError(404, "그런 계정이 없다")
            if row["role"] == "admin" and not active:
                raise AuthError(400, "관리자 계정은 차단할 수 없다")
            conn.execute("UPDATE users SET active = ? WHERE id = ?", (int(active), user_id))
            if not active:
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        log.info("auth.set_active", user_id=user_id, active=active)


# --- FastAPI 의존성 ---


async def current(request: Request) -> Principal | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    users: Users = request.app.state.users
    return await asyncio.to_thread(users.principal, token)


def require(minimum: Role) -> Callable[[Request], Awaitable[Principal]]:
    """이 등급 이상만 통과시키는 의존성.

    라우터를 include 할 때 한 번씩 붙인다 (api/main.py). 엔드포인트마다 데코레이터를
    다는 것보다, 어떤 화면이 어디까지 보는지가 한 파일에서 읽힌다.
    """

    async def dependency(request: Request) -> Principal:
        who = await current(request)
        if who is None:
            raise HTTPException(401, "로그인이 필요하다")
        if _RANK[who.role] < _RANK[minimum]:
            raise HTTPException(403, "권한이 없다")
        return who

    return dependency
