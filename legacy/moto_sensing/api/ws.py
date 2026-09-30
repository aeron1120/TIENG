"""WebSocket 브로드캐스트 (CLAUDE.md §3).

서버가 상태를 소유하고 프론트는 받기만 한다. 클라이언트 → 서버 메시지는 없으며,
receive 는 연결 종료를 감지하는 용도로만 쓴다.

기기가 하나뿐이라 모두가 같은 스냅샷을 본다. 그래서 JSON 을 한 번만 만들어 전원에게
보낸다 — 붙은 사람 수만큼 직렬화하면 루프가 접속자 수에 비례해 느려진다.
"""

from __future__ import annotations

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from core.schemas import Snapshot

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
            except Exception:  # noqa: BLE001
                # 끊긴 소켓 하나가 나머지 구독자의 갱신을 막으면 안 된다.
                self.disconnect(ws)


@router.websocket("/ws")
async def stream(ws: WebSocket) -> None:
    hub: Hub = ws.app.state.hub
    await hub.connect(ws)

    # 최신 스냅샷을 즉시 밀어 첫 화면이 한 틱 동안 비어 있지 않게 한다.
    latest: Snapshot | None = ws.app.state.pipeline.latest
    if latest is not None:
        await ws.send_text(latest.model_dump_json())

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)
