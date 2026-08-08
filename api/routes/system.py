"""시스템 상태.

하드웨어를 붙일 때 서버 로그를 뒤지는 대신 화면에서 보라고 만든다. 파이 옆에서
폰으로 열어 두고 센서를 하나씩 꽂으면 카드가 살아나는 걸 볼 수 있다.

scripts/hwcheck.py 와 같은 정보를 주지만 이쪽은 **이미 돌고 있는 서버**의 상태다.
hwcheck 는 별도 프로세스로 어댑터를 새로 열어 보는 것이라 목적이 다르다.
"""

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/api/system")
async def system_status(request: Request) -> dict[str, Any]:
    registry = getattr(request.app.state, "registry", None)
    if registry is None:
        return {"ready": False}
    status: dict[str, Any] = {"ready": True, **registry.status()}
    status["config_path"] = str(getattr(request.app.state, "config_path", ""))
    return status
