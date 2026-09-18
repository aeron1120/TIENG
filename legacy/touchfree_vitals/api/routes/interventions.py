from typing import Any

from fastapi import APIRouter, HTTPException, Request

from api.schemas import InterventionEvent

router = APIRouter()


@router.get("/api/interventions", response_model=list[InterventionEvent])
async def recent_interventions(request: Request) -> list[InterventionEvent]:
    """최근 개입. 최신이 앞에 온다.

    전체 이력은 logs/interventions.csv 에 있다. 여기는 화면에 띄울 최근 몇 건만.
    """
    runner = getattr(request.app.state, "runner", None)
    return [] if runner is None else runner.recent


@router.post("/api/interventions/{event_id}/cancel")
async def cancel_intervention(event_id: str, request: Request) -> dict[str, Any]:
    """카운트다운 중인 개입을 취소한다.

    되돌릴 수 없는 개입만 카운트다운을 거치므로, 사실상 보호자 알림을 막는 버튼이다.
    이미 나간 것은 취소되지 않는다 — 그때는 404 다.
    """
    runner = getattr(request.app.state, "runner", None)
    if runner is None or not runner.cancel(event_id):
        raise HTTPException(404, "취소할 수 있는 개입이 아니다 (이미 처리됐거나 없다)")
    return {"cancelled": event_id}
