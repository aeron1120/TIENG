"""WebSocket 브로드캐스트.

서버가 상태를 소유하고 프론트는 받기만 한다 (README §10). 클라이언트 → 서버 메시지는
없으며, receive는 연결 종료를 감지하는 용도로만 쓴다.

보내는 내용은 소켓마다 다르다. 소스가 서버(파이)면 방 스냅샷을 그대로 받고, 소스가
자기 기기면 그 세션이 자기 카메라로 만든 지표를 덮어쓴 것을 받는다.

나눠 보내는 이유는 그것이 이 화면의 요구사항이기 때문이다. 철수가 자기 폰으로 잰
심박이 영희 화면에 뜨면 안 된다. 그래서 세션(로그인)이 있는 것이고, 한 번 만든
JSON 을 전원에게 뿌리면 그 구분이 성립하지 않는다.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Literal

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.auth import COOKIE, Principal, Users
from api.schemas import Metric, Snapshot

log = structlog.get_logger(__name__)

router = APIRouter()

# 마지막 구독자가 나간 뒤 이만큼 기다렸다가 장치를 놓는다. 새로고침은 끊었다가
# 곧바로 다시 붙는 것이라, 유예가 없으면 카메라를 껐다 켜느라 새로고침마다
# 몇 초씩 값이 끊긴다.
IDLE_GRACE_S = 5.0


# 어느 기기의 센서를 볼 것인가.
#   server  이 서버에 붙은 센서 (파이의 카메라·온습도·열화상). 같은 방을 보는
#           사람들끼리는 같은 값이 맞다.
#   device  화면을 연 기기의 카메라. 그 세션에서만 보인다.
Source = Literal["server", "device"]

# 세션별 지표. 열쇠는 세션 토큰이다 (api/auth.py 의 쿠키).
#
# username 을 쓰지 않는 이유: 비회원은 username 이 없어서 전부 한 칸에 몰린다.
# 그러면 비회원 둘이 서로의 심박을 보게 된다 — 나누려던 것이 정확히 그것이다.
PersonalMetrics = Mapping[str, list[Metric]]


@dataclass(frozen=True)
class Viewer:
    """이 소켓에 무엇을 보낼지 정하는 값."""

    key: str  # 세션 토큰
    source: Source


class Hub:
    def __init__(
        self, on_watched: Callable[[bool], Awaitable[None]] | None = None
    ) -> None:
        self._clients: dict[WebSocket, Viewer] = {}
        # 보는 사람이 생기고 없어질 때 부를 곳. 카메라를 놓는 데 쓴다 (api/main.py).
        self._on_watched = on_watched
        self._idle: asyncio.Task[None] | None = None
        # 지금 장치를 들고 있는가. 구독자 수로 대신 판단할 수 없다 — 새로고침은
        # 목록을 잠깐 비우지만 유예 덕분에 장치는 그대로 들고 있다.
        self._watching = False

    async def connect(self, ws: WebSocket, viewer: Viewer) -> None:
        await ws.accept()
        self._clients[ws] = viewer
        self._cancel_idle()
        if not self._watching:
            self._watching = await self._watched(True)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.pop(ws, None)
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

    async def broadcast(self, room: Snapshot, personal: PersonalMetrics) -> None:
        if not self._clients:
            return

        # 같은 것을 보는 사람끼리는 JSON 을 한 번만 만든다. 붙은 사람 수만큼 직렬화하면
        # 1Hz 루프가 접속자 수에 비례해 느려진다.
        cache: dict[str, str] = {}
        for ws, viewer in list(self._clients.items()):
            slot = "" if viewer.source == "server" else viewer.key
            payload = cache.get(slot)
            if payload is None:
                payload = view_for(viewer, room, personal).model_dump_json()
                cache[slot] = payload
            try:
                await ws.send_text(payload)
            except Exception:
                # 끊긴 소켓 하나가 나머지 구독자의 갱신을 막으면 안 된다.
                self.disconnect(ws)


def view_for(viewer: Viewer, room: Snapshot, personal: PersonalMetrics) -> Snapshot:
    """이 사람에게 보낼 스냅샷.

    자기 기기를 보는 중이면 그 세션이 만든 지표로 같은 자리를 덮는다. 나머지 카드는
    방의 것을 그대로 둔다 — 브라우저에는 온습도 센서가 없고, 카드를 지워 버리면
    이 시스템이 무엇을 보는 물건인지가 화면에서 사라진다 (core/registry.py 가
    어댑터가 없어도 카드 자리를 남기는 것과 같은 이유다).
    """
    if viewer.source == "server":
        return room

    mine = {metric.key: metric for metric in personal.get(viewer.key, [])}
    if not mine:
        return room
    return room.model_copy(
        update={"metrics": [mine.get(metric.key, metric) for metric in room.metrics]}
    )


@router.websocket("/ws")
async def stream(ws: WebSocket, source: Source = "server") -> None:
    # 지표가 실제로 흐르는 통로는 여기다. REST 만 막고 이걸 열어 두면 게이트가 없는
    # 것과 같다. 라우터 의존성(api/main.py)을 쓰지 않는 이유는 HTTPException 이
    # 핸드셰이크 중에는 응답으로 옮겨지지 않아서다 — 직접 닫는다.
    users: Users = ws.app.state.users
    token = ws.cookies.get(COOKIE)
    who: Principal | None = (
        await asyncio.to_thread(users.principal, token) if token else None
    )
    if who is None or token is None:
        log.info("ws.rejected")
        await ws.close(code=1008)  # policy violation
        return

    hub: Hub = ws.app.state.hub
    viewer = Viewer(key=token, source=source)
    await hub.connect(ws, viewer)
    log.info("ws.connected", role=who.role, source=source)

    # 최신 스냅샷을 즉시 밀어 첫 화면이 한 틱 동안 비어 있지 않게 한다.
    latest: Snapshot | None = ws.app.state.latest
    if latest is not None:
        await ws.send_text(view_for(viewer, latest, ws.app.state.personal).model_dump_json())

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)
        log.info("ws.disconnected")
