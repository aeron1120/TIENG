"""화면 배치 읽기/쓰기.

배치는 계정마다 하나다. 처음에는 기기별 파일 하나였는데, 그건 방 하나에 태블릿
하나를 전제로 한 것이라 화면이 공개 주소로 열리면서 성립하지 않게 됐다 — 한 사람이
카메라를 크게 보면 다른 모든 사람 화면이 같이 바뀌었다 (core/layout.py).

비회원에게는 저장할 계정이 없다. 그렇다고 바꿔도 안 바뀌게 두면 눌러도 아무 일이
없는 화면이 되므로, 세션이 살아 있는 동안만 메모리에 들고 있는다. 서버가 다시 뜨면
사라지고, 그건 비회원 세션도 마찬가지다.

저장소 I/O 는 짧지만 블로킹이라 executor 로 넘긴다 (README §10). 1Hz 루프가 같은
이벤트 루프에서 돌기 때문에, 디스크가 한 번 느린 것이 지표 수신에 그대로 나타난다.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import APIRouter, Request

from api.auth import COOKIE, Users, current
from core.layout import Layout

if TYPE_CHECKING:  # psycopg 가 없는 기기에서도 이 모듈은 떠야 한다 (api/main.py)
    from api.auth_pg import PgUsers

router = APIRouter()

# 비회원 배치를 들고 있는 칸 수. 공개 주소에서는 세션이 계속 새로 생기므로 상한이
# 없으면 한 방향으로만 자란다. 넘치면 가장 오래된 것부터 버린다 — 잃는 것은 한
# 사람의 블록 순서고, 다시 끌면 된다.
MAX_GUESTS = 200


def _store(request: Request) -> Users | PgUsers:
    return request.app.state.users  # type: ignore[no-any-return]


def _guests(request: Request) -> dict[str, Layout]:
    return request.app.state.layouts  # type: ignore[no-any-return]


@router.get("/api/layout")
async def read_layout(request: Request) -> Layout:
    who = await current(request)
    if who is not None and who.username is not None:
        return await asyncio.to_thread(_store(request).layout, who.username)

    token = request.cookies.get(COOKIE)
    return _guests(request).get(token or "", Layout())


@router.put("/api/layout")
async def write_layout(request: Request, body: Layout) -> Layout:
    who = await current(request)
    if who is not None and who.username is not None:
        return await asyncio.to_thread(_store(request).save_layout, who.username, body)

    token = request.cookies.get(COOKIE)
    if token:
        guests = _guests(request)
        guests[token] = body
        while len(guests) > MAX_GUESTS:
            del guests[next(iter(guests))]  # 사전은 넣은 순서를 지킨다
    return body
