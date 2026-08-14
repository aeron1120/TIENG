"""운전 모드 읽기/쓰기.

무엇을 재는 데 집중할지를 고른다 (core/mode.py). 배치(layout)와 같은 이유로 서버가
들고 있는다 — 기기 하나를 여러 사람이 열어도 같은 모드를 봐야 하고, 새로고침한다고
심박이 도로 켜지면 안 된다.

파일 I/O 는 짧지만 블로킹이라 executor 로 넘긴다. 1Hz 샘플링 루프가 같은 이벤트
루프에서 도는데, 디스크가 한 번 느린 것이 그대로 지표 수신에 나타난다 (README §10).
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request

from core import mode as run_mode

router = APIRouter()


@router.get("/api/mode")
async def current(request: Request) -> dict[str, object]:
    registry = getattr(request.app.state, "registry", None)
    return {
        "mode": registry.mode if registry is not None else run_mode.ModeState().mode,
        "available": list(run_mode.MODES),
    }


@router.post("/api/mode")
async def switch(body: run_mode.ModeState, request: Request) -> dict[str, object]:
    """모드를 바꾸고 디스크에 남긴다.

    바꾸는 순간 어댑터 일부가 쉬기 시작한다. 되돌릴 수 있는 동작이라 확인을 받지
    않는다 — 다시 누르면 원래대로 돌아온다.
    """
    registry = getattr(request.app.state, "registry", None)
    if registry is None:
        raise HTTPException(503, "아직 준비되지 않았다")
    try:
        registry.apply_mode(body.mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    await asyncio.to_thread(run_mode.save, body, request.app.state.mode_path)
    return {"mode": registry.mode}
