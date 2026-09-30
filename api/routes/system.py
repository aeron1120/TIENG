"""시스템 상태.

하드웨어를 붙일 때 서버 로그를 뒤지는 대신 화면에서 보라고 만든다. 파이 옆에서
폰으로 열어 두고 센서를 하나씩 꽂으면 카드가 살아나는 걸 볼 수 있다.

scripts/hwcheck.py 와 같은 정보를 주지만 이쪽은 **이미 돌고 있는 서버**의 상태다.
hwcheck 는 별도 프로세스로 어댑터를 새로 열어 보는 것이라 목적이 다르다.

카메라 backend 를 바꾸는 것도 여기 둔다. camera.py 가 아니라 이쪽인 이유는 권한이다
— camera 라우터는 guest 까지 열려 있고 (미리보기는 비회원도 본다), 기기 설정을
바꾸는 것은 member 여야 한다 (api/main.py 의 라우터 등록).
"""

import asyncio
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core import overrides

log = structlog.get_logger(__name__)

router = APIRouter()


def _status(request: Request) -> dict[str, Any]:
    registry = getattr(request.app.state, "registry", None)
    if registry is None:
        return {"ready": False}
    status: dict[str, Any] = {"ready": True, **registry.status()}
    status["config_path"] = str(getattr(request.app.state, "config_path", ""))
    return status


@router.get("/api/system")
async def system_status(request: Request) -> dict[str, Any]:
    return _status(request)


class CameraBackendBody(BaseModel):
    backend: overrides.CameraBackend


@router.put("/api/system/camera-backend")
async def set_camera_backend(request: Request, body: CameraBackendBody) -> dict[str, Any]:
    """카메라를 여는 방식을 바꾸고 그 어댑터만 다시 연다.

    고른 값은 device.yaml 이 아니라 state/ 에 남는다 (core/overrides.py 에 이유).
    실패해도 저장은 한다 — 안 열리는 것을 확인하는 것도 이 화면을 쓰는 이유고,
    사유는 어댑터 카드에 그대로 실려 돌아간다.
    """
    registry = getattr(request.app.state, "registry", None)
    if registry is None:
        raise HTTPException(503, "서버가 아직 준비되지 않았다")

    entry = registry.camera_entry()
    if entry is None:
        raise HTTPException(404, "backend 를 고를 수 있는 카메라 어댑터가 없다")

    registry.set_camera_backend(body.backend)
    await asyncio.to_thread(overrides.save, overrides.Overrides(camera_backend=body.backend))
    log.info("camera.backend_changed", adapter=entry.id, backend=body.backend)

    await registry.restart_adapter(entry.id)
    return _status(request)
