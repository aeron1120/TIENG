"""계정·세션. 저장소는 state/users.db (SQLite).

이 기기는 LAN 안에서만 열린다 (README §1). 그래서 외부 인증 제공자를 쓰지 않는다.
막으려는 것은 인터넷이 아니라 "같은 네트워크에 있다는 것만으로 생체데이터가 보이는
상태"다.

셋으로 나눈다:
  guest   비회원. 실시간 화면 하나만 본다.
  member  승인된 계정. 기록·시스템·검증까지 본다.
  admin   첫 가입자. 가입을 승인하고 계정을 차단할 수 있다.

첫 가입자는 관리자로 바로 들어오고, 그 뒤로는 관리자 승인을 기다린다. 화면이 공개
주소로도 열리게 되면서 열어 둘 수 없게 됐다 — 주소를 아는 누구나 방의 지표와 기록을
보게 된다.

계정 상태를 approved 와 active 두 값으로 나눠 둔다. "아직 승인 안 됨"과 "쓰다가
막힘"은 관리자가 보는 목록도, 당사자에게 할 말도 다르다. 하나로 묶으면 로그인 실패
사유가 "차단됐다" 하나로 뭉개져서, 기다리면 되는 사람이 사람을 찾아 나선다.

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
import json
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

from core.layout import Layout

log = structlog.get_logger(__name__)

DEFAULT_PATH = Path("state/users.db")
COOKIE = "tfv_session"

# "로그인 유지"를 고른 사람의 세션. 침실 앞에 세워 두고 계속 켜 두는 태블릿에서는
# 껐다 켤 때마다 다시 로그인하게 만들 이유가 없다.
SESSION_TTL = timedelta(days=30)
# 안 고른 사람의 세션. 쿠키를 창이 닫히면 사라지게 굽지만(api/routes/auth.py) 서버의
# 줄은 그것만으로 안 지워지므로, 하루 뒤에 저절로 치워지게 짧게 준다. 하루면 창을
# 열어 둔 채로 쓰는 동안 끊길 일은 없다.
SESSION_TTL_BRIEF = timedelta(days=1)

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
    -- 두 값을 나누는 이유는 "아직 승인 안 됨"과 "쓰다가 막힘"이 다른 일이기 때문이다.
    -- 하나로 묶으면 화면이 대기자와 차단자를 같은 목록에 섞어 보여 주게 되고,
    -- 로그인 실패 사유도 "차단됐다" 하나로 뭉개진다.
    approved      INTEGER NOT NULL DEFAULT 1,  -- 0 이면 관리자 승인을 기다린다
    active        INTEGER NOT NULL,            -- 0 이면 차단됐다
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL 이면 비회원
    expires_at TEXT NOT NULL
);
-- 화면 배치. 계정마다 하나다 — 기기별 파일 하나로 두면 한 사람이 바꾼 것이 다른
-- 모든 사람 화면에 그대로 나간다 (core/layout.py).
CREATE TABLE IF NOT EXISTS layouts (
    user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hero     TEXT NOT NULL,
    -- JSON 배열. 지표 키는 센서 구성에 따라 늘고 줄어서 칸을 나눠 둘 수가 없다.
    -- "order" 는 SQL 예약어라 이름을 바꿨다.
    ordering TEXT NOT NULL
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
    approved: bool  # False 면 관리자 승인을 기다린다
    active: bool  # False 면 차단됐다
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
            # 승인 대기가 생기기 전에 만들어진 DB 에는 approved 가 없다. 기본값 1 이라
            # 기존 계정은 전부 승인된 것으로 남는다 — 쓰던 사람이 갑자기 잠기면 안 된다.
            columns = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
            if "approved" not in columns:
                conn.execute("ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1")
                log.info("auth.migrated", added="users.approved")

    def ensure_admin(self, username: str, password: str) -> None:
        """환경변수로 정한 관리자 계정을 보장한다.

        없으면 만들고, 있으면 비밀번호·권한·승인을 환경변수에 맞춘다. 비밀번호를
        잊었을 때 DB 를 손대지 않고 환경변수만 바꿔 다시 띄우면 되게 하려는 것이다.

        이 계정이 생기면 "첫 가입자가 관리자"(register)는 저절로 성립하지 않는다.
        세는 계정 수가 이미 1 이라 그 뒤로 가입하는 사람은 전부 승인을 기다린다.
        관리자가 누구인지를 화면에 먼저 온 순서가 아니라 배포하는 쪽이 정하게 된다.
        """
        username = check_username(username)
        if len(password) < 8:
            raise AuthError(400, "관리자 비밀번호는 8자 이상이어야 한다")

        digest = hash_password(password)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO users"
                    " (username, password_hash, role, approved, active, created_at)"
                    " VALUES (?, ?, 'admin', 1, 1, ?)",
                    (username, digest, datetime.now(UTC).isoformat()),
                )
                event = "auth.admin_created"
            else:
                conn.execute(
                    "UPDATE users SET password_hash = ?, role = 'admin', approved = 1, active = 1"
                    " WHERE id = ?",
                    (digest, int(row["id"])),
                )
                event = "auth.admin_synced"
            conn.execute("COMMIT")
        log.info(event, username=username)

    # --- 가입 / 로그인 ---

    def register(self, username: str, password: str) -> Account:
        """첫 가입자는 관리자로 바로 들어오고, 그 뒤로는 승인을 기다린다.

        기기를 처음 켠 사람이 주인이라고 본다. 그 사람을 대기시키면 승인해 줄 사람이
        아무도 없어서 기기가 잠긴다.

        두 번째부터 대기를 두는 이유는 이 화면이 공개 주소로도 열리기 때문이다.
        열어 두면 주소를 아는 누구나 방의 지표와 기록을 보게 된다.
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
            approved = first
            try:
                cur = conn.execute(
                    "INSERT INTO users"
                    " (username, password_hash, role, approved, active, created_at)"
                    " VALUES (?, ?, ?, ?, 1, ?)",
                    (username, digest, role, int(approved), now.isoformat()),
                )
            except sqlite3.IntegrityError:
                conn.execute("ROLLBACK")
                raise AuthError(409, "이미 쓰고 있는 아이디다") from None
            user_id = int(cur.lastrowid or 0)
            conn.execute("COMMIT")

        log.info("auth.registered", username=username, role=role, approved=approved)
        return Account(
            id=user_id,
            username=username,
            role=role,
            approved=approved,
            active=True,
            created_at=now,
        )

    def taken(self, username: str) -> bool:
        """이미 있는 아이디인가. 대소문자는 가리지 않는다 (users.username 이 NOCASE)."""
        with self._connect() as conn:
            row = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        return row is not None

    def login(self, username: str, password: str, remember: bool = False) -> str:
        """세션 토큰. 아이디가 없어도 비밀번호가 틀려도 같은 말을 돌려준다.

        remember 는 이 세션을 얼마나 살려 둘지만 정한다. 창을 닫으면 풀리게 하는
        것은 쿠키 쪽 일이다 (api/routes/auth.py) — 서버는 그걸 알 수 없으므로
        수명을 짧게 줘서 남은 줄이 저절로 치워지게 한다.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, password_hash, role, approved, active FROM users WHERE username = ?",
                (username.strip(),),
            ).fetchone()

            # 아이디가 없을 때도 해시를 한 번 계산한다. 안 그러면 응답 시간만 재도
            # 어떤 아이디가 존재하는지 알 수 있다.
            stored = row["password_hash"] if row else hash_password(password)
            if not check_password(password, stored) or row is None:
                raise AuthError(401, "아이디 또는 비밀번호가 맞지 않다")
            # 사유를 나눈다. 기다리면 되는 것과 사람에게 말해야 하는 것은 다르다.
            if not row["approved"]:
                raise AuthError(403, "관리자 승인을 기다리는 중이다")
            if not row["active"]:
                raise AuthError(403, "차단된 계정이다")

            return self._open(conn, user_id=int(row["id"]), remember=remember)

    def login_as_guest(self) -> str:
        with self._connect() as conn:
            return self._open(conn, user_id=None, remember=False)

    def _open(self, conn: sqlite3.Connection, user_id: int | None, remember: bool) -> str:
        token = secrets.token_urlsafe(32)
        expires = datetime.now(UTC) + (SESSION_TTL if remember else SESSION_TTL_BRIEF)
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
                "SELECT u.username, u.role, u.approved, u.active FROM sessions s"
                " LEFT JOIN users u ON u.id = s.user_id WHERE s.token = ?",
                (token,),
            ).fetchone()

        if row is None:
            return None
        if row["username"] is None:
            return Principal(username=None, role="guest")
        # 차단됐거나 승인이 철회된 계정의 옛 세션이 살아 있으면 안 된다.
        if not row["active"] or not row["approved"]:
            return None
        return Principal(username=str(row["username"]), role=str(row["role"]))  # type: ignore[arg-type]

    def accounts(self) -> list[Account]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, username, role, approved, active, created_at FROM users ORDER BY id"
            ).fetchall()
        return [
            Account(
                id=int(r["id"]),
                username=str(r["username"]),
                role=str(r["role"]),  # type: ignore[arg-type]
                approved=bool(r["approved"]),
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

    # --- 화면 배치 ---

    def layout(self, username: str) -> Layout:
        """이 계정이 마지막으로 둔 배치. 없으면 기본값이다."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT l.hero, l.ordering FROM layouts l JOIN users u ON u.id = l.user_id"
                " WHERE u.username = ?",
                (username,),
            ).fetchone()

        if row is None:
            return Layout()
        try:
            return Layout(hero=str(row["hero"]), order=json.loads(str(row["ordering"])))
        except (ValueError, TypeError):
            # 배치 하나 때문에 화면이 안 뜨면 곤란하다. 못 읽으면 기본값이다.
            log.warning("auth.layout_unreadable", username=username)
            return Layout()

    def save_layout(self, username: str, value: Layout) -> Layout:
        with self._connect() as conn:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if row is None:  # pragma: no cover - 세션이 가리키는 계정이라 여기 오지 않는다
                raise AuthError(404, "그런 계정이 없다")
            conn.execute(
                "INSERT INTO layouts (user_id, hero, ordering) VALUES (?, ?, ?)"
                " ON CONFLICT(user_id) DO UPDATE SET hero = excluded.hero,"
                " ordering = excluded.ordering",
                (int(row["id"]), value.hero, json.dumps(value.order)),
            )
        return value

    def set_approved(self, user_id: int, approved: bool) -> None:
        """가입 승인을 내주거나 거둔다. 거두면 열려 있던 세션도 같이 닫는다.

        차단(set_active)과 나눠 둔 이유는 관리자가 보는 목록이 다르기 때문이다.
        대기자는 "아직 아무것도 못 한 사람"이고 차단자는 "쓰다가 막힌 사람"이라,
        한 버튼으로 묶으면 승인 목록에 차단자가 섞여 들어온다.

        관리자에게서는 거둘 수 없다. set_active 와 같은 이유다 — 마지막 관리자를
        잠그면 되돌릴 사람이 없다.
        """
        with self._connect() as conn:
            row = conn.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
            if row is None:
                raise AuthError(404, "그런 계정이 없다")
            if row["role"] == "admin" and not approved:
                raise AuthError(400, "관리자 계정의 승인은 거둘 수 없다")
            conn.execute("UPDATE users SET approved = ? WHERE id = ?", (int(approved), user_id))
            if not approved:
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        log.info("auth.set_approved", user_id=user_id, approved=approved)

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
