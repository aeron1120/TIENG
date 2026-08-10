"""WebSocket 브로드캐스트.

서버가 상태를 소유하고 프론트는 받기만 한다 (README §10). 클라이언트 → 서버 메시지는
없으며, receive는 연결 종료를 감지하는 용도로만 쓴다.
"""

from __future__ import annotations

import asyncio

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.auth import COOKIE, Users
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
    # 지표가 실제로 흐르는 통로는 여기다. REST 만 막고 이걸 열어 두면 게이트가 없는
    # 것과 같다. 라우터 의존성(api/main.py)을 쓰지 않는 이유는 HTTPException 이
    # 핸드셰이크 중에는 응답으로 옮겨지지 않아서다 — 직접 닫는다.
    users: Users = ws.app.state.users
    token = ws.cookies.get(COOKIE)
    who = await asyncio.to_thread(users.principal, token) if token else None
    if who is None:
        log.info("ws.rejected")
        await ws.close(code=1008)  # policy violation
        return

    hub: Hub = ws.app.state.hub
    await hub.connect(ws)
    log.info("ws.connected", role=who.role)

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
