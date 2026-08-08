"""카메라 미리보기 (MJPEG).

카메라는 rPPG 어댑터가 캡처 스레드에서 이미 잡고 있다. 미리보기를 만들겠다고
VideoCapture 를 하나 더 열면 Windows 에서는 장치가 점유돼 실패하고, Linux 에서
열리더라도 두 스트림이 노출을 서로 흔들어 측정이 나빠진다. 그래서 새로 열지 않고
어댑터가 이미 들고 있는 프레임을 그대로 내보낸다.

multipart/x-mixed-replace 를 쓰는 이유는 <img src="..."> 하나로 끝나기 때문이다.
브라우저가 알아서 프레임을 갈아 끼우므로 프론트에 디코딩 코드가 없다.

원본을 저장하지도, LAN 밖으로 내보내지도 않는다 (README §1 비목표).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from core.adapters.base import PreviewSource

log = structlog.get_logger(__name__)

router = APIRouter()

BOUNDARY = "tfvframe"
# 어댑터가 굽는 속도보다 조금 빠르게 확인한다. 같은 프레임이면 보내지 않으므로
# 실제 전송률은 어댑터의 PREVIEW_FPS 를 넘지 않는다.
POLL_SEC = 1.0 / 15.0
# 카메라가 아직 첫 프레임을 못 냈을 때 얼마나 기다려 주는가.
FIRST_FRAME_TIMEOUT_SEC = 5.0


def _sources(request: Request) -> dict[str, PreviewSource]:
    registry = getattr(request.app.state, "registry", None)
    return registry.preview_sources() if registry is not None else {}


@router.get("/api/camera")
async def camera_status(request: Request) -> dict[str, Any]:
    """미리보기가 가능한지. 화면은 이걸 보고 패널을 띄울지 정한다."""
    sources = _sources(request)
    return {"available": bool(sources), "sources": sorted(sources)}


@router.get("/api/camera/stream")
async def camera_stream(request: Request, source: str | None = None) -> StreamingResponse:
    sources = _sources(request)
    if not sources:
        raise HTTPException(404, "미리보기를 낼 수 있는 카메라 어댑터가 없다")

    name = source or sorted(sources)[0]
    adapter = sources.get(name)
    if adapter is None:
        raise HTTPException(404, f"{name} 은(는) 미리보기를 내지 않는다")

    return StreamingResponse(
        _frames(request, adapter),
        media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY}",
        # 미리보기를 캐시하면 정지 화면이 남는다.
        headers={"Cache-Control": "no-store"},
    )


async def _frames(request: Request, adapter: PreviewSource) -> AsyncIterator[bytes]:
    last: bytes | None = None
    waited = 0.0

    while not await request.is_disconnected():
        # 매 회 알린다. 이 호출이 끊기면 어댑터가 곧 인코딩을 멈춘다.
        adapter.request_preview()
        frame = adapter.preview_jpeg()

        if frame is None:
            waited += POLL_SEC
            if waited >= FIRST_FRAME_TIMEOUT_SEC:
                # 프레임이 안 나오는데 연결만 붙잡고 있으면 화면은 검은 채로
                # 영원히 기다린다. 끊어야 프론트가 "없음"을 표시한다.
                log.warning("camera.no_frame", timeout_s=FIRST_FRAME_TIMEOUT_SEC)
                return
        elif frame is not last:
            last = frame
            yield (
                f"--{BOUNDARY}\r\n"
                f"Content-Type: image/jpeg\r\n"
                f"Content-Length: {len(frame)}\r\n\r\n"
            ).encode() + frame + b"\r\n"

        await asyncio.sleep(POLL_SEC)
