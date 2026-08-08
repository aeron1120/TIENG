from fastapi import APIRouter, Request

from api.schemas import InterventionEvent

router = APIRouter()


@router.get("/api/interventions", response_model=list[InterventionEvent])
async def recent_interventions(request: Request) -> list[InterventionEvent]:
    """최근 개입. 최신이 앞에 온다.

    전체 이력은 logs/interventions.csv 에 있다. 여기는 화면에 띄울 최근 몇 건만.
    """
    runner = getattr(request.app.state, "runner", None)
    return [] if runner is None else runner.recent
