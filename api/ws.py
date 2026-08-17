"""WebSocket 브로드캐스트.

서버가 상태를 소유하고 프론트는 받기만 한다 (README §10). 클라이언트 → 서버 메시지는
없으며, receive는 연결 종료를 감지하는 용도로만 쓴다.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.auth import COOKIE, Users
from api.schemas import Snapshot

log = structlog.get_logger(__name__)

router = APIRouter()

# 마지막 구독자가 나간 뒤 이만큼 기다렸다가 장치를 놓는다. 새로고침은 끊었다가
# 곧바로 다시 붙는 것이라, 유예가 없으면 카메라를 껐다 켜느라 새로고침마다
# 몇 초씩 값이 끊긴다.
IDLE_GRACE_S = 5.0


class Hub:
    def __init__(
        self, on_watched: Callable[[bool], Awaitable[None]] | None = None
    ) -> None:
        self._clients: set[WebSocket] = set()
        # 보는 사람이 생기고 없어질 때 부를 곳. 카메라를 놓는 데 쓴다 (api/main.py).
        self._on_watched = on_watched
        self._idle: asyncio.Task[None] | None = None
        # 지금 장치를 들고 있는가. 구독자 수로 대신 판단할 수 없다 — 새로고침은
        # 목록을 잠깐 비우지만 유예 덕분에 장치는 그대로 들고 있다.
        self._watching = False

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)
        self._cancel_idle()
        if not self._watching:
            self._watching = await self._watched(True)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)
        if self._clients or self._on_watched is None or self._idle is not None:
            return
        self._idle = asyncio.create_task(self._idle_release())

    async def close(self) -> None:
        """종료 때 유예 타이머를 정리한다. 남겨 두면 루프가 닫힌 뒤에 깨어난다."""
        self._cancel_idle()

    def _cancel_idle(self) -> None:
        if self._idle is not None:
            self._idle.cancel()
            self._idle = None

    async def _idle_release(self) -> None:
        try:
            await asyncio.sleep(IDLE_GRACE_S)
        except asyncio.CancelledError:
            return
        self._idle = None
        # 자는 사이에 누가 들어왔을 수 있다.
        if self._clients:
            return
        if await self._watched(False):
            self._watching = False

    async def _watched(self, watched: bool) -> bool:
        """장치 쪽에 알린다. 성공했는지 돌려준다 — 실패했으면 상태를 바꾸지 않는다."""
        if self._on_watched is None:
            return True
        try:
            await self._on_watched(watched)
        except Exception as exc:
            # 장치를 못 열거나 못 놓았다고 해서 구독자를 끊지 않는다. 다음 구독자가
            # 붙을 때 다시 열어 본다.
            log.warning("hub.watch_failed", watched=watched, error=str(exc))
            return False
        return True

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
