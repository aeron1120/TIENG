"""화면 배치 읽기/쓰기.

파일 I/O 는 짧지만 블로킹이라 executor 로 넘긴다 (README §10). 1Hz 루프가 같은
이벤트 루프에서 돌기 때문에, 디스크가 한 번 느린 것이 지표 수신에 그대로 나타난다.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from core import layout

router = APIRouter()


@router.get("/api/layout")
async def read_layout() -> layout.Layout:
    return await asyncio.to_thread(layout.load)


@router.put("/api/layout")
async def write_layout(body: layout.Layout) -> layout.Layout:
    await asyncio.to_thread(layout.save, body)
    return body
