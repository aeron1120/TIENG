"""WebSocket 브로드캐스트.

서버가 상태를 소유하고 프론트는 받기만 한다 (README §10). 클라이언트 → 서버 메시지는
없으며, receive는 연결 종료를 감지하는 용도로만 쓴다.
"""

from __future__ import annotations

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.schemas import Snapshot

log = structlog.get_logger(__name__)

router = APIRouter()


class Hub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast(self, snapshot: Snapshot) -> None:
        if not self._clients:
            return
        payload = snapshot.model_dump_json()
        for ws in list(self._clients):
            try:
                await ws.send_text(payload)
            except Exception:
                # 끊긴 소켓 하나가 나머지 구독자의 갱신을 막으면 안 된다.
                self.disconnect(ws)


@router.websocket("/ws")
async def stream(ws: WebSocket) -> None:
    hub: Hub = ws.app.state.hub
    await hub.connect(ws)
    log.info("ws.connected")

    # 최신 스냅샷을 즉시 밀어 첫 화면이 한 틱 동안 비어 있지 않게 한다.
    latest: Snapshot | None = ws.app.state.latest
    if latest is not None:
        await ws.send_text(latest.model_dump_json())

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)
        log.info("ws.disconnected")
