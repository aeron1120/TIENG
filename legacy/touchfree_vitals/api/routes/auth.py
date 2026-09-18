"""로그인·가입·승인 엔드포인트.

여기만 무인증으로 열려 있다. 나머지 라우터는 api/main.py 에서 등급을 붙여 건다.

세션 토큰은 응답 본문에 넣지 않고 쿠키로만 내보낸다. 화면이 토큰을 손에 쥐면
어딘가에 저장하게 되고, 그 순간 저장소를 쓰지 않는다는 규칙(README §10)이 깨진다.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from api.auth import (
    COOKIE,
    SESSION_TTL,
    Account,
    AuthError,
    Principal,
    Profile,
    Users,
    check_username,
    current,
    require,
)

if TYPE_CHECKING:  # psycopg 가 없는 기기에서도 이 모듈은 떠야 한다 (api/main.py)
    from api.auth_pg import PgUsers

# 로그인한 본인. 라우터 단위로 걸면 누가 요청했는지를 핸들러가 받지 못해서,
# 프로필처럼 "내 것"을 다루는 경로는 인자로 받는다.
Member = Annotated[Principal, Depends(require("member"))]

router = APIRouter(prefix="/api/auth")


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=128)
    # 안 고르면 창을 닫는 순간 풀린다. 태블릿을 여러 사람이 지나가며 쓰는 자리에서
    # 기본으로 남겨 두면 다음 사람이 앞사람 세션을 물려받는다.
    remember: bool = False


class Block(BaseModel):
    active: bool


class Approval(BaseModel):
    approved: bool


class Registration(BaseModel):
    """가입 결과.

    승인이 필요하면 세션이 없으므로 principal 도 없다. 화면은 pending 을 보고
    "기다리라"고 말한다 — Principal 하나로 돌려주면 그 구분을 못 한다.
    """

    pending: bool
    principal: Principal | None = None


class Availability(BaseModel):
    available: bool
    detail: str  # 왜 못 쓰는지. 쓸 수 있으면 빈 문자열


def _store(request: Request) -> Users | PgUsers:
    """계정 저장소. 배포에 따라 파일이거나 Postgres 다 (api/main.py)."""
    return request.app.state.users  # type: ignore[no-any-return]


def _set_cookie(response: Response, token: str, remember: bool = False) -> None:
    response.set_cookie(
        COOKIE,
        token,
        # max_age 를 주면 브라우저가 쿠키를 디스크에 적어 두고, 껐다 켜도 남는다.
        # 안 주면 창이 닫히는 순간 사라진다 — "로그인 유지 안 함"이 그 뜻이다.
        max_age=int(SESSION_TTL.total_seconds()) if remember else None,
        httponly=True,  # 스크립트가 못 읽어야 토큰이 화면 코드로 새지 않는다
        samesite="lax",
        # secure 는 켜지 않는다. 이 기기는 LAN 안에서 http 로 열리므로 (README §1)
        # 켜면 쿠키가 아예 실리지 않아 로그인이 통째로 막힌다.
    )


@router.get("/me", response_model=Principal | None)
async def me(request: Request) -> Principal | None:
    """지금 누구인가. 세션이 없으면 null 이고, 화면은 그때 첫 관문을 띄운다."""
    return await current(request)


@router.post("/guest", response_model=Principal)
async def enter_as_guest(request: Request, response: Response) -> Principal:
    """비회원 세션. 실시간 화면 하나만 열린다.

    비회원에게도 세션을 주는 이유: 쿠키가 아예 없는 요청과 구분돼야 "비회원에게만
    열어 둔 경로"라는 게 성립한다.
    """
    token = await asyncio.to_thread(_store(request).login_as_guest)
    _set_cookie(response, token)
    return Principal(username=None, role="guest")


@router.get("/available", response_model=Availability)
async def available(request: Request, username: str) -> Availability:
    """이 아이디를 쓸 수 있는가. 가입 화면이 치는 동안 물어본다.

    있는 계정을 알려 주는 셈이지만 /register 가 이미 409 로 같은 말을 하고 있어서
    새로 새는 것은 없다. 로그인이 존재 여부를 감추는 것(Users.login)과는 다른
    얘기다 — 거기서 감추는 것은 "이 아이디의 비밀번호를 맞혀 볼 가치가 있는가"다.
    """
    try:
        name = check_username(username)
    except AuthError as exc:
        return Availability(available=False, detail=exc.detail)

    if await asyncio.to_thread(_store(request).taken, name):
        return Availability(available=False, detail="이미 쓰고 있는 아이디다")
    return Availability(available=True, detail="")


@router.post("/register", response_model=Registration)
async def register(request: Request, response: Response, body: Credentials) -> Registration:
    """첫 가입자는 그 자리에서 들어오고, 그 뒤로는 승인을 기다린다.

    첫 사람을 대기시키면 승인해 줄 사람이 없어 기기가 잠긴다 (api/auth.py).

    승인이 필요한 경우에는 세션을 만들지 않는다. 쿠키를 내주고 화면만 가리면 서버는
    이미 들어온 것으로 아는 셈이라, 대기 중에도 API 가 열려 있게 된다.
    """
    store = _store(request)
    try:
        account = await asyncio.to_thread(store.register, body.username, body.password)
        if not account.approved:
            return Registration(pending=True)
        token = await asyncio.to_thread(store.login, body.username, body.password, body.remember)
    except AuthError as exc:
        raise HTTPException(exc.status, exc.detail) from None

    _set_cookie(response, token, body.remember)
    return Registration(
        pending=False, principal=Principal(username=account.username, role=account.role)
    )


@router.post("/login", response_model=Principal)
async def login(request: Request, response: Response, body: Credentials) -> Principal:
    store = _store(request)
    try:
        token = await asyncio.to_thread(store.login, body.username, body.password, body.remember)
    except AuthError as exc:
        raise HTTPException(exc.status, exc.detail) from None

    who = await asyncio.to_thread(store.principal, token)
    if who is None:  # pragma: no cover - 방금 만든 세션이라 여기 오지 않는다
        raise HTTPException(500, "세션을 만들지 못했다")
    _set_cookie(response, token, body.remember)
    return who


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict[str, bool]:
    token = request.cookies.get(COOKIE)
    if token:
        await asyncio.to_thread(_store(request).logout, token)
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/profile", response_model=Profile)
async def read_profile(request: Request, who: Member) -> Profile:
    assert who.username is not None  # member 이상이면 계정이 있다
    return await asyncio.to_thread(_store(request).profile, who.username)


@router.put("/profile", response_model=Profile)
async def write_profile(request: Request, who: Member, body: Profile) -> Profile:
    """자기 것만 고친다. 어느 계정인지는 세션이 정하고 본문은 관여하지 않는다."""
    assert who.username is not None
    return await asyncio.to_thread(_store(request).save_profile, who.username, body)


# --- 관리자 ---

admin = APIRouter(prefix="/api/auth", dependencies=[Depends(require("admin"))])


@admin.get("/users", response_model=list[Account])
async def list_users(request: Request) -> list[Account]:
    return await asyncio.to_thread(_store(request).accounts)


@admin.put("/users/{user_id}/approved", response_model=list[Account])
async def set_approved(user_id: int, body: Approval, request: Request) -> list[Account]:
    """가입을 승인하거나 거두고, 갱신된 목록을 돌려준다."""
    store = _store(request)
    try:
        await asyncio.to_thread(store.set_approved, user_id, body.approved)
    except AuthError as exc:
        raise HTTPException(exc.status, exc.detail) from None
    return await asyncio.to_thread(store.accounts)


@admin.put("/users/{user_id}/active", response_model=list[Account])
async def set_active(user_id: int, body: Block, request: Request) -> list[Account]:
    """차단하거나 되돌리고, 갱신된 목록을 돌려준다. 화면이 다시 조회하지 않아도 되게."""
    store = _store(request)
    try:
        await asyncio.to_thread(store.set_active, user_id, body.active)
    except AuthError as exc:
        raise HTTPException(exc.status, exc.detail) from None
    return await asyncio.to_thread(store.accounts)
