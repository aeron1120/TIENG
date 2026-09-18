from fastapi import APIRouter, HTTPException, Request

from api.schemas import Snapshot

router = APIRouter()


@router.get("/api/snapshot", response_model=Snapshot)
async def get_snapshot(request: Request) -> Snapshot:
    latest: Snapshot | None = request.app.state.latest
    if latest is None:
        raise HTTPException(status_code=503, detail="아직 첫 스냅샷이 만들어지지 않았다")
    return latest
